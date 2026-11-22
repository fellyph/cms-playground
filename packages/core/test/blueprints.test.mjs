import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CORE_STEPS,
  DOCUMENT_ROOT,
  bootPhp,
  loadBlueprint,
  packZip,
  resolveVfsPath,
  runBlueprint,
} from '../src/index.js';

describe('@cms-playground/core blueprints', () => {
  it('validates resolveVfsPath and rejects traversal, backslashes, null bytes, empty, and non-strings', () => {
    assert.equal(resolveVfsPath(DOCUMENT_ROOT, 'a/b/c.txt'), '/var/www/html/a/b/c.txt');
    assert.equal(resolveVfsPath(DOCUMENT_ROOT, '///nested/file.php'), '/var/www/html/nested/file.php');

    for (const invalid of [null, undefined, 42, {}, '', '/', '///', '../etc/passwd', 'a/../../b', 'a\\b', 'a\0b']) {
      assert.throws(() => resolveVfsPath(DOCUMENT_ROOT, invalid), /Invalid path/);
    }
  });

  it('executes mkdir, writeFile, runPHP, unzip (HTTP + error), and custom steps in runBlueprint', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    let server;

    try {
      // Build a real zip archive to serve over HTTP
      php.mkdir('/tmp/zip-src/sub');
      php.writeFile('/tmp/zip-src/sub/hello.txt', 'from-http-zip');
      const zipBytes = await packZip(php, '/tmp/zip-src');

      server = http.createServer((req, res) => {
        if (req.url === '/archive.zip') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/zip');
          res.end(Buffer.from(zipBytes));
          return;
        }
        res.statusCode = 404;
        res.end('missing');
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const logs = [];
      let customRan = false;
      const context = {
        php,
        documentRoot: DOCUMENT_ROOT,
        baseUrl,
        log: (msg) => logs.push(msg),
      };

      await runBlueprint(
        {
          steps: [
            { step: 'mkdir', path: 'deep/dir' },
            { step: 'writeFile', path: 'deep/dir/text.txt', data: 'hello' },
            { step: 'writeFile', path: 'deep/dir/bin.dat', data: [65, 66, 67] },
            { step: 'runPHP', code: '<?php file_put_contents("deep/dir/php.txt", file_get_contents("deep/dir/text.txt") . "!");' },
            { step: 'unzip', url: './archive.zip', to: 'unpacked' },
            { step: 'customStep', value: 'ok' },
          ],
        },
        context,
        {
          async customStep(step) {
            customRan = step.value === 'ok';
          },
        }
      );

      assert.equal(php.readFileAsText(`${DOCUMENT_ROOT}/deep/dir/text.txt`), 'hello');
      assert.equal(php.readFileAsText(`${DOCUMENT_ROOT}/deep/dir/bin.dat`), 'ABC');
      assert.equal(php.readFileAsText(`${DOCUMENT_ROOT}/deep/dir/php.txt`), 'hello!');
      assert.equal(php.readFileAsText(`${DOCUMENT_ROOT}/unpacked/sub/hello.txt`), 'from-http-zip');
      assert.equal(customRan, true);
      assert.equal(logs.length, 6);

      // HTTP 404 in unzip rejects with status
      await assert.rejects(
        () => CORE_STEPS.unzip({ url: './missing.zip' }, context),
        /Cannot download .* HTTP 404/
      );

      // Unknown step throws a helpful error listing known steps
      await assert.rejects(
        () => runBlueprint({ steps: [{ step: 'doesNotExist' }] }, context),
        /unknown step "doesNotExist".*Known steps:/
      );
    } finally {
      if (server) {
        await new Promise((r) => {
          server.close(() => r());
          server.closeAllConnections?.();
        });
      }
      php.exit();
    }
  });

  it('loads blueprints from local files and remote HTTP URLs and validates structure', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-bp-load-'));
    const server = http.createServer((req, res) => {
      if (req.url === '/valid.json') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ landingPage: '/admin/', steps: [] }));
        return;
      }
      if (req.url === '/invalid.json') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ steps: 'nope' }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const localPath = join(workDir, 'bp.json');
      writeFileSync(localPath, JSON.stringify({ steps: [{ step: 'mkdir', path: 'x' }] }));
      const local = await loadBlueprint(localPath);
      assert.equal(local.blueprint.steps.length, 1);
      assert.ok(local.baseUrl.startsWith('file://'));

      const remote = await loadBlueprint(`${baseUrl}/valid.json`);
      assert.equal(remote.blueprint.landingPage, '/admin/');
      assert.equal(remote.baseUrl, `${baseUrl}/valid.json`);

      await assert.rejects(() => loadBlueprint(`${baseUrl}/missing.json`), /Cannot fetch blueprint .* HTTP 404/);
      await assert.rejects(() => loadBlueprint(`${baseUrl}/invalid.json`), /"steps" must be an array/);
    } finally {
      await new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      });
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
