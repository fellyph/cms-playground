// Shared E2E test helpers for @cms-playground/cli.
// Inspired by @wp-playground/cli's end-to-end test harness.

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI_BIN = join(ROOT_DIR, 'packages/cli/bin/cms-playground.mjs');

/**
 * Finds an available local TCP port on 127.0.0.1.
 */
export async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => {
        if (err) {
          rejectPort(err);
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

/**
 * Creates a temporary directory and returns { dir, cleanup }.
 */
export function createTempDir(prefix = 'cms-playground-e2e-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs the cms-playground CLI binary to completion and resolves with { exitCode, stdout, stderr }.
 */
export function runCliProcess(args, { cwd = ROOT_DIR, env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      [CLI_BIN, ...args],
      {
        cwd,
        env: { ...process.env, ...env },
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolveResult({ exitCode, stdout, stderr, error });
      }
    );
  });
}

/**
 * Spawns `cms-playground start ...` as a child process, waits for the ready banner,
 * and returns parsed connection info plus a graceful `stop(signal)` helper.
 */
export async function startCliServer(
  args,
  { cwd = ROOT_DIR, env = {}, startupTimeoutMs = 120_000 } = {}
) {
  const child = spawn(process.execPath, [CLI_BIN, 'start', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let exited = false;
  let exitInfo = null;

  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      resolveExit(exitInfo);
    });
  });

  const ready = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectReady(
        new Error(
          `Timed out after ${startupTimeoutMs}ms waiting for cms-playground start.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
        )
      );
    }, startupTimeoutMs);

    const checkReady = () => {
      const siteMatch = stdout.match(/^\s*Site:\s+(http:\/\/[^\s/]+)\/?$/m);
      const adminMatch = stdout.match(/^\s*Admin:\s+(http:\/\/[^\s]+)$/m);
      const loginMatch = stdout.match(/^\s*Login:\s+(\S+)\s+\/\s+(\S+)$/m);

      if (siteMatch && adminMatch && loginMatch && stdout.includes('Press Ctrl+C to stop.')) {
        clearTimeout(timer);
        resolveReady({
          url: siteMatch[1],
          adminUrl: adminMatch[1],
          username: loginMatch[1],
          password: loginMatch[2],
        });
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      checkReady();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectReady(
        new Error(
          `cms-playground start exited early (code=${code}, signal=${signal}).\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
        )
      );
    });
  });

  return {
    ...ready,
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    async stop(signal = 'SIGTERM', timeoutMs = 15_000) {
      if (exited) {
        return exitInfo;
      }

      child.kill(signal);

      const result = await Promise.race([
        exitPromise,
        new Promise((_, rejectTimeout) =>
          setTimeout(() => {
            child.kill('SIGKILL');
            rejectTimeout(new Error(`Timed out waiting for cms-playground to exit on ${signal}`));
          }, timeoutMs)
        ),
      ]);

      return result;
    },
  };
}

/**
 * Creates a lightweight local Joomla-compatible site fixture for fast offline E2E tests.
 */
export function createMockJoomlaSite(dir) {
  mkdirSync(join(dir, 'cli'), { recursive: true });
  mkdirSync(join(dir, 'administrator'), { recursive: true });

  writeFileSync(
    join(dir, 'configuration.php'),
    `<?php
class JConfig {
    public $sitename = 'Mock Joomla';
    public $live_site = '';
    public $tmp_path = '';
    public $log_path = '';
    public $debug = false;
}
`
  );

  writeFileSync(
    join(dir, 'index.php'),
    `<?php
require_once __DIR__ . '/configuration.php';
$cfg = new JConfig();
header('Content-Type: application/json');
echo json_encode([
    'cms' => 'joomla-fixture',
    'sitename' => $cfg->sitename,
    'live_site' => $cfg->live_site,
    'debug' => $cfg->debug,
    'uri' => $_SERVER['REQUEST_URI'] ?? '/',
    'php' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
    'pdo_sqlite' => extension_loaded('pdo_sqlite'),
    'zip' => class_exists('ZipArchive'),
]);
`
  );

  writeFileSync(
    join(dir, 'administrator', 'index.php'),
    `<?php echo "Mock Joomla Admin";`
  );

  writeFileSync(
    join(dir, 'cli', 'joomla.php'),
    `<?php
$args = array_slice($argv, 1);
if (($args[0] ?? '') === 'fail') {
    fwrite(STDERR, "simulated cli error\\n");
    exit(42);
}
echo json_encode(['entrypoint' => 'cli/joomla.php', 'args' => $args]) . "\\n";
`
  );
}

/**
 * Creates a lightweight local WordPress-compatible site fixture for fast offline E2E tests.
 */
export function createMockWordPressSite(dir) {
  mkdirSync(join(dir, 'wp-content', 'plugins'), { recursive: true });
  mkdirSync(join(dir, 'wp-admin'), { recursive: true });

  writeFileSync(
    join(dir, 'wp-config.php'),
    `<?php
define('DB_NAME', 'wordpress');
`
  );

  writeFileSync(
    join(dir, 'index.php'),
    `<?php
require_once __DIR__ . '/wp-config.php';
header('Content-Type: application/json');
echo json_encode([
    'cms' => 'wp-fixture',
    'uri' => $_SERVER['REQUEST_URI'] ?? '/',
    'php' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
    'custom_const' => defined('E2E_CUSTOM_CONST') ? E2E_CUSTOM_CONST : null,
    'pdo_sqlite' => extension_loaded('pdo_sqlite'),
]);
`
  );
}
