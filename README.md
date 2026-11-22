# `@cms-playground`

Run **Joomla**, **WordPress**, and other PHP CMSs locally in WebAssembly (`@php-wasm/node`) with zero server or database setup.

## Usage

```bash
# Start a disposable Joomla site (downloads & caches bundle automatically)
npx cms-playground start --joomla
npx cms-playground start --joomla=5.4 --php=8.3 --port=8790

# Start a disposable WordPress site (SQLite-backed)
npx cms-playground start --wp
npx cms-playground start --wp=6.7 --php=8.4 --port=8791

# Auto-detect and mount a local Joomla extension or WordPress plugin/theme
npx cms-playground start --joomla --auto-mount
npx cms-playground start --wp --auto-mount=./my-plugin

# Mount local folders explicitly (before or after CMS configure)
npx cms-playground start --joomla --mount=./my-plugin:/var/www/html/plugins/system/myplugin
npx cms-playground start --joomla --mount-before-install=./overlay:/var/www/html/overlay

# Run a Blueprint (interactive, headless, or export as a .zip snapshot)
npx cms-playground start --joomla --blueprint=./blueprint.json
npx cms-playground run-blueprint --joomla --blueprint=./blueprint.json
npx cms-playground build-snapshot --joomla --blueprint=./blueprint.json --output=./snapshot.zip

# Run Joomla's own CLI (cli/joomla.php) without local PHP
npx cms-playground cli --joomla -- user:list

# List available CMS adapters
npx cms-playground list
```

## Documentation

- [Getting Started](docs/GETTING-STARTED.md) — installation, commands, flags, caching, and environment variables
- [Blueprints](docs/BLUEPRINTS.md) — core, Joomla, and WordPress Blueprint steps with JSON examples
- [Writing a CMS Adapter](docs/ADAPTERS.md) — adapter contract and how to add a new CMS
- [Roadmap](ROADMAP.md) — phased plan modeled on `@wp-playground/cli`

## Workspace Structure

- [`packages/core`](packages/core) (`@cms-playground/core`): Shared `@php-wasm/node` bootstrap, request serialization queue, HTTP server, bundle cache (`~/.cache/cms-playground`), `NODEFS` mounts, snapshot packer, and base Blueprint runner.
- [`packages/joomla`](packages/joomla) (`@cms-playground/joomla`): Joomla adapter using pre-installed SQLite bundles from `joomla-projects/joomla-playground`, on-demand `/media/*` static caching, SEF rewrites, XML `--auto-mount`, and `cli/joomla.php` support.
- [`packages/wordpress`](packages/wordpress) (`@cms-playground/wordpress`): WordPress adapter using official WordPress zips + `sqlite-database-integration`, auto-install on SQLite, plugin/theme `--auto-mount`, and WordPress blueprint steps.
- [`packages/cli`](packages/cli) (`@cms-playground/cli`): Unified CLI entrypoint (`cms-playground`).

## Testing

```bash
# Unit tests, PHP-WASM core tests, and automated docs tests
npm test

# Fast offline CLI end-to-end tests (spawns real cms-playground processes)
npm run test:e2e:cli

# Live end-to-end tests against real Joomla and WordPress bundles
npm run test:e2e:joomla
npm run test:e2e:wp

# All end-to-end tests
npm run test:e2e
```

The test suite verifies all package unit tests, live PHP 8.4 WebAssembly HTTP/Blueprint/snapshot tests, automated documentation tests (`tests/docs.test.mjs`), and end-to-end CLI tests (`tests/e2e/*.e2e.test.mjs`) modeled on `@wp-playground/cli`.
