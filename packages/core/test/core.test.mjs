import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildSnapshot,
  getAdapter,
  listAdapters,
  parseMountSpec,
  registerAdapter,
  runBlueprintHeadless,
  startPlayground,
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

  it('parses host:vfs mount specs and rejects malformed ones', () => {
    const parsed = parseMountSpec('./src:/var/www/html/plugins/system/test');

    assert.equal(parsed.vfsPath, '/var/www/html/plugins/system/test');
    assert.ok(parsed.hostPath.endsWith('/src'));

    assert.throws(() => parseMountSpec('no-colon'), /Invalid --mount/);
    assert.throws(() => parseMountSpec(':missing-host'), /Invalid --mount/);
    assert.throws(() => parseMountSpec('missing-vfs:'), /Invalid --mount/);
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
});
