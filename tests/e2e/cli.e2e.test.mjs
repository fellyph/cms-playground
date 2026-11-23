// End-to-end CLI tests for @cms-playground/cli using real spawned child processes
// and lightweight local site fixtures (fast, offline, deterministic).
// Modeled on @wp-playground/cli's run-cli.spec.ts, cli.spec.ts, and mounts.spec.ts.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
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

function assertStoppedCleanly(exit, signal) {
  if (process.platform === 'win32') {
    assert.ok(
      exit.code === 0 || exit.signal === signal,
      `Expected exit code 0 or signal ${signal} on Windows, got code=${exit.code} signal=${exit.signal}`
    );
  } else {
    assert.equal(exit.code, 0);
  }
}

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
        assertStoppedCleanly(exit, 'SIGTERM');
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
        assertStoppedCleanly(exit, 'SIGINT');
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
        assertStoppedCleanly(exit, 'SIGTERM');
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
        env: { HOME: homeDir, USERPROFILE: homeDir },
      });

      assert.equal(dryRun.exitCode, 0, dryRun.stderr);
      assert.match(dryRun.stdout, /\[dry-run\]/);
      assert.equal(existsSync(join(projectDir, '.mcp.json')), false);

      const applied = await runCliProcess(['setup', 'agent', '-y', '--project'], {
        cwd: projectDir,
        env: { HOME: homeDir, USERPROFILE: homeDir },
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

describe('CLI E2E: --json receipts, agent mode, --cwd, and classified exit codes', () => {
  it('emits { data } JSON receipts for list, run-blueprint, build-snapshot, and cli with --cwd', async () => {
    const listRes = await runCliProcess(['list', '--json']);
    assert.equal(listRes.exitCode, 0, listRes.stderr);
    const listPayload = JSON.parse(listRes.stdout.trim());
    assert.ok(Array.isArray(listPayload.data.adapters));
    assert.ok(listPayload.data.adapters.some((a) => a.name === 'joomla'));

    // Agent mode via CMS_PLAYGROUND_AGENT=1 and CI=1 enables --json automatically
    for (const agentEnv of [{ CMS_PLAYGROUND_AGENT: '1' }, { CI: '1' }]) {
      const agentRes = await runCliProcess(['list'], { env: agentEnv });
      assert.equal(agentRes.exitCode, 0, agentRes.stderr);
      const agentPayload = JSON.parse(agentRes.stdout.trim());
      assert.ok(Array.isArray(agentPayload.data.adapters));
    }

    const tmp = createTempDir('e2e-json-cwd-');
    try {
      const siteDir = join(tmp.dir, 'site');
      const mountDir = join(tmp.dir, 'extra');
      mkdirSync(siteDir, { recursive: true });
      mkdirSync(mountDir, { recursive: true });
      createMockJoomlaSite(siteDir);
      writeFileSync(join(mountDir, 'marker.txt'), 'mounted');
      writeFileSync(
        join(tmp.dir, 'bp.json'),
        JSON.stringify({
          steps: [{ step: 'writeFile', path: 'json-check.txt', data: 'ok' }],
        })
      );

      // run-blueprint with --cwd and --json
      const bpRes = await runCliProcess([
        'run-blueprint',
        '--joomla',
        '--site=./site',
        '--blueprint=./bp.json',
        '--mount=./extra:/var/www/html/extra',
        `--cwd=${tmp.dir}`,
        '--json',
      ]);
      assert.equal(bpRes.exitCode, 0, bpRes.stderr);
      const bpPayload = JSON.parse(bpRes.stdout.trim());
      assert.equal(bpPayload.data.cms, 'joomla');
      assert.equal(bpPayload.data.stepsRun, 1);
      assert.equal(bpPayload.data.mounts.length, 1);
      assert.equal(bpPayload.data.mounts[0].vfsPath, '/var/www/html/extra');

      // build-snapshot with --cwd and --json
      const snapRes = await runCliProcess([
        'build-snapshot',
        '--joomla',
        '--site=./site',
        '--output=./out/snap.zip',
        `--cwd=${tmp.dir}`,
        '--json',
      ]);
      assert.equal(snapRes.exitCode, 0, snapRes.stderr);
      const snapPayload = JSON.parse(snapRes.stdout.trim());
      assert.equal(snapPayload.data.cms, 'joomla');
      assert.equal(snapPayload.data.outputPath, join(tmp.dir, 'out', 'snap.zip'));
      assert.ok(snapPayload.data.bytes > 0);
      assert.equal(existsSync(join(tmp.dir, 'out', 'snap.zip')), true);

      // cli with --cwd and --json
      const cliRes = await runCliProcess([
        'cli',
        '--joomla',
        '--site=./site',
        `--cwd=${tmp.dir}`,
        '--json',
        '--',
        'user:list',
      ]);
      assert.equal(cliRes.exitCode, 0, cliRes.stderr);
      const cliPayload = JSON.parse(cliRes.stdout.trim());
      assert.equal(cliPayload.data.cms, 'joomla');
      assert.equal(cliPayload.data.exitCode, 0);
      assert.equal(JSON.parse(cliPayload.data.stdout.trim()).entrypoint, 'cli/joomla.php');
    } finally {
      tmp.cleanup();
    }
  });

  it('emits a single JSON ready-receipt on stdout for start --json and serves HTTP', async () => {
    const tmp = createTempDir('e2e-start-json-');
    try {
      createMockWordPressSite(tmp.dir);
      const child = spawn(
        process.execPath,
        [CLI_BIN, 'start', '--wp', `--site=${tmp.dir}`, '--port=0', '--json'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let stdout = '';
      let stderr = '';
      const exitPromise = new Promise((resolveExit) => {
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
      });

      const receipt = await new Promise((resolveReady, rejectReady) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          rejectReady(new Error(`Timed out waiting for JSON ready-receipt.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        }, 30_000);

        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
          const trimmed = stdout.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
              const parsed = JSON.parse(trimmed);
              clearTimeout(timer);
              resolveReady(parsed);
            } catch {}
          }
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          rejectReady(new Error(`Exited early (${code}). STDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        });
      });

      try {
        assert.equal(receipt.data.cms, 'wp');
        assert.match(receipt.data.url, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.equal(receipt.data.adminUrl, `${receipt.data.url}/wp-admin/`);
        assert.equal(receipt.data.username, 'admin');
        assert.ok(typeof receipt.data.password === 'string' && receipt.data.password.length > 0);
        assert.equal(receipt.data.pid, child.pid);
        assert.ok(Array.isArray(receipt.data.mounts));

        const res = await fetch(`${receipt.data.url}/`);
        assert.equal(res.status, 200);
        // Ensure HTTP request did not pollute stdout in --json mode
        assert.equal(stdout.trim().split('\n').length, 1);
      } finally {
        child.kill('SIGTERM');
        const exit = await exitPromise;
        assertStoppedCleanly(exit, 'SIGTERM');
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('emits structured JSON errors on stderr with classified exit codes (2, 20, 30, 40)', async () => {
    // Exit 2: validation error on unknown flag
    const badFlag = await runCliProcess(['start', '--joomla', '--nope', '--json']);
    assert.equal(badFlag.exitCode, 2);
    assert.equal(badFlag.stdout.trim(), '');
    const badFlagErr = JSON.parse(badFlag.stderr.trim());
    assert.equal(badFlagErr.error.code, 'invalid_option');
    assert.equal(badFlagErr.error.retryable, false);
    assert.ok(Array.isArray(badFlagErr.error.suggestions));

    // Exit 2: Blueprint validation failure with RFC 6901 pointer
    const tmp = createTempDir('e2e-json-errors-');
    try {
      createMockWordPressSite(tmp.dir);
      const badBp = join(tmp.dir, 'bad-bp.json');
      writeFileSync(
        badBp,
        JSON.stringify({
          steps: [
            { step: 'mkdir', path: 'ok' },
            { step: 'nonExistentStep', plugin: 'demo' },
          ],
        })
      );

      const bpErrRes = await runCliProcess([
        'run-blueprint',
        '--wp',
        `--site=${tmp.dir}`,
        `--blueprint=${badBp}`,
        '--json',
      ]);
      assert.equal(bpErrRes.exitCode, 2);
      assert.equal(bpErrRes.stdout.trim(), '');
      const bpErr = JSON.parse(bpErrRes.stderr.trim());
      assert.equal(bpErr.error.code, 'invalid_blueprint_step');
      assert.equal(bpErr.error.pointer, '/steps/1/step');

      // Exit 20: missing --site
      const missingSite = await runCliProcess(
        ['run-blueprint', '--wp', '--site=/nonexistent-dir-99999', `--blueprint=${badBp}`],
        { env: { CMS_PLAYGROUND_AGENT: '1' } }
      );
      assert.equal(missingSite.exitCode, 20);
      const missingSiteErr = JSON.parse(missingSite.stderr.trim());
      assert.equal(missingSiteErr.error.code, 'site_not_found');

      // Exit 20: missing --blueprint
      const missingBp = await runCliProcess([
        'run-blueprint',
        '--wp',
        `--site=${tmp.dir}`,
        '--blueprint=/nonexistent-bp-99999.json',
        '--json',
      ]);
      assert.equal(missingBp.exitCode, 20);
      assert.equal(JSON.parse(missingBp.stderr.trim()).error.code, 'blueprint_not_found');

      // Exit 30: port_in_use with runnable recovery command
      const blocker = net.createServer();
      await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
      const busyPort = blocker.address().port;
      try {
        const conflictRes = await runCliProcess([
          'start',
          '--wp',
          `--site=${tmp.dir}`,
          `--port=${busyPort}`,
          '--json',
        ]);
        assert.equal(conflictRes.exitCode, 30);
        const conflictErr = JSON.parse(conflictRes.stderr.trim());
        assert.equal(conflictErr.error.code, 'port_in_use');
        assert.equal(conflictErr.error.retryable, false);
        assert.equal(conflictErr.error.recovery, 'cms-playground start --wp --port=0');
      } finally {
        await new Promise((r) => blocker.close(r));
      }

      // Exit 40: retryable network error (HTTP 500 blueprint fetch)
      const failServer = http.createServer((_req, res) => {
        res.statusCode = 500;
        res.end('server error');
      });
      await new Promise((r) => failServer.listen(0, '127.0.0.1', r));
      const failPort = failServer.address().port;
      try {
        const netRes = await runCliProcess([
          'run-blueprint',
          '--wp',
          `--site=${tmp.dir}`,
          `--blueprint=http://127.0.0.1:${failPort}/bp.json`,
          '--json',
        ]);
        assert.equal(netRes.exitCode, 40);
        const netErr = JSON.parse(netRes.stderr.trim());
        assert.equal(netErr.error.code, 'blueprint_fetch_failed');
        assert.equal(netErr.error.retryable, true);
      } finally {
        await new Promise((r) => failServer.close(r));
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('supports cms-playground map, map --json, and map --paths', async () => {
    const mapRes = await runCliProcess(['map']);
    assert.equal(mapRes.exitCode, 0, mapRes.stderr);
    const mapPayload = JSON.parse(mapRes.stdout);
    assert.ok(mapPayload.data.commands.some((c) => c.id === 'map'));
    assert.ok(mapPayload.data.adapters.some((a) => a.name === 'joomla'));
    assert.ok(mapPayload.data.blueprintSteps.some((s) => s.step === 'runPHP'));

    const mapJsonRes = await runCliProcess(['map', '--json']);
    assert.equal(mapJsonRes.exitCode, 0, mapJsonRes.stderr);
    assert.deepEqual(JSON.parse(mapJsonRes.stdout.trim()), mapPayload);

    const pathsRes = await runCliProcess(['map', '--paths']);
    assert.equal(pathsRes.exitCode, 0, pathsRes.stderr);
    const lines = pathsRes.stdout.trim().split('\n');
    assert.ok(lines.includes('cms-playground start --joomla'));
    assert.ok(lines.includes('cms-playground start --wp'));
    assert.ok(lines.includes('cms-playground map --paths'));
    assert.ok(lines.includes('cms-playground mcp'));
  });
});

describe('CLI E2E: local stdio MCP server (cms-playground mcp)', () => {
  it('speaks MCP JSON-RPC over stdio, runs real PHP-WASM tools, and cleans up on stdin close', async () => {
    const tmp = createTempDir('e2e-mcp-');
    try {
      createMockJoomlaSite(tmp.dir);

      const child = spawn(process.execPath, [CLI_BIN, 'mcp'], {
        env: { ...process.env, CMS_PLAYGROUND_AGENT: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const pending = new Map();
      let buffer = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          const resolver = pending.get(msg.id);
          if (resolver) {
            pending.delete(msg.id);
            resolver(msg);
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      const sendRequest = (id, method, params = {}) =>
        new Promise((resolveReq, rejectReq) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectReq(new Error(`MCP request ${method} timed out. STDERR:\n${stderr}`));
          }, 30_000);
          pending.set(id, (msg) => {
            clearTimeout(timer);
            resolveReq(msg);
          });
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });

      const exitPromise = new Promise((resolveExit) => {
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
      });

      let startedUrl = null;
      try {
        const init = await sendRequest(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e-client', version: '1.0.0' },
        });
        assert.equal(init.result.serverInfo.name, 'cms-playground');

        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

        const toolsRes = await sendRequest(2, 'tools/list');
        assert.equal(toolsRes.result.tools.length, 7);

        const startRes = await sendRequest(3, 'tools/call', {
          name: 'start_playground',
          arguments: { cms: 'joomla', site: tmp.dir, php: '8.4' },
        });
        assert.equal(startRes.result.isError, false, startRes.result.content[0].text);
        const started = JSON.parse(startRes.result.content[0].text);
        startedUrl = started.url;
        assert.equal(started.id, 'pg_1');
        assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);

        const fetchRes = await sendRequest(4, 'tools/call', {
          name: 'fetch_page',
          arguments: { id: 'pg_1', path: '/' },
        });
        assert.equal(fetchRes.result.isError, false);
        const fetched = JSON.parse(fetchRes.result.content[0].text);
        assert.equal(fetched.status, 200);
        assert.equal(JSON.parse(fetched.body).cms, 'joomla-fixture');

        const logsRes = await sendRequest(5, 'tools/call', {
          name: 'read_php_logs',
          arguments: { id: 'pg_1', tail: 20 },
        });
        const logs = JSON.parse(logsRes.result.content[0].text);
        assert.ok(logs.lines.length >= 1);
      } finally {
        // Close stdin without calling stop_playground to verify automatic cleanup.
        child.stdin.end();
      }

      const exit = await exitPromise;
      assert.equal(exit.code, 0, `Expected exit 0, got ${exit.code}. STDERR:\n${stderr}`);

      if (startedUrl) {
        await assert.rejects(() => fetch(startedUrl));
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('CLI E2E: agents init', () => {
  it('scaffolds and updates AGENTS.md idempotently, supports --dry-run/--json, and exits 2 on malformed markers', async () => {
    const tmp = createTempDir('e2e-agents-init-');
    try {
      writeFileSync(
        join(tmp.dir, 'demo-plugin.php'),
        '<?php\n/*\nPlugin Name: E2E Demo\n*/\n',
        'utf8'
      );

      const dryRes = await runCliProcess(['agents', 'init', `--cwd=${tmp.dir}`, '--dry-run', '--json']);
      assert.equal(dryRes.exitCode, 0, dryRes.stderr);
      const dryPayload = JSON.parse(dryRes.stdout.trim());
      assert.equal(dryPayload.data.action, 'create');
      assert.equal(dryPayload.data.dryRun, true);
      assert.equal(dryPayload.data.detected.cms, 'wp');
      assert.equal(existsSync(join(tmp.dir, 'AGENTS.md')), false);

      const createRes = await runCliProcess(['agents', 'init', `--cwd=${tmp.dir}`, '--json']);
      assert.equal(createRes.exitCode, 0, createRes.stderr);
      assert.equal(JSON.parse(createRes.stdout.trim()).data.action, 'create');
      assert.equal(existsSync(join(tmp.dir, 'AGENTS.md')), true);

      const secondRes = await runCliProcess(['agents', 'init', `--cwd=${tmp.dir}`, '--json']);
      assert.equal(secondRes.exitCode, 0, secondRes.stderr);
      assert.equal(JSON.parse(secondRes.stdout.trim()).data.action, 'unchanged');

      // Malformed markers must fail with exit code 2 and structured JSON error.
      writeFileSync(join(tmp.dir, 'AGENTS.md'), '<!-- CMS-PLAYGROUND START -->\nbroken\n', 'utf8');
      const badRes = await runCliProcess(['agents', 'init', `--cwd=${tmp.dir}`, '--json']);
      assert.equal(badRes.exitCode, 2);
      assert.equal(JSON.parse(badRes.stderr.trim()).error.code, 'invalid_agents_markers');
    } finally {
      tmp.cleanup();
    }
  });
});

describe('CLI E2E: fetch one-shot HTTP verification', () => {
  it('smoke-tests a route with --verify-status, --fail-on-php-error, --headers, --output, and --json', async () => {
    const tmp = createTempDir('e2e-fetch-');
    try {
      const siteDir = join(tmp.dir, 'site');
      mkdirSync(siteDir, { recursive: true });
      createMockJoomlaSite(siteDir);
      writeFileSync(
        join(siteDir, 'php-warning.php'),
        '<?php echo "Warning: simulated failure in /var/www/html/php-warning.php on line 1";',
        'utf8'
      );

      const outFile = join(tmp.dir, 'home.json');
      const okRes = await runCliProcess([
        'fetch',
        '/',
        '--joomla',
        `--site=${siteDir}`,
        '--headers',
        `--output=${outFile}`,
        '--verify-status=200',
        '--fail-on-php-error',
        '--json',
      ]);

      assert.equal(okRes.exitCode, 0, okRes.stderr);
      const payload = JSON.parse(okRes.stdout.trim());
      assert.equal(payload.data.status, 200);
      assert.equal(payload.data.path, '/');
      assert.equal(payload.data.output, outFile);
      assert.ok(payload.data.bytes > 0);
      assert.ok(payload.data.headers);
      assert.deepEqual(payload.data.phpErrors, []);
      assert.equal(JSON.parse(readFileSync(outFile, 'utf8')).cms, 'joomla-fixture');

      // Status mismatch must fail non-zero with fetch_status_mismatch.
      const mismatchRes = await runCliProcess([
        'fetch',
        '/administrator/missing',
        '--joomla',
        `--site=${siteDir}`,
        '--verify-status=200',
        '--json',
      ]);
      assert.notEqual(mismatchRes.exitCode, 0);
      assert.equal(JSON.parse(mismatchRes.stderr.trim()).error.code, 'fetch_status_mismatch');

      // PHP error in body must fail non-zero when --fail-on-php-error is set.
      const phpErrRes = await runCliProcess([
        'fetch',
        '/php-warning.php',
        '--joomla',
        `--site=${siteDir}`,
        '--verify-status=200',
        '--fail-on-php-error',
        '--json',
      ]);
      assert.notEqual(phpErrRes.exitCode, 0);
      assert.equal(JSON.parse(phpErrRes.stderr.trim()).error.code, 'php_error_detected');
    } finally {
      tmp.cleanup();
    }
  });
});
