import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bootPhp } from '@cms-playground/core';
import {
  detectTypo3AutoMount,
  typo3Adapter,
  typo3DownloadUrl,
  validateTypo3Version,
} from '../src/index.js';

describe('@cms-playground/typo3', () => {
  it('builds TYPO3 download URLs and rejects invalid versions', () => {
    assert.equal(validateTypo3Version(null), '13');
    assert.equal(validateTypo3Version('latest'), '13');
    assert.equal(validateTypo3Version('13.4.40'), '13.4.40');
    assert.equal(typo3DownloadUrl('13'), 'https://get.typo3.org/13/zip');
    assert.equal(typo3DownloadUrl('13.4.40'), 'https://get.typo3.org/13.4.40/zip');
    assert.throws(() => typo3DownloadUrl('../evil'), /Invalid TYPO3 version/);
  });

  it('routes non-PHP paths to /index.php and missing .php files to 404', () => {
    assert.deepEqual(typo3Adapter.getFileNotFoundAction('/typo3'), {
      type: 'internal-redirect',
      uri: '/index.php',
    });
    assert.deepEqual(typo3Adapter.getFileNotFoundAction('/typo3/login'), {
      type: 'internal-redirect',
      uri: '/index.php',
    });
    assert.deepEqual(typo3Adapter.getFileNotFoundAction('/missing.php'), { type: '404' });
  });

  it('requests the intl PHP extension and exposes the TYPO3 CLI entrypoint', () => {
    assert.ok(typo3Adapter.phpExtensions.includes('intl'));
    assert.equal(typo3Adapter.cliEntrypoint, 'typo3/sysext/core/bin/typo3');
  });

  it('updates TYPO3 sitename via setSiteName blueprint step', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    try {
      php.mkdir('/var/www/html/typo3conf/system');
      php.writeFile(
        '/var/www/html/typo3conf/system/settings.php',
        "<?php\nreturn ['SYS' => ['sitename' => 'Old TYPO3']];\n"
      );

      await typo3Adapter.blueprintSteps.setSiteName(
        { name: 'TYPO3 $1 Playground' },
        { php, documentRoot: '/var/www/html' }
      );

      const settings = php.readFileAsText('/var/www/html/typo3conf/system/settings.php');
      assert.match(settings, /TYPO3 \$1 Playground/);
    } finally {
      php.exit();
    }
  });

  it('detects TYPO3 extensions via composer.json or ext_emconf.php for --auto-mount', () => {
    const root = mkdtempSync(join(tmpdir(), 'cms-playground-typo3-am-'));

    try {
      const extDir = join(root, 'my-sitepackage');
      mkdirSync(extDir);
      writeFileSync(
        join(extDir, 'composer.json'),
        JSON.stringify({
          name: 'vendor/my-sitepackage',
          type: 'typo3-cms-extension',
          extra: { 'typo3/cms': { 'extension-key': 'my_sitepackage' } },
        })
      );
      const res = detectTypo3AutoMount(extDir);
      assert.equal(res.kind, 'typo3-extension');
      assert.equal(res.slug, 'my_sitepackage');
      assert.equal(res.mounts[0].vfsPath, '/var/www/html/typo3conf/ext/my_sitepackage');

      const emconfDir = join(root, 'legacy_ext');
      mkdirSync(emconfDir);
      writeFileSync(join(emconfDir, 'ext_emconf.php'), '<?php $EM_CONF[$_EXTKEY] = [];');
      const res2 = detectTypo3AutoMount(emconfDir);
      assert.equal(res2.kind, 'typo3-extension');
      assert.equal(res2.slug, 'legacy_ext');
      assert.equal(res2.mounts[0].vfsPath, '/var/www/html/typo3conf/ext/legacy_ext');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
