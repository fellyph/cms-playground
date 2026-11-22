// Automated documentation verification tests.
// Ensures CLI examples, Blueprint JSON blocks, Markdown links, and live CLI output stay in sync with the codebase.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORE_STEPS } from '@cms-playground/core';
import { parseCliArgs } from '@cms-playground/cli';
import { joomlaAdapter } from '@cms-playground/joomla';
import { wordpressAdapter } from '@cms-playground/wordpress';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = join(ROOT, 'packages/cli/bin/cms-playground.mjs');
const DOC_FILES = [
  join(ROOT, 'README.md'),
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(ROOT, 'docs', f)),
  join(ROOT, 'packages/cli/skills/cms-playground/SKILL.md'),
  join(ROOT, 'packages/cli/skills/cms-playground/references/blueprints.md'),
];

function extractCodeBlocks(markdown, langPattern) {
  const blocks = [];
  const regex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    if (langPattern.test(match[1])) {
      blocks.push(match[2]);
    }
  }

  return blocks;
}

describe('Documentation verification', () => {
  it('all relative Markdown links in README.md and docs/*.md resolve to existing files', () => {
    const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;

    for (const file of DOC_FILES) {
      const content = readFileSync(file, 'utf8');
      let match;

      while ((match = linkRegex.exec(content)) !== null) {
        const href = match[1].trim();

        if (/^(https?:|mailto:|#)/i.test(href)) {
          continue;
        }

        const cleanPath = href.split('#')[0];
        const target = resolve(dirname(file), cleanPath);

        assert.equal(
          existsSync(target),
          true,
          `Broken link "${href}" in ${file} (resolved to ${target})`
        );
      }
    }
  });

  it('all CLI example commands in README.md and docs/*.md parse cleanly with parseCliArgs()', () => {
    const validCommands = new Set(['start', 'run-blueprint', 'build-snapshot', 'cli', 'list', 'setup']);
    let checked = 0;

    for (const file of DOC_FILES) {
      const content = readFileSync(file, 'utf8');
      const bashBlocks = extractCodeBlocks(content, /^(bash|sh)$/i);

      for (const block of bashBlocks) {
        for (const rawLine of block.split('\n')) {
          const line = rawLine.trim();

          if (!line || line.startsWith('#')) {
            continue;
          }

          const cmdMatch = line.match(/^(?:npx\s+(?:@cms-playground\/cli|cms-playground)|cms-playground)\s+(.+)$/);

          if (!cmdMatch) {
            continue;
          }

          const argv = cmdMatch[1].split(/\s+/).filter(Boolean);
          const parsed = parseCliArgs(argv);

          assert.ok(
            validCommands.has(parsed.command),
            `Unknown documented command "${parsed.command}" in ${file}: "${line}"`
          );

          if (parsed.command !== 'list' && parsed.command !== 'setup') {
            assert.ok(
              parsed.cms,
              `Documented "${parsed.command}" command missing CMS flag in ${file}: "${line}"`
            );
          }

          checked++;
        }
      }
    }

    assert.ok(checked >= 15, `Expected to validate at least 15 CLI examples, found ${checked}`);
  });

  it('all Blueprint JSON examples in docs/BLUEPRINTS.md and bundled skill reference are valid JSON with real step names', () => {
    const blueprintDocs = [
      join(ROOT, 'docs/BLUEPRINTS.md'),
      join(ROOT, 'packages/cli/skills/cms-playground/references/blueprints.md'),
    ];
    const knownSteps = new Set([
      ...Object.keys(CORE_STEPS),
      ...Object.keys(joomlaAdapter.blueprintSteps ?? {}),
      ...Object.keys(wordpressAdapter.blueprintSteps ?? {}),
    ]);
    let totalBlocks = 0;

    for (const blueprintsDoc of blueprintDocs) {
      const content = readFileSync(blueprintsDoc, 'utf8');
      const jsonBlocks = extractCodeBlocks(content, /^json$/i);

      assert.ok(jsonBlocks.length >= 1, `Expected at least 1 Blueprint JSON example in ${blueprintsDoc}`);
      totalBlocks += jsonBlocks.length;

      for (const [idx, block] of jsonBlocks.entries()) {
        const parsed = JSON.parse(block);

        assert.ok(Array.isArray(parsed.steps), `${blueprintsDoc} JSON block #${idx + 1} must have a steps array`);

        for (const step of parsed.steps) {
          assert.ok(
            knownSteps.has(step.step),
            `${blueprintsDoc} JSON block #${idx + 1} uses unknown step "${step.step}". Known: ${Array.from(knownSteps).join(', ')}`
          );

          if ((step.step === 'writeFile' || step.step === 'mkdir') && typeof step.path === 'string') {
            assert.equal(
              step.path.startsWith('/var/www/html'),
              false,
              `${blueprintsDoc} JSON block #${idx + 1} ${step.step} path "${step.path}" should be relative to /var/www/html`
            );
          }
        }
      }
    }

    assert.ok(totalBlocks >= 4, `Expected at least 4 Blueprint JSON examples across docs, found ${totalBlocks}`);
  });

  it('live CLI --help and list output match documented commands and CMS flags', () => {
    const helpOut = execFileSync(process.execPath, [CLI_BIN, '--help'], { encoding: 'utf8' });
    const listOut = execFileSync(process.execPath, [CLI_BIN, 'list'], { encoding: 'utf8' });
    const gettingStarted = readFileSync(join(ROOT, 'docs/GETTING-STARTED.md'), 'utf8');

    for (const token of [
      'start',
      'run-blueprint',
      'build-snapshot',
      'cli',
      'setup',
      'list',
      '--joomla',
      '--wp',
      '--php',
      '--port',
      '--site',
      '--blueprint',
      '--output',
      '--mount',
      '--mount-before-install',
      '--auto-mount',
      '--cwd',
      '--json',
      '--verbosity',
      '--quiet',
      '--agent',
      '--project',
      '--yes',
      '--skip-mcp',
      '--dry-run',
      '--force',
    ]) {
      assert.ok(helpOut.includes(token), `CLI --help missing "${token}"`);
      assert.ok(gettingStarted.includes(token), `docs/GETTING-STARTED.md missing "${token}"`);
    }

    assert.match(listOut, /--joomla/);
    assert.match(listOut, /--wp/);
  });
});
