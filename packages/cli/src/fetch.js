// One-shot HTTP verification command (`cms-playground fetch [path]`) for smoke-testing CMS routes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EXIT_CODES, PlaygroundError, startPlayground } from '@cms-playground/core';

const PHP_ERROR_REGEX =
  /(?:^|\b)(?:Fatal error|Parse error|Warning|Notice|Deprecated|Uncaught [A-Za-z0-9_\\]+):\s*.+/gm;

/**
 * Extracts unique PHP warning/fatal/parse/notice/uncaught error lines from response text.
 */
export function extractPhpErrors(text) {
  if (!text) {
    return [];
  }
  const matches = text.match(PHP_ERROR_REGEX) ?? [];
  return Array.from(new Set(matches.map((line) => line.trim())));
}

/**
 * Boots an ephemeral PHP-WASM instance on port 0, fetches `[path]`, optionally writes `--output`,
 * enforces `--verify-status` / `--fail-on-php-error`, and tears down the instance cleanly.
 */
export async function fetchPlaygroundPage({
  adapter,
  path = '/',
  version = null,
  phpVersion = null,
  site = null,
  mountsBeforeInstall = [],
  mounts = [],
  autoMount = null,
  blueprintSource = null,
  verbosity = 'normal',
  quiet = false,
  showStatus = false,
  showHeaders = false,
  outputPath = null,
  verifyStatus = null,
  failOnPhpError = false,
  log = (msg) => console.error(msg),
  startPlaygroundImpl = startPlayground,
  fetchImpl = globalThis.fetch,
}) {
  const normalizedPath =
    typeof path === 'string' && path.length > 0
      ? (path.startsWith('/') ? path : `/${path}`)
      : '/';

  const instance = await startPlaygroundImpl({
    adapter,
    version,
    phpVersion,
    port: 0,
    host: '127.0.0.1',
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
    const res = await fetchImpl(`${instance.url}${normalizedPath}`, {
      method: 'GET',
    });

    const rawBytes = Buffer.from(await res.arrayBuffer());
    const bodyText = rawBytes.toString('utf8');
    const phpErrors = extractPhpErrors(bodyText);
    const headers = Object.fromEntries(res.headers.entries());

    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, rawBytes);
    }

    const result = {
      cms: adapter.name,
      version: instance.version,
      phpVersion: instance.phpVersion,
      path: normalizedPath,
      status: res.status,
      statusText: res.statusText,
      ...(showHeaders ? { headers } : {}),
      bytes: rawBytes.length,
      ...(outputPath ? { output: outputPath } : {}),
      phpErrors,
    };

    if (verifyStatus !== null && res.status !== verifyStatus) {
      throw new PlaygroundError(
        `HTTP status verification failed for ${normalizedPath}: expected ${verifyStatus}, got ${res.status} ${res.statusText}`.trim(),
        {
          code: 'fetch_status_mismatch',
          exitCode: EXIT_CODES.UNKNOWN,
          retryable: false,
          suggestions: [
            `Inspect the route with --headers or --output=./response.html to see why ${normalizedPath} returned HTTP ${res.status}.`,
          ],
        }
      );
    }

    if (failOnPhpError && phpErrors.length > 0) {
      throw new PlaygroundError(
        `Detected ${phpErrors.length} PHP error(s) on ${normalizedPath}: ${phpErrors[0]}`,
        {
          code: 'php_error_detected',
          exitCode: EXIT_CODES.UNKNOWN,
          retryable: false,
          suggestions: [
            'Fix the reported PHP error(s) or inspect the full response with --output=./response.html.',
          ],
        }
      );
    }

    return { result, showStatus, showHeaders };
  } finally {
    await instance.close();
  }
}
