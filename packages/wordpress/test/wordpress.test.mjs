import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootPhp } from '@cms-playground/core';
import { validateWpVersion, wordpressAdapter, wpDownloadUrl } from '../src/index.js';

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
});
