# Blueprints

A **Blueprint** is a JSON file describing how to configure a CMS playground automatically after boot. Blueprints combine **core steps** (available for every CMS) with **adapter-specific steps** (for Joomla or WordPress).

Pass a Blueprint to `start` using `--blueprint`:

```bash
npx cms-playground start --joomla --blueprint=./blueprint.json
npx cms-playground start --wp --blueprint=./wp-blueprint.json
```

---

## Schema Overview

```json
{
  "preferredVersions": {
    "php": "8.4",
    "joomla": "6.2"
  },
  "landingPage": "/administrator/",
  "steps": [
    { "step": "writeFile", "path": "hello.txt", "data": "Hello from Blueprint!" }
  ]
}
```

- `preferredVersions`: Optional default PHP and CMS versions (overridden by CLI flags like `--php` or `--joomla=5.4`).
- `landingPage`: Optional path printed as the landing URL.
- `steps`: Ordered list of steps executed sequentially inside PHP-WASM.

---

## Core Steps (All CMSs)

| Step | Properties | Description |
|---|---|---|
| `runPHP` | `code` | Runs PHP code with the working directory set to `/var/www/html` |
| `writeFile` | `path`, `data` | Writes a file relative to `/var/www/html` (creates parent folders automatically) |
| `mkdir` | `path` | Creates a directory relative to `/var/www/html` |
| `unzip` | `url`, `to?` | Downloads a `.zip` (relative to the Blueprint URL/path or absolute) and extracts it into `/var/www/html` (or `to`) |

---

## Joomla Steps (`--joomla`)

| Step | Properties | Description |
|---|---|---|
| `setGlobalConfig` | `values` | Updates properties in `configuration.php` |
| `runSql` | `sql` | Executes SQL statements against Joomla's database (supports `#__` table prefix) |

### Example: Joomla Blueprint

```json
{
  "preferredVersions": {
    "php": "8.4",
    "joomla": "6.2"
  },
  "landingPage": "/index.php",
  "steps": [
    {
      "step": "setGlobalConfig",
      "values": {
        "sitename": "My Joomla Demo",
        "debug": true
      }
    },
    {
      "step": "writeFile",
      "path": "robots-custom.txt",
      "data": "User-agent: *\nAllow: /\n"
    },
    {
      "step": "runSql",
      "sql": "SELECT COUNT(*) FROM #__users;"
    }
  ]
}
```

---

## WordPress Steps (`--wp`)

| Step | Properties | Description |
|---|---|---|
| `defineWpConfigConsts` | `consts` | Defines PHP constants in `wp-config.php` |
| `setSiteOption` | `option`, `value` | Calls `update_option($option, $value)` |
| `activatePlugin` | `pluginPath` | Calls `activate_plugin($pluginPath)` (e.g. `hello-dolly/hello.php`) |

### Example: WordPress Blueprint

```json
{
  "preferredVersions": {
    "php": "8.4",
    "wp": "latest"
  },
  "landingPage": "/wp-admin/",
  "steps": [
    {
      "step": "defineWpConfigConsts",
      "consts": {
        "WP_DEBUG": true
      }
    },
    {
      "step": "setSiteOption",
      "option": "blogname",
      "value": "My WordPress Demo"
    },
    {
      "step": "runPHP",
      "code": "file_put_contents('hello-wp.txt', 'ready');"
    }
  ]
}
```
