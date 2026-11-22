// Shared PHP-WASM Node runtime helpers.

import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHP, ProcessIdAllocator } from '@php-wasm/universal';
import { createNodeFsMountHandler, loadNodeRuntime } from '@php-wasm/node';
import { EXIT_CODES, PlaygroundError } from './errors.js';

export const DOCUMENT_ROOT = '/var/www/html';

const processIds = new ProcessIdAllocator();

/**
 * Serializes async tasks so a single PHP-WASM instance never handles overlapping requests.
 */
export function createRequestQueue() {
  let queue = Promise.resolve();

  return (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});

    return run;
  };
}

/**
 * Generates a readable random password for ephemeral playground sessions.
 */
export function randomPassword(length = 12) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';

  for (let i = 0; i < length; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }

  return out;
}

/**
 * Boots a @php-wasm/node PHP instance and releases its claimed process ID on exit or failure.
 */
export async function bootPhp({ phpVersion = '8.4' } = {}) {
  const processId = processIds.claim();
  let released = false;
  const releaseProcessId = () => {
    if (!released) {
      released = true;
      processIds.release(processId);
    }
  };

  let runtime;
  try {
    runtime = await loadNodeRuntime(phpVersion, {
      emscriptenOptions: { processId },
    });
  } catch (error) {
    releaseProcessId();
    throw error;
  }

  let php;
  try {
    php = new PHP(runtime);
    php.mkdir(DOCUMENT_ROOT);
  } catch (error) {
    try {
      php?.exit();
    } catch {}
    releaseProcessId();
    throw error;
  }

  const originalExit = php.exit.bind(php);
  php.exit = (...args) => {
    try {
      return originalExit(...args);
    } finally {
      releaseProcessId();
    }
  };

  return php;
}

/**
 * Runs a PHP snippet (without <?php tag) and throws if PHP exits non-zero.
 */
export async function runPhpCode(php, code) {
  const response = await php.run({ code: `<?php\n${code}` });

  if (response.exitCode !== 0) {
    const details = (response.errors || response.text || `exit code ${response.exitCode}`).trim();
    throw new Error(`PHP error: ${details}`);
  }

  return response;
}

/**
 * Unpacks a zip archive (Uint8Array) into a target directory inside PHP's virtual filesystem.
 */
export async function unpackZip(php, zipBytes, targetDir = DOCUMENT_ROOT) {
  const tmpPath = `/tmp/archive-${process.pid}-${randomBytes(6).toString('hex')}.zip`;

  php.mkdir(targetDir);
  php.writeFile(tmpPath, zipBytes);

  try {
    await runPhpCode(
      php,
      `
      $zip = new ZipArchive();
      if ($zip->open(${JSON.stringify(tmpPath)}) !== true) {
          throw new RuntimeException('Cannot open zip archive');
      }
      for ($i = 0; $i < $zip->numFiles; $i++) {
          $entry = $zip->getNameIndex($i);
          if ($entry === false || strpos($entry, "\\0") !== false) {
              $zip->close();
              throw new RuntimeException('Unsafe zip entry path');
          }
          $normalized = str_replace('\\\\', '/', $entry);
          if (
              ($normalized !== '' && $normalized[0] === '/') ||
              preg_match('/^[a-zA-Z]:/', $normalized) ||
              in_array('..', explode('/', $normalized), true)
          ) {
              $zip->close();
              throw new RuntimeException('Unsafe zip entry path: ' . $entry);
          }
      }
      if (!$zip->extractTo(${JSON.stringify(targetDir)})) {
          $zip->close();
          throw new RuntimeException('Cannot extract zip archive');
      }
      if (!$zip->close()) {
          throw new RuntimeException('Cannot close zip archive');
      }
      `
    );
  } finally {
    if (php.fileExists(tmpPath)) {
      php.unlink(tmpPath);
    }
  }
}

/**
 * Packs a directory inside PHP's virtual filesystem into a zip archive (Uint8Array).
 */
export async function packZip(php, sourceDir = DOCUMENT_ROOT) {
  const tmpPath = `/tmp/snapshot-${process.pid}-${randomBytes(6).toString('hex')}.zip`;

  try {
    await runPhpCode(
      php,
      `
      $root = rtrim(${JSON.stringify(sourceDir)}, '/');
      $zip = new ZipArchive();
      if ($zip->open(${JSON.stringify(tmpPath)}, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
          throw new RuntimeException('Cannot create snapshot zip archive');
      }
      $it = new RecursiveIteratorIterator(
          new RecursiveDirectoryIterator($root, RecursiveDirectoryIterator::SKIP_DOTS),
          RecursiveIteratorIterator::SELF_FIRST
      );
      foreach ($it as $item) {
          $rel = substr($item->getPathname(), strlen($root) + 1);
          if ($item->isDir()) {
              $zip->addEmptyDir($rel);
          } else {
              $zip->addFile($item->getPathname(), $rel);
          }
      }
      if (!$zip->close()) {
          throw new RuntimeException('Cannot finalize snapshot zip archive');
      }
      `
    );

    return php.readFileAsBuffer(tmpPath);
  } finally {
    if (php.fileExists(tmpPath)) {
      php.unlink(tmpPath);
    }
  }
}

/**
 * Mounts host directories into the PHP virtual filesystem.
 * Each mount entry is { hostPath, vfsPath }.
 */
export async function mountDirectories(php, mounts = []) {
  for (const { hostPath, vfsPath } of mounts) {
    const absHost = resolve(hostPath);

    if (!existsSync(absHost)) {
      throw new PlaygroundError(`Mount host directory does not exist: ${absHost}`, {
        code: 'mount_not_found',
        exitCode: EXIT_CODES.NOT_FOUND,
        suggestions: ['Verify the host path passed to --mount or pass --cwd=<project-dir>.'],
      });
    }

    php.mkdir(vfsPath);
    await php.mount(vfsPath, createNodeFsMountHandler(absHost));
  }
}

/**
 * Parses CLI --mount specs of the form "hostPath:vfsPath".
 */
export function parseMountSpec(spec, baseDir = process.cwd()) {
  const idx = typeof spec === 'string' ? spec.lastIndexOf(':') : -1;

  if (idx <= 0 || idx === spec.length - 1) {
    throw new PlaygroundError(
      `Invalid --mount "${spec}". Expected <hostPath>:<vfsPath> (e.g. ./src:/var/www/html/plugins/system/foo)`,
      {
        code: 'invalid_mount',
        exitCode: EXIT_CODES.VALIDATION,
        suggestions: ['Use --mount=<hostPath>:<vfsPath> where <vfsPath> starts with "/".'],
      }
    );
  }

  const hostPart = spec.slice(0, idx);
  const vfsPath = spec.slice(idx + 1);

  // Reject bare Windows drive-letter paths (e.g. "C:/foo" or "C:\foo") that lack a :vfsPath separator.
  if (idx === 1 && /^[a-zA-Z]$/.test(hostPart)) {
    throw new PlaygroundError(
      `Invalid --mount "${spec}". Expected <hostPath>:<vfsPath> (e.g. C:\\src:/var/www/html/plugins/system/foo)`,
      {
        code: 'invalid_mount',
        exitCode: EXIT_CODES.VALIDATION,
        suggestions: ['Use --mount=<hostPath>:<vfsPath> where <vfsPath> starts with "/".'],
      }
    );
  }

  if (!vfsPath.startsWith('/')) {
    throw new PlaygroundError(
      `Invalid --mount "${spec}". VFS path "${vfsPath}" must start with "/"`,
      {
        code: 'invalid_mount',
        exitCode: EXIT_CODES.VALIDATION,
        suggestions: ['Prefix the VFS mount path with "/", e.g. /var/www/html/custom.'],
      }
    );
  }

  return {
    hostPath: resolve(baseDir, hostPart),
    vfsPath,
  };
}
