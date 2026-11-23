# Getting Started with `@cms-playground`

`@cms-playground` lets you boot **Joomla**, **WordPress**, **Drupal**, **TYPO3**, and **Kirby** locally inside WebAssembly (`@php-wasm/node`)—with no local PHP, Apache/Nginx, or MySQL installation required.

---

## Requirements

- **Node.js 24.18+** and **npm 11.16+**
- Internet access on first run to download and cache the CMS bundle (subsequent runs reuse the local cache)

## Run from npm

```bash
npx @cms-playground/cli list
```

## Installation (from source)

```bash
git clone https://github.com/fellyph/cms-playground.git
cd cms-playground
npm install
```

Run the CLI from this checkout with `node packages/cli/bin/cms-playground.mjs list`.

---

## Quick Start

### List registered CMS adapters

```bash
npx @cms-playground/cli list
```

### Start a disposable Joomla site

```bash
npx @cms-playground/cli start --joomla
npx @cms-playground/cli start --joomla=5.4 --php=8.3 --port=8790
```

When startup finishes, the CLI prints:
- **Site URL** (e.g. `http://127.0.0.1:8790/`)
- **Admin URL** (`http://127.0.0.1:8790/administrator/`)
- **Generated Super User credentials** (`admin` / `<random password>`)

### Start a disposable WordPress site

```bash
npx @cms-playground/cli start --wp
npx @cms-playground/cli start --wp=6.7 --php=8.4 --port=8791
```

`--wordpress` is also accepted as an alias for `--wp`:

```bash
npx @cms-playground/cli start --wordpress=6.7 --port=8792
```

### Start a disposable Drupal, TYPO3, or Kirby site

```bash
npx @cms-playground/cli start --drupal
npx @cms-playground/cli start --typo3
npx @cms-playground/cli start --kirby
```

- **Drupal** (`--drupal[=<ver>]`): Downloads official Drupal core, installs on SQLite (`minimal` profile), and serves the frontend and `/user/login`.
- **TYPO3** (`--typo3[=<ver>]`): Downloads official TYPO3 (default `13`), runs SQLite setup, and serves the backend at `/typo3` (plus native `cms-playground cli --typo3 -- <args>`).
- **Kirby** (`--kirby[=<ver>]`): Downloads the official Kirby Starterkit (flat-file, zero DB), creates a Panel admin account (`admin@example.com`), and serves the frontend and `/panel`.

### Auto-mount a local extension, plugin, or theme

Use `--auto-mount` (defaults to the current working directory) or `--auto-mount=<dir>` to automatically detect, mount, and register/activate your project:

- **Joomla:** scans for an extension XML manifest (`plugin`, `module`, `template`, or `component`), mounts it into `/var/www/html/...`, and runs `cli/joomla.php extension:discover:install`.
- **WordPress:** detects a theme (`style.css`), plugin (`Plugin Name:` header), or `wp-content/` folder, mounts it into `wp-content/`, and switches the theme or activates the plugin.

```bash
npx @cms-playground/cli start --joomla --auto-mount
npx @cms-playground/cli start --joomla --auto-mount=./my-joomla-plugin
npx @cms-playground/cli start --wp --auto-mount=./my-wp-plugin
```

### Mount local folders explicitly

Use `--mount=<hostPath>:<vfsPath>` (mounted after CMS configuration) or `--mount-before-install=<hostPath>:<vfsPath>` (mounted before CMS configuration, e.g. for custom DB drop-ins or config overlays). Both flags are repeatable:

```bash
npx @cms-playground/cli start --joomla --mount=./my-plugin:/var/www/html/plugins/system/myplugin
npx @cms-playground/cli start --wp --mount=./my-plugin:/var/www/html/wp-content/plugins/my-plugin
npx @cms-playground/cli start --joomla --mount-before-install=./overlay:/var/www/html/overlay
```

### Use an existing local site directory

Use `--site=<dir>` to mount a persistent local directory instead of unpacking an ephemeral bundle into memory:

```bash
npx @cms-playground/cli start --joomla --site=./my-joomla-site --port=8790
```

### Run a Blueprint (server or headless)

Pass a local JSON file or remote URL with `--blueprint`:

```bash
# Start a server after running a Blueprint
npx @cms-playground/cli start --joomla --blueprint=./blueprint.json
npx @cms-playground/cli start --wp --blueprint=https://example.org/blueprint.json

# Run a Blueprint headlessly (no HTTP server — ideal for CI)
npx @cms-playground/cli run-blueprint --joomla --blueprint=./blueprint.json --verbosity=debug
```

See [Blueprints](BLUEPRINTS.md) for all supported steps and examples.

### Build a portable `.zip` snapshot

Use `build-snapshot` to boot a CMS, optionally run a Blueprint, and export `/var/www/html` as a `.zip` archive:

```bash
npx @cms-playground/cli build-snapshot --joomla --blueprint=./blueprint.json --output=./snapshot.zip
npx @cms-playground/cli build-snapshot --wp --output=./wp-snapshot.zip --verbosity=quiet
```

### Run Joomla's native CLI (`cli/joomla.php`)

Pass arguments after `--` to forward them to `cli/joomla.php` inside PHP-WASM:

```bash
npx @cms-playground/cli cli --joomla -- user:list
npx @cms-playground/cli cli --joomla --site=./my-joomla-site -- cache:clean
```

---

## Command & Flag Reference

| Command | Description |
|---|---|
| `start` | Boot a CMS in PHP-WASM and start a local HTTP server |
| `run-blueprint` | Run a Blueprint headlessly without starting an HTTP server |
| `build-snapshot` | Boot a CMS, optionally run a Blueprint, and export a `.zip` snapshot |
| `cli` | Run the CMS's native CLI (e.g. `cli/joomla.php`) in PHP-WASM |
| `setup agent` | Install the bundled Agent Skill and configure MCP for supported coding agents |
| `agents init` | Scaffold or idempotently update the `@cms-playground` guidance block in `AGENTS.md` |
| `mcp` | Start a local stdio MCP server for coding agents |
| `list` | Show registered CMS adapters and supported PHP versions |
| `map` | Output a machine-readable catalog of commands, adapters, and Blueprint steps |

| Flag | Default | Description |
|---|---|---|
| `--joomla[=<ver>]` | `latest` | Select Joomla (e.g. `--joomla`, `--joomla=6.2`, `--joomla=5.4`) |
| `--wp[=<ver>]` / `--wordpress[=<ver>]` | `latest` | Select WordPress (e.g. `--wp`, `--wp=6.7`) |
| `--php=<version>` | `8.4` | PHP version (`8.3`–`8.5` for Joomla; `7.4`–`8.5` for WordPress) |
| `--port=<number>` | `8790` | Local HTTP port (`0` selects a random free port) |
| `--host=<address>` | `127.0.0.1` | Local bind address |
| `--site=<dir>` | *(ephemeral)* | Mount an existing local site directory |
| `--blueprint=<src>` | *(none)* | Blueprint JSON file path or HTTP(S) URL |
| `--output=<path>` | *(none)* | Output `.zip` path for `build-snapshot` |
| `--mount=<host:vfs>` | *(none)* | Mount a host folder into VFS after configure (repeatable) |
| `--mount-before-install=<host:vfs>` | *(none)* | Mount a host folder into VFS before configure (repeatable) |
| `--auto-mount[=<dir>]` | *(off)* | Auto-detect and mount a Joomla extension or WP plugin/theme (default: CWD) |
| `--cwd=<path>` | *(process CWD)* | Resolve relative paths (`--site`, `--blueprint`, `--mount`, `--auto-mount`, `--output`) from `<path>` |
| `--json` | `false` | Emit `{ "data": ... }` JSON receipts to `stdout` and `{ "error": ... }` JSON errors to `stderr` |
| `--paths` | `false` | Print canonical command invocations one per line (for `map`) |
| `--verbosity=<level>` | `normal` | Logging level: `quiet`, `normal`, or `debug` |
| `--quiet` | `false` | Alias for `--verbosity=quiet` |
| `-h`, `--help` | — | Show CLI help text |

### `setup agent` Flags

| Flag | Default | Description |
|---|---|---|
| `--agent <id>` | `auto` | Target agent (`auto`, `all`, `claude-code`, `cursor`, `codex`, `vscode`, `antigravity`, `generic`) |
| `-p`, `--project` | `false` | Install skill and MCP config into the current project |
| `-y`, `--yes` | `false` | Skip confirmation prompts |
| `--skip-mcp` | `false` | Install the bundled skill without writing MCP config |
| `--dry-run` | `false` | Preview planned file and config changes without writing |
| `--force` | `false` | Overwrite locally modified skill files |

### Machine-Readable Output & Exit Codes

Pass `--json` (or set `CMS_PLAYGROUND_AGENT=1` / `CI=1`) to enable agent mode: `stdout` receives a single `{ "data": ... }` JSON receipt, `stderr` receives structured `{ "error": { code, message, retryable, recovery, suggestions, pointer? } }` objects on failure, interactive prompts are disabled, and ANSI colors are suppressed.

```bash
npx @cms-playground/cli list --json
npx @cms-playground/cli map --json
npx @cms-playground/cli map --paths
npx @cms-playground/cli start --joomla --port=0 --json
npx @cms-playground/cli run-blueprint --wp --cwd=./my-site --site=. --blueprint=./blueprint.json --json
```

| Exit Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Unknown error |
| `2` | Validation error (bad flags/args or invalid Blueprint) |
| `20` | Not found (missing `--site`, `--blueprint`, `--cwd`, `--mount`, or auto-mount target) |
| `30` | Conflict (e.g. port already in use or locally modified skill file without `--force`) |
| `40` | Network error (bundle or asset download failed; retryable) |
| `50` | Timeout (retryable) |
| `130` | Cancelled (`SIGINT`/`SIGTERM` or declined confirmation prompt) |

---

## Coding Agent Setup

Install the bundled `cms-playground` Agent Skill and configure MCP for detected coding agents (Claude Code, Cursor, Codex, VS Code, Antigravity, or generic `.mcp.json`):

```bash
# Preview changes without writing files
npx @cms-playground/cli setup agent --dry-run

# Auto-detect clients and install into the current project
npx @cms-playground/cli setup agent -y --project

# Install skill only for a specific client
npx @cms-playground/cli setup agent --agent cursor --skip-mcp

# Start the local stdio MCP server directly
npx @cms-playground/cli mcp

# Scaffold or update the @cms-playground block in AGENTS.md
npx @cms-playground/cli agents init
npx @cms-playground/cli agents init --dry-run --json
```

---

## Caching & Environment Variables

Downloaded CMS zips and Joomla static `/media/*` assets are cached locally in `~/.cache/cms-playground/` (or `$XDG_CACHE_HOME/cms-playground/`).

| Environment Variable | Purpose |
|---|---|
| `CMS_PLAYGROUND_AGENT=1` | Enable agent mode (`--json`, non-interactive, no ANSI colors) |
| `CI=1` | Enable agent mode (`--json`, non-interactive, no ANSI colors) |
| `CMS_PLAYGROUND_CACHE_DIR` | Override the root cache directory |
| `JOOMLA_PLAYGROUND_BASE_URL` | Override the base URL used to download Joomla bundles (defaults to `https://joomla-projects.github.io/joomla-playground/`) |
