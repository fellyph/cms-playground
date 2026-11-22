import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CORE_STEPS,
  bootPhp,
  buildSnapshot,
  downloadToCache,
  getAdapter,
  getCacheDir,
  listAdapters,
  loadBlueprint,
  parseMountSpec,
  randomPassword,
  registerAdapter,
  resolveVfsPath,
  runBlueprintHeadless,
  runCmsCli,
  runPhpCode,
  startPlayground,
  unpackZip,
} from '../src/index.js';

describe('@cms-playground/core', () => {
  it('registers and resolves adapters by name and alias', () => {
    const dummy = {
      name: 'dummy',
      label: 'Dummy CMS',
      aliases: ['dm'],
      defaultPhp: '8.4',
      supportedPhp: ['8.4'],
      defaultVersion: '1.0',
      adminPath: '/admin/',
      resolveBundle: async () => ({}),
      configure: async () => ({}),
      getFileNotFoundAction: () => ({ type: '404' }),
    };

    registerAdapter(dummy);
    assert.equal(getAdapter('dummy'), dummy);
    assert.equal(getAdapter('DM'), dummy);
    assert.ok(listAdapters().includes(dummy));
  });

  it('parses host:vfs mount specs and rejects malformed ones', async () => {
    const parsed = parseMountSpec('./src:/var/www/html/plugins/system/test');

    assert.equal(parsed.vfsPath, '/var/www/html/plugins/system/test');
    assert.ok(parsed.hostPath.endsWith('/src'));

    // Valid Windows drive-letter mount spec
    const winParsed = parseMountSpec('C:\\src:/var/www/html/plugins/system/test');
    assert.equal(winParsed.vfsPath, '/var/www/html/plugins/system/test');

    assert.throws(() => parseMountSpec('no-colon'), /Invalid --mount/);
    assert.throws(() => parseMountSpec(':missing-host'), /Invalid --mount/);
    assert.throws(() => parseMountSpec('missing-vfs:'), /Invalid --mount/);
    assert.throws(() => parseMountSpec('C:/bare-windows-path'), /Invalid --mount/);
    assert.throws(() => parseMountSpec('C:\\bare-windows-path'), /Invalid --mount/);
    assert.throws(() => parseMountSpec('./src:relative/vfs/path'), /must start with "\/"/);

    const php = await bootPhp({ phpVersion: '8.4' });
    try {
      const { mountDirectories } = await import('../src/index.js');
      await assert.rejects(
        () => mountDirectories(php, [{ hostPath: '/nonexistent-cms-pg-mount-dir', vfsPath: '/var/www/html/x' }]),
        /Mount host directory does not exist/
      );
    } finally {
      php.exit();
    }
  });

  it('boots PHP 8.4 in WebAssembly and serves HTTP requests via startPlayground', async () => {
    const testAdapter = {
      name: 'test-php',
      label: 'Test PHP',
      defaultPhp: '8.4',
      supportedPhp: ['8.4'],
      defaultVersion: '1.0',
      adminPath: '/',
      async resolveBundle() {
        return { version: '1.0' };
      },
      async configure({ php, documentRoot }) {
        php.writeFile(
          `${documentRoot}/index.php`,
          '<?php header("Content-Type: application/json"); echo json_encode(["php" => PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION, "sqlite" => extension_loaded("pdo_sqlite")]);'
        );
      },
      getFileNotFoundAction() {
        return { type: 'internal-redirect', uri: '/index.php' };
      },
    };

    const instance = await startPlayground({
      adapter: testAdapter,
      port: 0,
      quiet: true,
    });

    try {
      const response = await fetch(`${instance.url}/hello-world`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.php, '8.4');
      assert.equal(data.sqlite, true);
    } finally {
      await instance.close();
    }
  });

  it('runs a blueprint headlessly and builds a zip snapshot with mountsBeforeInstall', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-test-'));
    const preMountDir = join(workDir, 'pre');
    const bpPath = join(workDir, 'blueprint.json');
    const snapPath = join(workDir, 'out.zip');

    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(preMountDir, { recursive: true });
      writeFileSync(join(preMountDir, 'flag.txt'), 'pre-install-ok');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            { step: 'writeFile', path: 'hello.txt', data: 'from-blueprint' },
            { step: 'runPHP', code: 'file_put_contents("generated.txt", file_get_contents("hello.txt") . ":php");' },
          ],
        })
      );

      let sawPreMountDuringConfigure = false;
      const testAdapter = {
        name: 'test-snap',
        label: 'Test Snap',
        defaultPhp: '8.4',
        supportedPhp: ['8.4'],
        defaultVersion: '1.0',
        adminPath: '/',
        async resolveBundle() {
          return { version: '1.0' };
        },
        async configure({ php, documentRoot }) {
          sawPreMountDuringConfigure = php.fileExists(`${documentRoot}/pre/flag.txt`);
          php.writeFile(`${documentRoot}/index.php`, '<?php echo "ok";');
        },
        getFileNotFoundAction() {
          return { type: '404' };
        },
      };

      const bpResult = await runBlueprintHeadless({
        adapter: testAdapter,
        blueprintSource: bpPath,
        mountsBeforeInstall: [{ hostPath: preMountDir, vfsPath: '/var/www/html/pre' }],
        quiet: true,
      });

      assert.equal(sawPreMountDuringConfigure, true);
      assert.equal(bpResult.stepsRun, 2);

      const snapResult = await buildSnapshot({
        adapter: testAdapter,
        blueprintSource: bpPath,
        outputPath: snapPath,
        quiet: true,
      });

      assert.equal(existsSync(snapPath), true);
      assert.ok(snapResult.bytes > 0);
      // Zip magic bytes PK\x03\x04
      const magic = readFileSync(snapPath).subarray(0, 4);
      assert.deepEqual(Array.from(magic), [0x50, 0x4b, 0x03, 0x04]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('rejects Zip Slip entries in unpackZip while extracting valid archives', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });

    const makeZip = async (entries) => {
      php.writeFile('/tmp/make-zip.json', JSON.stringify(entries));
      await runPhpCode(
        php,
        `
        $entries = json_decode(file_get_contents('/tmp/make-zip.json'), true);
        unlink('/tmp/make-zip.json');
        $zip = new ZipArchive();
        $zip->open('/tmp/test.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE);
        foreach ($entries as $name => $content) {
            $zip->addFromString($name, $content);
        }
        $zip->close();
        `
      );
      const bytes = php.readFileAsBuffer('/tmp/test.zip');
      php.unlink('/tmp/test.zip');
      return bytes;
    };

    try {
      for (const badPath of ['../evil.txt', 'sub/../../evil.txt', '..\\evil.txt', '/etc/evil.txt', 'C:/evil.txt']) {
        const badZip = await makeZip({ [badPath]: 'pwned' });
        await assert.rejects(
          () => unpackZip(php, badZip, '/var/www/html/extract-target'),
          /Unsafe zip entry path/
        );
      }

      assert.equal(php.fileExists('/var/www/html/evil.txt'), false);

      const goodZip = await makeZip({ 'nested/ok.txt': 'safe-content' });
      await unpackZip(php, goodZip, '/var/www/html/extract-target');
      assert.equal(php.readFileAsText('/var/www/html/extract-target/nested/ok.txt'), 'safe-content');
    } finally {
      php.exit();
    }
  });

  it('binds port 0 before bootSite so adapter.configure receives the bound URL, and omits body on HEAD', async () => {
    let configuredUrl = null;
    const testAdapter = {
      name: 'test-port-zero',
      label: 'Test Port Zero',
      defaultPhp: '8.4',
      supportedPhp: ['8.4'],
      defaultVersion: '1.0',
      adminPath: '/',
      async resolveBundle() {
        return { version: '1.0' };
      },
      async configure({ php, documentRoot, url }) {
        configuredUrl = url;
        php.writeFile(`${documentRoot}/index.php`, `<?php echo ${JSON.stringify(url)};`);
      },
      getFileNotFoundAction() {
        return { type: 'internal-redirect', uri: '/index.php' };
      },
    };

    const instance = await startPlayground({
      adapter: testAdapter,
      port: 0,
      quiet: true,
    });

    try {
      assert.ok(instance.port > 0);
      assert.equal(configuredUrl, instance.url);
      assert.ok(!configuredUrl.endsWith(':0'));

      const headRes = await fetch(`${instance.url}/`, { method: 'HEAD' });
      assert.equal(headRes.status, 200);
      assert.equal(await headRes.text(), '');
    } finally {
      await instance.close();
    }
  });

  it('supports local file:// unzip in local blueprints and blocks file:// from remote blueprints', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-bp-unzip-'));
    const zipPath = join(workDir, 'asset.zip');
    const bpPath = join(workDir, 'blueprint.json');

    try {
      // Create a valid zip file using PHP ZipArchive.
      const php = await bootPhp({ phpVersion: '8.4' });
      try {
        await runPhpCode(
          php,
          `
          $zip = new ZipArchive();
          $zip->open('/tmp/asset.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE);
          $zip->addFromString('from-local.txt', 'local-zip-ok');
          $zip->close();
          `
        );
        writeFileSync(zipPath, php.readFileAsBuffer('/tmp/asset.zip'));
      } finally {
        php.exit();
      }

      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            { step: 'unzip', url: './asset.zip', to: 'extracted' },
            {
              step: 'runPHP',
              code: 'if (file_get_contents("extracted/from-local.txt") !== "local-zip-ok") { exit(1); }',
            },
          ],
        })
      );

      const testAdapter = {
        name: 'test-unzip',
        label: 'Test Unzip',
        defaultPhp: '8.4',
        supportedPhp: ['8.4'],
        defaultVersion: '1.0',
        adminPath: '/',
        async resolveBundle() {
          return { version: '1.0' };
        },
        async configure() {},
        getFileNotFoundAction() {
          return { type: '404' };
        },
      };

      const result = await runBlueprintHeadless({
        adapter: testAdapter,
        blueprintSource: bpPath,
        quiet: true,
      });
      assert.equal(result.stepsRun, 2);

      // Remote blueprint baseUrl must NOT be allowed to read file:// URLs.
      await assert.rejects(
        () =>
          CORE_STEPS.unzip(
            { url: `file://${zipPath}` },
            { baseUrl: 'https://example.com/blueprint.json', documentRoot: '/var/www/html' }
          ),
        /non-local blueprint/
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('validates resolveVfsPath and loadBlueprint inputs', async () => {
    assert.equal(resolveVfsPath('/var/www/html', 'foo/bar.txt'), '/var/www/html/foo/bar.txt');
    assert.equal(resolveVfsPath('/var/www/html', '/leading.txt'), '/var/www/html/leading.txt');

    for (const bad of [null, undefined, 123, '', '/', '///', 'a\\b', 'a\0b', '../secret', 'a/../../b']) {
      assert.throws(() => resolveVfsPath('/var/www/html', bad), /Invalid path/);
    }

    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-bp-val-'));
    try {
      const arrayBp = join(workDir, 'array.json');
      const badStepsBp = join(workDir, 'bad-steps.json');
      writeFileSync(arrayBp, '[]');
      writeFileSync(badStepsBp, JSON.stringify({ steps: 'not-an-array' }));

      await assert.rejects(() => loadBlueprint(arrayBp), /expected a JSON object/);
      await assert.rejects(() => loadBlueprint(badStepsBp), /"steps" must be an array/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('validates --site before booting PHP and cleans up resources on configure failure', async () => {
    let resolveBundleCalled = false;
    const missingSiteAdapter = {
      name: 'test-missing-site',
      label: 'Test Missing Site',
      defaultPhp: '8.4',
      supportedPhp: ['8.4'],
      defaultVersion: '1.0',
      adminPath: '/',
      async resolveBundle() {
        resolveBundleCalled = true;
        return { version: '1.0' };
      },
      async configure() {},
      getFileNotFoundAction() {
        return { type: '404' };
      },
    };

    await assert.rejects(
      () =>
        startPlayground({
          adapter: missingSiteAdapter,
          site: '/nonexistent/cms-playground-site-dir',
          port: 0,
          quiet: true,
        }),
      /Site directory does not exist/
    );
    assert.equal(resolveBundleCalled, false);

    // Failure inside adapter.configure must clean up PHP and close the bound server.
    let phpRef = null;
    let exitCalled = false;
    const failingAdapter = {
      ...missingSiteAdapter,
      name: 'test-fail-configure',
      async configure({ php }) {
        phpRef = php;
        const origExit = php.exit.bind(php);
        php.exit = (...args) => {
          exitCalled = true;
          return origExit(...args);
        };
        throw new Error('boom during configure');
      },
    };

    await assert.rejects(
      () => startPlayground({ adapter: failingAdapter, port: 0, quiet: true }),
      /boom during configure/
    );
    assert.ok(phpRef !== null);
    assert.equal(exitCalled, true);
  });

  it('reuses bootSite in runCmsCli for supportedPhp, --site validation, and mountsBeforeInstall', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-cli-'));
    const preMountDir = join(workDir, 'pre');

    try {
      mkdirSync(preMountDir, { recursive: true });
      writeFileSync(join(preMountDir, 'msg.txt'), 'cli-pre-mount');

      const cliAdapter = {
        name: 'test-cli',
        label: 'Test CLI',
        defaultPhp: '8.4',
        supportedPhp: ['8.4'],
        defaultVersion: '1.0',
        cliEntrypoint: 'cli.php',
        async resolveBundle() {
          return { version: '1.0' };
        },
        async configure({ php, documentRoot }) {
          php.writeFile(
            `${documentRoot}/cli.php`,
            '<?php echo file_get_contents(__DIR__ . "/pre/msg.txt") . ":" . implode(",", array_slice($argv, 1));'
          );
        },
        getFileNotFoundAction() {
          return { type: '404' };
        },
      };

      await assert.rejects(
        () => runCmsCli({ adapter: cliAdapter, phpVersion: '7.4', quiet: true }),
        /does not support PHP 7\.4/
      );

      await assert.rejects(
        () => runCmsCli({ adapter: cliAdapter, site: '/nonexistent/cli-site-dir', quiet: true }),
        /Site directory does not exist/
      );

      const res = await runCmsCli({
        adapter: cliAdapter,
        args: ['hello', 'world'],
        mountsBeforeInstall: [{ hostPath: preMountDir, vfsPath: '/var/www/html/pre' }],
        quiet: true,
      });

      assert.equal(res.exitCode, 0);
      assert.equal(res.stdout, 'cli-pre-mount:hello,world');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('uses CMS_PLAYGROUND_CACHE_DIR directly and enforces downloadToCache timeout', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-cache-'));
    const prevEnv = process.env.CMS_PLAYGROUND_CACHE_DIR;

    try {
      process.env.CMS_PLAYGROUND_CACHE_DIR = workDir;
      const dir = getCacheDir('joomla');
      assert.equal(dir, join(workDir, 'joomla'));

      // Local HTTP server that stalls on /slow and succeeds on /ok
      const server = http.createServer((req, res) => {
        if (req.url === '/ok') {
          res.statusCode = 200;
          res.end('cached-payload');
          return;
        }
        // Intentionally hang for /slow until aborted
      });

      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();

      try {
        const okDest = join(workDir, 'ok.txt');
        await downloadToCache(`http://127.0.0.1:${port}/ok`, okDest);
        assert.equal(readFileSync(okDest, 'utf8'), 'cached-payload');

        const slowDest = join(workDir, 'slow.txt');
        await assert.rejects(
          () => downloadToCache(`http://127.0.0.1:${port}/slow`, slowDest, { timeoutMs: 100 }),
          (err) => err.name === 'TimeoutError' || err.name === 'AbortError'
        );
        assert.equal(existsSync(slowDest), false);
      } finally {
        await new Promise((r) => {
          server.close(() => r());
          server.closeAllConnections?.();
        });
      }

      // randomPassword sanity check
      const pw = randomPassword(16);
      assert.equal(pw.length, 16);
      assert.match(pw, /^[a-zA-Z0-9]+$/);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.CMS_PLAYGROUND_CACHE_DIR;
      } else {
        process.env.CMS_PLAYGROUND_CACHE_DIR = prevEnv;
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
