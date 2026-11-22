import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCliArgs } from '../src/cli.js';

describe('@cms-playground/cli parseCliArgs', () => {
  it('parses start --joomla with defaults', () => {
    const parsed = parseCliArgs(['start', '--joomla']);

    assert.equal(parsed.command, 'start');
    assert.equal(parsed.cms, 'joomla');
    assert.equal(parsed.cmsVersion, null);
    assert.equal(parsed.options.port, 8790);
  });

  it('parses start --joomla=6.2 with php and port', () => {
    const parsed = parseCliArgs(['start', '--joomla=6.2', '--php=8.3', '--port=9000']);

    assert.equal(parsed.command, 'start');
    assert.equal(parsed.cms, 'joomla');
    assert.equal(parsed.cmsVersion, '6.2');
    assert.equal(parsed.options.php, '8.3');
    assert.equal(parsed.options.port, 9000);
  });

  it('parses start --wp and --wordpress alias', () => {
    const a = parseCliArgs(['start', '--wp']);
    const b = parseCliArgs(['start', '--wordpress=6.7']);

    assert.equal(a.cms, 'wp');
    assert.equal(a.cmsVersion, null);
    assert.equal(b.cms, 'wp');
    assert.equal(b.cmsVersion, '6.7');
  });

  it('parses cli passthrough arguments after --', () => {
    const parsed = parseCliArgs(['cli', '--joomla', '--site=./site', '--', 'user:list', '--format=json']);

    assert.equal(parsed.command, 'cli');
    assert.equal(parsed.cms, 'joomla');
    assert.equal(parsed.options.site, './site');
    assert.deepEqual(parsed.passthrough, ['user:list', '--format=json']);
  });

  it('parses repeatable --mount flags', () => {
    const parsed = parseCliArgs([
      'start',
      '--joomla',
      '--mount=./a:/var/www/html/plugins/system/a',
      '--mount=./b:/var/www/html/plugins/system/b',
    ]);

    assert.equal(parsed.options.mounts.length, 2);
    assert.equal(parsed.options.mounts[0].vfsPath, '/var/www/html/plugins/system/a');
    assert.equal(parsed.options.mounts[1].vfsPath, '/var/www/html/plugins/system/b');
  });

  it('parses --auto-mount with and without an explicit directory', () => {
    const cwdMount = parseCliArgs(['start', '--joomla', '--auto-mount']);
    const dirMount = parseCliArgs(['start', '--wp', '--auto-mount=./my-plugin']);

    assert.equal(cwdMount.options.autoMount, true);
    assert.equal(dirMount.options.autoMount, './my-plugin');
  });

  it('rejects multiple CMS flags', () => {
    assert.throws(() => parseCliArgs(['start', '--joomla', '--wp']), /Multiple CMS flags/);
  });

  it('rejects unknown options', () => {
    assert.throws(() => parseCliArgs(['start', '--joomla', '--nope']), /Unknown option/);
  });
});
