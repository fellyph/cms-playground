// Live end-to-end tests for @cms-playground/joomla via the cms-playground CLI.
// Downloads and caches the real Joomla SQLite bundle from joomla-projects/joomla-playground.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTempDir, getFreePort, runCliProcess, startCliServer } from './helpers.mjs';

describe('Joomla live E2E', () => {
  it('boots real Joomla over HTTP, serves frontend, administrator, and /media/* assets', async () => {
    const port = await getFreePort();
    const server = await startCliServer(['--joomla', `--port=${port}`], {
      startupTimeoutMs: 180_000,
    });

    try {
      const homeRes = await fetch(`${server.url}/`);
      assert.equal(homeRes.status, 200);
      const homeHtml = await homeRes.text();
      assert.match(homeHtml, /<html/i);
      assert.match(homeHtml, /joomla/i);

      const adminRes = await fetch(server.adminUrl);
      assert.equal(adminRes.status, 200);
      const adminHtml = await adminRes.text();
      assert.match(adminHtml, /<form/i);
      assert.match(adminHtml, /username|mod-login/i);

      // Verify on-demand static /media/* serving for an asset referenced by the page
      const mediaMatch = homeHtml.match(/["'](\/media\/[^"']+\.(?:css|js))(?:\?[^"']*)?["']/i);
      if (mediaMatch) {
        const mediaRes = await fetch(`${server.url}${mediaMatch[1]}`);
        assert.equal(mediaRes.status, 200, `Expected 200 for ${mediaMatch[1]}`);
        const mediaText = await mediaRes.text();
        assert.ok(mediaText.length > 0, `Expected non-empty body for ${mediaMatch[1]}`);
      }
    } finally {
      const exit = await server.stop('SIGTERM');
      assert.equal(exit.code, 0);
    }
  });

  it('runs Joomla native CLI (`cms-playground cli --joomla -- list`)', async () => {
    const res = await runCliProcess(['cli', '--joomla', '--quiet', '--', 'list'], {
      timeoutMs: 180_000,
    });

    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /user:list/);
    assert.match(res.stdout, /extension:discover:install/);
  });

  it('builds a real Joomla snapshot with a Blueprint (`build-snapshot --joomla`)', async () => {
    const tmp = createTempDir('e2e-joomla-live-snap-');
    try {
      const bpPath = join(tmp.dir, 'blueprint.json');
      const outZip = join(tmp.dir, 'joomla-snapshot.zip');

      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            { step: 'setGlobalConfig', values: { sitename: 'Joomla Live E2E' } },
            { step: 'writeFile', path: 'e2e-joomla-marker.txt', data: 'joomla-e2e-ok' },
          ],
        })
      );

      const res = await runCliProcess(
        ['build-snapshot', '--joomla', `--blueprint=${bpPath}`, `--output=${outZip}`],
        { timeoutMs: 180_000 }
      );

      assert.equal(res.exitCode, 0, res.stderr);
      assert.equal(existsSync(outZip), true);

      const zipBytes = readFileSync(outZip);
      assert.deepEqual(Array.from(zipBytes.subarray(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
      assert.ok(zipBytes.includes(Buffer.from('configuration.php')));
      assert.ok(zipBytes.includes(Buffer.from('e2e-joomla-marker.txt')));
    } finally {
      tmp.cleanup();
    }
  });

  it('auto-mounts a local Joomla system plugin with --auto-mount', async () => {
    const tmp = createTempDir('e2e-joomla-automount-');
    try {
      const pluginDir = join(tmp.dir, 'e2eping');
      mkdirSync(pluginDir, { recursive: true });

      writeFileSync(
        join(pluginDir, 'e2eping.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<extension type="plugin" group="system" method="upgrade">
  <name>plg_system_e2eping</name>
  <author>CMS Playground E2E</author>
  <version>1.0.0</version>
  <description>E2E test plugin</description>
  <files>
    <filename plugin="e2eping">e2eping.php</filename>
  </files>
</extension>
`
      );
      writeFileSync(
        join(pluginDir, 'e2eping.php'),
        `<?php
defined('_JEXEC') or die;
`
      );

      const port = await getFreePort();
      const server = await startCliServer(
        ['--joomla', `--port=${port}`, `--auto-mount=${pluginDir}`],
        { startupTimeoutMs: 180_000 }
      );

      try {
        assert.match(server.getStdout(), /Auto-mount detected joomla-plugin/);
        const homeRes = await fetch(`${server.url}/`);
        assert.equal(homeRes.status, 200);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('seeds a published featured article via createArticle Blueprint step', async () => {
    const tmp = createTempDir('e2e-joomla-article-');
    try {
      const bpPath = join(tmp.dir, 'blueprint.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            {
              step: 'createArticle',
              title: 'Blueprint Seeded Article',
              introtext: '<p>Hello from Joomla createArticle!</p>',
              featured: true,
              fields: { project_role: 'Lead' },
            },
          ],
        })
      );

      const port = await getFreePort();
      const server = await startCliServer(
        ['--joomla', `--port=${port}`, `--blueprint=${bpPath}`],
        { startupTimeoutMs: 180_000 }
      );

      try {
        const homeRes = await fetch(`${server.url}/`);
        assert.equal(homeRes.status, 200);
        const homeHtml = await homeRes.text();
        assert.match(homeHtml, /Blueprint Seeded Article/);
        assert.match(homeHtml, /Hello from Joomla createArticle!/);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });
});
