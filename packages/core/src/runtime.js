// Shared PHP-WASM Node runtime helpers.

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PHP, ProcessIdAllocator } from '@php-wasm/universal';
import { createNodeFsMountHandler, loadNodeRuntime } from '@php-wasm/node';

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
  const bytes = randomBytes(length);

  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Boots a @php-wasm/node PHP instance.
 */
export async function bootPhp({ phpVersion = '8.4' } = {}) {
  const runtime = await loadNodeRuntime(phpVersion, {
    emscriptenOptions: { processId: processIds.claim() },
  });
  const php = new PHP(runtime);

  php.mkdir(DOCUMENT_ROOT);

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
  const tmpPath = `/tmp/archive-${process.pid}-${Date.now()}.zip`;

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
      if (!$zip->extractTo(${JSON.stringify(targetDir)})) {
          $zip->close();
          throw new RuntimeException('Cannot extract zip archive');
      }
      $zip->close();
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
  const tmpPath = `/tmp/snapshot-${process.pid}-${Date.now()}.zip`;

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
      $zip->close();
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
    php.mkdir(vfsPath);
    await php.mount(vfsPath, createNodeFsMountHandler(absHost));
  }
}

/**
 * Parses CLI --mount specs of the form "hostPath:vfsPath".
 */
export function parseMountSpec(spec) {
  const idx = spec.lastIndexOf(':');

  if (idx <= 0 || idx === spec.length - 1) {
    throw new Error(`Invalid --mount "${spec}". Expected <hostPath>:<vfsPath> (e.g. ./src:/var/www/html/plugins/system/foo)`);
  }

  return {
    hostPath: resolve(spec.slice(0, idx)),
    vfsPath: spec.slice(idx + 1),
  };
}
