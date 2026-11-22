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

# Mount a local extension / plugin directory while developing
npx cms-playground start --joomla --mount=./my-plugin:/var/www/html/plugins/system/myplugin
npx cms-playground start --wp --mount=./my-plugin:/var/www/html/wp-content/plugins/my-plugin

# Run a Blueprint JSON (local file or URL)
npx cms-playground start --joomla --blueprint=./blueprint.json

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

- [`packages/core`](packages/core) (`@cms-playground/core`): Shared `@php-wasm/node` bootstrap, request serialization queue, HTTP server, bundle cache (`~/.cache/cms-playground`), `NODEFS` mounts, and base Blueprint runner.
- [`packages/joomla`](packages/joomla) (`@cms-playground/joomla`): Joomla adapter using pre-installed SQLite bundles from `joomla-projects/joomla-playground`, on-demand `/media/*` static caching, SEF rewrites, and `cli/joomla.php` support.
- [`packages/wordpress`](packages/wordpress) (`@cms-playground/wordpress`): WordPress adapter using official WordPress zips + `sqlite-database-integration`, auto-install on SQLite, and WordPress blueprint steps.
- [`packages/cli`](packages/cli) (`@cms-playground/cli`): Unified CLI entrypoint (`cms-playground`).

## Testing

```bash
npm test
```

The test suite verifies all package unit tests, a live PHP 8.4 WebAssembly HTTP server test, and automated documentation tests (`tests/docs.test.mjs`) that validate every CLI command, Blueprint JSON example, and Markdown link in the docs.
