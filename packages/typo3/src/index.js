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
      $dbPath = $settings['DB']['Connections']['Default']['path'] ?? null;
      if (!is_string($dbPath) || $dbPath === '') {
          throw new RuntimeException('TYPO3 SQLite database path not configured in settings.php');
      }
      $db = new PDO('sqlite:' . $dbPath);
      $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
      if (trim($sql) !== '') {
          $db->exec($sql);
      }
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

    const settingsExists =
      php.fileExists(`${documentRoot}/typo3conf/system/settings.php`) ||
      php.fileExists(`${documentRoot}/config/system/settings.php`);

    if (!site && !settingsExists) {
      log?.('Running TYPO3 SQLite setup...');
      php.writeFile(
        '/tmp/typo3-setup.json',
        JSON.stringify({ root: documentRoot, url, password })
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

      // SetupCommand can end its PHP request. Configure host validation in a fresh one.
      await runPhpCode(php, `
        $root = ${phpSingleQuote(documentRoot)};
        $host = base64_decode('${Buffer.from(new URL(url).hostname).toString('base64')}');
        $hosts = array_unique(['localhost', '127.0.0.1', '[::1]', $host]);
        $trustedHosts = array_map(static fn ($name) => preg_quote($name, '/'), $hosts);
        foreach ([$root . '/typo3conf/system/settings.php', $root . '/config/system/settings.php'] as $file) {
            if (is_file($file)) {
                $settings = require $file;
                $settings['SYS']['trustedHostsPattern'] = '(?:' . implode('|', $trustedHosts) . ')(?::[0-9]+)?';
                file_put_contents($file, "<?php\\nreturn " . var_export($settings, true) . ";\\n");
                break;
            }
        }
      `);
    }

    return {
      username: 'admin',
      password: site ? '(unchanged)' : password,
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
