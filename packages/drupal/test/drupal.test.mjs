import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  detectDrupalAutoMount,
  drupalAdapter,
  drupalDownloadUrl,
  validateDrupalVersion,
} from '../src/index.js';

describe('@cms-playground/drupal', () => {
  it('builds Drupal download URLs and rejects invalid versions', () => {
    assert.equal(validateDrupalVersion(null), 'latest');
    assert.equal(validateDrupalVersion('11.4.13'), '11.4.13');
    assert.equal(drupalDownloadUrl('latest'), 'https://www.drupal.org/download-latest/zip');
    assert.equal(drupalDownloadUrl('11.4.13'), 'https://ftp.drupal.org/files/projects/drupal-11.4.13.zip');
    assert.throws(() => drupalDownloadUrl('../evil'), /Invalid Drupal version/);
  });

  it('routes non-PHP paths to /index.php and missing .php files to 404', () => {
    assert.deepEqual(drupalAdapter.getFileNotFoundAction('/user/login'), {
      type: 'internal-redirect',
      uri: '/index.php',
    });
    assert.deepEqual(drupalAdapter.getFileNotFoundAction('/node/1'), {
      type: 'internal-redirect',
      uri: '/index.php',
    });
    assert.deepEqual(drupalAdapter.getFileNotFoundAction('/missing.php'), { type: '404' });
  });

  it('requests the intl PHP extension', () => {
    assert.ok(drupalAdapter.phpExtensions.includes('intl'));
  });

  it('detects Drupal module and theme *.info.yml manifests for --auto-mount', () => {
    const root = mkdtempSync(join(tmpdir(), 'cms-playground-drupal-am-'));

    try {
      const modDir = join(root, 'hello_world');
      mkdirSync(modDir);
      writeFileSync(
        join(modDir, 'hello_world.info.yml'),
        "name: Hello World\ntype: module\ncore_version_requirement: ^11\n"
      );
      const modRes = detectDrupalAutoMount(modDir);
      assert.equal(modRes.kind, 'drupal-module');
      assert.equal(modRes.slug, 'hello_world');
      assert.equal(modRes.mounts[0].vfsPath, '/var/www/html/modules/custom/hello_world');
      assert.equal(typeof modRes.postMount, 'function');

      const themeDir = join(root, 'my_theme');
      mkdirSync(themeDir);
      writeFileSync(
        join(themeDir, 'my_theme.info.yml'),
        "name: My Theme\ntype: theme\nbase theme: stark\ncore_version_requirement: ^11\n"
      );
      const themeRes = detectDrupalAutoMount(themeDir);
      assert.equal(themeRes.kind, 'drupal-theme');
      assert.equal(themeRes.slug, 'my_theme');
      assert.equal(themeRes.mounts[0].vfsPath, '/var/www/html/themes/custom/my_theme');
      assert.equal(typeof themeRes.postMount, 'function');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
