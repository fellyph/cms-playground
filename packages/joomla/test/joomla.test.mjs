import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
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
});
