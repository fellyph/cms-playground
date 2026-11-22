import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
