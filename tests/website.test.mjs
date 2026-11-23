import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSite } from '../scripts/build-site.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');

test('website/app.js passes Node syntax check', async () => {
  await execFileAsync(process.execPath, ['--check', path.join(rootDir, 'website', 'app.js')]);
});

test('buildSite outputs complete static bundle with .nojekyll and CLI version', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cms-playground-site-'));
  try {
    const result = await buildSite({ outDir: tmpDir });
    const entries = await fs.readdir(tmpDir);

    assert.ok(entries.includes('index.html'));
    assert.ok(entries.includes('styles.css'));
    assert.ok(entries.includes('app.js'));
    assert.ok(entries.includes('favicon.svg'));
    assert.ok(entries.includes('.nojekyll'));

    const html = await fs.readFile(path.join(tmpDir, 'index.html'), 'utf8');
    assert.match(html, new RegExp(`PHP-WASM CLI v${result.version.replaceAll('.', '\\.')}`));
    assert.match(html, /npx @cms-playground\/cli start --joomla/);
    assert.match(html, /npx @cms-playground\/cli start --wp/);
    assert.match(html, /AGENTS\.md/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
