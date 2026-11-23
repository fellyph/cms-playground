import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { EXIT_CODES } from '@cms-playground/core';
import {
  AGENTS_END_MARKER,
  AGENTS_START_MARKER,
  initAgentsFile,
  mergeAgentsContent,
} from '../src/agents-init.js';
import { parseCliArgs } from '../src/cli.js';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cms-playground-agents-init-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('@cms-playground/cli agents init', () => {
  it('parses `agents init` with --cwd, --dry-run, and --json', () => {
    const dir = makeTempDir();
    const parsed = parseCliArgs(['agents', 'init', `--cwd=${dir}`, '--dry-run', '--json']);

    assert.equal(parsed.command, 'agents');
    assert.equal(parsed.subcommand, 'init');
    assert.equal(parsed.options.cwd, dir);
    assert.equal(parsed.options.dryRun, true);
    assert.equal(parsed.options.json, true);
  });

  it('creates AGENTS.md when absent and is idempotent on re-run', async () => {
    const dir = makeTempDir();

    const first = await initAgentsFile({ projectDir: dir, log: () => {} });
    assert.equal(first.action, 'create');
    assert.equal(first.detected, null);

    const agentsPath = join(dir, 'AGENTS.md');
    assert.equal(existsSync(agentsPath), true);
    const content = readFileSync(agentsPath, 'utf8');
    assert.ok(content.includes(AGENTS_START_MARKER));
    assert.ok(content.includes(AGENTS_END_MARKER));
    assert.ok(content.includes('npx @cms-playground/cli'));

    const second = await initAgentsFile({ projectDir: dir, log: () => {} });
    assert.equal(second.action, 'unchanged');
    assert.equal(readFileSync(agentsPath, 'utf8'), content);
  });

  it('preserves surrounding content in existing AGENTS.md and updates only the marked block', async () => {
    const dir = makeTempDir();
    const agentsPath = join(dir, 'AGENTS.md');
    writeFileSync(agentsPath, '# Project Agents\n\nCustom rules above.\n', 'utf8');

    const appended = await initAgentsFile({ projectDir: dir, log: () => {} });
    assert.equal(appended.action, 'update');

    const afterAppend = readFileSync(agentsPath, 'utf8');
    assert.ok(afterAppend.startsWith('# Project Agents\n\nCustom rules above.\n\n'));
    assert.ok(afterAppend.includes(AGENTS_START_MARKER));

    // Add trailing content after end marker, then change project CMS via .cms-playground.json.
    writeFileSync(agentsPath, `${afterAppend}\nFooter note below.\n`, 'utf8');
    writeFileSync(
      join(dir, '.cms-playground.json'),
      JSON.stringify({ cms: 'joomla', version: '5.4', php: '8.3' }),
      'utf8'
    );

    const updated = await initAgentsFile({ projectDir: dir, log: () => {} });
    assert.equal(updated.action, 'update');
    assert.equal(updated.detected.cms, 'joomla');
    assert.equal(updated.detected.source, 'config');
    assert.equal(updated.detected.version, '5.4');

    const finalContent = readFileSync(agentsPath, 'utf8');
    assert.ok(finalContent.startsWith('# Project Agents\n\nCustom rules above.\n\n'));
    assert.ok(finalContent.endsWith('\nFooter note below.\n'));
    assert.ok(finalContent.includes('--joomla=5.4 --php=8.3'));
    assert.ok(finalContent.includes('cli --joomla=5.4'));
  });

  it('detects WordPress plugin via --auto-mount heuristics', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'my-plugin.php'),
      '<?php\n/*\nPlugin Name: My Demo Plugin\n*/\n',
      'utf8'
    );

    const result = await initAgentsFile({ projectDir: dir, log: () => {} });
    assert.equal(result.action, 'create');
    assert.equal(result.detected.cms, 'wp');
    assert.equal(result.detected.source, 'auto-mount');
    assert.equal(result.detected.autoMountKind, 'wp-plugin');

    const content = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(content.includes('Detected **WordPress** (wp-plugin)'));
    assert.ok(content.includes('--wp --auto-mount'));
  });

  it('supports --dry-run without creating or modifying AGENTS.md', async () => {
    const dir = makeTempDir();

    const result = await initAgentsFile({ projectDir: dir, dryRun: true, log: () => {} });
    assert.equal(result.action, 'create');
    assert.equal(result.dryRun, true);
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
  });

  it('fails with exit code 2 on malformed, reversed, or duplicate markers', () => {
    const block = `${AGENTS_START_MARKER}\nbody\n${AGENTS_END_MARKER}`;

    // Missing end marker
    assert.throws(
      () => mergeAgentsContent(`# Hi\n${AGENTS_START_MARKER}\norphan\n`, block),
      (err) => err.exitCode === EXIT_CODES.VALIDATION && err.code === 'invalid_agents_markers'
    );

    // Reversed markers
    assert.throws(
      () => mergeAgentsContent(`${AGENTS_END_MARKER}\nbody\n${AGENTS_START_MARKER}\n`, block),
      (err) => err.exitCode === EXIT_CODES.VALIDATION && err.code === 'invalid_agents_markers'
    );

    // Duplicate markers
    assert.throws(
      () =>
        mergeAgentsContent(
          `${AGENTS_START_MARKER}\na\n${AGENTS_END_MARKER}\n${AGENTS_START_MARKER}\nb\n${AGENTS_END_MARKER}\n`,
          block
        ),
      (err) => err.exitCode === EXIT_CODES.VALIDATION && err.code === 'invalid_agents_markers'
    );
  });

  it('refuses symlinked AGENTS.md', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'real.md');
    writeFileSync(target, '# Real\n', 'utf8');
    symlinkSync(target, join(dir, 'AGENTS.md'));

    await assert.rejects(
      () => initAgentsFile({ projectDir: dir, log: () => {} }),
      (err) => err.exitCode === EXIT_CODES.VALIDATION && /symbolic link/i.test(err.message)
    );
  });
});
