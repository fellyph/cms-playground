# Writing a CMS Adapter

`@cms-playground/core` is CMS-agnostic. Each CMS (`@cms-playground/joomla`, `@cms-playground/wordpress`, or your own adapter) implements a small adapter object and registers it with `registerAdapter()`.

---

## Adapter Interface

```js
import { DOCUMENT_ROOT, registerAdapter } from '@cms-playground/core';

export const myCmsAdapter = {
  // Required metadata
  name: 'mycms',                 // Canonical CLI flag: --mycms
  label: 'MyCMS',                // Display name in logs and `list`
  aliases: ['mycms', 'mc'],      // Optional extra CLI flag aliases
  defaultPhp: '8.4',
  supportedPhp: ['8.3', '8.4'],
  phpExtensions: ['intl'],       // Optional PHP-WASM extensions to load
  defaultVersion: 'latest',
  adminPath: '/admin/',

  // Optional native CLI entrypoint relative to /var/www/html
  cliEntrypoint: 'bin/console',

  // 1. Download/cache the CMS bundle (returns { version, zipBytes, extractTo? })
  async resolveBundle({ version, cacheDir, log }) {
    return { version: version || 'latest', zipBytes: null };
  },

  // 2. Configure the CMS inside PHP-WASM (config files, DB setup, admin password)
  async configure({ php, documentRoot, url, password, site, bundle, log }) {
    return { username: 'admin', password };
  },

  // 3. URL rewrite rules for PHPRequestHandler
  getFileNotFoundAction(relativePath) {
    return { type: 'internal-redirect', uri: '/index.php' };
  },

  // 4. Optional static asset handler (return { status, headers, body } or null to fall back to PHP)
  async serveStatic({ request, bundle, cacheDir }) {
    return null;
  },

  // 5. Optional --auto-mount detector (returns { kind, mounts, postMount? } or null)
  detectAutoMount(dir) {
    return {
      kind: 'mycms-plugin',
      mounts: [{ hostPath: dir, vfsPath: `${DOCUMENT_ROOT}/plugins/my-plugin` }],
      async postMount({ php, documentRoot, log }) {
        log?.('Activating plugin...');
      },
    };
  },

  // 6. Optional CMS-specific Blueprint steps
  blueprintSteps: {
    async setTitle({ title }, context) {
      await context.runPhp(`file_put_contents('title.txt', ${JSON.stringify(title)});`);
    },
  },
};

registerAdapter(myCmsAdapter);
```

---

## Built-in Adapters

- **Joomla** ([`packages/joomla/src/index.js`](../packages/joomla/src/index.js)): Pre-installed SQLite bundles from `joomla-projects/joomla-playground`, on-demand `/media/*` caching, SEF URL rewrites, XML manifest `--auto-mount`, and `cli/joomla.php` passthrough.
- **WordPress** ([`packages/wordpress/src/index.js`](../packages/wordpress/src/index.js)): Official WordPress zips paired with `sqlite-database-integration`, automatic `wp_install()`, pretty permalink rewrites, plugin/theme/`wp-content` `--auto-mount`, and WordPress blueprint steps.
- **Drupal** ([`packages/drupal/src/index.js`](../packages/drupal/src/index.js)): Official Drupal core zips, programmatic SQLite installation, `*.info.yml` module/theme `--auto-mount`, and Drupal blueprint steps.
- **TYPO3** ([`packages/typo3/src/index.js`](../packages/typo3/src/index.js)): Official TYPO3 classic release zips, non-interactive SQLite setup via `SetupCommand`, `ext_emconf.php`/`composer.json` `--auto-mount`, and `typo3` CLI passthrough.
- **Kirby** ([`packages/kirby/src/index.js`](../packages/kirby/src/index.js)): Official Kirby Starterkit (flat-file, zero DB), automatic Panel admin user creation, plugin/site/content `--auto-mount`, and Kirby blueprint steps.
