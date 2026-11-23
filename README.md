# `@cms-playground`

Run **Joomla**, **WordPress**, **Drupal**, **TYPO3**, and **Kirby** locally in WebAssembly (`@php-wasm/node`) with zero server or database setup.

## Usage

```bash
# Start a disposable Joomla site (downloads & caches bundle automatically)
npx @cms-playground/cli start --joomla
npx @cms-playground/cli start --joomla=5.4 --php=8.3 --port=8790

# Start a disposable WordPress site (SQLite-backed)
npx @cms-playground/cli start --wp
npx @cms-playground/cli start --wp=6.7 --php=8.4 --port=8791

# Start a disposable Drupal, TYPO3, or Kirby site
npx @cms-playground/cli start --drupal
npx @cms-playground/cli start --typo3
npx @cms-playground/cli start --kirby

# Auto-detect and mount a local Joomla extension or WordPress plugin/theme
npx @cms-playground/cli start --joomla --auto-mount
npx @cms-playground/cli start --wp --auto-mount=./my-plugin

# Mount local folders explicitly (before or after CMS configure)
npx @cms-playground/cli start --joomla --mount=./my-plugin:/var/www/html/plugins/system/myplugin
npx @cms-playground/cli start --joomla --mount-before-install=./overlay:/var/www/html/overlay

# Run a Blueprint (interactive, headless, or export as a .zip snapshot)
npx @cms-playground/cli start --joomla --blueprint=./blueprint.json
npx @cms-playground/cli run-blueprint --joomla --blueprint=./blueprint.json
npx @cms-playground/cli build-snapshot --joomla --blueprint=./blueprint.json --output=./snapshot.zip

# Persist a local site directory, bind a custom host, or control log verbosity
npx @cms-playground/cli start --joomla --site=./my-site --host=127.0.0.1 --verbosity=debug
npx @cms-playground/cli run-blueprint --wp --blueprint=./blueprint.json --quiet

# Run Joomla's own CLI (cli/joomla.php) without local PHP
npx @cms-playground/cli cli --joomla -- user:list

# Install the bundled Agent Skill and configure MCP for coding agents
npx @cms-playground/cli setup agent --dry-run

# List available CMS adapters
npx @cms-playground/cli list
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
- [`packages/drupal`](packages/drupal) (`@cms-playground/drupal`): Drupal adapter using official Drupal zips, automatic SQLite installation, `*.info.yml` module/theme `--auto-mount`, and Drupal blueprint steps.
- [`packages/typo3`](packages/typo3) (`@cms-playground/typo3`): TYPO3 adapter using official TYPO3 release zips, non-interactive SQLite setup, `ext_emconf.php`/`composer.json` `--auto-mount`, and native `typo3` CLI support.
- [`packages/kirby`](packages/kirby) (`@cms-playground/kirby`): Kirby adapter using the official Starterkit (flat-file, zero DB), automatic Panel admin account creation, plugin/site/content `--auto-mount`, and Kirby blueprint steps.
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

## Publishing the npm workspaces

Use Node.js 24.18+ and npm 11.16+. From the repository root:

```sh
npm ci
npm test
npm run release:check
npm run release:preview
npm run release:publish -- --dry-run
npm login --registry=https://registry.npmjs.org/
npm run release:publish
```

`npm run release:check` validates that workspace versions and internal dependency pins match and that no test or temporary files leak into any tarball. The publish command releases core, then the adapters, then the CLI to the public npm registry. If publishing stops midway, check each version with `npm view <package>@<version> version --registry=https://registry.npmjs.org/`. Resume with `npm publish -w <package> --access public --registry=https://registry.npmjs.org/` for each remaining workspace in the same order.

For a subsequent release, start from the last released revision and run `npm run release:patch`, `npm run release:minor`, or `npm run release:major` once. This bumps the workspaces, aligns internal dependency pins, and refreshes the lockfile. Review and commit those changes, then push a matching `vX.Y.Z` tag to trigger `.github/workflows/release.yml` (which verifies tests and tarballs, publishes with `--provenance`, and creates a GitHub Release), or run the workflow manually with `dry_run` enabled to test the release pipeline first. From an empty directory, verify the published CLI with `npx @cms-playground/cli list` and `npx @cms-playground/cli start --wp`.
