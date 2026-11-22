---
name: cms-playground
description: "Run Joomla, WordPress, and other PHP CMSs locally in WebAssembly (@php-wasm/node) using @cms-playground/cli with zero server or database setup. Use when an agent needs to boot a disposable PHP CMS instance, auto-mount a local extension/plugin/theme, run headless Blueprints, execute native CMS CLIs (cli/joomla.php), or export .zip snapshots."
---

# `@cms-playground`

Use `@cms-playground/cli` (`npx @cms-playground/cli` or `cms-playground`) to boot disposable or persistent PHP CMS environments inside Node.js WebAssembly (`@php-wasm/node`)—no Apache, Nginx, MySQL, Docker, or local PHP installation required.

## Supported CMS Adapters

Pick exactly one CMS flag per command:

- `--joomla[=<ver>]` — Joomla (SQLite pre-installed bundles, `cli/joomla.php`)
- `--wp[=<ver>]` (or `--wordpress[=<ver>]`) — WordPress (SQLite database integration)

Run `cms-playground list` to inspect all registered adapters and their supported PHP versions.

## Common Workflows

### 1. Start a local CMS server

```bash
# Disposable instance (downloads & caches bundle in ~/.cache/cms-playground)
cms-playground start --joomla
cms-playground start --wp=6.7 --php=8.4 --port=8791

# Reuse a persistent local directory
cms-playground start --joomla --site=./my-joomla-site
```

### 2. Develop & test a local extension, plugin, or theme

Use `--auto-mount` to detect the project in CWD (or a given directory), mount it into the right VFS path, and install/activate it automatically:

```bash
cms-playground start --joomla --auto-mount
cms-playground start --wp --auto-mount=./my-plugin
```

For explicit mounts:

- `--mount=<host:vfs>` — mounted **after** CMS configuration (repeatable)
- `--mount-before-install=<host:vfs>` — mounted **before** CMS configuration (for config/DB overrides)

### 3. Run Blueprints headlessly (CI & automation)

Execute a Blueprint JSON file or URL without starting an HTTP server:

```bash
cms-playground run-blueprint --joomla --blueprint=./blueprint.json
cms-playground run-blueprint --wp --auto-mount --blueprint=./setup.json
```

### 4. Build a portable `.zip` snapshot

```bash
cms-playground build-snapshot --joomla --blueprint=./blueprint.json --output=./snapshot.zip
```

### 5. Run the CMS's native CLI without local PHP

Pass native CLI arguments after `--`:

```bash
cms-playground cli --joomla -- user:list
cms-playground cli --joomla --site=./my-joomla-site -- cache:clean
```

## Tips for Agents

- Use `--verbosity=quiet` (or `--quiet`) when you only need clean command output, and `--verbosity=debug` when diagnosing boot or Blueprint issues.
- Use `--port=0` (or pick a distinct `--port`) if port `8790` is already in use by another instance.
- Bundles are cached automatically under `~/.cache/cms-playground` (override with `CMS_PLAYGROUND_CACHE_DIR`).
- For Blueprint JSON schemas and CMS-specific steps, read `references/blueprints.md`.
