// Live end-to-end tests for @cms-playground/kirby via the cms-playground CLI.
// Downloads and caches the official Kirby Starterkit zip.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTempDir, getFreePort, startCliServer } from './helpers.mjs';

describe('Kirby live E2E', () => {
  it('boots real Kirby Starterkit, serves frontend and /panel, and exits cleanly', async () => {
    const port = await getFreePort();
    const server = await startCliServer(['--kirby', `--port=${port}`], {
      startupTimeoutMs: 180_000,
    });

    try {
      const homeRes = await fetch(`${server.url}/`);
      assert.equal(homeRes.status, 200);
      const homeHtml = await homeRes.text();
      assert.match(homeHtml, /<title>/i);

      const panelRes = await fetch(`${server.url}/panel/login`, { redirect: 'follow' });
      assert.equal(panelRes.status, 200);
      const panelHtml = await panelRes.text();
      assert.match(panelHtml, /kirby|panel/i);
    } finally {
      const exit = await server.stop('SIGTERM');
      assert.equal(exit.code, 0);
    }
  });

  it('applies a Kirby Blueprint (setSiteTitle + createPage) and serves the updated title', async () => {
    const tmp = createTempDir('e2e-kirby-live-bp-');
    try {
      const bpPath = join(tmp.dir, 'blueprint.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            { step: 'setSiteTitle', title: 'Kirby E2E Blueprint Site' },
            { step: 'createPage', slug: 'hello-e2e', title: 'Hello E2E', template: 'default' },
          ],
        })
      );

      const port = await getFreePort();
      const server = await startCliServer(
        ['--kirby', `--port=${port}`, `--blueprint=${bpPath}`],
        { startupTimeoutMs: 180_000 }
      );

      try {
        const homeRes = await fetch(`${server.url}/`);
        assert.equal(homeRes.status, 200);
        const homeHtml = await homeRes.text();
        assert.match(homeHtml, /Kirby E2E Blueprint Site/);

        const pageRes = await fetch(`${server.url}/hello-e2e`);
        assert.equal(pageRes.status, 200);
        const pageHtml = await pageRes.text();
        assert.match(pageHtml, /Hello E2E/);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });
});
