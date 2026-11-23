// Local disk cache for downloaded CMS bundles and static assets.

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { EXIT_CODES, PlaygroundError } from './errors.js';

export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const CACHE_BUCKET_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Resolves the root cache directory path without creating it on disk.
 * When CMS_PLAYGROUND_CACHE_DIR is explicitly set, it is used directly as the root.
 */
export function resolveCacheRoot() {
  const explicit = process.env.CMS_PLAYGROUND_CACHE_DIR;

  return explicit
    ? resolve(explicit)
    : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'cms-playground');
}

/**
 * Returns the cache directory (~/.cache/cms-playground or $XDG_CACHE_HOME/cms-playground),
 * creating it on disk if needed.
 */
export function getCacheDir(...segments) {
  const dir = join(resolveCacheRoot(), ...segments);

  mkdirSync(dir, { recursive: true });

  return dir;
}

function validateBucketName(cms) {
  if (typeof cms !== 'string' || !CACHE_BUCKET_RE.test(cms)) {
    throw new PlaygroundError(`Invalid cache bucket name: "${cms}"`, {
      code: 'invalid_option',
      exitCode: EXIT_CODES.VALIDATION,
      suggestions: ['Specify a valid CMS adapter flag such as --joomla or --wp.'],
    });
  }
}

function measureDirectory(dirPath) {
  let files = 0;
  let bytes = 0;

  if (!existsSync(dirPath)) {
    return { files, bytes };
  }

  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      const stats = lstatSync(fullPath);

      if (stats.isDirectory()) {
        stack.push(fullPath);
      } else if (stats.isFile()) {
        files += 1;
        bytes += stats.size;
      }
    }
  }

  return { files, bytes };
}

/**
 * Inspects cached CMS buckets, file counts, and disk usage under the cache root.
 */
export function inspectCache({ cms = null } = {}) {
  const root = resolveCacheRoot();

  if (cms !== null && cms !== undefined) {
    validateBucketName(cms);
  }

  if (!existsSync(root)) {
    return {
      root,
      exists: false,
      buckets: [],
      totalFiles: 0,
      totalBytes: 0,
    };
  }

  const buckets = [];

  if (cms) {
    const bucketPath = resolve(root, cms);
    if (existsSync(bucketPath) && lstatSync(bucketPath).isDirectory()) {
      const { files, bytes } = measureDirectory(bucketPath);
      buckets.push({ name: cms, path: bucketPath, files, bytes });
    }
  } else {
    const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      const fullPath = join(root, entry.name);
      const stats = lstatSync(fullPath);

      if (stats.isDirectory()) {
        const { files, bytes } = measureDirectory(fullPath);
        buckets.push({ name: entry.name, path: fullPath, files, bytes });
      } else if (stats.isFile()) {
        buckets.push({ name: entry.name, path: fullPath, files: 1, bytes: stats.size });
      }
    }
  }

  const totalFiles = buckets.reduce((sum, b) => sum + b.files, 0);
  const totalBytes = buckets.reduce((sum, b) => sum + b.bytes, 0);

  return {
    root,
    exists: true,
    buckets,
    totalFiles,
    totalBytes,
  };
}

/**
 * Clears the entire cache root or a single CMS bucket safely.
 */
export function clearCache({ cms = null } = {}) {
  const root = resolveCacheRoot();

  if (cms !== null && cms !== undefined) {
    validateBucketName(cms);
  }

  const before = inspectCache({ cms });

  if (cms) {
    const target = resolve(root, cms);

    if (!target.startsWith(root + sep)) {
      throw new PlaygroundError(`Refusing to clear path outside cache root: ${target}`, {
        code: 'invalid_option',
        exitCode: EXIT_CODES.VALIDATION,
      });
    }

    if (!existsSync(target)) {
      return {
        root,
        target,
        cms,
        cleared: false,
        removedBuckets: [],
        removedFiles: 0,
        freedBytes: 0,
      };
    }

    rmSync(target, { recursive: true, force: true });

    return {
      root,
      target,
      cms,
      cleared: true,
      removedBuckets: [cms],
      removedFiles: before.totalFiles,
      freedBytes: before.totalBytes,
    };
  }

  if (!existsSync(root) || before.buckets.length === 0) {
    return {
      root,
      target: root,
      cms: null,
      cleared: false,
      removedBuckets: [],
      removedFiles: 0,
      freedBytes: 0,
    };
  }

  for (const entry of readdirSync(root)) {
    const fullPath = resolve(root, entry);
    if (fullPath.startsWith(root + sep)) {
      rmSync(fullPath, { recursive: true, force: true });
    }
  }

  return {
    root,
    target: root,
    cms: null,
    cleared: true,
    removedBuckets: before.buckets.map((b) => b.name),
    removedFiles: before.totalFiles,
    freedBytes: before.totalBytes,
  };
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
