import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bootPhp,
  createRequestQueue,
  packZip,
  randomPassword,
  runPhpCode,
  unpackZip,
} from '../src/index.js';

describe('@cms-playground/core runtime', () => {
  it('serializes overlapping tasks in createRequestQueue and recovers after errors', async () => {
    const enqueue = createRequestQueue();
    const events = [];
    let active = 0;
    let maxConcurrent = 0;

    const task = (name, delayMs, shouldFail = false) =>
      enqueue(async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        events.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, delayMs));
        events.push(`end:${name}`);
        active -= 1;

        if (shouldFail) {
          throw new Error(`failed:${name}`);
        }

        return `ok:${name}`;
      });

    const p1 = task('first', 20);
    const p2 = task('second', 10, true);
    const p3 = task('third', 5);

    assert.equal(await p1, 'ok:first');
    await assert.rejects(() => p2, /failed:second/);
    assert.equal(await p3, 'ok:third');

    assert.equal(maxConcurrent, 1);
    assert.deepEqual(events, [
      'start:first',
      'end:first',
      'start:second',
      'end:second',
      'start:third',
      'end:third',
    ]);
  });

  it('round-trips files and directories through packZip and unpackZip and rejects corrupt archives', async () => {
    const php = await bootPhp({ phpVersion: '8.4' });

    try {
      php.mkdir('/tmp/roundtrip-src/a/b');
      php.mkdir('/tmp/roundtrip-src/empty-dir');
      php.writeFile('/tmp/roundtrip-src/root.txt', 'root-content');
      php.writeFile('/tmp/roundtrip-src/a/b/nested.txt', 'nested-content-123');

      const zipBytes = await packZip(php, '/tmp/roundtrip-src');
      assert.ok(zipBytes.byteLength > 0);
      assert.deepEqual(Array.from(zipBytes.subarray(0, 4)), [0x50, 0x4b, 0x03, 0x04]);

      await unpackZip(php, zipBytes, '/tmp/roundtrip-dst');
      assert.equal(php.readFileAsText('/tmp/roundtrip-dst/root.txt'), 'root-content');
      assert.equal(php.readFileAsText('/tmp/roundtrip-dst/a/b/nested.txt'), 'nested-content-123');
      assert.equal(php.isDir('/tmp/roundtrip-dst/empty-dir'), true);

      // Corrupt zip bytes should fail cleanly
      await assert.rejects(
        () => unpackZip(php, new Uint8Array([0x00, 0x01, 0x02, 0x03]), '/tmp/roundtrip-bad'),
        /Cannot open zip archive/
      );

      // runPhpCode surfaces PHP errors on non-zero exit
      await assert.rejects(() => runPhpCode(php, 'echo "fatal oops"; exit(1);'), /fatal oops/);
    } finally {
      php.exit();
    }
  });

  it('generates random passwords of requested length', () => {
    const p1 = randomPassword();
    const p2 = randomPassword(24);
    assert.equal(p1.length, 12);
    assert.equal(p2.length, 24);
    assert.notEqual(p1, randomPassword());
  });
});
