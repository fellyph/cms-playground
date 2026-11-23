import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildSnapshot,
  runBlueprintHeadless,
  runCmsCli,
  startPlayground,
} from '../src/index.js';

function createBaseAdapter(overrides = {}) {
  return {
    name: 'test-srv',
    label: 'Test Server',
    defaultPhp: '8.4',
    supportedPhp: ['8.4'],
    defaultVersion: '1.0',
    adminPath: '/admin/',
    async resolveBundle() {
      return { version: '1.0' };
    },
    async configure({ php, documentRoot }) {
      php.writeFile(`${documentRoot}/index.php`, '<?php echo "hello";');
    },
    getFileNotFoundAction() {
      return { type: 'internal-redirect', uri: '/index.php' };
    },
    ...overrides,
  };
}

describe('@cms-playground/core server lifecycle and error paths', () => {
  it('validates required inputs and error paths in startPlayground, runBlueprintHeadless, buildSnapshot, and runCmsCli', async () => {
    await assert.rejects(() => startPlayground({ port: 0, quiet: true }), /A CMS adapter is required/);

    const adapter = createBaseAdapter();

    await assert.rejects(
      () => startPlayground({ adapter, phpVersion: '7.4', port: 0, quiet: true }),
      /does not support PHP 7\.4/
    );

    await assert.rejects(
      () => startPlayground({ adapter, autoMount: true, port: 0, quiet: true }),
      /does not support --auto-mount/
    );

    const adapterNoMatch = createBaseAdapter({ detectAutoMount: () => null });
    await assert.rejects(
      () => startPlayground({ adapter: adapterNoMatch, autoMount: '.', port: 0, quiet: true }),
      /Could not detect/
    );

    await assert.rejects(
      () => runBlueprintHeadless({ adapter, quiet: true }),
      /--blueprint file or URL is required/
    );

    await assert.rejects(
      () => buildSnapshot({ adapter, quiet: true }),
      /--output path .* is required/
    );

    await assert.rejects(
      () => runCmsCli({ adapter, quiet: true }),
      /does not define a CLI entrypoint/
    );
  });

  it('serves adapter static assets for GET/HEAD and returns HTTP 500 when serveStatic throws', async () => {
    const adapter = createBaseAdapter({
      async serveStatic({ request }) {
        if (request.url === '/static/hello.txt') {
          return {
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: Buffer.from('static-body'),
          };
        }
        if (request.url === '/static/boom') {
          throw new Error('static failure');
        }
        return null;
      },
    });

    const instance = await startPlayground({ adapter, port: 0, quiet: true });
    try {
      const getStatic = await fetch(`${instance.url}/static/hello.txt`);
      assert.equal(getStatic.status, 200);
      assert.equal(await getStatic.text(), 'static-body');

      const headStatic = await fetch(`${instance.url}/static/hello.txt`, { method: 'HEAD' });
      assert.equal(headStatic.status, 200);
      assert.equal(await headStatic.text(), '');

      const boom = await fetch(`${instance.url}/static/boom`);
      assert.equal(boom.status, 500);
      assert.match(await boom.text(), /static failure/);
    } finally {
      await instance.close();
    }
  });

  it('runs runCmsCli against a mounted --site with --mount and captures stdout, stderr, and exitCode', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-srv-cli-'));
    const siteDir = join(workDir, 'site');
    const mountDir = join(workDir, 'extra');

    try {
      mkdirSync(siteDir, { recursive: true });
      mkdirSync(mountDir, { recursive: true });
      writeFileSync(join(mountDir, 'val.txt'), 'mounted-value');
      writeFileSync(
        join(siteDir, 'cli.php'),
        `<?php
        if (($argv[1] ?? '') === 'err') {
            fwrite(STDERR, 'bad arg');
            exit(7);
        }
        echo file_get_contents(__DIR__ . '/extra/val.txt') . '|' . ($argv[1] ?? '');
        `
      );

      const adapter = createBaseAdapter({
        cliEntrypoint: 'cli.php',
        async configure() {},
      });

      const ok = await runCmsCli({
        adapter,
        site: siteDir,
        args: ['ping'],
        mounts: [{ hostPath: mountDir, vfsPath: '/var/www/html/extra' }],
        quiet: true,
      });
      assert.equal(ok.exitCode, 0);
      assert.equal(ok.stdout, 'mounted-value|ping');

      const err = await runCmsCli({
        adapter,
        site: siteDir,
        args: ['err'],
        quiet: true,
      });
      assert.equal(err.exitCode, 7);
      assert.equal(err.stderr, 'bad arg');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('enforces site directory locks and recovers stale locks', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-site-lock-'));
    try {
      writeFileSync(join(workDir, 'index.php'), '<?php echo "locked-site";');

      const adapter = createBaseAdapter({
        async configure() {},
      });

      const first = await startPlayground({
        adapter,
        site: workDir,
        port: 0,
        quiet: true,
      });

      try {
        // Lock file exists while running
        assert.equal(existsSync(join(workDir, '.cms-playground.lock')), true);

        // Second concurrent start on the same --site must fail with site_locked (CONFLICT)
        await assert.rejects(
          () => startPlayground({ adapter, site: workDir, port: 0, quiet: true }),
          (err) => err.code === 'site_locked' && err.exitCode === 30
        );
      } finally {
        await first.close();
      }

      // Lock file is cleaned up on close
      assert.equal(existsSync(join(workDir, '.cms-playground.lock')), false);

      // Stale lock from a dead PID is automatically recovered
      writeFileSync(
        join(workDir, '.cms-playground.lock'),
        JSON.stringify({ pid: 999999, cms: 'test', startedAt: '2020-01-01T00:00:00.000Z' })
      );

      const recovered = await startPlayground({
        adapter,
        site: workDir,
        port: 0,
        quiet: true,
      });
      await recovered.close();
      assert.equal(existsSync(join(workDir, '.cms-playground.lock')), false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('validates and executes --site --reset with safety guardrails', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-site-reset-'));
    try {
      const adapter = createBaseAdapter({
        async configure({ php, documentRoot, site }) {
          assert.equal(site, null);
          php.writeFile(`${documentRoot}/index.php`, '<?php echo "fresh-install";');
        },
      });

      // --reset without --site must fail
      await assert.rejects(
        () => startPlayground({ adapter, reset: true, port: 0, quiet: true }),
        (err) => err.code === 'missing_option' && /--reset requires --site/.test(err.message)
      );

      // Non-empty non-site directory must be rejected
      const nonSiteDir = join(workDir, 'random-folder');
      mkdirSync(nonSiteDir, { recursive: true });
      writeFileSync(join(nonSiteDir, 'notes.txt'), 'keep me');
      await assert.rejects(
        () => startPlayground({ adapter, site: nonSiteDir, reset: true, port: 0, quiet: true }),
        (err) => err.code === 'unsafe_site_reset'
      );
      assert.equal(existsSync(join(nonSiteDir, 'notes.txt')), true);

      // Git repository directory must be rejected even if index.php exists
      const gitDir = join(workDir, 'git-repo');
      mkdirSync(join(gitDir, '.git'), { recursive: true });
      writeFileSync(join(gitDir, 'index.php'), '<?php echo "repo";');
      await assert.rejects(
        () => startPlayground({ adapter, site: gitDir, reset: true, port: 0, quiet: true }),
        (err) => err.code === 'unsafe_site_reset'
      );

      // Existing CMS site directory is cleanly wiped and re-initialized
      const cmsSiteDir = join(workDir, 'my-site');
      mkdirSync(cmsSiteDir, { recursive: true });
      writeFileSync(join(cmsSiteDir, 'index.php'), '<?php echo "stale";');
      writeFileSync(join(cmsSiteDir, 'stale-file.txt'), 'remove-me');

      const instance = await startPlayground({
        adapter,
        site: cmsSiteDir,
        reset: true,
        port: 0,
        quiet: true,
      });

      try {
        assert.equal(existsSync(join(cmsSiteDir, 'stale-file.txt')), false);
        assert.equal(existsSync(join(cmsSiteDir, '.cms-playground-site.json')), true);
        const res = await fetch(`${instance.url}/`);
        assert.equal(await res.text(), 'fresh-install');
      } finally {
        await instance.close();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
