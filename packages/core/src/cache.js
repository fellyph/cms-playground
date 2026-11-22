// Local disk cache for downloaded CMS bundles and static assets.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EXIT_CODES, PlaygroundError } from './errors.js';

const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/**
 * Returns the root cache directory (~/.cache/cms-playground or $XDG_CACHE_HOME/cms-playground).
 * When CMS_PLAYGROUND_CACHE_DIR is explicitly set, it is used directly as the root.
 */
export function getCacheDir(...segments) {
  const explicit = process.env.CMS_PLAYGROUND_CACHE_DIR;
  const root = explicit
    ? explicit
    : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'cms-playground');
  const dir = join(root, ...segments);

  mkdirSync(dir, { recursive: true });

  return dir;
}

/**
 * Downloads a URL to a local file path if not already cached, using an atomic temp-file rename.
 *
 * @returns {Promise<string>} Path to the cached file
 */
export async function downloadToCache(
  url,
  destination,
  { force = false, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, log = () => {} } = {}
) {
  if (!force && existsSync(destination)) {
    return destination;
  }

  mkdirSync(dirname(destination), { recursive: true });
  log(`Downloading ${url}`);

  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw error;
    }
    throw new PlaygroundError(`Failed to download ${url}: ${error?.message ?? error}`, {
      code: 'download_failed',
      exitCode: EXIT_CODES.NETWORK,
      retryable: true,
      suggestions: ['Check your network connection and retry the command.'],
      cause: error,
    });
  }

  if (!response.ok) {
    throw new PlaygroundError(
      `Failed to download ${url}: HTTP ${response.status} ${response.statusText}`,
      {
        code: 'download_failed',
        exitCode: EXIT_CODES.NETWORK,
        retryable: true,
        suggestions: ['Retry the command or verify the requested CMS version exists.'],
      }
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const tmp = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, destination);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw error;
  }

  return destination;
}

/**
 * Reads a cached file as Uint8Array, downloading it first if missing.
 */
export async function fetchCachedBytes(url, destination, options = {}) {
  const path = await downloadToCache(url, destination, options);

  return new Uint8Array(readFileSync(path));
}
