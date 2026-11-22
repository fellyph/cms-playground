# Blueprints Reference

Blueprints are declarative JSON files (`--blueprint=./blueprint.json` or a URL) executed after the CMS boots in PHP-WASM.

```json
{
  "steps": [
    { "step": "mkdir", "path": "/var/www/html/custom" },
    { "step": "writeFile", "path": "/var/www/html/custom/hello.txt", "data": "Hello" },
    { "step": "runPHP", "code": "<?php echo PHP_VERSION;" }
  ]
}
```

## Core Steps (all CMSs)

| Step | Key fields | Description |
| --- | --- | --- |
| `writeFile` | `path`, `data` | Write a file into the PHP-WASM VFS. |
| `mkdir` | `path` | Create a directory recursively in the VFS. |
| `cp` | `fromPath`, `toPath` | Copy a file in the VFS. |
| `mv` | `fromPath`, `toPath` | Move or rename a file in the VFS. |
| `rm` | `path` | Remove a file or directory in the VFS. |
| `unzip` | `zipPath` or `zipFile`, `extractToPath` | Extract a zip archive into the VFS. |
| `runPHP` | `code` | Execute inline PHP code inside the booted runtime. |

## CMS-Specific Steps

- **Joomla (`--joomla`)**: `runJoomlaCli`, `setSiteName`, `setConfig`, and Joomla extension discovery/install via `--auto-mount`.
- **WordPress (`--wp`)**: `setSiteOptions`, `activatePlugin`, `activateTheme`, and WordPress plugin/theme activation via `--auto-mount`.
- **Drupal (`--drupal`)**, **TYPO3 (`--typo3`)**, **Kirby (`--kirby`)**: Support all core steps plus their adapter-specific configuration steps.

Run `cms-playground run-blueprint --<cms> --blueprint=./blueprint.json --verbosity=debug` to trace each step during development.
