// WordPress adapter for @cms-playground.
// Downloads official WordPress + WordPress/sqlite-database-integration and installs on SQLite inside PHP-WASM.

import { join } from 'node:path';
import { fetchCachedBytes, runPhpCode, unpackZip } from '@cms-playground/core';

const WP_SQLITE_PLUGIN_URL = 'https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip';
const WP_VERSION_RE = /^(latest|default|[0-9]+(\.[0-9]+)*(-[a-zA-Z0-9.]+)?)$/;

export function validateWpVersion(version) {
  if (!version || version === 'latest' || version === 'default') {
    return 'latest';
  }

  const normalized = String(version);

  if (!WP_VERSION_RE.test(normalized)) {
    throw new Error(`Invalid WordPress version "${version}". Expected "latest" or a version number like "6.7.2".`);
  }

  return normalized;
}

export function wpDownloadUrl(version) {
  const resolved = validateWpVersion(version);

  if (resolved === 'latest') {
    return 'https://wordpress.org/latest.zip';
  }

  return `https://wordpress.org/wordpress-${resolved}.zip`;
}

const blueprintSteps = {
  async defineWpConfigConsts({ consts }, context) {
    context.php.writeFile('/tmp/wp-consts.json', JSON.stringify(consts ?? {}));
    await runPhpCode(
      context.php,
      `
      $consts = json_decode(file_get_contents('/tmp/wp-consts.json'), true);
      unlink('/tmp/wp-consts.json');
      $file = ${JSON.stringify(context.documentRoot)} . '/wp-config.php';
      $content = file_get_contents($file);
      $snippet = '';
      foreach ($consts as $name => $value) {
          $snippet .= "if (!defined(" . var_export($name, true) . ")) { define(" . var_export($name, true) . ", " . var_export($value, true) . "); }\\n";
      }
      $content = preg_replace_callback(
          '/<\\?php\\s*/',
          function () use ($snippet) {
              return "<?php\\n" . $snippet;
          },
          $content,
          1
      );
      file_put_contents($file, $content);
      `
    );
  },

  async setSiteOption({ option, value }, context) {
    context.php.writeFile('/tmp/wp-option.json', JSON.stringify({ option, value }));
    await runPhpCode(
      context.php,
      `
      $data = json_decode(file_get_contents('/tmp/wp-option.json'), true);
      unlink('/tmp/wp-option.json');
      require_once ${JSON.stringify(context.documentRoot)} . '/wp-load.php';
      update_option($data['option'], $data['value']);
      `
    );
  },

  async activatePlugin({ pluginPath }, context) {
    await runPhpCode(
      context.php,
      `
      require_once ${JSON.stringify(context.documentRoot)} . '/wp-load.php';
      require_once ABSPATH . 'wp-admin/includes/plugin.php';
      $result = activate_plugin(${JSON.stringify(pluginPath)});
      if (is_wp_error($result)) {
          throw new RuntimeException($result->get_error_message());
      }
      `
    );
  },
};

export const wordpressAdapter = {
  name: 'wp',
  label: 'WordPress',
  aliases: ['wp', 'wordpress'],
  defaultPhp: '8.4',
  supportedPhp: ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5'],
  defaultVersion: 'latest',
  adminPath: '/wp-admin/',
  cliEntrypoint: null,
  blueprintSteps,

  async resolveBundle({ version, cacheDir, log }) {
    const resolvedVersion = validateWpVersion(version);
    const wpZipUrl = wpDownloadUrl(resolvedVersion);
    const wpZipPath = join(cacheDir, `wordpress-${resolvedVersion}.zip`);
    const sqliteZipPath = join(cacheDir, 'sqlite-database-integration.zip');

    const [zipBytes, sqliteZipBytes] = await Promise.all([
      fetchCachedBytes(wpZipUrl, wpZipPath, { log }),
      fetchCachedBytes(WP_SQLITE_PLUGIN_URL, sqliteZipPath, { log }),
    ]);

    return {
      version: resolvedVersion,
      zipBytes,
      // WordPress zip contains a top-level "wordpress/" folder; extract to /tmp and move in configure().
      extractTo: '/tmp/wp-extract',
      sqliteZipBytes,
    };
  },

  async configure({ php, documentRoot, url, password, site, bundle, log }) {
    // Move extracted /tmp/wp-extract/wordpress/* into documentRoot for fresh sites.
    if (!site && php.fileExists('/tmp/wp-extract/wordpress')) {
      await runPhpCode(
        php,
        `
        $src = '/tmp/wp-extract/wordpress';
        $dst = ${JSON.stringify(documentRoot)};
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($src, RecursiveDirectoryIterator::SKIP_DOTS),
            RecursiveIteratorIterator::SELF_FIRST
        );
        foreach ($it as $item) {
            $target = $dst . '/' . $it->getSubPathName();
            if ($item->isDir()) {
                @mkdir($target, 0777, true);
            } else {
                @mkdir(dirname($target), 0777, true);
                rename($item->getPathname(), $target);
            }
        }
        `
      );
    }

    // Install sqlite-database-integration plugin & wp-content/db.php drop-in.
    if (bundle?.sqliteZipBytes && !php.fileExists(`${documentRoot}/wp-content/db.php`)) {
      log?.('Installing SQLite database integration for WordPress...');
      await unpackZip(php, bundle.sqliteZipBytes, `${documentRoot}/wp-content/plugins`);
      await runPhpCode(
        php,
        `
        $root = ${JSON.stringify(documentRoot)};
        $copy = $root . '/wp-content/plugins/sqlite-database-integration/db.copy';
        $dbPhp = file_get_contents($copy);
        $dbPhp = str_replace(
            ['{SQLITE_IMPLEMENTATION_FOLDER_PATH}', '{SQLITE_PLUGIN}'],
            [$root . '/wp-content/plugins/sqlite-database-integration', 'sqlite-database-integration/load.php'],
            $dbPhp
        );
        file_put_contents($root . '/wp-content/db.php', $dbPhp);
        @mkdir($root . '/wp-content/database', 0777, true);
        `
      );
    }

    // Generate wp-config.php if missing, and point WP_HOME / WP_SITEURL at the local server URL.
    if (!php.fileExists(`${documentRoot}/wp-config.php`)) {
      const wpConfig = `<?php
define('DB_NAME', 'wordpress');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', 'localhost');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');
define('WP_HOME', ${JSON.stringify(url)});
define('WP_SITEURL', ${JSON.stringify(url)});
define('WP_DEBUG', false);
$table_prefix = 'wp_';
if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}
require_once ABSPATH . 'wp-settings.php';
`;
      php.writeFile(`${documentRoot}/wp-config.php`, wpConfig);
    }

    // Run WordPress installer if not yet installed.
    if (!site) {
      log?.('Installing WordPress database...');
      php.writeFile('/tmp/wp-install.json', JSON.stringify({ url, password, root: documentRoot }));
      await runPhpCode(
        php,
        `
        $cfg = json_decode(file_get_contents('/tmp/wp-install.json'), true);
        unlink('/tmp/wp-install.json');
        $_SERVER['HTTP_HOST'] = parse_url($cfg['url'], PHP_URL_HOST) . ':' . parse_url($cfg['url'], PHP_URL_PORT);
        $_SERVER['REQUEST_URI'] = '/';
        $_SERVER['SERVER_NAME'] = parse_url($cfg['url'], PHP_URL_HOST);
        $_SERVER['SERVER_PORT'] = (string) parse_url($cfg['url'], PHP_URL_PORT);
        define('WP_INSTALLING', true);
        require_once $cfg['root'] . '/wp-load.php';
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        if (!is_blog_installed()) {
            wp_install('WordPress Playground', 'admin', 'admin@example.com', true, '', $cfg['password']);
        }
        `
      );
    }

    return { username: 'admin', password: site ? '(unchanged)' : password };
  },

  getFileNotFoundAction(relativePath) {
    if (relativePath.endsWith('.php')) {
      return { type: '404' };
    }

    return { type: 'internal-redirect', uri: '/index.php' };
  },
};
