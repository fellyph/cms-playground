// Core HTTP server & CMS CLI runner backed by @php-wasm/node.

import http from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHPRequestHandler } from '@php-wasm/universal';
import { createNodeFsMountHandler } from '@php-wasm/node';
import { loadBlueprint, runBlueprint } from './blueprints.js';
import { getCacheDir } from './cache.js';
import {
  DOCUMENT_ROOT,
  bootPhp,
  createRequestQueue,
  mountDirectories,
  randomPassword,
  runPhpCode,
  unpackZip,
} from './runtime.js';

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
  mounts = [],
  blueprintSource = null,
  quiet = false,
  log = (msg) => console.log(msg),
} = {}) {
  if (!adapter) {
    throw new Error('A CMS adapter is required');
  }

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

  const url = `http://${host}:${port}`;
  const password = randomPassword();
  const statusLog = quiet ? () => {} : log;

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

  if (mounts.length > 0) {
    await mountDirectories(php, mounts);
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
    phpVersion: String(effectivePhp),
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
 * Runs a CMS's native CLI (e.g. cli/joomla.php) inside PHP-WASM.
 */
export async function runCmsCli({
  adapter,
  args = [],
  site = null,
  version = null,
  phpVersion = null,
  mounts = [],
  log = () => {},
}) {
  if (!adapter?.cliEntrypoint) {
    throw new Error(`${adapter?.label ?? 'This CMS'} adapter does not define a CLI entrypoint`);
  }

  const effectivePhp = String(phpVersion ?? adapter.defaultPhp ?? '8.4');
  const php = await bootPhp({ phpVersion: effectivePhp });

  if (site) {
    await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(resolve(site)));
  } else {
    const cacheDir = getCacheDir(adapter.name);
    const bundle = await adapter.resolveBundle({ version: version ?? adapter.defaultVersion, cacheDir, log });

    if (bundle.zipBytes) {
      await unpackZip(php, bundle.zipBytes, bundle.extractTo ?? DOCUMENT_ROOT);
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
}
