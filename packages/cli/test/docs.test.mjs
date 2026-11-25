import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '@cms-playground/core';
import {
  buildCliMap,
  formatDocsText,
  loadDocsCatalog,
  parseCliArgs,
  queryDocs,
  run,
} from '../src/cli.js';
import { buildDocsIndex } from '../../../scripts/build-docs-index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BUNDLED_INDEX = join(ROOT, 'packages/cli/docs-index.json');

async function captureConsoleLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await fn();
    return { code, output: lines.join('\n') };
  } finally {
    console.log = orig;
  }
}

describe('@cms-playground/cli docs command', () => {
  it('parses docs with positional query words, --all, and --json', () => {
    const bare = parseCliArgs(['docs'], { env: {} });
    assert.equal(bare.command, 'docs');
    assert.deepEqual(bare.options.query, []);
    assert.equal(bare.options.all, false);

    const multi = parseCliArgs(['docs', 'drupal', 'blueprint', '--json'], { env: {} });
    assert.equal(multi.command, 'docs');
    assert.deepEqual(multi.options.query, ['drupal', 'blueprint']);
    assert.equal(multi.options.json, true);

    const allJson = parseCliArgs(['docs', '--all', '--json'], { env: {} });
    assert.equal(allJson.command, 'docs');
    assert.equal(allJson.options.all, true);
    assert.equal(allJson.options.json, true);
  });

  it('ships an up-to-date bundled docs-index.json generated from docs/', () => {
    const bundled = JSON.parse(readFileSync(BUNDLED_INDEX, 'utf8'));
    const fresh = buildDocsIndex(ROOT);
    assert.deepEqual(bundled, fresh, 'Run `npm run build:docs-index` to refresh packages/cli/docs-index.json');
    assert.ok(bundled.topics.some((t) => t.slug === 'getting-started'));
    assert.ok(bundled.topics.some((t) => t.slug === 'blueprints'));
    assert.ok(bundled.topics.some((t) => t.slug === 'adapters'));
  });

  it('lists offline topics for `cms-playground docs` and prints full page for exact slug', async () => {
    const { code, output } = await captureConsoleLog(() => run(['docs'], { env: {} }));
    assert.equal(code, EXIT_CODES.OK);
    assert.match(output, /getting-started/);
    assert.match(output, /blueprints/);
    assert.match(output, /adapters/);
    assert.match(output, /adapter-steps/);

    const exact = await captureConsoleLog(() => run(['docs', 'blueprints'], { env: {} }));
    assert.equal(exact.code, EXIT_CODES.OK);
    assert.match(exact.output, /^# Blueprints/m);
    assert.match(exact.output, /Core Steps/);
  });

  it('matches single and multi-word queries across titles, headings, and summaries offline', async () => {
    const single = await captureConsoleLog(() => run(['docs', 'blueprint'], { env: {} }));
    assert.equal(single.code, EXIT_CODES.OK);
    assert.match(single.output, /blueprints/);

    const multi = await captureConsoleLog(() =>
      run(['docs', 'drupal', 'setFrontPage', '--json'], { env: {} })
    );
    assert.equal(multi.code, EXIT_CODES.OK);
    const parsed = JSON.parse(multi.output);
    assert.equal(parsed.data.mode, 'search');
    assert.ok(parsed.data.count >= 1);
    assert.ok(parsed.data.matches.some((m) => m.slug === 'blueprints' || m.slug === 'adapter-steps'));

    const empty = queryDocs({ query: ['zzzz-nonexistent-token-xyz'] }, loadDocsCatalog());
    assert.equal(empty.mode, 'search');
    assert.equal(empty.count, 0);
    assert.match(formatDocsText(empty, loadDocsCatalog()), /No documentation matched/);
  });

  it('returns the full offline documentation catalog for `docs --all --json` and registers docs in `map`', async () => {
    const { code, output } = await captureConsoleLog(() =>
      run(['docs', '--all', '--json'], { env: {} })
    );
    assert.equal(code, EXIT_CODES.OK);
    const parsed = JSON.parse(output);
    assert.equal(parsed.data.mode, 'all');
    assert.ok(parsed.data.count >= 4);
    assert.ok(parsed.data.topics.every((t) => typeof t.slug === 'string' && typeof t.content === 'string'));
    assert.ok(parsed.data.topics.some((t) => t.slug === 'adapter-steps'));

    const cliMap = buildCliMap();
    assert.ok(cliMap.commands.some((c) => c.id === 'docs'));
  });
});
