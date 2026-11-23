// Live end-to-end tests for @cms-playground/drupal via the cms-playground CLI.
// Downloads and caches the official Drupal zip and installs on SQLite.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTempDir, getFreePort, startCliServer } from './helpers.mjs';

describe('Drupal live E2E', () => {
  it('boots real Drupal on SQLite, serves frontend and /user/login, and exits cleanly', async () => {
    const port = await getFreePort();
    const server = await startCliServer(['--drupal', `--port=${port}`], {
      startupTimeoutMs: 220_000,
    });

    try {
      const homeRes = await fetch(`${server.url}/`);
      assert.equal(homeRes.status, 200);
      const homeHtml = await homeRes.text();
      assert.match(homeHtml, /Drupal Playground/);

      const loginRes = await fetch(`${server.url}/user/login`);
      assert.equal(loginRes.status, 200);
      const loginHtml = await loginRes.text();
      assert.match(loginHtml, /user-login-form/);
    } finally {
      const exit = await server.stop('SIGTERM');
      assert.equal(exit.code, 0);
    }
  });

  it('applies a Drupal Blueprint (setSiteName) and serves the updated site name', async () => {
    const tmp = createTempDir('e2e-drupal-live-bp-');
    try {
      const bpPath = join(tmp.dir, 'blueprint.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [{ step: 'setSiteName', name: 'Drupal E2E Blueprint Site' }],
        })
      );

      const port = await getFreePort();
      const server = await startCliServer(
        ['--drupal', `--port=${port}`, `--blueprint=${bpPath}`],
        { startupTimeoutMs: 220_000 }
      );

      try {
        const homeRes = await fetch(`${server.url}/`);
        assert.equal(homeRes.status, 200);
        const homeHtml = await homeRes.text();
        assert.match(homeHtml, /Drupal E2E Blueprint Site/);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });
});
