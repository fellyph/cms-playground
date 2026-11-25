// TYPO3 CMS adapter for @cms-playground.
// Downloads official TYPO3 classic release zip and runs non-interactive SQLite setup inside PHP-WASM.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  DOCUMENT_ROOT,
  fetchCachedBytes,
  moveDirectoryContents,
  phpSingleQuote,
  runPhpCode,
} from '@cms-playground/core';

const TYPO3_VERSION_RE = /^(latest|default|[0-9]+(\.[0-9]+)*)$/;

export function validateTypo3Version(version) {
  if (!version || version === 'latest' || version === 'default') {
    return '13';
  }

  const normalized = String(version).replace(/^v/i, '');

  if (!TYPO3_VERSION_RE.test(normalized)) {
    throw new Error(`Invalid TYPO3 version "${version}". Expected "13", "13.4", or a version like "13.4.40".`);
  }

  return normalized;
}

export function typo3DownloadUrl(version) {
  const resolved = validateTypo3Version(version);

  return `https://get.typo3.org/${resolved}/zip`;
}

/**
 * Ensures a password satisfies TYPO3 13's default PasswordPolicyValidator
 * (minimum 8 chars, lowercase, uppercase, digit, and special character).
 */
export function ensureTypo3Password(password) {
  let out = String(password ?? '');

  if (!/[a-z]/.test(out)) {
    out += 'a';
  }
  if (!/[A-Z]/.test(out)) {
    out += 'A';
  }
  if (!/[0-9]/.test(out)) {
    out += '9';
  }
  if (!/[^A-Za-z0-9]/.test(out)) {
    out += '!';
  }
  while (out.length < 8) {
    out += 'x';
  }

  return out;
}

function typo3DbSnippet(rootExpr) {
  return `
    $root = ${rootExpr};
    $candidates = [
        $root . '/typo3conf/system/settings.php',
        $root . '/config/system/settings.php',
    ];
    $settingsFile = null;
    foreach ($candidates as $candidate) {
        if (file_exists($candidate)) {
            $settingsFile = $candidate;
            break;
        }
    }
    if ($settingsFile === null) {
        throw new RuntimeException('TYPO3 settings.php not found');
    }
    $settings = require $settingsFile;
    $dbPath = is_array($settings) ? ($settings['DB']['Connections']['Default']['path'] ?? null) : null;
    if (!is_string($dbPath) || $dbPath === '') {
        throw new RuntimeException('TYPO3 SQLite database path not configured in settings.php');
    }
    $db = new PDO('sqlite:' . $dbPath);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  `;
}

const blueprintSteps = {
  async setSiteName({ name }, context) {
    context.php.writeFile('/tmp/typo3-sitename.json', JSON.stringify({ name: String(name ?? '') }));
    await runPhpCode(
      context.php,
      `
      $data = json_decode(file_get_contents('/tmp/typo3-sitename.json'), true);
      unlink('/tmp/typo3-sitename.json');
      $root = ${phpSingleQuote(context.documentRoot)};
      $candidates = [
          $root . '/typo3conf/system/settings.php',
          $root . '/config/system/settings.php',
      ];
      $file = null;
      foreach ($candidates as $candidate) {
          if (file_exists($candidate)) {
              $file = $candidate;
              break;
          }
      }
      if ($file === null) {
          throw new RuntimeException('TYPO3 settings.php not found');
      }
      $settings = require $file;
      if (!is_array($settings)) {
          $settings = [];
      }
      $settings['SYS']['sitename'] = $data['name'];
      file_put_contents($file, "<?php\\nreturn " . var_export($settings, true) . ";\\n");
      `
    );
  },

  async runSql({ sql }, context) {
    context.php.writeFile('/tmp/typo3-step.sql', String(sql ?? ''));
    await runPhpCode(
      context.php,
      `
      $sql = file_get_contents('/tmp/typo3-step.sql');
      unlink('/tmp/typo3-step.sql');
      ${typo3DbSnippet(phpSingleQuote(context.documentRoot))}
      if (trim($sql) !== '') {
          $db->exec($sql);
      }
      `
    );
  },

  async createStarterSite(
    { title = 'Home', siteName, header, bodytext, identifier = 'main' } = {},
    context
  ) {
    const safeIdentifier = String(identifier || 'main').trim();
    if (!/^[a-z0-9_-]+$/i.test(safeIdentifier)) {
      throw new Error(`Invalid TYPO3 site identifier "${identifier}"`);
    }

    context.php.writeFile(
      '/tmp/typo3-starter-site.json',
      JSON.stringify({
        title: String(title || 'Home'),
        siteName: String(siteName ?? title ?? 'TYPO3 Playground'),
        header: header != null ? String(header) : '',
        bodytext: bodytext != null ? String(bodytext) : '',
        identifier: safeIdentifier,
        base: context.url ? String(context.url).replace(/\/?$/, '/') : '/',
      })
    );

    await runPhpCode(
      context.php,
      `
      $data = json_decode(file_get_contents('/tmp/typo3-starter-site.json'), true);
      unlink('/tmp/typo3-starter-site.json');
      ${typo3DbSnippet(phpSingleQuote(context.documentRoot))}

      $now = time();
      $rootPageId = $db->query('SELECT uid FROM pages WHERE is_siteroot = 1 AND deleted = 0 ORDER BY uid ASC LIMIT 1')->fetchColumn();
      if ($rootPageId === false) {
          $stmt = $db->prepare(
              'INSERT INTO pages (pid, tstamp, crdate, deleted, hidden, doktype, title, slug, is_siteroot, sorting) '
              . 'VALUES (0, :now, :now, 0, 0, 1, :title, :slug, 1, 256)'
          );
          $stmt->execute([
              ':now' => $now,
              ':title' => $data['title'],
              ':slug' => '/',
          ]);
          $rootPageId = (int) $db->lastInsertId();
      } else {
          $rootPageId = (int) $rootPageId;
          $stmt = $db->prepare('UPDATE pages SET title = :title, slug = :slug, hidden = 0, tstamp = :now WHERE uid = :uid');
          $stmt->execute([
              ':title' => $data['title'],
              ':slug' => '/',
              ':now' => $now,
              ':uid' => $rootPageId,
          ]);
      }

      $siteDir = $root . '/typo3conf/sites/' . $data['identifier'];
      if (!is_dir($siteDir)) {
          @mkdir($siteDir, 0777, true);
      }
      $siteConfigPath = $siteDir . '/config.yaml';
      if (!is_file($siteConfigPath)) {
          $escapedTitle = str_replace("'", "''", $data['siteName']);
          $escapedBase = str_replace("'", "''", $data['base']);
          $yaml = "base: '{$escapedBase}'\\n"
              . "rootPageId: {$rootPageId}\\n"
              . "websiteTitle: '{$escapedTitle}'\\n"
              . "languages:\\n"
              . "  - title: English\\n"
              . "    enabled: true\\n"
              . "    languageId: 0\\n"
              . "    base: /\\n"
              . "    locale: en_US.UTF-8\\n"
              . "    navigationTitle: English\\n"
              . "    flag: us\\n";
          file_put_contents($siteConfigPath, $yaml);
      }

      $typoscript = "page = PAGE\\n"
          . "page.10 = CONTENT\\n"
          . "page.10 {\\n"
          . "  table = tt_content\\n"
          . "  select.orderBy = sorting\\n"
          . "  select.where = colPos=0\\n"
          . "  renderObj = COA\\n"
          . "  renderObj {\\n"
          . "    10 = TEXT\\n"
          . "    10.field = header\\n"
          . "    10.wrap = <h2>|</h2>\\n"
          . "    10.required = 1\\n"
          . "    20 = TEXT\\n"
          . "    20.field = bodytext\\n"
          . "    20.wrap = <div>|</div>\\n"
          . "    20.required = 1\\n"
          . "  }\\n"
          . "}\\n";

      $tplUid = $db->query('SELECT uid FROM sys_template WHERE pid = ' . $rootPageId . ' AND deleted = 0 ORDER BY uid ASC LIMIT 1')->fetchColumn();
      if ($tplUid === false) {
          $tplStmt = $db->prepare(
              'INSERT INTO sys_template (pid, tstamp, crdate, deleted, hidden, title, root, clear, config) '
              . 'VALUES (:pid, :now, :now, 0, 0, :title, 1, 3, :config)'
          );
          $tplStmt->execute([
              ':pid' => $rootPageId,
              ':now' => $now,
              ':title' => 'Main TypoScript Template',
              ':config' => $typoscript,
          ]);
      } else {
          $tplStmt = $db->prepare('UPDATE sys_template SET config = :config, root = 1, clear = 3, hidden = 0, tstamp = :now WHERE uid = :uid');
          $tplStmt->execute([
              ':config' => $typoscript,
              ':now' => $now,
              ':uid' => (int) $tplUid,
          ]);
      }

      if ($data['header'] !== '' || $data['bodytext'] !== '') {
          $contentStmt = $db->prepare(
              'INSERT INTO tt_content (pid, tstamp, crdate, deleted, hidden, sorting, colPos, CType, header, bodytext) '
              . 'VALUES (:pid, :now, :now, 0, 0, 256, 0, :ctype, :header, :bodytext)'
          );
          $contentStmt->execute([
              ':pid' => $rootPageId,
              ':now' => $now,
              ':ctype' => 'text',
              ':header' => $data['header'],
              ':bodytext' => $data['bodytext'],
          ]);
      }
      `
    );
  },

  async createPage({ title, pid, slug, doktype = 1, isSiteroot = false }, context) {
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new Error('TYPO3 createPage requires a non-empty "title"');
    }

    context.php.writeFile(
      '/tmp/typo3-page.json',
      JSON.stringify({
        title: title.trim(),
        pid: pid != null ? Number(pid) : (isSiteroot ? 0 : 1),
        slug: typeof slug === 'string' && slug.trim() ? slug.trim() : null,
        doktype: Number(doktype ?? 1),
        isSiteroot: isSiteroot ? 1 : 0,
      })
    );

    await runPhpCode(
      context.php,
      `
      $data = json_decode(file_get_contents('/tmp/typo3-page.json'), true);
      unlink('/tmp/typo3-page.json');
      ${typo3DbSnippet(phpSingleQuote(context.documentRoot))}

      $slug = $data['slug'];
      if ($slug === null) {
          if ($data['isSiteroot'] === 1) {
              $slug = '/';
          } else {
              $part = strtolower(trim(preg_replace('/[^a-zA-Z0-9]+/', '-', $data['title']), '-'));
              $slug = '/' . ($part !== '' ? $part : ('page-' . time()));
          }
      } elseif ($slug[0] !== '/') {
          $slug = '/' . $slug;
      }

      $now = time();
      $maxSort = (int) $db->query('SELECT COALESCE(MAX(sorting), 0) FROM pages WHERE pid = ' . (int) $data['pid'])->fetchColumn();
      $stmt = $db->prepare(
          'INSERT INTO pages (pid, tstamp, crdate, deleted, hidden, sorting, doktype, title, slug, is_siteroot) '
          . 'VALUES (:pid, :now, :now, 0, 0, :sorting, :doktype, :title, :slug, :is_siteroot)'
      );
      $stmt->execute([
          ':pid' => (int) $data['pid'],
          ':now' => $now,
          ':sorting' => $maxSort + 256,
          ':doktype' => (int) $data['doktype'],
          ':title' => $data['title'],
          ':slug' => $slug,
          ':is_siteroot' => (int) $data['isSiteroot'],
      ]);
      `
    );
  },

  async createContent({ header, bodytext = '', pid = 1, ctype = 'text', colPos = 0 }, context) {
    if ((!header || !String(header).trim()) && (!bodytext || !String(bodytext).trim())) {
      throw new Error('TYPO3 createContent requires a non-empty "header" or "bodytext"');
    }

    context.php.writeFile(
      '/tmp/typo3-content.json',
      JSON.stringify({
        header: String(header ?? ''),
        bodytext: String(bodytext ?? ''),
        pid: Number(pid ?? 1),
        ctype: String(ctype || 'text'),
        colPos: Number(colPos ?? 0),
      })
    );

    await runPhpCode(
      context.php,
      `
      $data = json_decode(file_get_contents('/tmp/typo3-content.json'), true);
      unlink('/tmp/typo3-content.json');
      ${typo3DbSnippet(phpSingleQuote(context.documentRoot))}

      $now = time();
      $maxSort = (int) $db->query('SELECT COALESCE(MAX(sorting), 0) FROM tt_content WHERE pid = ' . (int) $data['pid'])->fetchColumn();
      $stmt = $db->prepare(
          'INSERT INTO tt_content (pid, tstamp, crdate, deleted, hidden, sorting, colPos, CType, header, bodytext) '
          . 'VALUES (:pid, :now, :now, 0, 0, :sorting, :colPos, :ctype, :header, :bodytext)'
      );
      $stmt->execute([
          ':pid' => (int) $data['pid'],
          ':now' => $now,
          ':sorting' => $maxSort + 256,
          ':colPos' => (int) $data['colPos'],
          ':ctype' => $data['ctype'],
          ':header' => $data['header'],
          ':bodytext' => $data['bodytext'],
      ]);
      `
    );
  },
};

export const typo3Adapter = {
  name: 'typo3',
  label: 'TYPO3',
  aliases: ['typo3'],
  defaultPhp: '8.4',
  supportedPhp: ['8.2', '8.3', '8.4'],
  phpExtensions: ['intl'],
  defaultVersion: '13',
  adminPath: '/typo3',
  cliEntrypoint: 'typo3/sysext/core/bin/typo3',
  blueprintSteps,
  blueprintStepSchemas: {
    setSiteName: {
      requiredFields: ['name'],
      optionalFields: [],
      description: 'Update the TYPO3 site name',
    },
    runSql: {
      requiredFields: ['sql'],
      optionalFields: [],
      description: 'Execute SQL statements against the TYPO3 SQLite database',
    },
    createStarterSite: {
      requiredFields: [],
      optionalFields: ['title', 'siteName', 'header', 'bodytext', 'identifier'],
      description: 'Seed a root page, site config.yaml, TypoScript template, and optional tt_content record so / renders',
    },
    createPage: {
      requiredFields: ['title'],
      optionalFields: ['pid', 'slug', 'doktype', 'isSiteroot'],
      description: 'Insert a TYPO3 page record into the pages table',
    },
    createContent: {
      requiredFields: ['header'],
      optionalFields: ['bodytext', 'pid', 'ctype', 'colPos'],
      description: 'Insert a TYPO3 content element into the tt_content table',
    },
  },

  async resolveBundle({ version, cacheDir, log }) {
    const resolvedVersion = validateTypo3Version(version);
    const url = typo3DownloadUrl(resolvedVersion);
    const zipPath = join(cacheDir, `typo3-${resolvedVersion}.zip`);
    const zipBytes = await fetchCachedBytes(url, zipPath, { log });

    return {
      version: resolvedVersion,
      zipBytes,
      extractTo: '/tmp/typo3-extract',
    };
  },

  async configure({ php, documentRoot, url, password, site, log }) {
    if (!site && php.fileExists('/tmp/typo3-extract')) {
      await moveDirectoryContents(php, '/tmp/typo3-extract', documentRoot, { unwrapSingleDir: true });
    }

    // TYPO3's /typo3/index.php uses relative `require '../index.php'`, which fails when CWD is documentRoot.
    const typo3Index = `${documentRoot}/typo3/index.php`;
    if (php.fileExists(typo3Index)) {
      const content = php.readFileAsText(typo3Index);
      if (content.includes("require '../index.php'")) {
        php.writeFile(typo3Index, content.replace("require '../index.php'", "require __DIR__ . '/../index.php'"));
      }
    }

    const effectivePassword = site ? '(unchanged)' : ensureTypo3Password(password);

    const settingsExists =
      php.fileExists(`${documentRoot}/typo3conf/system/settings.php`) ||
      php.fileExists(`${documentRoot}/config/system/settings.php`);

    if (!site && !settingsExists) {
      log?.('Running TYPO3 SQLite setup...');
      php.writeFile(
        '/tmp/typo3-setup.json',
        JSON.stringify({ root: documentRoot, url, password: effectivePassword })
      );
      await runPhpCode(
        php,
        `
        $cfg = json_decode(file_get_contents('/tmp/typo3-setup.json'), true);
        unlink('/tmp/typo3-setup.json');
        $root = $cfg['root'];
        $cliScript = $root . '/typo3/sysext/core/bin/typo3';

        chdir($root);
        $_SERVER['argv'] = [$cliScript];
        $_SERVER['argc'] = 1;
        $_SERVER['SCRIPT_FILENAME'] = $cliScript;
        $_SERVER['SCRIPT_NAME'] = $cliScript;
        $_SERVER['PHP_SELF'] = $cliScript;
        $_SERVER['DOCUMENT_ROOT'] = $root;

        $classLoader = require $root . '/vendor/autoload.php';
        \\TYPO3\\CMS\\Core\\Core\\SystemEnvironmentBuilder::run(4, \\TYPO3\\CMS\\Core\\Core\\SystemEnvironmentBuilder::REQUESTTYPE_CLI);
        $container = \\TYPO3\\CMS\\Core\\Core\\Bootstrap::init($classLoader, true);
        $cmd = $container->get(\\TYPO3\\CMS\\Install\\Command\\SetupCommand::class);
        $cmd->setHelperSet(new \\Symfony\\Component\\Console\\Helper\\HelperSet([
            new \\Symfony\\Component\\Console\\Helper\\QuestionHelper(),
        ]));
        $input = new \\Symfony\\Component\\Console\\Input\\ArrayInput([
            '--driver' => 'sqlite',
            '--dbname' => 'typo3',
            '--admin-username' => 'admin',
            '--admin-user-password' => $cfg['password'],
            '--admin-email' => 'admin@example.com',
            '--project-name' => 'TYPO3 Playground',
            '--create-site' => $cfg['url'],
            '--server-type' => 'other',
            '--force' => true,
            '--no-interaction' => true,
        ]);
        $input->setInteractive(false);
        $output = new \\Symfony\\Component\\Console\\Output\\BufferedOutput();
        $code = $cmd->run($input, $output);
        if ($code !== 0) {
            throw new RuntimeException('TYPO3 setup failed (exit ' . $code . '): ' . trim($output->fetch()));
        }
        `
      );

      // SetupCommand can end its PHP request. Configure host validation and verify the admin user in a fresh one.
      php.writeFile(
        '/tmp/typo3-post-setup.json',
        JSON.stringify({
          root: documentRoot,
          host: new URL(url).hostname,
          password: effectivePassword,
        })
      );
      await runPhpCode(php, `
        $cfg = json_decode(file_get_contents('/tmp/typo3-post-setup.json'), true);
        unlink('/tmp/typo3-post-setup.json');
        $root = $cfg['root'];
        $host = $cfg['host'];
        $adminPassword = $cfg['password'];
        $hosts = array_unique(['localhost', '127.0.0.1', '[::1]', $host]);
        $trustedHosts = array_map(static fn ($name) => preg_quote($name, '/'), $hosts);
        $settings = null;
        foreach ([$root . '/typo3conf/system/settings.php', $root . '/config/system/settings.php'] as $file) {
            if (is_file($file)) {
                $settings = require $file;
                $settings['SYS']['trustedHostsPattern'] = '(?:' . implode('|', $trustedHosts) . ')(?::[0-9]+)?';
                file_put_contents($file, "<?php\\nreturn " . var_export($settings, true) . ";\\n");
                break;
            }
        }

        $dbPath = is_array($settings) ? ($settings['DB']['Connections']['Default']['path'] ?? null) : null;
        if (is_string($dbPath) && $dbPath !== '' && is_file($dbPath)) {
            $db = new PDO('sqlite:' . $dbPath);
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $count = (int) $db->query("SELECT COUNT(*) FROM be_users WHERE username = 'admin' AND deleted = 0")->fetchColumn();
            if ($count === 0) {
                require_once $root . '/vendor/autoload.php';
                $hasher = new \\TYPO3\\CMS\\Core\\Crypto\\PasswordHashing\\BcryptPasswordHash();
                $hash = $hasher->getHashedPassword($adminPassword);
                $now = time();
                $stmt = $db->prepare(
                    'INSERT INTO be_users (pid, tstamp, crdate, username, password, admin, disable, deleted, email, realName) '
                    . 'VALUES (0, :now, :now, :username, :password, 1, 0, 0, :email, :realName)'
                );
                $stmt->execute([
                    ':now' => $now,
                    ':username' => 'admin',
                    ':password' => $hash,
                    ':email' => 'admin@example.com',
                    ':realName' => 'Admin',
                ]);
            }
        }
      `);
    }

    return {
      username: 'admin',
      password: effectivePassword,
    };
  },

  getFileNotFoundAction(relativePath) {
    if (relativePath.endsWith('.php')) {
      return { type: '404' };
    }

    return { type: 'internal-redirect', uri: '/index.php' };
  },

  detectAutoMount(dir) {
    return detectTypo3AutoMount(dir);
  },
};

/**
 * Inspects a host directory for a TYPO3 extension (ext_emconf.php or composer.json type "typo3-cms-extension").
 */
export function detectTypo3AutoMount(dir) {
  const absDir = resolve(dir);

  if (!existsSync(absDir)) {
    return null;
  }

  let extKey = basename(absDir).replace(/[^a-zA-Z0-9_]/g, '_');
  let detected = false;

  const composerPath = join(absDir, 'composer.json');
  if (existsSync(composerPath)) {
    try {
      const composer = JSON.parse(readFileSync(composerPath, 'utf8'));
      if (composer?.type === 'typo3-cms-extension') {
        detected = true;
        const configuredKey = composer?.extra?.['typo3/cms']?.['extension-key'];
        if (typeof configuredKey === 'string' && /^[a-z][a-z0-9_]*$/i.test(configuredKey)) {
          extKey = configuredKey;
        }
      }
    } catch {}
  }

  if (!detected && existsSync(join(absDir, 'ext_emconf.php'))) {
    detected = true;
  }

  if (detected) {
    return {
      kind: 'typo3-extension',
      slug: extKey,
      mounts: [{ hostPath: absDir, vfsPath: `${DOCUMENT_ROOT}/typo3conf/ext/${extKey}` }],
      async postMount({ php, documentRoot, log }) {
        log?.(`Activating TYPO3 extension "${extKey}"...`);
        await runPhpCode(
          php,
          `
          $root = ${phpSingleQuote(documentRoot)};
          $extKey = ${phpSingleQuote(extKey)};
          $packageStatesFile = $root . '/typo3conf/PackageStates.php';
          if (file_exists($packageStatesFile)) {
              $states = require $packageStatesFile;
              if (is_array($states) && isset($states['packages']) && is_array($states['packages'])) {
                  if (!isset($states['packages'][$extKey])) {
                      $states['packages'][$extKey] = [
                          'packagePath' => 'typo3conf/ext/' . $extKey . '/',
                      ];
                      file_put_contents($packageStatesFile, "<?php\\nreturn " . var_export($states, true) . ";\\n");
                  }
              }
          }
          `
        );
      },
    };
  }

  return null;
}
