// Core HTTP server, headless Blueprint runner, snapshot builder, and CMS CLI runner backed by @php-wasm/node.

import http from 'node:http';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PHPRequestHandler } from '@php-wasm/universal';
import { createNodeFsMountHandler } from '@php-wasm/node';
import { loadBlueprint, runBlueprint } from './blueprints.js';
import { getCacheDir } from './cache.js';
import { EXIT_CODES, PlaygroundError } from './errors.js';
import {
  DOCUMENT_ROOT,
  bootPhp,
  createRequestQueue,
  mountDirectories,
  packZip,
  randomPassword,
  runPhpCode,
  unpackZip,
} from './runtime.js';

const SITE_LOCK_FILE = '.cms-playground.lock';
const SITE_MARKER_FILE = '.cms-playground-site.json';
const RECOGNIZED_SITE_MARKERS = [
  SITE_MARKER_FILE,
  'configuration.php',
  'wp-config.php',
  'wp-load.php',
  'sites/default/settings.php',
  'kirby',
  'public/typo3',
  'index.php',
];

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireSiteLock(absSite, cms) {
  const lockPath = join(absSite, SITE_LOCK_FILE);
  const payload = JSON.stringify({
    pid: process.pid,
    cms,
    startedAt: new Date().toISOString(),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, payload, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      let existing = null;
      try {
        existing = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        // Corrupt lock file — treat as stale.
      }

      if (existing && isProcessAlive(existing.pid)) {
        throw new PlaygroundError(
          `Site directory is already in use by another cms-playground process (PID ${existing.pid}): ${absSite}`,
          {
            code: 'site_locked',
            exitCode: EXIT_CODES.CONFLICT,
            retryable: false,
            suggestions: [
              'Stop the other cms-playground process using this --site directory, or pass a different --site path.',
            ],
          }
        );
      }

      // Stale lock from a dead process — remove and retry once.
      try {
        rmSync(lockPath, { force: true });
      } catch {}

      if (attempt === 1) {
        throw new PlaygroundError(`Could not acquire site lock for ${absSite}`, {
          code: 'site_locked',
          exitCode: EXIT_CODES.CONFLICT,
          retryable: true,
        });
      }
    }
  }

  let released = false;

  return {
    lockPath,
    release() {
      if (released) {
        return;
      }
      released = true;

      try {
        if (!existsSync(lockPath)) {
          return;
        }
        const current = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (current?.pid === process.pid) {
          rmSync(lockPath, { force: true });
        }
      } catch {
        // Ignore cleanup errors.
      }
    },
  };
}

function assertSafeResetTarget(absSite) {
  const forbidden = new Set([dirname(absSite), resolve(homedir()), resolve(tmpdir())]);

  if (forbidden.has(absSite)) {
    throw new PlaygroundError(`Refusing to --reset protected directory: ${absSite}`, {
      code: 'unsafe_site_reset',
      exitCode: EXIT_CODES.VALIDATION,
      suggestions: ['Pass a dedicated subdirectory for --site=<dir> when using --reset.'],
    });
  }

  if (!existsSync(absSite)) {
    return;
  }

  if (!lstatSync(absSite).isDirectory()) {
    throw new PlaygroundError(`--site path is not a directory: ${absSite}`, {
      code: 'unsafe_site_reset',
      exitCode: EXIT_CODES.VALIDATION,
    });
  }

  if (existsSync(join(absSite, '.git'))) {
    throw new PlaygroundError(
      `Refusing to --reset a Git repository directory: ${absSite}`,
      {
        code: 'unsafe_site_reset',
        exitCode: EXIT_CODES.VALIDATION,
        suggestions: ['Use a dedicated site directory outside your Git repository for --site --reset.'],
      }
    );
  }

  const entries = readdirSync(absSite).filter((name) => name !== SITE_LOCK_FILE);

  if (entries.length === 0) {
    return;
  }

  const looksLikeCmsSite = RECOGNIZED_SITE_MARKERS.some((marker) =>
    existsSync(join(absSite, marker))
  );

  if (!looksLikeCmsSite) {
    throw new PlaygroundError(
      `Refusing to --reset "${absSite}" because it is non-empty and does not look like a CMS Playground site directory`,
      {
        code: 'unsafe_site_reset',
        exitCode: EXIT_CODES.VALIDATION,
        suggestions: [
          'Verify the --site path or clear the directory manually before initializing it.',
        ],
      }
    );
  }
}

function clearSiteContentsExceptLock(absSite) {
  for (const entry of readdirSync(absSite)) {
    if (entry === SITE_LOCK_FILE) {
      continue;
    }
    rmSync(join(absSite, entry), { recursive: true, force: true });
  }
}

/**
 * Shared site bootstrap: loads blueprint (if any), boots PHP-WASM, mounts/unpacks the CMS,
 * applies mountsBeforeInstall -> adapter.configure() -> mounts -> blueprint steps.
 */
async function bootSite({
  adapter,
  version = null,
  phpVersion = null,
  url = 'http://127.0.0.1:8790',
  site = null,
  reset = false,
  stageDir = null,
  mountsBeforeInstall = [],
  mounts = [],
  autoMount = null,
  blueprintSource = null,
  verbosity = 'normal',
  quiet = false,
  log = (msg) => console.log(msg),
}) {
  if (!adapter) {
    throw new PlaygroundError('A CMS adapter is required', {
      code: 'missing_cms',
      exitCode: EXIT_CODES.VALIDATION,
    });
  }

  const effectiveVerbosity = quiet ? 'quiet' : verbosity;
  const statusLog = effectiveVerbosity === 'quiet' ? () => {} : log;
  const debugLog = effectiveVerbosity === 'debug' ? log : () => {};

  let loadedBlueprint = null;

  if (blueprintSource) {
    loadedBlueprint = await loadBlueprint(blueprintSource);
  }

  const effectivePhp = phpVersion
    ?? loadedBlueprint?.blueprint?.preferredVersions?.php
    ?? adapter.defaultPhp
    ?? '8.4';
  const effectiveVersion = version
    ?? loadedBlueprint?.blueprint?.preferredVersions?.[adapter.name]
    ?? adapter.defaultVersion;

  if (adapter.supportedPhp && !adapter.supportedPhp.includes(String(effectivePhp))) {
    throw new PlaygroundError(
      `${adapter.label} does not support PHP ${effectivePhp}. Supported: ${adapter.supportedPhp.join(', ')}`,
      {
        code: 'invalid_php_version',
        exitCode: EXIT_CODES.VALIDATION,
        recovery: `cms-playground start --${adapter.name} --php=${adapter.defaultPhp ?? adapter.supportedPhp[0]}`,
        suggestions: [`Supported PHP versions for ${adapter.label}: ${adapter.supportedPhp.join(', ')}`],
      }
    );
  }

  const absSite = site ? resolve(site) : null;

  if (reset && !absSite) {
    throw new PlaygroundError('--reset requires --site=<dir>', {
      code: 'missing_option',
      exitCode: EXIT_CODES.VALIDATION,
      recovery: `cms-playground start --${adapter.name} --site=./my-site --reset`,
      suggestions: ['Pass --site=<dir> together with --reset to re-initialize a persistent site directory.'],
    });
  }

  if (absSite) {
    if (reset) {
      assertSafeResetTarget(absSite);
      mkdirSync(absSite, { recursive: true });
    } else if (!existsSync(absSite)) {
      throw new PlaygroundError(`Site directory does not exist: ${absSite}`, {
        code: 'site_not_found',
        exitCode: EXIT_CODES.NOT_FOUND,
        suggestions: ['Verify the --site directory path or omit --site to boot a fresh CMS bundle.'],
      });
    }
  }

  const password = randomPassword();

  let detectedAutoMount = null;

  if (autoMount) {
    if (typeof adapter.detectAutoMount !== 'function') {
      throw new PlaygroundError(`${adapter.label} adapter does not support --auto-mount`, {
        code: 'unsupported_operation',
        exitCode: EXIT_CODES.VALIDATION,
        suggestions: ['Use --mount=<hostPath>:<vfsPath> instead.'],
      });
    }

    const targetDir = typeof autoMount === 'string' ? resolve(autoMount) : process.cwd();
    detectedAutoMount = await adapter.detectAutoMount(targetDir);

    if (!detectedAutoMount) {
      throw new PlaygroundError(
        `Could not detect a ${adapter.label} extension/plugin/theme in ${targetDir}`,
        {
          code: 'auto_mount_not_found',
          exitCode: EXIT_CODES.NOT_FOUND,
          suggestions: [
            'Pass --cwd=<project-dir> or --auto-mount=<dir> pointing to a valid extension/plugin/theme directory.',
          ],
        }
      );
    }

    statusLog(`Auto-mount detected ${detectedAutoMount.kind} in ${targetDir}`);
  }

  const siteLock = absSite ? acquireSiteLock(absSite, adapter.name) : null;
  let php = null;

  try {
    if (absSite && reset) {
      statusLog(`Resetting site directory ${absSite}...`);
      clearSiteContentsExceptLock(absSite);
    }

    statusLog(`Booting PHP ${effectivePhp} (WebAssembly)...`);
    php = await bootPhp({ phpVersion: String(effectivePhp), extensions: adapter.phpExtensions });

    let bundle = null;

    if (absSite && !reset) {
      statusLog(`Mounting local site ${absSite}...`);
      await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(absSite));
    } else {
      const mountHostDir = absSite ?? stageDir;
      if (mountHostDir) {
        await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(mountHostDir));
      }

      const cacheDir = getCacheDir(adapter.name);
      bundle = await adapter.resolveBundle({ version: effectiveVersion, cacheDir, log: statusLog });

      if (bundle.zipBytes) {
        statusLog(`Unpacking ${adapter.label} ${bundle.version ?? effectiveVersion}...`);
        await unpackZip(php, bundle.zipBytes, bundle.extractTo ?? DOCUMENT_ROOT);
      }
    }

    php.chdir(DOCUMENT_ROOT);

    if (mountsBeforeInstall.length > 0) {
      debugLog(`Mounting ${mountsBeforeInstall.length} pre-install director${mountsBeforeInstall.length === 1 ? 'y' : 'ies'}...`);
      await mountDirectories(php, mountsBeforeInstall);
    }

    statusLog(`Configuring ${adapter.label}...`);
    const info = (await adapter.configure({
      php,
      documentRoot: DOCUMENT_ROOT,
      url,
      password,
      site: reset ? null : absSite,
      bundle,
      log: statusLog,
    })) ?? {};

    if (absSite && reset) {
      writeFileSync(
        join(absSite, SITE_MARKER_FILE),
        JSON.stringify(
          {
            cms: adapter.name,
            version: bundle?.version ?? effectiveVersion,
            initializedAt: new Date().toISOString(),
          },
          null,
          2
        ) + '\n'
      );
    }

    const postInstallMounts = [...(detectedAutoMount?.mounts ?? []), ...mounts];

    if (postInstallMounts.length > 0) {
      debugLog(`Mounting ${postInstallMounts.length} director${postInstallMounts.length === 1 ? 'y' : 'ies'}...`);
      await mountDirectories(php, postInstallMounts);
    }

    if (typeof detectedAutoMount?.postMount === 'function') {
      await detectedAutoMount.postMount({ php, documentRoot: DOCUMENT_ROOT, url, log: statusLog });
    }

    const handler = new PHPRequestHandler({
      php,
      documentRoot: DOCUMENT_ROOT,
      absoluteUrl: url,
      cookieStore: false,
      getFileNotFoundAction: (relativePath) => adapter.getFileNotFoundAction(relativePath),
    });

    if (loadedBlueprint) {
      await runBlueprint(
        loadedBlueprint.blueprint,
        {
          php,
          handler,
          documentRoot: DOCUMENT_ROOT,
          url,
          baseUrl: loadedBlueprint.baseUrl,
          runPhp: (code) => runPhpCode(php, code),
          log: statusLog,
        },
        adapter.blueprintSteps ?? {}
      );
    }

    const allMounts = [...mountsBeforeInstall, ...postInstallMounts].map(({ hostPath, vfsPath }) => ({
      hostPath: resolve(hostPath),
      vfsPath,
    }));

    return {
      php,
      handler,
      bundle,
      info,
      password,
      loadedBlueprint,
      detectedAutoMount,
      mounts: allMounts,
      effectivePhp: String(effectivePhp),
      effectiveVersion,
      statusLog,
      debugLog,
      releaseSiteLock: () => siteLock?.release(),
    };
  } catch (error) {
    try {
      php?.exit();
    } catch {}
    siteLock?.release();
    throw error;
  }
}

function closeHttpServer(server) {
  return new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections?.();
  });
}

/**
 * Boots a CMS adapter in PHP-WASM and serves it over HTTP on localhost.
 */
export async function startPlayground({
  adapter,
  version = null,
  phpVersion = null,
  port = 8790,
  host = '127.0.0.1',
  site = null,
  reset = false,
  mountsBeforeInstall = [],
  mounts = [],
  autoMount = null,
  blueprintSource = null,
  verbosity = 'normal',
  quiet = false,
  log = (msg) => console.log(msg),
} = {}) {
  let handleRequest = null;

  const server = http.createServer((request, response) => {
    if (!handleRequest) {
      response.statusCode = 503;
      response.end(request.method === 'HEAD' ? undefined : 'Playground is starting...');
      return;
    }

    return handleRequest(request, response);
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, host, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      const cmsFlag = adapter?.name ? `--${adapter.name}` : '--joomla';
      throw new PlaygroundError(`Port ${port} on ${host} is already in use`, {
        code: 'port_in_use',
        exitCode: EXIT_CODES.CONFLICT,
        retryable: false,
        recovery: `cms-playground start ${cmsFlag} --port=0`,
        suggestions: ['Pass --port=0 to bind an ephemeral free port, or choose another --port.'],
        cause: error,
      });
    }
    throw error;
  }

  const boundPort = server.address()?.port ?? port;
  const boundUrl = `http://${host}:${boundPort}`;

  let booted;
  try {
    booted = await bootSite({
      adapter,
      version,
      phpVersion,
      url: boundUrl,
      site,
      reset,
      mountsBeforeInstall,
      mounts,
      autoMount,
      blueprintSource,
      verbosity,
      quiet,
      log,
    });
  } catch (error) {
    await closeHttpServer(server);
    throw error;
  }

  const {
    php,
    handler,
    bundle,
    info,
    password,
    loadedBlueprint,
    effectivePhp,
    effectiveVersion,
    statusLog,
  } = booted;

  try {
    const serialized = createRequestQueue();
    const staticCacheDir = adapter.serveStatic ? getCacheDir(adapter.name) : null;

    handleRequest = async (request, response) => {
      const started = performance.now();

      try {
        // Allow the adapter to serve static assets (e.g. Joomla's split /media/ bundle) directly.
        if (adapter.serveStatic && ['GET', 'HEAD'].includes(request.method)) {
          const staticResult = await adapter.serveStatic({
            request,
            bundle,
            cacheDir: staticCacheDir,
          });

          if (staticResult) {
            response.statusCode = staticResult.status ?? 200;

            for (const [name, value] of Object.entries(staticResult.headers ?? {})) {
              response.setHeader(name, value);
            }

            response.end(request.method === 'HEAD' ? undefined : Buffer.from(staticResult.body));
            statusLog(`${request.method} ${request.url} ${response.statusCode} ${Math.round(performance.now() - started)} ms [static]`);

            return;
          }
        }

        const chunks = [];

        for await (const chunk of request) {
          chunks.push(chunk);
        }

        const headers = Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])
        );
        const body = Buffer.concat(chunks);
        const phpResponse = await serialized(() =>
          handler.request({
            url: request.url,
            method: request.method,
            headers,
            body: body.length ? new Uint8Array(body) : undefined,
          })
        );

        response.statusCode = phpResponse.httpStatusCode;

        for (const [name, value] of Object.entries(phpResponse.headers)) {
          response.setHeader(name, value);
        }

        response.end(request.method === 'HEAD' ? undefined : Buffer.from(phpResponse.bytes));
        statusLog(`${request.method} ${request.url} ${phpResponse.httpStatusCode} ${Math.round(performance.now() - started)} ms`);
      } catch (error) {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end(request.method === 'HEAD' ? undefined : String(error?.stack ?? error));
        } else if (!response.writableEnded) {
          response.end();
        }
        statusLog(`${request.method} ${request.url} 500 ${error?.message ?? error}`);
      }
    };

    const landingPage = loadedBlueprint?.blueprint?.landingPage ?? adapter.adminPath ?? '/';

    return {
      url: boundUrl,
      port: boundPort,
      adminUrl: `${boundUrl}${adapter.adminPath ?? '/'}`,
      landingUrl: `${boundUrl}${landingPage}`,
      username: info.username ?? 'admin',
      password: info.password ?? password,
      version: bundle?.version ?? effectiveVersion,
      phpVersion: effectivePhp,
      mounts: booted.mounts,
      php,
      close: async () => {
        await closeHttpServer(server);
        try {
          php.exit();
        } catch {}
        booted.releaseSiteLock?.();
      },
    };
  } catch (error) {
    try {
      php.exit();
    } catch {}
    booted.releaseSiteLock?.();
    await closeHttpServer(server);
    throw error;
  }
}

/**
 * Runs a Blueprint headlessly against a CMS adapter without starting an HTTP server.
 */
export async function runBlueprintHeadless({
  adapter,
  blueprintSource,
  version = null,
  phpVersion = null,
  site = null,
  reset = false,
  mountsBeforeInstall = [],
  mounts = [],
  autoMount = null,
  verbosity = 'normal',
  quiet = false,
  log = (msg) => console.log(msg),
}) {
  if (!blueprintSource) {
    const cmsFlag = adapter?.name ? `--${adapter.name}` : '--joomla';
    throw new PlaygroundError('A --blueprint file or URL is required for run-blueprint', {
      code: 'missing_option',
      exitCode: EXIT_CODES.VALIDATION,
      recovery: `cms-playground run-blueprint ${cmsFlag} --blueprint=./blueprint.json`,
      suggestions: ['Pass --blueprint=<file-or-url> to specify the Blueprint to run.'],
    });
  }

  const booted = await bootSite({
    adapter,
    version,
    phpVersion,
    site,
    reset,
    mountsBeforeInstall,
    mounts,
    autoMount,
    blueprintSource,
    verbosity,
    quiet,
    log,
  });

  try {
    return {
      version: booted.bundle?.version ?? booted.effectiveVersion,
      phpVersion: booted.effectivePhp,
      stepsRun: booted.loadedBlueprint?.blueprint?.steps?.length ?? 0,
      mounts: booted.mounts,
    };
  } finally {
    try {
      booted.php.exit();
    } catch {}
    booted.releaseSiteLock?.();
  }
}

/**
 * Boots a CMS, optionally runs a Blueprint, and exports DOCUMENT_ROOT as a portable zip snapshot.
 */
export async function buildSnapshot({
  adapter,
  outputPath,
  blueprintSource = null,
  version = null,
  phpVersion = null,
  site = null,
  reset = false,
  mountsBeforeInstall = [],
  mounts = [],
  autoMount = null,
  verbosity = 'normal',
  quiet = false,
  log = (msg) => console.log(msg),
}) {
  if (!outputPath) {
    const cmsFlag = adapter?.name ? `--${adapter.name}` : '--joomla';
    throw new PlaygroundError(
      'An --output path (e.g. ./snapshot.zip) is required for build-snapshot',
      {
        code: 'missing_option',
        exitCode: EXIT_CODES.VALIDATION,
        recovery: `cms-playground build-snapshot ${cmsFlag} --output=./snapshot.zip`,
        suggestions: ['Pass --output=<path.zip> to specify where to write the snapshot archive.'],
      }
    );
  }

  const booted = await bootSite({
    adapter,
    version,
    phpVersion,
    site,
    reset,
    mountsBeforeInstall,
    mounts,
    autoMount,
    blueprintSource,
    verbosity,
    quiet,
    log,
  });

  try {
    const absOutput = resolve(outputPath);

    booted.statusLog(`Packing snapshot to ${absOutput}...`);
    const zipBytes = await packZip(booted.php, DOCUMENT_ROOT);

    mkdirSync(dirname(absOutput), { recursive: true });
    writeFileSync(absOutput, zipBytes);

    return {
      outputPath: absOutput,
      bytes: zipBytes.byteLength,
      version: booted.bundle?.version ?? booted.effectiveVersion,
      phpVersion: booted.effectivePhp,
      mounts: booted.mounts,
    };
  } finally {
    try {
      booted.php.exit();
    } catch {}
    booted.releaseSiteLock?.();
  }
}

/**
 * Runs a CMS's native CLI (e.g. cli/joomla.php) inside PHP-WASM.
 */
export async function runCmsCli({
  adapter,
  args = [],
  site = null,
  reset = false,
  version = null,
  phpVersion = null,
  mountsBeforeInstall = [],
  mounts = [],
  autoMount = null,
  blueprintSource = null,
  verbosity = 'normal',
  quiet = false,
  log = () => {},
}) {
  if (!adapter?.cliEntrypoint) {
    throw new PlaygroundError(
      `${adapter?.label ?? 'This CMS'} adapter does not define a CLI entrypoint`,
      {
        code: 'unsupported_operation',
        exitCode: EXIT_CODES.VALIDATION,
        suggestions: ['Use `run-blueprint` with a `runPHP` step instead.'],
      }
    );
  }

  let tempSiteDir = null;
  let hostSiteDir = site ? resolve(site) : null;
  let releaseSiteLock = null;

  try {
    if (!hostSiteDir) {
      // @php-wasm cannot call php.cli() after php.run() on the same WASM instance.
      // Stage bundle unpack + configure into a temp directory via bootSite(),
      // then run php.cli() on a fresh PHP instance mounted to that directory.
      tempSiteDir = mkdtempSync(join(tmpdir(), 'cms-playground-cli-'));
      hostSiteDir = tempSiteDir;
    }

    const booted = await bootSite({
      adapter,
      version,
      phpVersion,
      site,
      reset,
      stageDir: site ? null : hostSiteDir,
      mountsBeforeInstall,
      mounts: [],
      autoMount,
      blueprintSource,
      verbosity,
      quiet,
      log,
    });
    releaseSiteLock = booted.releaseSiteLock;

    const effectivePhp = booted.effectivePhp;
    const allMounts = [
      ...mountsBeforeInstall,
      ...(booted.detectedAutoMount?.mounts ?? []),
      ...mounts,
    ];

    try {
      booted.php.exit();
    } catch {}

    const php = await bootPhp({ phpVersion: effectivePhp, extensions: adapter.phpExtensions });

    try {
      await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(hostSiteDir));
      php.chdir(DOCUMENT_ROOT);

      if (allMounts.length > 0) {
        await mountDirectories(php, allMounts);
      }

      const response = await php.cli(['php', `${DOCUMENT_ROOT}/${adapter.cliEntrypoint}`, ...args]);
      const stdout = await response.stdoutText;
      const stderr = await response.stderrText;

      return {
        exitCode: await response.exitCode,
        stdout,
        stderr,
        version: booted.bundle?.version ?? booted.effectiveVersion,
        phpVersion: effectivePhp,
      };
    } finally {
      try {
        php.exit();
      } catch {}
    }
  } finally {
    releaseSiteLock?.();
    if (tempSiteDir) {
      rmSync(tempSiteDir, { recursive: true, force: true });
    }
  }
}
