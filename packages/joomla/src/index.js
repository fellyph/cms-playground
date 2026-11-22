// Joomla adapter for @cms-playground.
// Reuses the pre-installed SQLite bundles published by joomla-projects/joomla-playground.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fetchCachedBytes, runPhpCode } from '@cms-playground/core';

const DEFAULT_PLAYGROUND_URL = 'https://joomla-projects.github.io/joomla-playground/';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
};

function playgroundBaseUrl() {
  return process.env.JOOMLA_PLAYGROUND_BASE_URL || DEFAULT_PLAYGROUND_URL;
}

/**
 * Resolves a requested Joomla version (e.g. "6.2", "5.4", "5", or "6.2.0") against versions.json.
 */
export function matchJoomlaVersion(requested, versionsManifest) {
  const available = (versionsManifest.versions ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.joomla));

  if (!requested || requested === 'latest' || requested === 'default') {
    return versionsManifest.default ?? available[0] ?? '6.2.0';
  }

  const exact = available.find((v) => v === requested);

  if (exact) {
    return exact;
  }

  const prefix = available.find((v) => v.startsWith(`${requested}.`));

  if (prefix) {
    return prefix;
  }

  throw new Error(`Joomla ${requested} is not available. Available versions: ${available.join(', ')}`);
}

const blueprintSteps = {
  async setGlobalConfig({ values }, context) {
    context.php.writeFile('/tmp/joomla-config.json', JSON.stringify(values ?? {}));
    await runPhpCode(
      context.php,
      `
      $values = json_decode(file_get_contents('/tmp/joomla-config.json'), true);
      unlink('/tmp/joomla-config.json');
      $file = ${JSON.stringify(context.documentRoot)} . '/configuration.php';
      $config = file_get_contents($file);
      foreach ($values as $key => $value) {
          $config = preg_replace(
              '/public \\$' . preg_quote($key, '/') . ' = [^;]*;/',
              'public $' . $key . ' = ' . var_export($value, true) . ';',
              $config
          );
      }
      chmod($file, 0644);
      file_put_contents($file, $config);
      `
    );
  },

  async runSql({ sql }, context) {
    context.php.writeFile('/tmp/joomla-step.sql', String(sql));
    await runPhpCode(
      context.php,
      `
      define('_JEXEC', 1);
      define('JPATH_BASE', ${JSON.stringify(context.documentRoot)} . '/administrator');
      if (is_file(JPATH_BASE . '/defines.php')) {
          include_once JPATH_BASE . '/defines.php';
      }
      if (!defined('_JDEFINES')) {
          require_once JPATH_BASE . '/includes/defines.php';
      }
      require_once JPATH_BASE . '/includes/framework.php';
      $db = \\Joomla\\CMS\\Factory::getContainer()->get(\\Joomla\\Database\\DatabaseInterface::class);
      $sql = file_get_contents('/tmp/joomla-step.sql');
      unlink('/tmp/joomla-step.sql');
      foreach ($db->splitSql($sql) as $query) {
          $query = trim($query);
          if ($query !== '') {
              $db->setQuery($query)->execute();
          }
      }
      `
    );
  },
};

export const joomlaAdapter = {
  name: 'joomla',
  label: 'Joomla',
  aliases: ['joomla'],
  defaultPhp: '8.4',
  supportedPhp: ['8.3', '8.4', '8.5'],
  defaultVersion: 'latest',
  adminPath: '/administrator/',
  cliEntrypoint: 'cli/joomla.php',
  blueprintSteps,

  async resolveBundle({ version, cacheDir, log }) {
    const baseUrl = playgroundBaseUrl();
    const versionsUrl = new URL('joomla/versions.json', baseUrl).href;
    const versionsResponse = await fetch(versionsUrl, { redirect: 'follow' });

    if (!versionsResponse.ok) {
      throw new Error(`Cannot fetch Joomla versions list (${versionsUrl}): HTTP ${versionsResponse.status}`);
    }

    const versionsManifest = await versionsResponse.json();
    const resolvedVersion = matchJoomlaVersion(version, versionsManifest);
    const zipUrl = new URL(`joomla/${resolvedVersion}/site.zip`, baseUrl).href;
    const zipPath = join(cacheDir, resolvedVersion, 'site.zip');
    const zipBytes = await fetchCachedBytes(zipUrl, zipPath, { log });

    return {
      version: resolvedVersion,
      zipBytes,
      baseUrl,
      mediaBaseUrl: new URL(`joomla/${resolvedVersion}/`, baseUrl).href,
    };
  },

  async configure({ php, documentRoot, url, password, site }) {
    php.writeFile('/tmp/cms-joomla-cfg.json', JSON.stringify({ url, password, root: documentRoot, resetPassword: !site }));

    await runPhpCode(
      php,
      `
      $cfg = json_decode(file_get_contents('/tmp/cms-joomla-cfg.json'), true);
      unlink('/tmp/cms-joomla-cfg.json');

      $file = $cfg['root'] . '/configuration.php';
      if (!is_file($file)) {
          throw new RuntimeException('configuration.php not found in Joomla site root');
      }

      $values = [
          'live_site' => $cfg['url'],
          'tmp_path'  => $cfg['root'] . '/tmp',
          'log_path'  => $cfg['root'] . '/administrator/logs',
      ];
      $config = file_get_contents($file);
      foreach ($values as $key => $value) {
          $config = preg_replace('/public \\$' . $key . ' = [^;]*;/', 'public $' . $key . ' = ' . var_export($value, true) . ';', $config);
      }
      chmod($file, 0644);
      file_put_contents($file, $config);

      $dbFile = $cfg['root'] . '/data/joomla.sqlite';
      if ($cfg['resetPassword'] && is_file($dbFile)) {
          $db = new PDO('sqlite:' . $dbFile);
          $stmt = $db->prepare("UPDATE jos_users SET password = ? WHERE username = 'admin'");
          $stmt->execute([password_hash($cfg['password'], PASSWORD_DEFAULT)]);
      }
      `
    );

    return { username: 'admin', password: site ? '(unchanged)' : password };
  },

  getFileNotFoundAction(relativePath) {
    return relativePath.startsWith('/administrator') || relativePath.startsWith('/api')
      ? { type: '404' }
      : { type: 'internal-redirect', uri: '/index.php' };
  },

  /**
   * Serves split /media/* assets from local disk cache (fetching on demand from the playground bundle).
   * Returns null if not found so the request falls back to PHP-WASM (e.g. extension-installed media).
   */
  async serveStatic({ request, bundle, cacheDir }) {
    if (!bundle?.mediaBaseUrl) {
      return null;
    }

    const parsed = new URL(request.url, 'http://localhost');

    if (!parsed.pathname.startsWith('/media/')) {
      return null;
    }

    const relPath = parsed.pathname.replace(/^\/+/, '');

    if (relPath.split('/').includes('..')) {
      return null;
    }

    const cachedFile = join(cacheDir, bundle.version, relPath);
    const contentType = MIME_TYPES[extname(relPath).toLowerCase()] ?? 'application/octet-stream';

    if (existsSync(cachedFile)) {
      return { status: 200, headers: { 'content-type': contentType }, body: new Uint8Array(readFileSync(cachedFile)) };
    }

    const remoteUrl = new URL(relPath, bundle.mediaBaseUrl).href;
    const response = await fetch(remoteUrl, { redirect: 'follow' });

    if (!response.ok) {
      return null;
    }

    const body = new Uint8Array(await response.arrayBuffer());
    mkdirSync(dirname(cachedFile), { recursive: true });
    writeFileSync(cachedFile, body);

    return {
      status: 200,
      headers: { 'content-type': response.headers.get('content-type') || contentType },
      body,
    };
  },
};
