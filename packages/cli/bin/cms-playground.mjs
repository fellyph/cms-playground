#!/usr/bin/env node

import { run } from '../src/cli.js';

try {
  const exitCode = await run(process.argv.slice(2));

  if (typeof exitCode === 'number') {
    process.exit(exitCode);
  }
} catch (error) {
  console.error(`Error: ${error?.message ?? error}`);
  process.exit(1);
}
