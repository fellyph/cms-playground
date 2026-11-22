#!/usr/bin/env node

import { EXIT_CODES, PlaygroundError, classifyError, toErrorPayload } from '@cms-playground/core';
import { run, wantsJsonOutput } from '../src/cli.js';

const argv = process.argv.slice(2);
const jsonMode = wantsJsonOutput(argv, process.env);

function flushAndExit(code) {
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) {
      process.exit(code);
    }
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
}

const onCancel = (signal) => {
  const err = new PlaygroundError(`Command cancelled by ${signal}`, {
    code: 'cancelled',
    exitCode: EXIT_CODES.CANCELLED,
    retryable: false,
  });

  if (jsonMode) {
    process.stderr.write(`${JSON.stringify(toErrorPayload(err))}\n`);
  } else {
    process.stderr.write(`Error: ${err.message}\n`);
  }

  flushAndExit(EXIT_CODES.CANCELLED);
};

process.once('SIGINT', onCancel);
process.once('SIGTERM', onCancel);

try {
  const exitCode = await run(argv);

  process.off('SIGINT', onCancel);
  process.off('SIGTERM', onCancel);

  if (typeof exitCode === 'number') {
    flushAndExit(exitCode);
  }
} catch (error) {
  process.off('SIGINT', onCancel);
  process.off('SIGTERM', onCancel);

  const classified = classifyError(error);

  if (jsonMode) {
    process.stderr.write(`${JSON.stringify(toErrorPayload(classified))}\n`);
  } else {
    process.stderr.write(`Error: ${classified.message}\n`);
  }

  flushAndExit(classified.exitCode);
}
