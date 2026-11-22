// Local disk cache for downloaded CMS bundles and static assets.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Returns the root cache directory (~/.cache/cms-playground or $XDG_CACHE_HOME/cms-playground).
 */
export function getCacheDir(...segments) {
  const base = process.env.CMS_PLAYGROUND_CACHE_DIR
    || process.env.XDG_CACHE_HOME
    || join(homedir(), '.cache');
  const dir = join(base, 'cms-playground', ...segments);

  mkdirSync(dir, { recursive: true });

  return dir;
}

/**
 * Downloads a URL to a local file path if not already cached, using an atomic temp-file rename.
 *
 * @returns {Promise<string>} Path to the cached file
 */
export async function downloadToCache(url, destination, { force = false, log = () => {} } = {}) {
  if (!force && existsSync(destination)) {
    return destination;
  }

  mkdirSync(dirname(destination), { recursive: true });
  log(`Downloading ${url}`);

  const response = await fetch(url, { redirect: 'follow' });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const tmp = `${destination}.${process.pid}.tmp`;

  writeFileSync(tmp, bytes);
  renameSync(tmp, destination);

  return destination;
}

/**
 * Reads a cached file as Uint8Array, downloading it first if missing.
 */
export async function fetchCachedBytes(url, destination, options = {}) {
  const path = await downloadToCache(url, destination, options);

  return new Uint8Array(readFileSync(path));
}
