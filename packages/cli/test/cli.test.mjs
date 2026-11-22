import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HELP_TEXT, parseCliArgs, run } from '../src/cli.js';

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

  it('parses run-blueprint and build-snapshot with --mount-before-install and --verbosity', () => {
    const bp = parseCliArgs([
      'run-blueprint',
      '--joomla=6.2',
      '--blueprint=./bp.json',
      '--mount-before-install=./overlay:/var/www/html/overlay',
      '--verbosity=debug',
    ]);

    assert.equal(bp.command, 'run-blueprint');
    assert.equal(bp.cms, 'joomla');
    assert.equal(bp.cmsVersion, '6.2');
    assert.equal(bp.options.blueprint, './bp.json');
    assert.equal(bp.options.mountsBeforeInstall.length, 1);
    assert.equal(bp.options.mountsBeforeInstall[0].vfsPath, '/var/www/html/overlay');
    assert.equal(bp.options.verbosity, 'debug');
    assert.equal(bp.options.quiet, false);

    const snap = parseCliArgs(['build-snapshot', '--wp', '--output=./out.zip', '--verbosity=quiet']);
    assert.equal(snap.command, 'build-snapshot');
    assert.equal(snap.cms, 'wp');
    assert.equal(snap.options.output, './out.zip');
    assert.equal(snap.options.quiet, true);
  });

  it('parses setup agent with flags', () => {
    const parsed = parseCliArgs([
      'setup',
      'agent',
      '--agent',
      'claude-code',
      '--agent=cursor',
      '-p',
      '-y',
      '--skip-mcp',
      '--dry-run',
      '--force',
    ]);

    assert.equal(parsed.command, 'setup');
    assert.equal(parsed.subcommand, 'agent');
    assert.deepEqual(parsed.options.agents, ['claude-code', 'cursor']);
    assert.equal(parsed.options.project, true);
    assert.equal(parsed.options.yes, true);
    assert.equal(parsed.options.skipMcp, true);
    assert.equal(parsed.options.dryRun, true);
    assert.equal(parsed.options.force, true);
  });

  it('rejects invalid verbosity', () => {
    assert.throws(() => parseCliArgs(['start', '--joomla', '--verbosity=loud']), /Invalid verbosity/);
  });

  it('rejects multiple CMS flags', () => {
    assert.throws(() => parseCliArgs(['start', '--joomla', '--wp']), /Multiple CMS flags/);
  });

  it('rejects unknown options', () => {
    assert.throws(() => parseCliArgs(['start', '--joomla', '--nope']), /Unknown option/);
  });

  it('rejects empty inline option values', () => {
    for (const flag of ['--port=', '--php=', '--host=', '--site=', '--blueprint=', '--output=', '--mount=', '--verbosity=']) {
      assert.throws(() => parseCliArgs(['start', '--joomla', flag]), /requires a value/, `Expected ${flag} to throw`);
    }
  });
});

describe('@cms-playground/cli run() command dispatch', () => {
  async function captureLogs(fn) {
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      const result = await fn();
      return { result, output: lines.join('\n') };
    } finally {
      console.log = origLog;
    }
  }

  it('prints HELP_TEXT for --help, -h, and empty argv', async () => {
    for (const argv of [['--help'], ['-h'], []]) {
      const { result, output } = await captureLogs(() => run(argv));
      assert.equal(result, 0);
      assert.equal(output, HELP_TEXT);
    }
  });

  it('lists registered CMS adapters for list command', async () => {
    const { result, output } = await captureLogs(() => run(['list']));
    assert.equal(result, 0);
    assert.match(output, /--joomla/);
    assert.match(output, /--wp/);
    assert.match(output, /PHP:/);
  });

  it('rejects missing CMS flag, unknown commands, and missing required command options', async () => {
    await assert.rejects(() => run(['start']), /Missing CMS flag/);
    await assert.rejects(() => run(['bogus', '--joomla']), /Unknown command "bogus"/);
    await assert.rejects(() => run(['run-blueprint', '--joomla']), /--blueprint/);
    await assert.rejects(() => run(['build-snapshot', '--wp']), /--output/);
    await assert.rejects(() => run(['cli', '--wp']), /does not define a CLI entrypoint/);
  });

  it('dispatches run-blueprint against a local --site and respects --quiet', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-cli-run-'));
    try {
      writeFileSync(join(workDir, 'wp-config.php'), "<?php\ndefine('WP_DEBUG', false);\n");
      const bpPath = join(workDir, 'bp.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [{ step: 'writeFile', path: 'created.txt', data: 'via-cli-run' }],
        })
      );

      const { result, output } = await captureLogs(() =>
        run(['run-blueprint', '--wp', `--site=${workDir}`, `--blueprint=${bpPath}`, '--quiet'])
      );
      assert.equal(result, 0);
      assert.equal(output, '');
      assert.equal(readFileSync(join(workDir, 'created.txt'), 'utf8'), 'via-cli-run');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
