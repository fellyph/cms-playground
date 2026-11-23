import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bootPhp } from '@cms-playground/core';
import {
  detectKirbyAutoMount,
  kirbyAdapter,
  kirbyDownloadUrl,
  validateKirbyVersion,
} from '../src/index.js';

describe('@cms-playground/kirby', () => {
  it('builds Kirby download URLs and rejects invalid versions', () => {
    assert.equal(validateKirbyVersion(null), 'latest');
    assert.equal(validateKirbyVersion('v5.6.4'), '5.6.4');
    assert.equal(
      kirbyDownloadUrl('latest'),
      'https://github.com/getkirby/starterkit/archive/refs/heads/main.zip'
    );
    assert.equal(
      kirbyDownloadUrl('5.6.4'),
      'https://github.com/getkirby/starterkit/archive/refs/tags/5.6.4.zip'
    );
    assert.throws(() => kirbyDownloadUrl('../evil'), /Invalid Kirby version/);
  });

  it('routes non-PHP paths to /index.php and missing .php files to 404', () => {
    assert.deepEqual(kirbyAdapter.getFileNotFoundAction('/panel'), {
      type: 'internal-redirect',
      uri: '/index.php',
    });
    assert.deepEqual(kirbyAdapter.getFileNotFoundAction('/notes/exploring-the-universe'), {
      type: 'internal-redirect',
      uri: '/index.php',
    });
    assert.deepEqual(kirbyAdapter.getFileNotFoundAction('/missing.php'), { type: '404' });
  });

  it('updates site title and creates pages via blueprint steps', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });
    try {
      php.mkdir('/var/www/html/content');
      php.writeFile('/var/www/html/content/site.txt', 'Title: Old Title\n\n----\n\nAuthor: Kirby\n');

      await kirbyAdapter.blueprintSteps.setSiteTitle(
        { title: 'Kirby $1 Playground' },
        { php, documentRoot: '/var/www/html' }
      );

      const siteTxt = php.readFileAsText('/var/www/html/content/site.txt');
      assert.match(siteTxt, /^Title: Kirby \$1 Playground$/m);
      assert.match(siteTxt, /Author: Kirby/);

      await kirbyAdapter.blueprintSteps.createPage(
        { slug: 'hello', title: 'Hello World', template: 'note', content: { Text: 'Welcome!' } },
        { php, documentRoot: '/var/www/html' }
      );

      const pageTxt = php.readFileAsText('/var/www/html/content/hello/note.txt');
      assert.match(pageTxt, /Title: Hello World/);
      assert.match(pageTxt, /Text: Welcome!/);
    } finally {
      php.exit();
    }
  });

  it('detects Kirby plugin, content, and site directories for --auto-mount', () => {
    const root = mkdtempSync(join(tmpdir(), 'cms-playground-kirby-am-'));

    try {
      const pluginDir = join(root, 'my-kirby-plugin');
      mkdirSync(pluginDir);
      writeFileSync(pluginDir + '/index.php', "<?php\nKirby::plugin('demo/my-plugin', []);\n");
      const pluginRes = detectKirbyAutoMount(pluginDir);
      assert.equal(pluginRes.kind, 'kirby-plugin');
      assert.equal(pluginRes.mounts[0].vfsPath, '/var/www/html/site/plugins/my-kirby-plugin');

      const contentDir = join(root, 'my-content');
      mkdirSync(contentDir);
      writeFileSync(join(contentDir, 'site.txt'), 'Title: Demo\n');
      const contentRes = detectKirbyAutoMount(contentDir);
      assert.equal(contentRes.kind, 'kirby-content');
      assert.equal(contentRes.mounts[0].vfsPath, '/var/www/html/content');

      const siteDir = join(root, 'my-site');
      mkdirSync(join(siteDir, 'config'), { recursive: true });
      mkdirSync(join(siteDir, 'templates'), { recursive: true });
      const siteRes = detectKirbyAutoMount(siteDir);
      assert.equal(siteRes.kind, 'kirby-site');
      assert.equal(siteRes.mounts[0].vfsPath, '/var/www/html/site');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
