# Hands-On Tutorial: Testing CMSs Locally with `@cms-playground`

This step-by-step tutorial walks you through running the `@cms-playground` CLI locally, spinning up and testing all five built-in CMSs (**Joomla**, **WordPress**, **Drupal**, **TYPO3**, and **Kirby**), automating setup with a Blueprint, mounting local code, running native CMS CLI commands, and exporting a `.zip` snapshot.

No local PHP, Apache/Nginx, or MySQL/MariaDB server is required—everything runs inside WebAssembly (`@php-wasm/node`).

---

## Prerequisites

- **Node.js 22+** and **npm**
- Internet access on first run so the CLI can download and cache each CMS bundle in `~/.cache/cms-playground/`

---

## Step 1: Set Up and Verify the CLI

Clone the repository and install workspace dependencies:

```bash
git clone https://github.com/fellyph/cms-playground.git
cd cms-playground
npm install
```

Verify the CLI is working by listing the registered CMS adapters and supported PHP versions:

```bash
npx cms-playground list
```

Expected output:

```text
--joomla     Joomla       PHP: 8.3, 8.4, 8.5 (default 8.4)
--wp         WordPress    PHP: 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, 8.5 (default 8.4)
--drupal     Drupal       PHP: 8.3, 8.4, 8.5 (default 8.4)
--typo3      TYPO3        PHP: 8.2, 8.3, 8.4 (default 8.4)
--kirby      Kirby        PHP: 8.2, 8.3, 8.4, 8.5 (default 8.4)
```

> **Tip:** You can also run the CLI directly from source with `node packages/cli/bin/cms-playground.mjs <command>` or via the workspace shortcuts (`npm run start:joomla`, `npm run start:wp`, `npm run start:drupal`, `npm run start:typo3`, `npm run start:kirby`).

---

## Step 2: Launch and Test the Main CMSs

Each `start` command boots an isolated PHP-WASM instance, downloads and caches the CMS bundle (on first run), configures a local database or flat-file store, generates a random admin password, and starts a local HTTP server. Press **Ctrl+C** when you are done testing a site.

### 1. Joomla

```bash
npx cms-playground start --joomla --port=8790
```

Startup output:

```text
Booting PHP 8.4 (WebAssembly)...
Unpacking Joomla 6.2.0...
Configuring Joomla...

Joomla 6.2.0 (PHP 8.4) is running:
  Site:  http://127.0.0.1:8790/
  Admin: http://127.0.0.1:8790/administrator/
  Login: admin / <generated-password>
Press Ctrl+C to stop.
```

- Open `http://127.0.0.1:8790/` to verify the Joomla frontend (`Home`).
- Open `http://127.0.0.1:8790/administrator/` and sign in with `admin` and the generated password.

### 2. WordPress

```bash
npx cms-playground start --wp --port=8791
```

On first run, the CLI downloads official WordPress and `sqlite-database-integration`, configures SQLite automatically, and installs WordPress:

```text
Booting PHP 8.4 (WebAssembly)...
Unpacking WordPress latest...
Configuring WordPress...
Installing SQLite database integration for WordPress...
Installing WordPress database...

WordPress latest (PHP 8.4) is running:
  Site:  http://127.0.0.1:8791/
  Admin: http://127.0.0.1:8791/wp-admin/
  Login: admin / <generated-password>
Press Ctrl+C to stop.
```

- Open `http://127.0.0.1:8791/` to see the default WordPress site (`WordPress Playground`).
- Open `http://127.0.0.1:8791/wp-admin/` (redirects to `/wp-login.php`) and sign in with `admin` and the printed password.

### 3. Drupal

```bash
npx cms-playground start --drupal --port=8792
```

Drupal installs automatically using SQLite and the `minimal` profile:

- **Site:** `http://127.0.0.1:8792/`
- **Admin login:** `http://127.0.0.1:8792/user/login` (`admin` / `<generated-password>`)

### 4. TYPO3

```bash
npx cms-playground start --typo3 --port=8793
```

TYPO3 runs non-interactive SQLite setup and exposes the backend immediately:

- **Backend login:** `http://127.0.0.1:8793/typo3` (`admin` / `<generated-password>`)
- **Frontend note:** `http://127.0.0.1:8793/` returns `404 Page Not Found` on a fresh installation until you create a root page and site configuration inside the `/typo3` backend—this is standard TYPO3 behavior.

### 5. Kirby

```bash
npx cms-playground start --kirby --port=8794
```

Kirby uses the official flat-file Starterkit (zero database) and provisions a Panel admin account automatically:

- **Site:** `http://127.0.0.1:8794/` (`Mægazine | Home`)
- **Panel:** `http://127.0.0.1:8794/panel` (`admin@example.com` / `<generated-password>`)

### Summary of Built-in CMSs

| CMS | Flag | Admin / Login Path | Default Username | Storage |
|---|---|---|---|---|
| **Joomla** | `--joomla` | `/administrator/` | `admin` | SQLite (pre-installed bundle) |
| **WordPress** | `--wp` | `/wp-admin/` | `admin` | SQLite (`sqlite-database-integration`) |
| **Drupal** | `--drupal` | `/user/login` | `admin` | SQLite (`minimal` profile) |
| **TYPO3** | `--typo3` | `/typo3` | `admin` | SQLite (`SetupCommand`) |
| **Kirby** | `--kirby` | `/panel` | `admin@example.com` | Flat-file (Starterkit) |

---

## Step 3: Automate Setup with a Blueprint

Blueprints let you configure a CMS declaratively via JSON—ideal for reproducible demos, bug reproductions, and CI.

Create a file named `wp-blueprint.json`:

```json
{
  "preferredVersions": {
    "php": "8.4",
    "wp": "latest"
  },
  "landingPage": "/",
  "steps": [
    {
      "step": "setSiteOption",
      "option": "blogname",
      "value": "Tutorial Demo Site"
    },
    {
      "step": "writeFile",
      "path": "tutorial-check.txt",
      "data": "Created by cms-playground Blueprint"
    }
  ]
}
```

### Run interactively with a local server

```bash
npx cms-playground start --wp --blueprint=./wp-blueprint.json --port=8791
```

Visit `http://127.0.0.1:8791/` to see the updated site title (`Tutorial Demo Site`) and `http://127.0.0.1:8791/tutorial-check.txt` to verify the generated file.

### Run headlessly (CI / automation)

Use `run-blueprint` to execute all steps and exit immediately without starting an HTTP server:

```bash
npx cms-playground run-blueprint --wp --blueprint=./wp-blueprint.json
```

Expected output:

```text
Blueprint step 1/2: setSiteOption
Blueprint step 2/2: writeFile
Ran 2 blueprint step(s) on WordPress latest (PHP 8.4).
```

See [Blueprints](BLUEPRINTS.md) for all core and CMS-specific steps.

---

## Step 4: Mount Local Extensions, Plugins, or Themes

To test code you are actively developing on your machine, mount a local folder directly into the PHP-WASM filesystem.

### Auto-detect and mount (`--auto-mount`)

Point `--auto-mount` at your plugin, theme, module, or extension directory (or omit the path to use the current working directory):

```bash
npx cms-playground start --wp --auto-mount=./my-wp-plugin
npx cms-playground start --joomla --auto-mount=./my-joomla-extension
```

The adapter inspects your folder (for example, WordPress `Plugin Name:` / `style.css` headers, Joomla XML manifests, Drupal `*.info.yml`, TYPO3 `ext_emconf.php`, or Kirby plugins), mounts it to the right destination inside `/var/www/html`, and activates or registers it automatically.

### Explicit mount (`--mount`)

For full control over the mount path, use `--mount=<hostPath>:<vfsPath>`:

```bash
npx cms-playground start --wp --mount=./my-wp-plugin:/var/www/html/wp-content/plugins/my-wp-plugin
```

---

## Step 5: Run a CMS's Native CLI

For CMSs that ship a native CLI (such as Joomla's `cli/joomla.php` or TYPO3's `typo3` console), pass arguments after `--` to run them inside PHP-WASM without installing local PHP:

```bash
npx cms-playground cli --joomla -- user:list
```

Example output:

```text
List Users
==========

 ----- ---------- ------------ ----------------------- --------- -------------
  ID    Username   Name         Email                   Blocked   Groups
 ----- ---------- ------------ ----------------------- --------- -------------
  629   admin      Super User   admin@example.invalid   0         Super Users
 ----- ---------- ------------ ----------------------- --------- -------------
```

---

## Step 6: Export a Portable `.zip` Snapshot

Use `build-snapshot` to boot a CMS, optionally apply a Blueprint, and package `/var/www/html` into a `.zip` archive you can share or archive:

```bash
npx cms-playground build-snapshot --kirby --output=./kirby-snapshot.zip
npx cms-playground build-snapshot --wp --blueprint=./wp-blueprint.json --output=./wp-snapshot.zip
```

---

## Next Steps

- [Getting Started](GETTING-STARTED.md) — full command, flag, caching, and environment variable reference
- [Blueprints](BLUEPRINTS.md) — complete list of core and CMS-specific Blueprint steps
- [Writing a CMS Adapter](ADAPTERS.md) — how to add support for another PHP CMS
