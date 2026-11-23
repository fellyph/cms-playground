import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { EXIT_CODES } from '@cms-playground/core';
import { parseCliArgs } from '../src/cli.js';
import { extractPhpErrors, fetchPlaygroundPage } from '../src/fetch.js';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cms-playground-fetch-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const mockAdapter = {
  name: 'joomla',
  label: 'Joomla',
  defaultVersion: '5.4',
  defaultPhp: '8.4',
};

describe('@cms-playground/cli fetch command', () => {
  it('parses fetch [path] with --status, --headers, --output, --verify-status, and --fail-on-php-error', () => {
    const parsed = parseCliArgs([
      'fetch',
      '/administrator',
      '--joomla',
      '--auto-mount',
      '--status',
      '--headers',
      '--output=./page.html',
      '--verify-status=200',
      '--fail-on-php-error',
      '--json',
    ]);

    assert.equal(parsed.command, 'fetch');
    assert.equal(parsed.subcommand, '/administrator');
    assert.equal(parsed.cms, 'joomla');
    assert.equal(parsed.options.autoMount, true);
    assert.equal(parsed.options.status, true);
    assert.equal(parsed.options.headers, true);
    assert.equal(parsed.options.output, './page.html');
    assert.equal(parsed.options.verifyStatus, 200);
    assert.equal(parsed.options.failOnPhpError, true);
    assert.equal(parsed.options.json, true);

    assert.throws(
      () => parseCliArgs(['fetch', '--joomla', '--verify-status=999']),
      (err) => err.exitCode === EXIT_CODES.VALIDATION
    );
  });

  it('extracts unique PHP error lines cleanly', () => {
    const errors = extractPhpErrors(
      'Notice: Undefined variable $x in /a.php on line 2\n' +
        'Fatal error: Call to undefined function foo() in /a.php on line 5\n' +
        'Notice: Undefined variable $x in /a.php on line 2\n'
    );
    assert.equal(errors.length, 2);
    assert.match(errors[0], /Notice: Undefined variable/);
    assert.match(errors[1], /Fatal error: Call to undefined function/);
  });

  it('fetches a route, writes --output, returns headers when requested, and always closes instance', async () => {
    const dir = makeTempDir();
    const outFile = join(dir, 'nested', 'out.html');
    let closed = false;

    const { result } = await fetchPlaygroundPage({
      adapter: mockAdapter,
      path: 'hello',
      showStatus: true,
      showHeaders: true,
      outputPath: outFile,
      verifyStatus: 200,
      failOnPhpError: true,
      log: () => {},
      startPlaygroundImpl: async () => ({
        url: 'http://127.0.0.1:9999',
        version: '5.4',
        phpVersion: '8.4',
        close: async () => {
          closed = true;
        },
      }),
      fetchImpl: async (url) => {
        assert.equal(url, 'http://127.0.0.1:9999/hello');
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          arrayBuffer: async () => Buffer.from('<h1>OK</h1>'),
        };
      },
    });

    assert.equal(closed, true);
    assert.equal(result.path, '/hello');
    assert.equal(result.status, 200);
    assert.equal(result.bytes, 11);
    assert.equal(result.output, outFile);
    assert.equal(result.headers['content-type'], 'text/html; charset=utf-8');
    assert.deepEqual(result.phpErrors, []);
    assert.equal(existsSync(outFile), true);
    assert.equal(readFileSync(outFile, 'utf8'), '<h1>OK</h1>');
  });

  it('throws on --verify-status mismatch and --fail-on-php-error while still closing instance', async () => {
    let closeCount = 0;
    const makeStart = () => async () => ({
      url: 'http://127.0.0.1:9999',
      version: '5.4',
      phpVersion: '8.4',
      close: async () => {
        closeCount++;
      },
    });

    await assert.rejects(
      () =>
        fetchPlaygroundPage({
          adapter: mockAdapter,
          path: '/missing',
          verifyStatus: 200,
          log: () => {},
          startPlaygroundImpl: makeStart(),
          fetchImpl: async () => ({
            status: 404,
            statusText: 'Not Found',
            headers: new Headers(),
            arrayBuffer: async () => Buffer.from('Not Found'),
          }),
        }),
      (err) => err.code === 'fetch_status_mismatch' && err.exitCode === EXIT_CODES.UNKNOWN
    );

    await assert.rejects(
      () =>
        fetchPlaygroundPage({
          adapter: mockAdapter,
          path: '/',
          verifyStatus: 200,
          failOnPhpError: true,
          log: () => {},
          startPlaygroundImpl: makeStart(),
          fetchImpl: async () => ({
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            arrayBuffer: async () => Buffer.from('Warning: Division by zero in /index.php on line 3'),
          }),
        }),
      (err) => err.code === 'php_error_detected' && err.exitCode === EXIT_CODES.UNKNOWN
    );

    assert.equal(closeCount, 2);
  });
});
