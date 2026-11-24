import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bootPhp, runPhpCode } from '@cms-playground/core';
import { detectJoomlaAutoMount, joomlaAdapter, matchJoomlaVersion } from '../src/index.js';

describe('@cms-playground/joomla', () => {
  const manifest = { default: '6.2.0', versions: ['6.2.0', '5.4.10'] };

  it('matches default, exact, and minor/major version prefixes', () => {
    assert.equal(matchJoomlaVersion(null, manifest), '6.2.0');
    assert.equal(matchJoomlaVersion('latest', manifest), '6.2.0');
    assert.equal(matchJoomlaVersion('5.4.10', manifest), '5.4.10');
    assert.equal(matchJoomlaVersion('5.4', manifest), '5.4.10');
    assert.equal(matchJoomlaVersion('5', manifest), '5.4.10');
  });

  it('throws on unknown Joomla version', () => {
    assert.throws(() => matchJoomlaVersion('4.4', manifest), /not available/);
  });

  it('routes site SEF URLs to /index.php and leaves /administrator and /api as 404', () => {
    assert.deepEqual(joomlaAdapter.getFileNotFoundAction('/about-us'), { type: 'internal-redirect', uri: '/index.php' });
    assert.deepEqual(joomlaAdapter.getFileNotFoundAction('/administrator/missing'), { type: '404' });
    assert.deepEqual(joomlaAdapter.getFileNotFoundAction('/api/missing'), { type: '404' });
  });

  it('hardens serveStatic against traversal, bad versions, and directory EISDIR', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cms-pg-joomla-static-'));

    try {
      mkdirSync(join(cacheDir, '6.2.0', 'media', 'system'), { recursive: true });
      writeFileSync(join(cacheDir, 'secret.txt'), 'do-not-read');
      writeFileSync(join(cacheDir, '6.2.0', 'media', 'system', 'app.css'), 'body{}');

      const bundle = { version: '6.2.0', mediaBaseUrl: 'http://127.0.0.1:1/joomla/6.2.0/' };

      // Traversal attempts (backslash, URL-encoded .., invalid bundle.version)
      assert.equal(
        await joomlaAdapter.serveStatic({ request: { url: '/media/..\\..\\secret.txt' }, bundle, cacheDir }),
        null
      );
      assert.equal(
        await joomlaAdapter.serveStatic({ request: { url: '/media/%2e%2e/%2e%2e/secret.txt' }, bundle, cacheDir }),
        null
      );
      assert.equal(
        await joomlaAdapter.serveStatic({
          request: { url: '/media/system/app.css' },
          bundle: { version: '../evil', mediaBaseUrl: bundle.mediaBaseUrl },
          cacheDir,
        }),
        null
      );

      // Existing directory should return null instead of throwing EISDIR
      assert.equal(
        await joomlaAdapter.serveStatic({ request: { url: '/media/system' }, bundle, cacheDir }),
        null
      );
      assert.equal(
        await joomlaAdapter.serveStatic({ request: { url: '/media/system/' }, bundle, cacheDir }),
        null
      );

      // Valid cached file is served properly
      const hit = await joomlaAdapter.serveStatic({ request: { url: '/media/system/app.css' }, bundle, cacheDir });
      assert.equal(hit.status, 200);
      assert.equal(Buffer.from(hit.body).toString('utf8'), 'body{}');
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('preserves backreference characters and validates keys in setGlobalConfig', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    const documentRoot = '/var/www/html';

    try {
      php.writeFile(
        `${documentRoot}/configuration.php`,
        "<?php\nclass JConfig {\n\tpublic $sitename = 'Old';\n}\n"
      );

      await joomlaAdapter.blueprintSteps.setGlobalConfig(
        { values: { sitename: 'Price $0 / $1 \\\\1' } },
        { php, documentRoot }
      );

      const updated = php.readFileAsText(`${documentRoot}/configuration.php`);
      assert.ok(updated.includes("public $sitename = 'Price $0 / $1 \\\\\\\\1';"), `Unexpected config: ${updated}`);

      await assert.rejects(
        () => joomlaAdapter.blueprintSteps.setGlobalConfig({ values: { 'bad;key': 'x' } }, { php, documentRoot }),
        /Invalid Joomla configuration key/
      );
    } finally {
      php.exit();
    }
  });

  it('detects Joomla plugin, module, and component manifests for --auto-mount', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joomla-automount-'));

    try {
      writeFileSync(
        join(dir, 'hello.xml'),
        '<extension type="plugin" group="content"><name>plg_content_hello</name><files><filename plugin="hello">hello.php</filename></files></extension>'
      );
      const plg = detectJoomlaAutoMount(dir);
      assert.equal(plg.kind, 'joomla-plugin');
      assert.equal(plg.element, 'hello');
      assert.equal(plg.mounts[0].vfsPath, '/var/www/html/plugins/content/hello');

      writeFileSync(
        join(dir, 'hello.xml'),
        '<extension type="module" client="administrator"><name>mod_quick</name><files><filename module="mod_quick">mod_quick.php</filename></files></extension>'
      );
      const mod = detectJoomlaAutoMount(dir);
      assert.equal(mod.kind, 'joomla-module');
      assert.equal(mod.mounts[0].vfsPath, '/var/www/html/administrator/modules/mod_quick');

      writeFileSync(join(dir, 'hello.xml'), '<extension type="component"><name>weblinks</name></extension>');
      const com = detectJoomlaAutoMount(dir);
      assert.equal(com.kind, 'joomla-component');
      assert.equal(com.element, 'com_weblinks');
      assert.equal(com.mounts[0].vfsPath, '/var/www/html/components/com_weblinks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads $dbprefix dynamically from configuration.php when resetting admin password', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    const documentRoot = '/var/www/html';

    try {
      php.mkdir(`${documentRoot}/data`);
      php.writeFile(
        `${documentRoot}/configuration.php`,
        [
          '<?php',
          'class JConfig {',
          "\tpublic $dbprefix = 'custom_';",
          "\tpublic $live_site = '';",
          "\tpublic $tmp_path = '';",
          "\tpublic $log_path = '';",
          '}',
        ].join('\n')
      );

      // Create SQLite database with custom_users table
      const { runPhpCode } = await import('@cms-playground/core');
      await runPhpCode(
        php,
        `
        $db = new PDO('sqlite:${documentRoot}/data/joomla.sqlite');
        $db->exec("CREATE TABLE custom_users (username TEXT, password TEXT)");
        $db->exec("INSERT INTO custom_users (username, password) VALUES ('admin', 'old-hash')");
        `
      );

      await joomlaAdapter.configure({
        php,
        documentRoot,
        url: 'http://127.0.0.1:8790',
        password: 'new-secret-password',
        site: null,
      });

      const res = await runPhpCode(
        php,
        `
        $db = new PDO('sqlite:${documentRoot}/data/joomla.sqlite');
        $hash = $db->query("SELECT password FROM custom_users WHERE username = 'admin'")->fetchColumn();
        echo password_verify('new-secret-password', $hash) ? 'VERIFIED' : 'FAILED';
        `
      );
      assert.equal(res.text.trim(), 'VERIFIED');
    } finally {
      php.exit();
    }
  });

  it('fetches, caches, and serves remote /media/* assets via serveStatic and returns null on 404 or non-media', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cms-pg-joomla-remote-static-'));
    let remoteHits = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/joomla/6.2.0/media/system/js/core.js') {
        remoteHits += 1;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.end('console.log("joomla");');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const mediaBaseUrl = `http://127.0.0.1:${server.address().port}/joomla/6.2.0/`;
    const bundle = { version: '6.2.0', mediaBaseUrl };

    try {
      // Non-/media/ paths return null immediately
      assert.equal(
        await joomlaAdapter.serveStatic({ request: { url: '/index.php' }, bundle, cacheDir }),
        null
      );

      // First /media/ request fetches from remote and caches to disk
      const first = await joomlaAdapter.serveStatic({
        request: { url: '/media/system/js/core.js' },
        bundle,
        cacheDir,
      });
      assert.equal(first.status, 200);
      assert.equal(Buffer.from(first.body).toString('utf8'), 'console.log("joomla");');
      assert.equal(remoteHits, 1);
      assert.equal(existsSync(join(cacheDir, '6.2.0', 'media', 'system', 'js', 'core.js')), true);

      // Second request is served from disk cache without hitting remote server
      const second = await joomlaAdapter.serveStatic({
        request: { url: '/media/system/js/core.js' },
        bundle,
        cacheDir,
      });
      assert.equal(second.status, 200);
      assert.equal(remoteHits, 1);

      // Remote 404 returns null (falls back to PHP-WASM)
      assert.equal(
        await joomlaAdapter.serveStatic({ request: { url: '/media/missing.css' }, bundle, cacheDir }),
        null
      );
    } finally {
      await new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('throws when configuration.php is missing and updates config paths without resetting password for --site', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    const documentRoot = '/var/www/html';

    try {
      await assert.rejects(
        () =>
          joomlaAdapter.configure({
            php,
            documentRoot,
            url: 'http://127.0.0.1:8790',
            password: 'pw',
            site: null,
          }),
        /configuration\.php not found/
      );

      php.writeFile(
        `${documentRoot}/configuration.php`,
        [
          '<?php',
          'class JConfig {',
          "\tpublic $live_site = '';",
          "\tpublic $tmp_path = '/old/tmp';",
          "\tpublic $log_path = '/old/logs';",
          "\tpublic $debug = false;",
          "\tpublic $offset = 0;",
          '}',
        ].join('\n')
      );

      const info = await joomlaAdapter.configure({
        php,
        documentRoot,
        url: 'http://127.0.0.1:9999',
        password: 'pw',
        site: '/tmp/local-site',
      });
      assert.equal(info.username, 'admin');
      assert.equal(info.password, '(unchanged)');

      const cfg = php.readFileAsText(`${documentRoot}/configuration.php`);
      assert.ok(cfg.includes("public $live_site = 'http://127.0.0.1:9999';"));
      assert.ok(cfg.includes("public $tmp_path = '/var/www/html/tmp';"));
      assert.ok(cfg.includes("public $log_path = '/var/www/html/administrator/logs';"));

      await joomlaAdapter.blueprintSteps.setGlobalConfig(
        { values: { debug: true, offset: 42 } },
        { php, documentRoot }
      );
      const updated = php.readFileAsText(`${documentRoot}/configuration.php`);
      assert.ok(updated.includes('public $debug = true;'));
      assert.ok(updated.includes('public $offset = 42;'));
    } finally {
      php.exit();
    }
  });

  it('detects Joomla site template manifests for --auto-mount with postMount hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joomla-tpl-automount-'));

    try {
      writeFileSync(
        join(dir, 'templateDetails.xml'),
        '<extension type="template" client="site" version="6.0" method="upgrade"><name>my_tpl</name></extension>'
      );
      const tpl = detectJoomlaAutoMount(dir);
      assert.equal(tpl.kind, 'joomla-template');
      assert.equal(tpl.element, 'my_tpl');
      assert.equal(tpl.mounts[0].vfsPath, '/var/www/html/templates/my_tpl');
      assert.equal(typeof tpl.postMount, 'function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
