import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DOCUMENT_ROOT,
  EXIT_CODES,
  PlaygroundError,
  bootPhp,
  classifyError,
  formatJsonPointer,
  loadBlueprint,
  runBlueprint,
  toErrorPayload,
} from '../src/index.js';

describe('@cms-playground/core structured errors & exit codes', () => {
  it('defines stable classified exit codes', () => {
    assert.deepEqual(EXIT_CODES, {
      OK: 0,
      UNKNOWN: 1,
      VALIDATION: 2,
      NOT_FOUND: 20,
      CONFLICT: 30,
      NETWORK: 40,
      TIMEOUT: 50,
      CANCELLED: 130,
    });
  });

  it('formats RFC 6901 JSON pointers with ~ and / escaping', () => {
    assert.equal(formatJsonPointer(), '');
    assert.equal(formatJsonPointer('steps', 2, 'plugin'), '/steps/2/plugin');
    assert.equal(formatJsonPointer('a/b', 'c~d'), '/a~1b/c~0d');
  });

  it('classifies Node system/fetch errors into structured payloads', () => {
    const portErr = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const portClassified = classifyError(portErr, { cms: 'joomla' });
    assert.equal(portClassified.code, 'port_in_use');
    assert.equal(portClassified.exitCode, EXIT_CODES.CONFLICT);
    assert.equal(portClassified.retryable, false);
    assert.equal(portClassified.recovery, 'cms-playground start --joomla --port=0');

    const timeoutErr = new DOMException('Timed out', 'TimeoutError');
    const timeoutClassified = classifyError(timeoutErr);
    assert.equal(timeoutClassified.code, 'timeout');
    assert.equal(timeoutClassified.exitCode, EXIT_CODES.TIMEOUT);
    assert.equal(timeoutClassified.retryable, true);

    const netErr = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    });
    const netClassified = classifyError(netErr);
    assert.equal(netClassified.code, 'network_error');
    assert.equal(netClassified.exitCode, EXIT_CODES.NETWORK);
    assert.equal(netClassified.retryable, true);

    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    assert.equal(classifyError(enoentErr).exitCode, EXIT_CODES.NOT_FOUND);

    const unknown = classifyError(new Error('boom'));
    assert.equal(unknown.code, 'unknown_error');
    assert.equal(unknown.exitCode, EXIT_CODES.UNKNOWN);
  });

  it('serializes PlaygroundError with and without pointer', () => {
    const withPointer = new PlaygroundError('bad step', {
      code: 'invalid_blueprint_step',
      exitCode: EXIT_CODES.VALIDATION,
      pointer: '/steps/2/plugin',
      suggestions: ['Check step name'],
    });
    assert.deepEqual(toErrorPayload(withPointer), {
      error: {
        code: 'invalid_blueprint_step',
        message: 'bad step',
        retryable: false,
        recovery: null,
        suggestions: ['Check step name'],
        pointer: '/steps/2/plugin',
      },
    });

    const withoutPointer = new PlaygroundError('missing', {
      code: 'site_not_found',
      exitCode: EXIT_CODES.NOT_FOUND,
    });
    const payload = toErrorPayload(withoutPointer);
    assert.equal('pointer' in payload.error, false);
  });

  it('attaches RFC 6901 pointers and classified exit codes to Blueprint errors', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cms-pg-err-bp-'));
    const php = await bootPhp({ phpVersion: '8.4' });

    try {
      await assert.rejects(
        () => loadBlueprint(join(workDir, 'does-not-exist.json')),
        (err) => err instanceof PlaygroundError && err.code === 'blueprint_not_found' && err.exitCode === EXIT_CODES.NOT_FOUND
      );

      const badStepsPath = join(workDir, 'bad-steps.json');
      writeFileSync(badStepsPath, JSON.stringify({ steps: 'not-an-array' }));
      await assert.rejects(
        () => loadBlueprint(badStepsPath),
        (err) => err instanceof PlaygroundError && err.exitCode === EXIT_CODES.VALIDATION && err.pointer === '/steps'
      );

      await assert.rejects(
        () =>
          runBlueprint(
            {
              steps: [
                { step: 'mkdir', path: 'ok' },
                { step: 'unknownStep', plugin: 'foo' },
              ],
            },
            { php, documentRoot: DOCUMENT_ROOT }
          ),
        (err) =>
          err instanceof PlaygroundError &&
          err.code === 'invalid_blueprint_step' &&
          err.exitCode === EXIT_CODES.VALIDATION &&
          err.pointer === '/steps/1/step'
      );

      await assert.rejects(
        () =>
          runBlueprint(
            {
              steps: [{ step: 'writeFile', path: '../escape.txt', data: 'x' }],
            },
            { php, documentRoot: DOCUMENT_ROOT }
          ),
        (err) =>
          err instanceof PlaygroundError &&
          err.exitCode === EXIT_CODES.VALIDATION &&
          err.pointer === '/steps/0/path'
      );
    } finally {
      php.exit();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
