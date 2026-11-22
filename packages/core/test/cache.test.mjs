import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { downloadToCache, fetchCachedBytes, getCacheDir } from '../src/index.js';

describe('@cms-playground/core cache', () => {
  it('resolves getCacheDir from CMS_PLAYGROUND_CACHE_DIR, XDG_CACHE_HOME, and creates nested segments', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-cache-unit-'));
    const prevCacheDir = process.env.CMS_PLAYGROUND_CACHE_DIR;
    const prevXdg = process.env.XDG_CACHE_HOME;

    try {
      // Explicit CMS_PLAYGROUND_CACHE_DIR is used directly without appending cms-playground
      process.env.CMS_PLAYGROUND_CACHE_DIR = join(workDir, 'explicit');
      const explicitDir = getCacheDir('joomla', '6.2.0');
      assert.equal(explicitDir, join(workDir, 'explicit', 'joomla', '6.2.0'));
      assert.equal(existsSync(explicitDir), true);

      // XDG_CACHE_HOME appends cms-playground
      delete process.env.CMS_PLAYGROUND_CACHE_DIR;
      process.env.XDG_CACHE_HOME = join(workDir, 'xdg');
      const xdgDir = getCacheDir('wp');
      assert.equal(xdgDir, join(workDir, 'xdg', 'cms-playground', 'wp'));
      assert.equal(existsSync(xdgDir), true);
    } finally {
      if (prevCacheDir === undefined) {
        delete process.env.CMS_PLAYGROUND_CACHE_DIR;
      } else {
        process.env.CMS_PLAYGROUND_CACHE_DIR = prevCacheDir;
      }
      if (prevXdg === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevXdg;
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('downloads, caches, force-refreshes, handles HTTP errors, and returns cached bytes via fetchCachedBytes', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-cache-http-'));
    let hits = 0;

    const server = http.createServer((req, res) => {
      if (req.url === '/file.bin') {
        hits += 1;
        res.statusCode = 200;
        res.end(`payload-v${hits}`);
        return;
      }

      if (req.url === '/missing') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      res.statusCode = 500;
      res.end('error');
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const dest = join(workDir, 'nested', 'file.bin');
      const logs = [];

      // First download (cache miss)
      const returnedPath = await downloadToCache(`${baseUrl}/file.bin`, dest, {
        log: (msg) => logs.push(msg),
      });
      assert.equal(returnedPath, dest);
      assert.equal(hits, 1);
      assert.equal(readFileSync(dest, 'utf8'), 'payload-v1');
      assert.equal(logs.length, 1);

      // Second call (cache hit — must not hit server)
      const bytesHit = await fetchCachedBytes(`${baseUrl}/file.bin`, dest);
      assert.equal(hits, 1);
      assert.equal(Buffer.from(bytesHit).toString('utf8'), 'payload-v1');

      // Force refresh (hits server again and overwrites)
      const bytesForced = await fetchCachedBytes(`${baseUrl}/file.bin`, dest, { force: true });
      assert.equal(hits, 2);
      assert.equal(Buffer.from(bytesForced).toString('utf8'), 'payload-v2');

      // HTTP 404 throws and leaves no stray files
      const missingDest = join(workDir, 'missing.bin');
      await assert.rejects(
        () => downloadToCache(`${baseUrl}/missing`, missingDest),
        /Failed to download .* HTTP 404/
      );
      assert.equal(existsSync(missingDest), false);
      assert.equal(readdirSync(workDir).filter((f) => f.endsWith('.tmp')).length, 0);
    } finally {
      await new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      });
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
