# Getting Started with `@cms-playground`

`@cms-playground` lets you boot **Joomla**, **WordPress**, and other PHP CMSs locally inside WebAssembly (`@php-wasm/node`)—with no local PHP, Apache/Nginx, or MySQL installation required.

---

## Requirements

- **Node.js 22+** and **npm**
- Internet access on first run to download and cache the CMS bundle (subsequent runs reuse the local cache)

## Installation (from source)

```bash
git clone https://github.com/fellyph/cms-playground.git
cd cms-playground
npm install
```

Once installed, run the CLI via `npx cms-playground` (or `node packages/cli/bin/cms-playground.mjs`).

---

## Quick Start

### List registered CMS adapters

```bash
npx cms-playground list
```

### Start a disposable Joomla site

```bash
npx cms-playground start --joomla
npx cms-playground start --joomla=5.4 --php=8.3 --port=8790
```

When startup finishes, the CLI prints:
- **Site URL** (e.g. `http://127.0.0.1:8790/`)
- **Admin URL** (`http://127.0.0.1:8790/administrator/`)
- **Generated Super User credentials** (`admin` / `<random password>`)

### Start a disposable WordPress site

```bash
npx cms-playground start --wp
npx cms-playground start --wp=6.7 --php=8.4 --port=8791
```

`--wordpress` is also accepted as an alias for `--wp`:

```bash
npx cms-playground start --wordpress=6.7 --port=8792
```

### Mount local code while developing

Use `--mount=<hostPath>:<vfsPath>` (repeatable) to mount local extension, plugin, or theme folders directly into `/var/www/html`:

```bash
npx cms-playground start --joomla --mount=./my-plugin:/var/www/html/plugins/system/myplugin
npx cms-playground start --wp --mount=./my-plugin:/var/www/html/wp-content/plugins/my-plugin
```

### Use an existing local site directory

Use `--site=<dir>` to mount a persistent local directory instead of unpacking an ephemeral bundle into memory:

```bash
npx cms-playground start --joomla --site=./my-joomla-site --port=8790
```

### Run a Blueprint on boot

Pass a local JSON file or remote URL with `--blueprint`:

```bash
npx cms-playground start --joomla --blueprint=./blueprint.json
npx cms-playground start --wp --blueprint=https://example.org/blueprint.json
```

See [Blueprints](BLUEPRINTS.md) for all supported steps and examples.

### Run Joomla's native CLI (`cli/joomla.php`)

Pass arguments after `--` to forward them to `cli/joomla.php` inside PHP-WASM:

```bash
npx cms-playground cli --joomla -- user:list
npx cms-playground cli --joomla --site=./my-joomla-site -- cache:clean
```

---

## Command & Flag Reference

| Command | Description |
|---|---|
| `start` | Boot a CMS in PHP-WASM and start a local HTTP server |
| `cli` | Run the CMS's native CLI (e.g. `cli/joomla.php`) in PHP-WASM |
| `list` | Show registered CMS adapters and supported PHP versions |

| Flag | Default | Description |
|---|---|---|
| `--joomla[=<ver>]` | `latest` | Select Joomla (e.g. `--joomla`, `--joomla=6.2`, `--joomla=5.4`) |
| `--wp[=<ver>]` / `--wordpress[=<ver>]` | `latest` | Select WordPress (e.g. `--wp`, `--wp=6.7`) |
| `--php=<version>` | `8.4` | PHP version (`8.3`–`8.5` for Joomla; `7.4`–`8.5` for WordPress) |
| `--port=<number>` | `8790` | Local HTTP port (`0` selects a random free port) |
| `--host=<address>` | `127.0.0.1` | Local bind address |
| `--site=<dir>` | *(ephemeral)* | Mount an existing local site directory |
| `--blueprint=<src>` | *(none)* | Blueprint JSON file path or HTTP(S) URL |
| `--mount=<host:vfs>` | *(none)* | Mount a host folder into VFS (repeatable) |
| `--quiet` | `false` | Suppress request and progress logs |
| `-h`, `--help` | — | Show CLI help text |

---

## Caching & Environment Variables

Downloaded CMS zips and Joomla static `/media/*` assets are cached locally in `~/.cache/cms-playground/` (or `$XDG_CACHE_HOME/cms-playground/`).

| Environment Variable | Purpose |
|---|---|
| `CMS_PLAYGROUND_CACHE_DIR` | Override the root cache directory |
| `JOOMLA_PLAYGROUND_BASE_URL` | Override the base URL used to download Joomla bundles (defaults to `https://joomla-projects.github.io/joomla-playground/`) |
