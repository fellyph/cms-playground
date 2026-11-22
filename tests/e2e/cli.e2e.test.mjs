// End-to-end CLI tests for @cms-playground/cli using real spawned child processes
// and lightweight local site fixtures (fast, offline, deterministic).
// Modeled on @wp-playground/cli's run-cli.spec.ts, cli.spec.ts, and mounts.spec.ts.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CLI_BIN,
  createMockJoomlaSite,
  createMockWordPressSite,
  createTempDir,
  getFreePort,
  runCliProcess,
  startCliServer,
} from './helpers.mjs';

describe('CLI E2E: start command, routing & signal handling', () => {
  it('starts a Joomla site, serves SEF routes and 404s, and exits cleanly on SIGTERM', async () => {
    const tmp = createTempDir('e2e-joomla-start-');
    try {
      createMockJoomlaSite(tmp.dir);
      const port = await getFreePort();
      const server = await startCliServer([
        '--joomla',
        `--site=${tmp.dir}`,
        `--port=${port}`,
        '--php=8.4',
      ]);

      try {
        assert.equal(server.url, `http://127.0.0.1:${port}`);
        assert.equal(server.adminUrl, `http://127.0.0.1:${port}/administrator/`);
        assert.equal(server.username, 'admin');

        const homeRes = await fetch(`${server.url}/`);
        assert.equal(homeRes.status, 200);
        const home = await homeRes.json();
        assert.equal(home.cms, 'joomla-fixture');
        assert.equal(home.php, '8.4');
        assert.equal(home.live_site, server.url);
        assert.equal(home.pdo_sqlite, true);
        assert.equal(home.zip, true);

        // Site SEF URLs route to /index.php
        const sefRes = await fetch(`${server.url}/about-us`);
        assert.equal(sefRes.status, 200);
        const sef = await sefRes.json();
        assert.equal(sef.uri, '/about-us');

        // Missing /administrator/* returns 404
        const missingAdmin = await fetch(`${server.url}/administrator/does-not-exist`);
        assert.equal(missingAdmin.status, 404);
      } finally {
        const exit = await server.stop('SIGTERM');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('starts a WordPress site, routes non-PHP URLs to /index.php, and exits cleanly on SIGINT', async () => {
    const tmp = createTempDir('e2e-wp-start-');
    try {
      createMockWordPressSite(tmp.dir);
      const port = await getFreePort();
      const server = await startCliServer([
        '--wp',
        `--site=${tmp.dir}`,
        `--port=${port}`,
        '--php=8.3',
      ]);

      try {
        assert.equal(server.adminUrl, `http://127.0.0.1:${port}/wp-admin/`);

        const postRes = await fetch(`${server.url}/hello-world/`);
        assert.equal(postRes.status, 200);
        const post = await postRes.json();
        assert.equal(post.cms, 'wp-fixture');
        assert.equal(post.php, '8.3');
        assert.equal(post.uri, '/hello-world/');
        assert.equal(post.pdo_sqlite, true);

        // Missing .php files return 404
        const missingPhp = await fetch(`${server.url}/nonexistent.php`);
        assert.equal(missingPhp.status, 404);
      } finally {
        const exit = await server.stop('SIGINT');
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('CLI E2E: mounts and verbosity', () => {
  it('mounts a host directory with --mount and reflects live edits without restarting', async () => {
    const tmp = createTempDir('e2e-mount-');
    try {
      const siteDir = join(tmp.dir, 'site');
      const mountDir = join(tmp.dir, 'extra');
      mkdirSync(siteDir, { recursive: true });
      mkdirSync(mountDir, { recursive: true });

      createMockWordPressSite(siteDir);
      writeFileSync(join(mountDir, 'info.php'), '<?php echo "version-1";');

      const port = await getFreePort();
      const server = await startCliServer([
        '--wp',
        `--site=${siteDir}`,
        `--port=${port}`,
        `--mount=${mountDir}:/var/www/html/mounted`,
        '--verbosity=debug',
      ]);

      try {
        assert.match(server.getStdout(), /Mounting 1 directory/);

        const res1 = await fetch(`${server.url}/mounted/info.php`);
        assert.equal(res1.status, 200);
        assert.equal(await res1.text(), 'version-1');

        // Edit file on host filesystem and confirm live visibility inside PHP-WASM
        writeFileSync(join(mountDir, 'info.php'), '<?php echo "version-2";');
        const res2 = await fetch(`${server.url}/mounted/info.php`);
        assert.equal(res2.status, 200);
        assert.equal(await res2.text(), 'version-2');
      } finally {
        await server.stop('SIGTERM');
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('respects --verbosity=quiet vs --verbosity=normal', async () => {
    const tmp = createTempDir('e2e-verbosity-');
    try {
      createMockWordPressSite(tmp.dir);
      const blueprintPath = join(tmp.dir, 'bp.json');
      writeFileSync(
        blueprintPath,
        JSON.stringify({
          steps: [{ step: 'writeFile', path: 'quiet-check.txt', data: 'ok' }],
        })
      );

      const quietRes = await runCliProcess([
        'run-blueprint',
        '--wp',
        `--site=${tmp.dir}`,
        `--blueprint=${blueprintPath}`,
        '--verbosity=quiet',
      ]);
      assert.equal(quietRes.exitCode, 0);
      assert.equal(quietRes.stdout.trim(), '');

      const normalRes = await runCliProcess([
        'run-blueprint',
        '--wp',
        `--site=${tmp.dir}`,
        `--blueprint=${blueprintPath}`,
        '--verbosity=normal',
      ]);
      assert.equal(normalRes.exitCode, 0);
      assert.match(normalRes.stdout, /Ran 1 blueprint step\(s\) on WordPress/);
      assert.doesNotMatch(normalRes.stdout, /Mounting \d+ director/);
    } finally {
      tmp.cleanup();
    }
  });

  it('suppresses the startup banner when starting with --quiet and exits cleanly on SIGTERM', async () => {
    const tmp = createTempDir('e2e-start-quiet-');
    try {
      createMockWordPressSite(tmp.dir);
      const port = await getFreePort();
      const child = spawn(
        process.execPath,
        [CLI_BIN, 'start', '--wp', `--site=${tmp.dir}`, `--port=${port}`, '--quiet'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      const exitPromise = new Promise((resolveExit) => {
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
      });

      try {
        // Poll until HTTP server responds 200
        let ok = false;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            if (res.status === 200) {
              ok = true;
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 100));
        }

        assert.equal(ok, true, `Server did not become ready. STDERR:\n${stderr}`);
        assert.equal(stdout, '', `Expected empty stdout in --quiet mode, got:\n${stdout}`);
      } finally {
        child.kill('SIGTERM');
        const exit = await exitPromise;
        assert.equal(exit.code, 0);
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('CLI E2E: run-blueprint, start --blueprint, and build-snapshot', () => {
  it('runs a Joomla blueprint headlessly (core + setGlobalConfig) and persists changes to --site', async () => {
    const tmp = createTempDir('e2e-joomla-bp-');
    try {
      const siteDir = join(tmp.dir, 'site');
      mkdirSync(siteDir, { recursive: true });
      createMockJoomlaSite(siteDir);

      const bpPath = join(tmp.dir, 'blueprint.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            { step: 'mkdir', path: 'generated' },
            { step: 'writeFile', path: 'generated/hello.txt', data: 'from-blueprint' },
            {
              step: 'runPHP',
              code: 'file_put_contents("generated/php.txt", file_get_contents("generated/hello.txt") . ":ok");',
            },
            {
              step: 'setGlobalConfig',
              values: { sitename: 'E2E Joomla Site', debug: true },
            },
          ],
        })
      );

      const res = await runCliProcess([
        'run-blueprint',
        '--joomla',
        `--site=${siteDir}`,
        `--blueprint=${bpPath}`,
      ]);

      assert.equal(res.exitCode, 0, res.stderr);
      assert.match(res.stdout, /Ran 4 blueprint step\(s\) on Joomla/);
      assert.equal(readFileSync(join(siteDir, 'generated', 'php.txt'), 'utf8'), 'from-blueprint:ok');

      const config = readFileSync(join(siteDir, 'configuration.php'), 'utf8');
      assert.match(config, /public \$sitename = 'E2E Joomla Site';/);
      assert.match(config, /public \$debug = true;/);
    } finally {
      tmp.cleanup();
    }
  });

  it('starts WordPress with --blueprint (defineWpConfigConsts) and serves the configured constant', async () => {
    const tmp = createTempDir('e2e-wp-bp-');
    try {
      const siteDir = join(tmp.dir, 'site');
      mkdirSync(siteDir, { recursive: true });
      createMockWordPressSite(siteDir);

      const bpPath = join(tmp.dir, 'wp-blueprint.json');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [
            {
              step: 'defineWpConfigConsts',
              consts: { E2E_CUSTOM_CONST: 'hello-from-blueprint' },
            },
          ],
        })
      );

      const port = await getFreePort();
      const server = await startCliServer([
        '--wp',
        `--site=${siteDir}`,
        `--port=${port}`,
        `--blueprint=${bpPath}`,
      ]);

      try {
        const res = await fetch(`${server.url}/`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.custom_const, 'hello-from-blueprint');
      } finally {
        await server.stop('SIGTERM');
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('exports a valid .zip snapshot with build-snapshot and --mount-before-install', async () => {
    const tmp = createTempDir('e2e-snapshot-');
    try {
      const siteDir = join(tmp.dir, 'site');
      const preMountDir = join(tmp.dir, 'pre-mount');
      const bpPath = join(tmp.dir, 'bp.json');
      const outZip = join(tmp.dir, 'dist', 'snapshot.zip');

      mkdirSync(siteDir, { recursive: true });
      mkdirSync(preMountDir, { recursive: true });
      createMockWordPressSite(siteDir);
      writeFileSync(join(preMountDir, 'pre.txt'), 'pre-install-marker');
      writeFileSync(
        bpPath,
        JSON.stringify({
          steps: [{ step: 'writeFile', path: 'snap-marker.txt', data: 'snapshot-ok' }],
        })
      );

      const res = await runCliProcess([
        'build-snapshot',
        '--wp',
        `--site=${siteDir}`,
        `--mount-before-install=${preMountDir}:/var/www/html/pre`,
        `--blueprint=${bpPath}`,
        `--output=${outZip}`,
      ]);

      assert.equal(res.exitCode, 0, res.stderr);
      assert.match(res.stdout, /Snapshot written to/);
      assert.equal(existsSync(outZip), true);

      const zipBytes = readFileSync(outZip);
      // ZIP local file header signature PK\x03\x04
      assert.deepEqual(Array.from(zipBytes.subarray(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
      assert.ok(zipBytes.includes(Buffer.from('snap-marker.txt')));
      assert.ok(zipBytes.includes(Buffer.from('pre.txt')));
    } finally {
      tmp.cleanup();
    }
  });
});

describe('CLI E2E: native CMS CLI passthrough', () => {
  it('forwards arguments and exit codes through `cms-playground cli --joomla`', async () => {
    const tmp = createTempDir('e2e-joomla-cli-');
    try {
      createMockJoomlaSite(tmp.dir);

      const okRes = await runCliProcess([
        'cli',
        '--joomla',
        `--site=${tmp.dir}`,
        '--quiet',
        '--',
        'user:list',
        '--format=json',
      ]);

      assert.equal(okRes.exitCode, 0, okRes.stderr);
      const parsed = JSON.parse(okRes.stdout.trim());
      assert.equal(parsed.entrypoint, 'cli/joomla.php');
      assert.deepEqual(parsed.args, ['user:list', '--format=json']);

      const failRes = await runCliProcess([
        'cli',
        '--joomla',
        `--site=${tmp.dir}`,
        '--quiet',
        '--',
        'fail',
      ]);

      assert.equal(failRes.exitCode, 42);
      assert.match(failRes.stderr, /simulated cli error/);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('CLI E2E: error handling', () => {
  it('exits non-zero with clear error messages on invalid invocations', async () => {
    const missingCms = await runCliProcess(['start']);
    assert.notEqual(missingCms.exitCode, 0);
    assert.match(missingCms.stderr, /Missing CMS flag/);

    const unknownCmd = await runCliProcess(['bogus', '--joomla']);
    assert.notEqual(unknownCmd.exitCode, 0);
    assert.match(unknownCmd.stderr, /Unknown command "bogus"/);

    const badPhp = await runCliProcess(['run-blueprint', '--joomla', '--php=7.4', '--blueprint=x.json']);
    assert.notEqual(badPhp.exitCode, 0);

    const missingSite = await runCliProcess([
      'run-blueprint',
      '--wp',
      '--site=/nonexistent-cms-playground-dir-12345',
      '--blueprint=package.json',
    ]);
    assert.notEqual(missingSite.exitCode, 0);
    assert.match(missingSite.stderr, /Site directory does not exist/);

    const missingBp = await runCliProcess(['run-blueprint', '--joomla']);
    assert.notEqual(missingBp.exitCode, 0);
    assert.match(missingBp.stderr, /--blueprint/);

    const missingOutput = await runCliProcess(['build-snapshot', '--joomla']);
    assert.notEqual(missingOutput.exitCode, 0);
    assert.match(missingOutput.stderr, /--output/);

    const emptyPort = await runCliProcess(['start', '--joomla', '--port=']);
    assert.notEqual(emptyPort.exitCode, 0);
    assert.match(emptyPort.stderr, /Option --port requires a value/);

    const relativeMount = await runCliProcess(['start', '--joomla', '--mount=./src:relative/vfs']);
    assert.notEqual(relativeMount.exitCode, 0);
    assert.match(relativeMount.stderr, /must start with "\/"/);

    const tmp = createTempDir('e2e-err-mount-');
    try {
      createMockWordPressSite(tmp.dir);
      const bpPath = join(tmp.dir, 'bp.json');
      writeFileSync(bpPath, JSON.stringify({ steps: [] }));

      const missingMountHost = await runCliProcess([
        'run-blueprint',
        '--wp',
        `--site=${tmp.dir}`,
        `--blueprint=${bpPath}`,
        '--mount=/nonexistent-cms-pg-host-dir:/var/www/html/x',
      ]);
      assert.notEqual(missingMountHost.exitCode, 0);
      assert.match(missingMountHost.stderr, /Mount host directory does not exist/);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('CLI E2E: setup agent', () => {
  it('supports --dry-run and installs bundled skill + project MCP config with -y --project', async () => {
    const tmp = createTempDir('e2e-setup-agent-');
    try {
      const homeDir = join(tmp.dir, 'home');
      const projectDir = join(tmp.dir, 'project');
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      mkdirSync(projectDir, { recursive: true });

      const dryRun = await runCliProcess(['setup', 'agent', '--project', '--dry-run'], {
        cwd: projectDir,
        env: { HOME: homeDir },
      });

      assert.equal(dryRun.exitCode, 0, dryRun.stderr);
      assert.match(dryRun.stdout, /\[dry-run\]/);
      assert.equal(existsSync(join(projectDir, '.mcp.json')), false);

      const applied = await runCliProcess(['setup', 'agent', '-y', '--project'], {
        cwd: projectDir,
        env: { HOME: homeDir },
      });

      assert.equal(applied.exitCode, 0, applied.stderr);
      assert.equal(existsSync(join(projectDir, '.claude', 'skills', 'cms-playground', 'SKILL.md')), true);

      const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
      assert.deepEqual(mcp.mcpServers['cms-playground'], {
        command: 'npx',
        args: ['-y', '@cms-playground/cli', 'mcp'],
      });
    } finally {
      tmp.cleanup();
    }
  });
});
