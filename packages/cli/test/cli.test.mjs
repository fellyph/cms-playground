import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { EXIT_CODES, PlaygroundError } from '@cms-playground/core';
import { HELP_TEXT, isAgentMode, parseCliArgs, run, wantsJsonOutput } from '../src/cli.js';

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
    for (const flag of ['--port=', '--php=', '--host=', '--site=', '--blueprint=', '--output=', '--mount=', '--verbosity=', '--cwd=']) {
      assert.throws(() => parseCliArgs(['start', '--joomla', flag]), /requires a value/, `Expected ${flag} to throw`);
    }
  });

  it('parses --cwd before all other options so --mount resolves relative to --cwd', () => {
    const parsed = parseCliArgs([
      'start',
      '--joomla',
      '--mount=./plugin:/var/www/html/plugins/system/demo',
      '--cwd=/tmp/project-root',
      '--json',
    ]);

    assert.equal(parsed.options.cwd, resolve('/tmp/project-root'));
    assert.equal(parsed.options.json, true);
    assert.equal(parsed.options.mounts[0].hostPath, resolve('/tmp/project-root', './plugin'));
  });

  it('enables agent mode on CMS_PLAYGROUND_AGENT=1 or CI=1 (and ignores CI=true)', () => {
    assert.equal(isAgentMode({ CMS_PLAYGROUND_AGENT: '1' }), true);
    assert.equal(isAgentMode({ CI: '1' }), true);
    assert.equal(isAgentMode({ CI: 'true' }), false);
    assert.equal(isAgentMode({}), false);

    const agentParsed = parseCliArgs(['list'], { env: { CMS_PLAYGROUND_AGENT: '1' } });
    assert.equal(agentParsed.options.agentMode, true);
    assert.equal(agentParsed.options.json, true);
    assert.equal(agentParsed.options.yes, true);
    assert.equal(agentParsed.options.noColor, true);

    assert.equal(wantsJsonOutput(['list', '--json'], {}), true);
    assert.equal(wantsJsonOutput(['cli', '--joomla', '--', '--json'], {}), false);
    assert.equal(wantsJsonOutput(['list'], { CI: '1' }), true);
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

  it('emits { data } JSON receipts for list --json and run-blueprint --json with --cwd', async () => {
    const { result: listCode, output: listOut } = await captureLogs(() => run(['list', '--json']));
    assert.equal(listCode, 0);
    const listJson = JSON.parse(listOut);
    assert.ok(Array.isArray(listJson.data.adapters));
    assert.ok(listJson.data.adapters.some((a) => a.name === 'joomla'));
    assert.ok(listJson.data.adapters.some((a) => a.name === 'wp'));

    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-cli-cwd-'));
    try {
      const siteDir = join(workDir, 'site');
      mkdirSync(siteDir, { recursive: true });
      writeFileSync(join(siteDir, 'wp-config.php'), "<?php\ndefine('WP_DEBUG', false);\n");
      writeFileSync(
        join(workDir, 'bp.json'),
        JSON.stringify({
          steps: [{ step: 'writeFile', path: 'cwd-marker.txt', data: 'from-cwd' }],
        })
      );

      const { result, output } = await captureLogs(() =>
        run(['run-blueprint', '--wp', '--site=./site', '--blueprint=./bp.json', `--cwd=${workDir}`, '--json'])
      );

      assert.equal(result, 0);
      const parsed = JSON.parse(output);
      assert.equal(parsed.data.cms, 'wp');
      assert.equal(parsed.data.stepsRun, 1);
      assert.equal(readFileSync(join(siteDir, 'cwd-marker.txt'), 'utf8'), 'from-cwd');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('rejects nonexistent --cwd with NOT_FOUND exit code', async () => {
    await assert.rejects(
      () => run(['list', '--cwd=/nonexistent-cms-pg-cwd-99999']),
      (err) => err instanceof PlaygroundError && err.code === 'cwd_not_found' && err.exitCode === EXIT_CODES.NOT_FOUND
    );
  });
});
