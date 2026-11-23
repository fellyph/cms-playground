// The CLI depends on every adapter, and each adapter depends on core.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const cli = JSON.parse(readFileSync(new URL('../packages/cli/package.json', import.meta.url)));
const core = '@cms-playground/core';
const adapters = Object.keys(cli.dependencies).filter(name => name.startsWith('@cms-playground/') && name !== core);
const allowedFlags = new Set(['--dry-run', '--provenance']);
const args = process.argv.slice(2);
if (args.some((arg) => !allowedFlags.has(arg))) {
  throw new Error('Usage: npm run release:publish [-- --dry-run] [-- --provenance]');
}

for (const name of [core, ...adapters, cli.name]) {
  console.log(`Publishing ${name}`);
  execFileSync(process.execPath, [
    process.env.npm_execpath, 'publish', '--workspace', name,
    '--access', 'public', '--registry=https://registry.npmjs.org/', ...args,
  ], { stdio: 'inherit' });
}
