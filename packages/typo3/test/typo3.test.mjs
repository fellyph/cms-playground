import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bootPhp } from '@cms-playground/core';
import {
  detectTypo3AutoMount,
  ensureTypo3Password,
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

  it('ensures generated passwords satisfy TYPO3 13 password policy', () => {
    const fromAlnum = ensureTypo3Password('Abcdef123456');
    assert.ok(fromAlnum.length >= 8);
    assert.match(fromAlnum, /[a-z]/);
    assert.match(fromAlnum, /[A-Z]/);
    assert.match(fromAlnum, /[0-9]/);
    assert.match(fromAlnum, /[^A-Za-z0-9]/);

    const fromShortLower = ensureTypo3Password('abc');
    assert.ok(fromShortLower.length >= 8);
    assert.match(fromShortLower, /[a-z]/);
    assert.match(fromShortLower, /[A-Z]/);
    assert.match(fromShortLower, /[0-9]/);
    assert.match(fromShortLower, /[^A-Za-z0-9]/);

    const alreadyValid = 'Str0ng!Pass';
    assert.equal(ensureTypo3Password(alreadyValid), alreadyValid);
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

  it('executes SQL against the configured SQLite database via runSql blueprint step', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    try {
      php.mkdir('/var/www/html/typo3conf/system');
      php.writeFile(
        '/var/www/html/typo3conf/system/settings.php',
        "<?php\nreturn ['DB' => ['Connections' => ['Default' => ['driver' => 'pdo_sqlite', 'path' => '/var/www/html/typo3conf/cms-test1234.sqlite']]]];\n"
      );

      await typo3Adapter.blueprintSteps.runSql(
        { sql: "CREATE TABLE pages (uid INTEGER PRIMARY KEY, title TEXT); INSERT INTO pages (uid, title) VALUES (1, 'Home');" },
        { php, documentRoot: '/var/www/html' }
      );

      const res = await php.run({
        code: "<?php $db = new PDO('sqlite:/var/www/html/typo3conf/cms-test1234.sqlite'); echo $db->query('SELECT title FROM pages WHERE uid = 1')->fetchColumn();",
      });
      assert.equal(res.text, 'Home');
    } finally {
      php.exit();
    }
  });

  it('activates auto-mounted TYPO3 extensions in PackageStates.php via postMount', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cms-playground-typo3-pm-'));
    const php = await bootPhp({ phpVersion: '8.4' });

    try {
      const extDir = join(root, 'my_ext');
      mkdirSync(extDir);
      writeFileSync(join(extDir, 'ext_emconf.php'), '<?php $EM_CONF[$_EXTKEY] = [];');

      const res = detectTypo3AutoMount(extDir);
      assert.equal(typeof res.postMount, 'function');

      php.mkdir('/var/www/html/typo3conf');
      php.writeFile(
        '/var/www/html/typo3conf/PackageStates.php',
        "<?php\nreturn ['packages' => ['core' => ['packagePath' => 'typo3/sysext/core/']], 'version' => 5];\n"
      );

      await res.postMount({ php, documentRoot: '/var/www/html' });

      const updated = php.readFileAsText('/var/www/html/typo3conf/PackageStates.php');
      assert.match(updated, /'my_ext'/);
      assert.match(updated, /typo3conf\/ext\/my_ext\//);
    } finally {
      php.exit();
      rmSync(root, { recursive: true, force: true });
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
