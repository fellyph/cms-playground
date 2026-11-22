# Blueprints Reference

Blueprints are declarative JSON files (`--blueprint=./blueprint.json` or an HTTP(S) URL) executed after the CMS boots in PHP-WASM. All file and directory paths are resolved **relative to `/var/www/html`**.

```json
{
  "preferredVersions": {
    "php": "8.4",
    "joomla": "6.2"
  },
  "landingPage": "/administrator/",
  "steps": [
    { "step": "mkdir", "path": "custom" },
    { "step": "writeFile", "path": "custom/hello.txt", "data": "Hello" },
    { "step": "runPHP", "code": "file_put_contents('custom/php-version.txt', PHP_VERSION);" }
  ]
}
```

## Core Steps (all CMSs)

| Step | Key fields | Description |
| --- | --- | --- |
| `runPHP` | `code` | Execute inline PHP code with working directory `/var/www/html`. |
| `writeFile` | `path`, `data` | Write a file relative to `/var/www/html` (creates parent directories automatically). |
| `mkdir` | `path` | Create a directory relative to `/var/www/html`. |
| `unzip` | `url`, `to?` | Download a `.zip` (relative to the Blueprint path/URL or absolute) and extract it into `/var/www/html` (or `to`). |

## CMS-Specific Steps

- **Joomla (`--joomla`)**:
  - `setGlobalConfig` (`values`) — updates properties in `configuration.php`.
  - `runSql` (`sql`) — executes SQL statements against Joomla's database (supports `#__` table prefix).
- **WordPress (`--wp`)**:
  - `defineWpConfigConsts` (`consts`) — defines PHP constants in `wp-config.php`.
  - `setSiteOption` (`option`, `value`) — calls `update_option($option, $value)`.
  - `activatePlugin` (`pluginPath`) — calls `activate_plugin($pluginPath)` (e.g. `hello-dolly/hello.php`).

Run `cms-playground run-blueprint --joomla --blueprint=./blueprint.json --verbosity=debug` to trace each step during development.
