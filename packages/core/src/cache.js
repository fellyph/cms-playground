// Local disk cache for downloaded CMS bundles and static assets.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

  const response = await fetch(url, {
    redirect: 'follow',
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
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
