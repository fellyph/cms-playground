import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { bootPhp, packZip } from '@cms-playground/core';
import { detectWordPressAutoMount, validateWpVersion, wordpressAdapter, wpDownloadUrl } from '../src/index.js';

describe('@cms-playground/wordpress', () => {
  it('builds WordPress download URLs and rejects invalid versions', () => {
    assert.equal(wpDownloadUrl(null), 'https://wordpress.org/latest.zip');
    assert.equal(wpDownloadUrl('latest'), 'https://wordpress.org/latest.zip');
    assert.equal(wpDownloadUrl('default'), 'https://wordpress.org/latest.zip');
    assert.equal(wpDownloadUrl('6.7.2'), 'https://wordpress.org/wordpress-6.7.2.zip');
    assert.equal(wpDownloadUrl('6.8-RC1'), 'https://wordpress.org/wordpress-6.8-RC1.zip');

    assert.throws(() => validateWpVersion('../../tmp/evil'), /Invalid WordPress version/);
    assert.throws(() => wpDownloadUrl('../evil'), /Invalid WordPress version/);
    assert.throws(() => validateWpVersion('6.7/evil'), /Invalid WordPress version/);
    assert.throws(() => validateWpVersion('6.7 evil'), /Invalid WordPress version/);
  });

  it('routes non-PHP paths to /index.php and missing .php files to 404', () => {
    assert.deepEqual(wordpressAdapter.getFileNotFoundAction('/sample-post/'), { type: 'internal-redirect', uri: '/index.php' });
    assert.deepEqual(wordpressAdapter.getFileNotFoundAction('/missing.php'), { type: '404' });
  });

  it('preserves backreference characters in defineWpConfigConsts', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    const documentRoot = '/var/www/html';

    try {
      php.writeFile(`${documentRoot}/wp-config.php`, "<?php\ndefine('WP_DEBUG', false);\n");

      await wordpressAdapter.blueprintSteps.defineWpConfigConsts(
        { consts: { MY_SECRET: 'val-$0-$1-\\1' } },
        { php, documentRoot }
      );

      const updated = php.readFileAsText(`${documentRoot}/wp-config.php`);
      assert.ok(updated.includes("define('MY_SECRET', 'val-$0-$1-\\\\1');"), `Unexpected wp-config.php: ${updated}`);
      // Ensure the original <?php tag was not duplicated or corrupted by $0 expansion
      assert.equal(updated.startsWith('<?php\nif (!defined(\'MY_SECRET\'))'), true);
    } finally {
      php.exit();
    }
  });

  it('detects WordPress plugin, theme, and wp-content directories for --auto-mount', () => {
    const root = mkdtempSync(join(tmpdir(), 'wp-automount-'));

    try {
      const pluginDir = join(root, 'my-plugin');
      mkdirSync(pluginDir);
      writeFileSync(join(pluginDir, 'my-plugin.php'), '<?php\n/*\n * Plugin Name: My Plugin\n */\n');
      const plugin = detectWordPressAutoMount(pluginDir);
      assert.equal(plugin.kind, 'wp-plugin');
      assert.equal(plugin.pluginFile, 'my-plugin.php');
      assert.equal(plugin.mounts[0].vfsPath, '/var/www/html/wp-content/plugins/my-plugin');

      const themeDir = join(root, 'my-theme');
      mkdirSync(themeDir);
      writeFileSync(join(themeDir, 'style.css'), '/*\nTheme Name: My Theme\n*/\n');
      const theme = detectWordPressAutoMount(themeDir);
      assert.equal(theme.kind, 'wp-theme');
      assert.equal(theme.mounts[0].vfsPath, `/var/www/html/wp-content/themes/${basename(themeDir)}`);

      const contentDir = join(root, 'wp-content');
      mkdirSync(join(contentDir, 'plugins'), { recursive: true });
      const wpContent = detectWordPressAutoMount(contentDir);
      assert.equal(wpContent.kind, 'wp-content');
      assert.equal(wpContent.mounts[0].vfsPath, '/var/www/html/wp-content');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans up /tmp/wp-extract, generates auth salts, and avoids trailing colon in HTTP_HOST', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    const documentRoot = '/var/www/html';

    try {
      // Simulate extracted WordPress archive under /tmp/wp-extract/wordpress
      php.mkdir('/tmp/wp-extract/wordpress/wp-admin/includes');
      php.writeFile(
        '/tmp/wp-extract/wordpress/wp-load.php',
        `<?php
        define('ABSPATH', __DIR__ . '/');
        file_put_contents('/tmp/captured-server.json', json_encode([
            'HTTP_HOST' => $_SERVER['HTTP_HOST'],
            'SERVER_NAME' => $_SERVER['SERVER_NAME'],
            'SERVER_PORT' => $_SERVER['SERVER_PORT'],
        ]));
        `
      );
      php.writeFile(
        '/tmp/wp-extract/wordpress/wp-admin/includes/upgrade.php',
        '<?php function is_blog_installed() { return true; }'
      );

      await wordpressAdapter.configure({
        php,
        documentRoot,
        url: 'https://example.test',
        password: 'secret-password',
        site: null,
        bundle: {},
      });

      // /tmp/wp-extract should be removed
      assert.equal(php.fileExists('/tmp/wp-extract'), false);

      // Generated wp-config.php should contain all 8 non-empty auth keys & salts
      const wpConfig = php.readFileAsText(`${documentRoot}/wp-config.php`);
      for (const key of [
        'AUTH_KEY',
        'SECURE_AUTH_KEY',
        'LOGGED_IN_KEY',
        'NONCE_KEY',
        'AUTH_SALT',
        'SECURE_AUTH_SALT',
        'LOGGED_IN_SALT',
        'NONCE_SALT',
      ]) {
        assert.match(wpConfig, new RegExp(`define\\('${key}', '[0-9a-f]{64}'\\);`));
      }

      // HTTP_HOST must not have a trailing colon and SERVER_PORT defaults to 443 for https
      const serverVars = JSON.parse(php.readFileAsText('/tmp/captured-server.json'));
      assert.equal(serverVars.HTTP_HOST, 'example.test');
      assert.equal(serverVars.SERVER_NAME, 'example.test');
      assert.equal(serverVars.SERVER_PORT, '443');
    } finally {
      php.exit();
    }
  });

  it('installs sqlite drop-in, preserves existing wp-config.php, and executes setSiteOption & activatePlugin steps', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    const documentRoot = '/var/www/html';

    try {
      // Build a minimal sqlite-database-integration plugin zip
      php.mkdir('/tmp/sqlite-plugin-src/sqlite-database-integration');
      php.writeFile(
        '/tmp/sqlite-plugin-src/sqlite-database-integration/db.copy',
        '<?php // PATH={SQLITE_IMPLEMENTATION_FOLDER_PATH} PLUGIN={SQLITE_PLUGIN}'
      );
      const sqliteZipBytes = await packZip(php, '/tmp/sqlite-plugin-src');

      // Pre-existing wp-config.php should not be overwritten
      php.writeFile(`${documentRoot}/wp-config.php`, '<?php // custom-existing-config\n');
      php.mkdir(`${documentRoot}/wp-admin/includes`);
      php.writeFile(
        `${documentRoot}/wp-load.php`,
        `<?php
        if (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }
        function update_option($k, $v) {
            file_put_contents('/tmp/wp-opt-result.json', json_encode([$k => $v]));
        }
        `
      );
      php.writeFile(
        `${documentRoot}/wp-admin/includes/plugin.php`,
        `<?php
        class MockWpError {
            public function __construct(private string $msg) {}
            public function get_error_message(): string { return $this->msg; }
        }
        function is_wp_error($thing): bool { return $thing instanceof MockWpError; }
        function activate_plugin($path) {
            if ($path === 'broken/plugin.php') {
                return new MockWpError('plugin activation failed');
            }
            file_put_contents('/tmp/wp-activated.txt', $path);
            return null;
        }
        `
      );

      const info = await wordpressAdapter.configure({
        php,
        documentRoot,
        url: 'http://127.0.0.1:8790',
        password: 'pw',
        site: '/tmp/local-wp-site',
        bundle: { sqliteZipBytes },
      });

      assert.equal(info.username, 'admin');
      assert.equal(info.password, '(unchanged)');
      assert.equal(php.readFileAsText(`${documentRoot}/wp-config.php`), '<?php // custom-existing-config\n');

      const dbDropIn = php.readFileAsText(`${documentRoot}/wp-content/db.php`);
      assert.ok(dbDropIn.includes(`${documentRoot}/wp-content/plugins/sqlite-database-integration`));
      assert.ok(dbDropIn.includes('sqlite-database-integration/load.php'));

      // Blueprint step: setSiteOption
      await wordpressAdapter.blueprintSteps.setSiteOption(
        { option: 'blogname', value: 'My Playground' },
        { php, documentRoot }
      );
      assert.deepEqual(JSON.parse(php.readFileAsText('/tmp/wp-opt-result.json')), { blogname: 'My Playground' });

      // Blueprint step: activatePlugin (success + WP_Error)
      await wordpressAdapter.blueprintSteps.activatePlugin(
        { pluginPath: 'hello-dolly/hello.php' },
        { php, documentRoot }
      );
      assert.equal(php.readFileAsText('/tmp/wp-activated.txt'), 'hello-dolly/hello.php');

      await assert.rejects(
        () =>
          wordpressAdapter.blueprintSteps.activatePlugin(
            { pluginPath: 'broken/plugin.php' },
            { php, documentRoot }
          ),
        /plugin activation failed/
      );
    } finally {
      php.exit();
    }
  });
});
