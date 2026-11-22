import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { bootPhp } from '@cms-playground/core';
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
});
