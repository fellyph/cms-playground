# `@cms-playground` Roadmap

A phased roadmap for `@cms-playground`, modeled on [`@wp-playground/cli`](https://wordpress.github.io/wordpress-playground/developers/local-development/wp-playground-cli/) and adapted for a multi-CMS WebAssembly architecture (`--joomla`, `--wp`, and future CMS adapters).

---

## Current State — v0.1 (Completed)

- [x] Monorepo workspace (`@cms-playground/core`, `@cms-playground/cli`, `@cms-playground/joomla`, `@cms-playground/wordpress`)
- [x] Adapter registry (`--joomla[=<ver>]`, `--wp[=<ver>]`, `--wordpress[=<ver>]`)
- [x] `start` command with `@php-wasm/node`, serialized `PHPRequestHandler`, and local bundle caching (`~/.cache/cms-playground/`)
- [x] `cli` command passthrough for Joomla (`cli/joomla.php`)
- [x] `list` command showing registered adapters and supported PHP versions
- [x] `--php`, `--port`, `--host`, `--site`, `--mount`, `--blueprint`, `--quiet`
- [x] Unit tests and live PHP 8.4 WebAssembly HTTP server test

---

## Phase 1 — Core CLI & Local Dev Parity (`v0.2`)

*Goal: match the everyday local development workflow of `@wp-playground/cli server`.*

- [ ] **`--auto-mount` (zero-config extension/plugin development)**
  - **Joomla:** detect XML manifests (`<extension type="component|module|plugin|template">`) in CWD, mount into the right `/var/www/html/...` path, and run Joomla Discover & Install automatically.
  - **WordPress:** detect plugin headers, theme `style.css`, or `wp-content/` in CWD, mount into `wp-content/plugins|themes`, and activate automatically.
- [ ] **Mount lifecycle ordering (`--mount-before-install` vs `--mount`)**
  - Allow mounting custom config files, DB drop-ins, or core overrides *before* `adapter.configure()` runs.
- [ ] **`--login` auto-login convenience**
  - Provide a local `/__login` redirect or auto-authenticated session so developers don't have to paste credentials on every ephemeral start.
- [ ] **`run-blueprint` command**
  - Execute a Blueprint headlessly without starting an HTTP server (ideal for CI, smoke tests, and scripted site setup).
- [ ] **`build-snapshot` command**
  - Boot a CMS, execute a Blueprint, and export a portable `.zip` snapshot (replacing bespoke build scripts).
- [ ] **`--verbosity=quiet|normal|debug` & `--open`**
  - Control logging granularity and optionally open the site/admin URL in the default browser on startup.

---

## Phase 2 — Full Blueprints & Native CMS CLIs (`v0.3`)

*Goal: feature-complete Blueprints and native CLI tooling across both CMSs.*

- [ ] **Joomla Blueprint steps parity**
  - Port remaining steps from `joomla-playground`: `installExtension`, `enableExtension`, `disableExtension`, `importSampleData`, `installLanguage`, `setSiteLanguage`, `addModule`, `addArticle`, `addUserGroup`, `indexSmartSearch`.
- [ ] **WordPress Blueprint steps parity**
  - Add `installPlugin`, `installTheme`, `importWxr`, `login`, and `wp-cli` steps compatible with WordPress Playground Blueprints.
- [ ] **WP-CLI support (`cms-playground cli --wp -- <args>`)**
  - Download and cache `wp-cli.phar` automatically so `cms-playground cli --wp -- plugin list` works identically to `cms-playground cli --joomla -- user:list`.
- [ ] **Cross-CMS Blueprint conventions**
  - Support portable core steps (`runPHP`, `writeFile`, `mkdir`, `unzip`, `runSql`) alongside CMS-specific steps, with JSON Schema validation and clear error messages.
- [ ] **Persistent `--site` management**
  - Add `--reset` flag and safe lock/dirty checks when reusing a local `--site=<dir>`.

---

## Phase 3 — Performance, Debugging & Dev Ergonomics (`v0.4`)

*Goal: match `@wp-playground/cli`'s advanced runtime and debugging capabilities.*

- [ ] **Multi-worker PHP pool (`--workers=N`)**
  - Support multiple `@php-wasm/node` workers (like `@php-wasm`'s `PHPProcessManager`) so concurrent browser/AJAX requests execute in parallel instead of queuing behind a single instance.
- [ ] **Step debugging (`--xdebug`)**
  - Integrate `@php-wasm`'s Xdebug support so VS Code and PhpStorm can attach to PHP running inside WebAssembly.
- [ ] **Local Mail Capture (`/__mail`)**
  - Intercept `sendmail` via `@php-wasm/util`'s `createSpawnHandler` and expose captured emails in the terminal or at a local `/__mail` dev inbox endpoint.
- [ ] **Symlink & Watch helpers (`--follow-symlinks`)**
  - Support symlinks inside mounted directories for monorepo/Composer-linked extensions and plugins.

---

## Phase 4 — CI, Quality & npm Distribution (`v0.5`)

*Goal: rock-solid reliability and one-command `npx` installation.*

- [ ] **GitHub Actions CI**
  - Run unit tests and end-to-end integration tests that boot real Joomla and WordPress instances over HTTP on Linux, macOS, and Windows.
- [ ] **npm Publishing**
  - Publish `@cms-playground/core`, `@cms-playground/joomla`, `@cms-playground/wordpress`, and `@cms-playground/cli` to npm so `npx @cms-playground/cli start --joomla` works anywhere.
- [ ] **Reusable GitHub Action**
  - Provide a GitHub Action for extension/plugin repositories to run automated Playwright/PHP tests against ephemeral Joomla or WordPress instances in CI.

---

## Phase 5 — Pluggable Multi-CMS Ecosystem (`v1.0`)

*Goal: make `@cms-playground` an extensible platform beyond Joomla and WordPress.*

- [ ] **Dynamic adapter discovery**
  - Auto-load third-party adapters installed as `@cms-playground/*` or `cms-playground-adapter-*` (or passed via `--adapter=<pkg>`).
- [ ] **Additional CMS adapters**
  - `@cms-playground/drupal` (SQLite-native Drupal)
  - `@cms-playground/typo3`
  - `@cms-playground/laravel` (for PHP framework previews)
- [ ] **Unified Blueprint & Browser bridge**
  - Share adapter Blueprint definitions between `@cms-playground/cli` and browser-based playgrounds (such as `joomla-playground`).
