// Live end-to-end tests for @cms-playground/typo3 via the cms-playground CLI.
// Downloads and caches the official TYPO3 zip and sets up SQLite.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTempDir, getFreePort, startCliServer } from './helpers.mjs';

describe('TYPO3 live E2E', () => {
  it('boots real TYPO3 on SQLite, serves /typo3 backend login, accepts generated credentials, and exits cleanly', async () => {
    const port = await getFreePort();
    const server = await startCliServer(['--typo3', `--port=${port}`], {
      startupTimeoutMs: 220_000,
    });

    try {
      assert.equal(server.username, 'admin');
      assert.ok(server.password.length >= 8);
      assert.match(server.password, /[a-z]/);
      assert.match(server.password, /[A-Z]/);
      assert.match(server.password, /[0-9]/);
      assert.match(server.password, /[^A-Za-z0-9]/);

      const loginRes = await fetch(`${server.url}/typo3/login`, { redirect: 'follow' });
      assert.equal(loginRes.status, 200);
      const loginHtml = await loginRes.text();
      assert.match(loginHtml, /TYPO3/i);

      const tokenMatch = loginHtml.match(/name="__RequestToken"\s+value="([^"]+)"/);
      assert.ok(tokenMatch, 'Expected __RequestToken hidden input on /typo3/login');

      const cookies = (loginRes.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .join('; ');

      const form = new URLSearchParams({
        login_status: 'login',
        username: server.username,
        userident: server.password,
        __RequestToken: tokenMatch[1],
      });

      const authRes = await fetch(`${server.url}/typo3/login?loginProvider=1433416747`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(cookies ? { cookie: cookies } : {}),
        },
        body: form.toString(),
        redirect: 'manual',
      });

      assert.ok(
        authRes.status >= 300 && authRes.status < 400,
        `Expected redirect after TYPO3 backend login, got HTTP ${authRes.status}`
      );
      const location = authRes.headers.get('location') ?? '';
      assert.match(location, /\/typo3\/main/, `Expected redirect to /typo3/main, got ${location}`);
      const authCookies = authRes.headers.getSetCookie?.() ?? [];
      assert.ok(
        authCookies.some((c) => c.startsWith('be_typo_user=')),
        'Expected be_typo_user session cookie after login'
      );
    } finally {
      const exit = await server.stop('SIGTERM');
      assert.equal(exit.code, 0);
    }
  });

  it('applies a TYPO3 Blueprint (setSiteName, createStarterSite, createContent, createPage) and renders /', async () => {
    const tmp = createTempDir('e2e-typo3-live-bp-');
    try {
      const bpPath = join(tmp.dir, 'blueprint.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            { step: 'setSiteName', name: 'TYPO3 E2E Blueprint Site' },
            {
              step: 'createStarterSite',
              title: 'Home',
              header: 'TYPO3 Starter Headline',
              bodytext: 'Rendered from tt_content!',
            },
            { step: 'createPage', title: 'Projects' },
            { step: 'createContent', header: 'Second Section', bodytext: 'More TYPO3 content.' },
          ],
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

        const homeRes = await fetch(`${server.url}/`);
        assert.equal(homeRes.status, 200);
        const homeHtml = await homeRes.text();
        assert.match(homeHtml, /TYPO3 Starter Headline/);
        assert.match(homeHtml, /Rendered from tt_content!/);
        assert.match(homeHtml, /Second Section/);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });
});
