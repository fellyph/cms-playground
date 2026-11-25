// Live end-to-end tests for @cms-playground/drupal via the cms-playground CLI.
// Downloads and caches the official Drupal zip and installs on SQLite.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTempDir, getFreePort, startCliServer } from './helpers.mjs';

describe('Drupal live E2E', () => {
  it('boots real Drupal on SQLite with Claro admin theme, toolbar, /node frontpage, and exits cleanly', async () => {
    const port = await getFreePort();
    const server = await startCliServer(['--drupal', `--port=${port}`], {
      startupTimeoutMs: 220_000,
    });

    try {
      const homeRes = await fetch(`${server.url}/`);
      assert.equal(homeRes.status, 200);
      const homeHtml = await homeRes.text();
      assert.match(homeHtml, /Drupal Playground/);

      const nodeRes = await fetch(`${server.url}/node`);
      assert.equal(nodeRes.status, 200);

      const loginRes = await fetch(`${server.url}/user/login`);
      assert.equal(loginRes.status, 200);
      const loginHtml = await loginRes.text();
      assert.match(loginHtml, /user-login-form/);

      const formBuildId = loginHtml.match(/name="form_build_id"\s+value="([^"]+)"/)?.[1];
      assert.ok(formBuildId, 'Expected form_build_id on /user/login');

      const loginForm = new URLSearchParams({
        name: server.username,
        pass: server.password,
        form_build_id: formBuildId,
        form_id: 'user_login_form',
        op: 'Log in',
      });

      const authRes = await fetch(`${server.url}/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: loginForm.toString(),
        redirect: 'manual',
      });
      assert.ok(
        authRes.status >= 300 && authRes.status < 400,
        `Expected redirect after Drupal login, got HTTP ${authRes.status}`
      );
      const sessionCookie = (authRes.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .join('; ');
      assert.ok(sessionCookie, 'Expected session cookie after Drupal login');

      const adminRes = await fetch(`${server.url}/admin/content`, {
        headers: { cookie: sessionCookie },
      });
      assert.equal(adminRes.status, 200);
      const adminHtml = await adminRes.text();
      assert.match(adminHtml, /claro/i, 'Expected /admin/content to render with Claro admin theme');
      assert.match(adminHtml, /toolbar-bar|toolbar-administration/i, 'Expected toolbar on /admin/content');
    } finally {
      const exit = await server.stop('SIGTERM');
      assert.equal(exit.code, 0);
    }
  });

  it('applies a Drupal Blueprint (setSiteName, setAdminTheme, setFrontPage) and serves the updated config', async () => {
    const tmp = createTempDir('e2e-drupal-live-bp-');
    try {
      const bpPath = join(tmp.dir, 'blueprint.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            { step: 'setSiteName', name: 'Drupal E2E Blueprint Site' },
            { step: 'setAdminTheme', theme: 'claro' },
            { step: 'setFrontPage', path: '/user/login' },
          ],
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
        assert.match(homeHtml, /user-login-form/);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });
});
