// Core HTTP server, headless Blueprint runner, snapshot builder, and CMS CLI runner backed by @php-wasm/node.

import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PHPRequestHandler } from '@php-wasm/universal';
import { createNodeFsMountHandler } from '@php-wasm/node';
import { loadBlueprint, runBlueprint } from './blueprints.js';
import { getCacheDir } from './cache.js';
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
    throw new Error('A CMS adapter is required');
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
    throw new Error(
      `${adapter.label} does not support PHP ${effectivePhp}. Supported: ${adapter.supportedPhp.join(', ')}`
    );
  }

  const absSite = site ? resolve(site) : null;

  if (absSite && !existsSync(absSite)) {
    throw new Error(`Site directory does not exist: ${absSite}`);
  }

  const password = randomPassword();

  let detectedAutoMount = null;

  if (autoMount) {
    if (typeof adapter.detectAutoMount !== 'function') {
      throw new Error(`${adapter.label} adapter does not support --auto-mount`);
    }

    const targetDir = typeof autoMount === 'string' ? resolve(autoMount) : process.cwd();
    detectedAutoMount = await adapter.detectAutoMount(targetDir);

    if (!detectedAutoMount) {
      throw new Error(`Could not detect a ${adapter.label} extension/plugin/theme in ${targetDir}`);
    }

    statusLog(`Auto-mount detected ${detectedAutoMount.kind} in ${targetDir}`);
  }

  statusLog(`Booting PHP ${effectivePhp} (WebAssembly)...`);
  const php = await bootPhp({ phpVersion: String(effectivePhp) });

  try {
    let bundle = null;

    if (absSite) {
      statusLog(`Mounting local site ${absSite}...`);
      await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(absSite));
    } else {
      if (stageDir) {
        await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(stageDir));
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
      site: absSite,
      bundle,
      log: statusLog,
    })) ?? {};

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

    return {
      php,
      handler,
      bundle,
      info,
      password,
      loadedBlueprint,
      detectedAutoMount,
      effectivePhp: String(effectivePhp),
      effectiveVersion,
      statusLog,
      debugLog,
    };
  } catch (error) {
    try {
      php.exit();
    } catch {}
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

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

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
      php,
      close: async () => {
        await closeHttpServer(server);
        try {
          php.exit();
        } catch {}
      },
    };
  } catch (error) {
    try {
      php.exit();
    } catch {}
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
  mountsBeforeInstall = [],
  mounts = [],
  autoMount = null,
  verbosity = 'normal',
  quiet = false,
  log = (msg) => console.log(msg),
}) {
  if (!blueprintSource) {
    throw new Error('A --blueprint file or URL is required for run-blueprint');
  }

  const booted = await bootSite({
    adapter,
    version,
    phpVersion,
    site,
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
    };
  } finally {
    try {
      booted.php.exit();
    } catch {}
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
  mountsBeforeInstall = [],
  mounts = [],
  autoMount = null,
  verbosity = 'normal',
  quiet = false,
  log = (msg) => console.log(msg),
}) {
  if (!outputPath) {
    throw new Error('An --output path (e.g. ./snapshot.zip) is required for build-snapshot');
  }

  const booted = await bootSite({
    adapter,
    version,
    phpVersion,
    site,
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
    };
  } finally {
    try {
      booted.php.exit();
    } catch {}
  }
}

/**
 * Runs a CMS's native CLI (e.g. cli/joomla.php) inside PHP-WASM.
 */
export async function runCmsCli({
  adapter,
  args = [],
  site = null,
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
    throw new Error(`${adapter?.label ?? 'This CMS'} adapter does not define a CLI entrypoint`);
  }

  let tempSiteDir = null;
  let hostSiteDir = site ? resolve(site) : null;

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
      stageDir: site ? null : hostSiteDir,
      mountsBeforeInstall,
      mounts: [],
      autoMount,
      blueprintSource,
      verbosity,
      quiet,
      log,
    });

    const effectivePhp = booted.effectivePhp;
    const allMounts = [
      ...mountsBeforeInstall,
      ...(booted.detectedAutoMount?.mounts ?? []),
      ...mounts,
    ];

    try {
      booted.php.exit();
    } catch {}

    const php = await bootPhp({ phpVersion: effectivePhp });

    try {
      await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(hostSiteDir));
      php.chdir(DOCUMENT_ROOT);

      if (allMounts.length > 0) {
        await mountDirectories(php, allMounts);
      }

      const response = await php.cli(['php', `${DOCUMENT_ROOT}/${adapter.cliEntrypoint}`, ...args]);
      const stdout = await response.stdoutText;
      const stderr = await response.stderrText;

      return { exitCode: await response.exitCode, stdout, stderr };
    } finally {
      try {
        php.exit();
      } catch {}
    }
  } finally {
    if (tempSiteDir) {
      rmSync(tempSiteDir, { recursive: true, force: true });
    }
  }
}
