import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAdapter, listAdapters, parseMountSpec, registerAdapter, startPlayground } from '../src/index.js';

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
});
