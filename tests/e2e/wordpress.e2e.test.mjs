// Live end-to-end tests for @cms-playground/wordpress via the cms-playground CLI.
// Downloads and caches official WordPress + sqlite-database-integration.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTempDir, getFreePort, startCliServer } from './helpers.mjs';

describe('WordPress live E2E', () => {
  it('boots real WordPress on SQLite, serves frontend and /wp-login.php, and exits cleanly', async () => {
    const port = await getFreePort();
    const server = await startCliServer(['--wp', `--port=${port}`], {
      startupTimeoutMs: 180_000,
    });

    try {
      const homeRes = await fetch(`${server.url}/`);
      assert.equal(homeRes.status, 200);
      const homeHtml = await homeRes.text();
      assert.match(homeHtml, /WordPress Playground/);

      const loginRes = await fetch(`${server.url}/wp-login.php`);
      assert.equal(loginRes.status, 200);
      const loginHtml = await loginRes.text();
      assert.match(loginHtml, /user_login/);
      assert.match(loginHtml, /wp-submit/);
    } finally {
      const exit = await server.stop('SIGTERM');
      assert.equal(exit.code, 0);
    }
  });

  it('applies a WordPress Blueprint (defineWpConfigConsts + setSiteOption) and serves the updated title', async () => {
    const tmp = createTempDir('e2e-wp-live-bp-');
    try {
      const bpPath = join(tmp.dir, 'blueprint.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            { step: 'defineWpConfigConsts', consts: { WP_DEBUG: false } },
            { step: 'setSiteOption', option: 'blogname', value: 'WP E2E Blueprint Site' },
          ],
        })
      );

      const port = await getFreePort();
      const server = await startCliServer(
        ['--wp', `--port=${port}`, `--blueprint=${bpPath}`],
        { startupTimeoutMs: 180_000 }
      );

      try {
        const homeRes = await fetch(`${server.url}/`);
        assert.equal(homeRes.status, 200);
        const homeHtml = await homeRes.text();
        assert.match(homeHtml, /WP E2E Blueprint Site/);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('auto-mounts and activates a local WordPress plugin with --auto-mount', async () => {
    const tmp = createTempDir('e2e-wp-automount-');
    try {
      const pluginDir = join(tmp.dir, 'e2e-hello-plugin');
      mkdirSync(pluginDir, { recursive: true });

      writeFileSync(
        join(pluginDir, 'e2e-hello-plugin.php'),
        `<?php
/*
 * Plugin Name: E2E Hello Plugin
 * Version: 1.0.0
 */
add_action('wp_head', function () {
    echo '<meta name="e2e-hello-plugin" content="active">' . "\\n";
});
`
      );

      const port = await getFreePort();
      const server = await startCliServer(
        ['--wp', `--port=${port}`, `--auto-mount=${pluginDir}`],
        { startupTimeoutMs: 180_000 }
      );

      try {
        assert.match(server.getStdout(), /Auto-mount detected wp-plugin/);
        assert.match(server.getStdout(), /Activating WordPress plugin/);

        const homeRes = await fetch(`${server.url}/`);
        assert.equal(homeRes.status, 200);
        const homeHtml = await homeRes.text();
        assert.match(homeHtml, /<meta name="e2e-hello-plugin" content="active">/);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });
});
