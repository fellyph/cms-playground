// Joomla adapter for @cms-playground.
// Reuses the pre-installed SQLite bundles published by joomla-projects/joomla-playground.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DOCUMENT_ROOT,
  fetchCachedBytes,
  phpSingleQuote,
  runPhpCode,
} from '@cms-playground/core';

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
      $file = ${phpSingleQuote(context.documentRoot)} . '/configuration.php';
      $config = file_get_contents($file);
      foreach ($values as $key => $value) {
          if (!is_string($key) || !preg_match('/^[a-zA-Z_][a-zA-Z0-9_]*$/', $key)) {
              throw new RuntimeException('Invalid Joomla configuration key: ' . (string) $key);
          }
          $replacement = 'public $' . $key . ' = ' . var_export($value, true) . ';';
          $config = preg_replace_callback(
              '/public \\$' . preg_quote($key, '/') . ' = [^;]*;/',
              function () use ($replacement) {
                  return $replacement;
              },
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
      define('JPATH_BASE', ${phpSingleQuote(context.documentRoot)} . '/administrator');
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

  async createArticle(
    {
      title,
      alias,
      introtext,
      content,
      fulltext = '',
      catid,
      state = 1,
      featured = 0,
      access = 1,
      language = '*',
      fields,
    },
    context
  ) {
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new Error('Joomla createArticle requires a non-empty "title"');
    }

    const payload = {
      title: title.trim(),
      alias: typeof alias === 'string' && alias.trim() ? alias.trim() : null,
      introtext: String(introtext ?? content ?? ''),
      fulltext: String(fulltext ?? ''),
      catid: catid != null ? Number(catid) : null,
      state: Number(state ?? 1),
      featured: featured ? 1 : 0,
      access: Number(access ?? 1),
      language: String(language || '*'),
      fields: fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : null,
    };

    context.php.writeFile('/tmp/joomla-article.json', JSON.stringify(payload));
    await runPhpCode(
      context.php,
      `
      $data = json_decode(file_get_contents('/tmp/joomla-article.json'), true);
      unlink('/tmp/joomla-article.json');

      $root = ${phpSingleQuote(context.documentRoot)};
      $configFile = $root . '/configuration.php';
      $dbFile = $root . '/data/joomla.sqlite';
      if (!is_file($configFile)) {
          throw new RuntimeException('configuration.php not found in Joomla site root');
      }
      if (!is_file($dbFile)) {
          throw new RuntimeException('Joomla SQLite database not found at ' . $dbFile);
      }

      $config = file_get_contents($configFile);
      $dbprefix = 'jos_';
      if (preg_match('/public\\s+\\$dbprefix\\s*=\\s*[\\x27\\"]([^\\x27\\"]+)[\\x27\\"]\\s*;/', $config, $m)) {
          $dbprefix = $m[1];
      }
      if (!preg_match('/^[a-zA-Z0-9_]+$/', $dbprefix)) {
          throw new RuntimeException('Invalid Joomla $dbprefix: ' . $dbprefix);
      }

      $db = new PDO('sqlite:' . $dbFile);
      $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

      $catid = $data['catid'];
      if ($catid === null || $catid <= 0) {
          $catRow = $db->query('SELECT id FROM "' . $dbprefix . 'categories" WHERE extension = \\'com_content\\' ORDER BY id ASC LIMIT 1')->fetchColumn();
          $catid = $catRow !== false ? (int) $catRow : 2;
      }

      $createdBy = 0;
      $userRow = $db->query('SELECT id FROM "' . $dbprefix . 'users" ORDER BY id ASC LIMIT 1')->fetchColumn();
      if ($userRow !== false) {
          $createdBy = (int) $userRow;
      }

      $alias = $data['alias'];
      if ($alias === null || $alias === '') {
          $slug = strtolower(trim(preg_replace('/[^a-zA-Z0-9]+/', '-', $data['title']), '-'));
          $alias = $slug !== '' ? $slug : ('article-' . time());
      }

      $baseAlias = $alias;
      $suffix = 2;
      $checkAlias = $db->prepare('SELECT COUNT(*) FROM "' . $dbprefix . 'content" WHERE alias = ? AND catid = ?');
      while (true) {
          $checkAlias->execute([$alias, $catid]);
          if ((int) $checkAlias->fetchColumn() === 0) {
              break;
          }
          $alias = $baseAlias . '-' . $suffix;
          $suffix++;
      }

      $now = gmdate('Y-m-d H:i:s');
      $stmt = $db->prepare(
          'INSERT INTO "' . $dbprefix . 'content" ('
          . 'asset_id, title, alias, introtext, "fulltext", state, catid, '
          . 'created, created_by, created_by_alias, modified, modified_by, '
          . 'publish_up, images, urls, attribs, version, ordering, '
          . 'metakey, metadesc, access, hits, metadata, featured, language, note'
          . ') VALUES ('
          . '0, :title, :alias, :introtext, :fulltext, :state, :catid, '
          . ':created, :created_by, \\'\\', :modified, :modified_by, '
          . ':publish_up, \\'{}\\', \\'{}\\', \\'{}\\', 1, 0, '
          . '\\'\\', \\'\\', :access, 0, \\'{}\\', :featured, :language, \\'\\''
          . ')'
      );
      $stmt->execute([
          ':title' => $data['title'],
          ':alias' => $alias,
          ':introtext' => $data['introtext'],
          ':fulltext' => $data['fulltext'],
          ':state' => (int) $data['state'],
          ':catid' => (int) $catid,
          ':created' => $now,
          ':created_by' => $createdBy,
          ':modified' => $now,
          ':modified_by' => $createdBy,
          ':publish_up' => $now,
          ':access' => (int) $data['access'],
          ':featured' => (int) $data['featured'],
          ':language' => $data['language'],
      ]);
      $articleId = (int) $db->lastInsertId();

      // Associate with default publishing workflow stage so article appears in Content -> Articles.
      $wfTableExists = $db->query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=" . $db->quote($dbprefix . 'workflow_associations')
      )->fetchColumn();
      if ($wfTableExists !== false) {
          $wfStmt = $db->prepare(
              'INSERT OR REPLACE INTO "' . $dbprefix . 'workflow_associations" (item_id, stage_id, extension) '
              . 'VALUES (:item_id, 1, \\'com_content.article\\')'
          );
          $wfStmt->execute([':item_id' => $articleId]);
      }

      if ((int) $data['featured'] === 1) {
          $fpTableExists = $db->query(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=" . $db->quote($dbprefix . 'content_frontpage')
          )->fetchColumn();
          if ($fpTableExists !== false) {
              $fpStmt = $db->prepare(
                  'INSERT OR REPLACE INTO "' . $dbprefix . 'content_frontpage" (content_id, ordering) VALUES (:content_id, 0)'
              );
              $fpStmt->execute([':content_id' => $articleId]);
          }
      }

      if (is_array($data['fields']) && count($data['fields']) > 0) {
          $findField = $db->prepare(
              'SELECT id FROM "' . $dbprefix . 'fields" WHERE context = \\'com_content.article\\' AND name = :name LIMIT 1'
          );
          $insertField = $db->prepare(
              'INSERT INTO "' . $dbprefix . 'fields" ('
              . 'asset_id, context, group_id, title, name, label, default_value, type, note, description, '
              . 'state, required, only_use_in_subform, ordering, params, fieldparams, language, '
              . 'created_time, created_user_id, modified_time, modified_by, access'
              . ') VALUES ('
              . '0, \\'com_content.article\\', 0, :title, :name, :label, \\'\\', \\'text\\', \\'\\', \\'\\', '
              . '1, 0, 0, 0, \\'{}\\', \\'{}\\', \\'*\\', :now, :uid, :now, :uid, 1'
              . ')'
          );
          $insertValue = $db->prepare(
              'INSERT INTO "' . $dbprefix . 'fields_values" (field_id, item_id, value) VALUES (:field_id, :item_id, :value)'
          );

          foreach ($data['fields'] as $fieldName => $fieldValue) {
              $name = strtolower(trim(preg_replace('/[^a-zA-Z0-9_-]+/', '-', (string) $fieldName), '-'));
              if ($name === '') {
                  continue;
              }
              $findField->execute([':name' => $name]);
              $fieldId = $findField->fetchColumn();
              if ($fieldId === false) {
                  $label = ucwords(str_replace(['-', '_'], ' ', $name));
                  $insertField->execute([
                      ':title' => $label,
                      ':name' => $name,
                      ':label' => $label,
                      ':now' => $now,
                      ':uid' => $createdBy,
                  ]);
                  $fieldId = (int) $db->lastInsertId();
              } else {
                  $fieldId = (int) $fieldId;
              }
              $insertValue->execute([
                  ':field_id' => $fieldId,
                  ':item_id' => (string) $articleId,
                  ':value' => is_scalar($fieldValue) ? (string) $fieldValue : json_encode($fieldValue),
              ]);
          }
      }
      `
    );
  },
};

const blueprintStepSchemas = Object.freeze({
  setGlobalConfig: Object.freeze({
    requiredFields: ['values'],
    optionalFields: [],
    description: 'Update properties in Joomla configuration.php',
  }),
  runSql: Object.freeze({
    requiredFields: ['sql'],
    optionalFields: [],
    description: 'Execute SQL statements against the Joomla SQLite database',
  }),
  createArticle: Object.freeze({
    requiredFields: ['title'],
    optionalFields: ['alias', 'introtext', 'content', 'fulltext', 'catid', 'state', 'featured', 'access', 'language', 'fields'],
    description: 'Create a Joomla article with workflow_associations and optional com_fields values',
  }),
});

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
  blueprintStepSchemas,

  async resolveBundle({ version, cacheDir, log }) {
    const baseUrl = playgroundBaseUrl();
    const versionsUrl = new URL('joomla/versions.json', baseUrl).href;
    const versionsResponse = await fetch(versionsUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });

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
          $replacement = 'public $' . $key . ' = ' . var_export($value, true) . ';';
          $config = preg_replace_callback(
              '/public \\$' . preg_quote($key, '/') . ' = [^;]*;/',
              function () use ($replacement) {
                  return $replacement;
              },
              $config
          );
      }
      chmod($file, 0644);
      file_put_contents($file, $config);

      $dbFile = $cfg['root'] . '/data/joomla.sqlite';
      if ($cfg['resetPassword'] && is_file($dbFile)) {
          $dbprefix = 'jos_';
          if (preg_match('/public\\s+\\$dbprefix\\s*=\\s*[\\\'\\"]([^\\\'\\"]+)[\\\'\\"]\\s*;/', $config, $m)) {
              $dbprefix = $m[1];
          }
          if (!preg_match('/^[a-zA-Z0-9_]+$/', $dbprefix)) {
              throw new RuntimeException('Invalid Joomla $dbprefix: ' . $dbprefix);
          }
          $db = new PDO('sqlite:' . $dbFile);
          $stmt = $db->prepare('UPDATE "' . $dbprefix . 'users" SET password = ? WHERE username = \\'admin\\'');
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
    if (!bundle?.mediaBaseUrl || typeof bundle.version !== 'string' || !/^[0-9A-Za-z._-]+$/.test(bundle.version) || bundle.version === '.' || bundle.version === '..') {
      return null;
    }

    const parsed = new URL(request.url, 'http://localhost');
    let decodedPathname;

    try {
      decodedPathname = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }

    if (!decodedPathname.startsWith('/media/') || decodedPathname.includes('\0') || decodedPathname.includes('\\')) {
      return null;
    }

    const relPath = decodedPathname.replace(/^\/+/, '');

    if (!relPath || relPath.endsWith('/') || relPath.split('/').includes('..')) {
      return null;
    }

    const versionDir = resolve(cacheDir, bundle.version);
    const cachedFile = resolve(versionDir, relPath);

    if (!cachedFile.startsWith(versionDir + sep)) {
      return null;
    }

    const contentType = MIME_TYPES[extname(relPath).toLowerCase()] ?? 'application/octet-stream';

    try {
      if (statSync(cachedFile).isFile()) {
        return { status: 200, headers: { 'content-type': contentType }, body: new Uint8Array(readFileSync(cachedFile)) };
      }

      return null;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    const remoteUrl = new URL(relPath, bundle.mediaBaseUrl).href;
    const response = await fetch(remoteUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const body = new Uint8Array(await response.arrayBuffer());
    mkdirSync(dirname(cachedFile), { recursive: true });
    const tmpFile = `${cachedFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

    try {
      writeFileSync(tmpFile, body);
      renameSync(tmpFile, cachedFile);
    } catch (error) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Ignore temp-file cleanup errors.
      }
      throw error;
    }

    return {
      status: 200,
      headers: { 'content-type': response.headers.get('content-type') || contentType },
      body,
    };
  },

  detectAutoMount(dir) {
    return detectJoomlaAutoMount(dir);
  },
};

/**
 * Inspects a host directory for a Joomla extension XML manifest and returns mount + postMount discovery instructions.
 * Supports plugin, module, template, and component extensions.
 */
export function detectJoomlaAutoMount(dir) {
  const absDir = resolve(dir);

  if (!existsSync(absDir)) {
    return null;
  }

  const xmlFiles = readdirSync(absDir).filter((name) => name.toLowerCase().endsWith('.xml'));

  for (const xmlFile of xmlFiles) {
    const content = readFileSync(join(absDir, xmlFile), 'utf8');
    const extMatch = content.match(/<extension\b([^>]*)>/i);

    if (!extMatch) {
      continue;
    }

    const attrs = extMatch[1];
    const type = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const group = attrs.match(/\bgroup\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? 'system';
    const client = attrs.match(/\bclient\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? 'site';

    if (!['plugin', 'module', 'template', 'component'].includes(type)) {
      continue;
    }

    const fallbackElement = basename(xmlFile, extname(xmlFile)).toLowerCase();
    let element = fallbackElement;

    if (type === 'plugin') {
      element = content.match(/<filename\b[^>]*\bplugin\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? fallbackElement;
    } else if (type === 'module') {
      element = content.match(/<filename\b[^>]*\bmodule\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? fallbackElement;
      if (!element.startsWith('mod_')) {
        element = `mod_${element}`;
      }
    } else if (type === 'component') {
      const nameTag = content.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.toLowerCase();
      element = nameTag || fallbackElement;
      if (!element.startsWith('com_')) {
        element = `com_${element}`;
      }
    } else if (type === 'template') {
      element = content.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.toLowerCase() ?? fallbackElement;
    }

    const adminPrefix = client === 'administrator' ? '/administrator' : '';
    let vfsPath;

    if (type === 'plugin') {
      vfsPath = `${DOCUMENT_ROOT}/plugins/${group}/${element}`;
    } else if (type === 'module') {
      vfsPath = `${DOCUMENT_ROOT}${adminPrefix}/modules/${element}`;
    } else if (type === 'template') {
      vfsPath = `${DOCUMENT_ROOT}${adminPrefix}/templates/${element}`;
    } else {
      vfsPath = `${DOCUMENT_ROOT}/components/${element}`;
    }

    const clientId = client === 'administrator' ? 1 : 0;

    return {
      kind: `joomla-${type}`,
      element,
      mounts: [{ hostPath: absDir, vfsPath }],
      async postMount({ php, documentRoot, log }) {
        log?.(`Discovering and installing Joomla ${type} "${element}"...`);
        await runPhpCode(
          php,
          `
          define('_JEXEC', 1);
          define('JPATH_BASE', ${phpSingleQuote(documentRoot)} . '/administrator');
          if (is_file(JPATH_BASE . '/defines.php')) {
              include_once JPATH_BASE . '/defines.php';
          }
          if (!defined('_JDEFINES')) {
              require_once JPATH_BASE . '/includes/defines.php';
          }
          require_once JPATH_BASE . '/includes/framework.php';

          $container = \\Joomla\\CMS\\Factory::getContainer();
          $container->alias('session.web', 'session.web.administrator')
              ->alias('session', 'session.web.administrator')
              ->alias('JSession', 'session.web.administrator');
          $app = $container->get(\\Joomla\\CMS\\Application\\AdministratorApplication::class);
          \\Joomla\\CMS\\Factory::$application = $app;

          $installer = \\Joomla\\CMS\\Installer\\Installer::getInstance();
          $discovered = $installer->discover();
          $db = $container->get(\\Joomla\\Database\\DatabaseInterface::class);
          foreach ($discovered as $ext) {
              $ext->store();
          }
          $query = $db->getQuery(true)
              ->select($db->quoteName('extension_id'))
              ->from($db->quoteName('#__extensions'))
              ->where($db->quoteName('state') . ' = -1')
              ->where($db->quoteName('element') . ' = ' . $db->quote(${phpSingleQuote(element)}));
          $extIds = $db->setQuery($query)->loadColumn();
          foreach ($extIds as $id) {
              $installer->discover_install((int) $id);
          }
          `
        );

        // Ensure mounted templates are registered in #__extensions / #__template_styles
        // and activate site templates as the default frontend style (matching WP --auto-mount).
        if (type === 'template') {
          await runPhpCode(
            php,
            `
            $root = ${phpSingleQuote(documentRoot)};
            $element = ${phpSingleQuote(element)};
            $clientId = ${clientId};
            $dbFile = $root . '/data/joomla.sqlite';
            if (!is_file($dbFile)) {
                return;
            }
            $prefix = 'jos_';
            $configFile = $root . '/configuration.php';
            if (is_file($configFile)) {
                $cfg = file_get_contents($configFile);
                if (preg_match('/public\\s+\\$dbprefix\\s*=\\s*[\\x27"]([^\\x27"]+)[\\x27"]\\s*;/', $cfg, $m)) {
                    $prefix = $m[1];
                }
            }
            $db = new PDO('sqlite:' . $dbFile);
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

            $stmt = $db->prepare("SELECT COUNT(*) FROM {$prefix}extensions WHERE type = 'template' AND element = ? AND client_id = ?");
            $stmt->execute([$element, $clientId]);
            if ((int) $stmt->fetchColumn() === 0) {
                $manifestCache = json_encode(['name' => $element, 'type' => 'template', 'version' => '1.0.0']);
                $ins = $db->prepare(
                    "INSERT INTO {$prefix}extensions (package_id, name, type, element, folder, client_id, enabled, access, protected, locked, manifest_cache, params, custom_data, checked_out, checked_out_time, ordering, state) VALUES (0, ?, 'template', ?, '', ?, 1, 1, 0, 0, ?, '{}', '', NULL, NULL, 0, 0)"
                );
                $ins->execute([$element, $element, $clientId, $manifestCache]);
            }

            $stmt = $db->prepare("SELECT COUNT(*) FROM {$prefix}template_styles WHERE template = ? AND client_id = ?");
            $stmt->execute([$element, $clientId]);
            if ((int) $stmt->fetchColumn() === 0) {
                $ins = $db->prepare(
                    "INSERT INTO {$prefix}template_styles (template, client_id, home, title, inheritable, parent, params) VALUES (?, ?, '0', ?, 0, '', '{}')"
                );
                $ins->execute([$element, $clientId, $element . ' - Default']);
            }

            if ($clientId === 0) {
                $db->exec("UPDATE {$prefix}template_styles SET home = '0' WHERE client_id = 0");
                $upd = $db->prepare("UPDATE {$prefix}template_styles SET home = '1' WHERE client_id = 0 AND template = ?");
                $upd->execute([$element]);
            }
            `
          );
        }
      },
    };
  }

  return null;
}
