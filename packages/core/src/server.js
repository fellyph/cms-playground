// Core HTTP server, headless Blueprint runner, snapshot builder, and CMS CLI runner backed by @php-wasm/node.

import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  mountsBeforeInstall = [],
  mounts = [],
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

  const password = randomPassword();

  statusLog(`Booting PHP ${effectivePhp} (WebAssembly)...`);
  const php = await bootPhp({ phpVersion: String(effectivePhp) });

  let bundle = null;

  if (site) {
    const absSite = resolve(site);

    if (!existsSync(absSite)) {
      throw new Error(`Site directory does not exist: ${absSite}`);
    }

    statusLog(`Mounting local site ${absSite}...`);
    await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(absSite));
  } else {
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
    site: site ? resolve(site) : null,
    bundle,
    log: statusLog,
  })) ?? {};

  if (mounts.length > 0) {
    debugLog(`Mounting ${mounts.length} director${mounts.length === 1 ? 'y' : 'ies'}...`);
    await mountDirectories(php, mounts);
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
    effectivePhp: String(effectivePhp),
    effectiveVersion,
    statusLog,
    debugLog,
  };
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
  blueprintSource = null,
  verbosity = 'normal',
  quiet = false,
  log = (msg) => console.log(msg),
} = {}) {
  const initialUrl = `http://${host}:${port}`;
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
  } = await bootSite({
    adapter,
    version,
    phpVersion,
    url: initialUrl,
    site,
    mountsBeforeInstall,
    mounts,
    blueprintSource,
    verbosity,
    quiet,
    log,
  });

  const serialized = createRequestQueue();

  const server = http.createServer(async (request, response) => {
    const started = performance.now();

    try {
      // Allow the adapter to serve static assets (e.g. Joomla's split /media/ bundle) directly.
      if (adapter.serveStatic && ['GET', 'HEAD'].includes(request.method)) {
        const staticResult = await adapter.serveStatic({
          request,
          bundle,
          cacheDir: getCacheDir(adapter.name),
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

      response.end(Buffer.from(phpResponse.bytes));
      statusLog(`${request.method} ${request.url} ${phpResponse.httpStatusCode} ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error?.stack ?? error));
      statusLog(`${request.method} ${request.url} 500 ${error?.message ?? error}`);
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => resolveListen());
  });

  const boundPort = server.address()?.port ?? port;
  const boundUrl = `http://${host}:${boundPort}`;
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
    close: () =>
      new Promise((done) => {
        server.close(() => {
          try {
            php.exit();
          } catch {}
          done();
        });
        server.closeAllConnections?.();
      }),
  };
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
  log = () => {},
}) {
  if (!adapter?.cliEntrypoint) {
    throw new Error(`${adapter?.label ?? 'This CMS'} adapter does not define a CLI entrypoint`);
  }

  const effectivePhp = String(phpVersion ?? adapter.defaultPhp ?? '8.4');
  const php = await bootPhp({ phpVersion: effectivePhp });

  try {
    if (site) {
      await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(resolve(site)));
    } else {
      const cacheDir = getCacheDir(adapter.name);
      const bundle = await adapter.resolveBundle({ version: version ?? adapter.defaultVersion, cacheDir, log });

      if (bundle.zipBytes) {
        await unpackZip(php, bundle.zipBytes, bundle.extractTo ?? DOCUMENT_ROOT);
      }

      if (mountsBeforeInstall.length > 0) {
        await mountDirectories(php, mountsBeforeInstall);
      }

      await adapter.configure({ php, documentRoot: DOCUMENT_ROOT, url: 'http://127.0.0.1:8790', password: randomPassword(), bundle, log });
    }

    php.chdir(DOCUMENT_ROOT);

    if (mounts.length > 0) {
      await mountDirectories(php, mounts);
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
}
