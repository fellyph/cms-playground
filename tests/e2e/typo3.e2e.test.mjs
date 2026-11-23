// Live end-to-end tests for @cms-playground/typo3 via the cms-playground CLI.
// Downloads and caches the official TYPO3 zip and sets up SQLite.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTempDir, getFreePort, startCliServer } from './helpers.mjs';

describe('TYPO3 live E2E', () => {
  it('boots real TYPO3 on SQLite, serves /typo3 backend login, and exits cleanly', async () => {
    const port = await getFreePort();
    const server = await startCliServer(['--typo3', `--port=${port}`], {
      startupTimeoutMs: 220_000,
    });

    try {
      const loginRes = await fetch(`${server.url}/typo3`, { redirect: 'follow' });
      assert.equal(loginRes.status, 200);
      const loginHtml = await loginRes.text();
      assert.match(loginHtml, /TYPO3/i);
    } finally {
      const exit = await server.stop('SIGTERM');
      assert.equal(exit.code, 0);
    }
  });

  it('applies a TYPO3 Blueprint (setSiteName) and serves the updated site name', async () => {
    const tmp = createTempDir('e2e-typo3-live-bp-');
    try {
      const bpPath = join(tmp.dir, 'blueprint.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [{ step: 'setSiteName', name: 'TYPO3 E2E Blueprint Site' }],
        })
      );

      const port = await getFreePort();
      const server = await startCliServer(
        ['--typo3', `--port=${port}`, `--blueprint=${bpPath}`],
        { startupTimeoutMs: 220_000 }
      );

      try {
        const loginRes = await fetch(`${server.url}/typo3`, { redirect: 'follow' });
        assert.equal(loginRes.status, 200);
        const loginHtml = await loginRes.text();
        assert.match(loginHtml, /TYPO3 E2E Blueprint Site/);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });
});
