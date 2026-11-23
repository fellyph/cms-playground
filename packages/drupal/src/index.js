// Drupal adapter for @cms-playground.
// Downloads official Drupal core zip and installs programmatically on SQLite inside PHP-WASM.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  DOCUMENT_ROOT,
  fetchCachedBytes,
  moveDirectoryContents,
  phpSingleQuote,
  runPhpCode,
} from '@cms-playground/core';

const DRUPAL_VERSION_RE = /^(latest|default|[0-9]+(\.[0-9]+)*(-[a-zA-Z0-9.]+)?)$/;

export function validateDrupalVersion(version) {
  if (!version || version === 'latest' || version === 'default') {
    return 'latest';
  }

  const normalized = String(version).replace(/^v/i, '');

  if (!DRUPAL_VERSION_RE.test(normalized)) {
    throw new Error(`Invalid Drupal version "${version}". Expected "latest" or a version number like "11.4.13".`);
  }

  return normalized;
}

export function drupalDownloadUrl(version) {
  const resolved = validateDrupalVersion(version);

  if (resolved === 'latest') {
    return 'https://www.drupal.org/download-latest/zip';
  }

  return `https://ftp.drupal.org/files/projects/drupal-${resolved}.zip`;
}

function drupalBootstrapSnippet(rootExpr) {
  return `
    $root = ${rootExpr};
    chdir($root);
    $autoloader = require $root . '/autoload.php';
    $request = Symfony\\Component\\HttpFoundation\\Request::create('/');
    $kernel = Drupal\\Core\\DrupalKernel::createFromRequest($request, $autoloader, 'prod');
    $kernel->boot();
    $kernel->preHandle($request);
  `;
}

const blueprintSteps = {
  async setSiteName({ name }, context) {
    context.php.writeFile('/tmp/drupal-sitename.json', JSON.stringify({ name: String(name ?? '') }));
    await runPhpCode(
      context.php,
      `
      $data = json_decode(file_get_contents('/tmp/drupal-sitename.json'), true);
      unlink('/tmp/drupal-sitename.json');
      ${drupalBootstrapSnippet(phpSingleQuote(context.documentRoot))}
      \\Drupal::configFactory()->getEditable('system.site')->set('name', $data['name'])->save();
      drupal_flush_all_caches();
      `
    );
  },

  async enableModule({ module }, context) {
    if (!module || !/^[a-z][a-z0-9_]*$/i.test(String(module))) {
      throw new Error(`Invalid Drupal module machine name "${module}"`);
    }

    await runPhpCode(
      context.php,
      `
      ${drupalBootstrapSnippet(phpSingleQuote(context.documentRoot))}
      \\Drupal::service('module_installer')->install([${phpSingleQuote(String(module))}]);
      `
    );
  },
};

export const drupalAdapter = {
  name: 'drupal',
  label: 'Drupal',
  aliases: ['drupal'],
  defaultPhp: '8.4',
  supportedPhp: ['8.3', '8.4', '8.5'],
  phpExtensions: ['intl'],
  defaultVersion: 'latest',
  adminPath: '/user/login',
  cliEntrypoint: null,
  blueprintSteps,
  blueprintStepSchemas: {
    setSiteName: {
      requiredFields: ['name'],
      optionalFields: [],
      description: 'Update the Drupal site name',
    },
    enableModule: {
      requiredFields: ['module'],
      optionalFields: [],
      description: 'Install and enable a Drupal module',
    },
  },

  async resolveBundle({ version, cacheDir, log }) {
    const resolvedVersion = validateDrupalVersion(version);
    const url = drupalDownloadUrl(resolvedVersion);
    const zipPath = join(cacheDir, `drupal-${resolvedVersion}.zip`);
    const zipBytes = await fetchCachedBytes(url, zipPath, { log });

    return {
      version: resolvedVersion,
      zipBytes,
      extractTo: '/tmp/drupal-extract',
    };
  },

  async configure({ php, documentRoot, url, password, site, log }) {
    if (!site && php.fileExists('/tmp/drupal-extract')) {
      await moveDirectoryContents(php, '/tmp/drupal-extract', documentRoot, { unwrapSingleDir: true });
    }

    // PHP-WASM (Emscripten) does not implement POSIX ucontext/getcontext required by PHP Fibers.
    // Patch Drupal's Renderer.php to execute render contexts and placeholders synchronously.
    const rendererPath = `${documentRoot}/core/lib/Drupal/Core/Render/Renderer.php`;
    if (php.fileExists(rendererPath)) {
      let code = php.readFileAsText(rendererPath);
      if (code.includes('new \\Fiber(')) {
        code = code.replace(
          /\$fiber\s*=\s*new\s+\\Fiber\(static fn \(\) => \$callable\(\)\);[\s\S]*?\$result\s*=\s*\$fiber->getReturn\(\);/,
          () => '$result = $callable();'
        );
        code = code.replace(
          /\$fibers\s*=\s*\[\];[\s\S]*?\$iterations\+\+;\s*\}/,
          () =>
            `foreach ($elements['#attached']['placeholders'] as $placeholder => $placeholder_element) {\n` +
            `      if (isset($placeholder_element['#lazy_builder']) && $placeholder_element['#lazy_builder'][0] === 'Drupal\\\\Core\\\\Render\\\\Element\\\\StatusMessages::renderMessages') {\n` +
            `        $message_placeholders[] = $placeholder;\n` +
            `      } else {\n` +
            `        $markup = $this->doRenderPlaceholder($placeholder_element);\n` +
            `        $elements = $this->doReplacePlaceholder($placeholder, $markup, $elements, $placeholder_element);\n` +
            `      }\n` +
            `    }`
        );
        php.writeFile(rendererPath, code);
      }
    }

    if (!site && !php.fileExists(`${documentRoot}/sites/default/settings.php`)) {
      log?.('Installing Drupal on SQLite (minimal profile)...');
      php.writeFile('/tmp/drupal-install.json', JSON.stringify({ root: documentRoot, url, password }));
      await runPhpCode(
        php,
        `
        $cfg = json_decode(file_get_contents('/tmp/drupal-install.json'), true);
        unlink('/tmp/drupal-install.json');
        $root = $cfg['root'];
        $parsed = parse_url($cfg['url']);
        $host = $parsed['host'] ?? '127.0.0.1';
        $port = (string) ($parsed['port'] ?? 80);

        $_SERVER['HTTP_HOST'] = $host . ':' . $port;
        $_SERVER['SERVER_NAME'] = $host;
        $_SERVER['SERVER_PORT'] = $port;
        $_SERVER['REQUEST_URI'] = '/';
        $_SERVER['REQUEST_METHOD'] = 'GET';
        $_SERVER['SCRIPT_NAME'] = '/index.php';
        $_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
        $_SERVER['PHP_SELF'] = '/index.php';

        chdir($root);
        @mkdir($root . '/sites/default/files', 0777, true);
        $class_loader = require $root . '/autoload.php';
        require_once $root . '/core/includes/install.core.inc';

        $settings = [
            'parameters' => [
                'profile' => 'minimal',
                'langcode' => 'en',
            ],
            'forms' => [
                'install_settings_form' => [
                    'driver' => 'Drupal\\\\sqlite\\\\Driver\\\\Database\\\\sqlite',
                    'Drupal\\\\sqlite\\\\Driver\\\\Database\\\\sqlite' => [
                        'database' => 'sites/default/files/.ht.sqlite',
                    ],
                ],
                'install_configure_form' => [
                    'site_name' => 'Drupal Playground',
                    'site_mail' => 'admin@example.com',
                    'account' => [
                        'name' => 'admin',
                        'mail' => 'admin@example.com',
                        'pass' => [
                            'pass1' => $cfg['password'],
                            'pass2' => $cfg['password'],
                        ],
                    ],
                    'enable_update_status_module' => false,
                    'enable_update_status_emails' => false,
                ],
            ],
        ];

        install_drupal($class_loader, $settings);

        $settingsFile = $root . '/sites/default/settings.php';
        if (file_exists($settingsFile)) {
            @chmod($settingsFile, 0666);
            $content = file_get_contents($settingsFile);
            if (strpos($content, 'trusted_host_patterns') === false) {
                $content .= "\\n\\$settings['trusted_host_patterns'] = ['^localhost$', '^127\\\\.0\\\\.0\\\\.1$'];\\n";
                file_put_contents($settingsFile, $content);
            }
        }
        `
      );
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
    return detectDrupalAutoMount(dir);
  },
};

/**
 * Inspects a host directory for a Drupal module or theme (*.info.yml)
 * and returns mount + postMount activation instructions.
 */
export function detectDrupalAutoMount(dir) {
  const absDir = resolve(dir);

  if (!existsSync(absDir)) {
    return null;
  }

  const infoFiles = readdirSync(absDir).filter((name) => name.endsWith('.info.yml'));

  for (const infoFile of infoFiles) {
    const machineName = infoFile.slice(0, -'.info.yml'.length);

    if (!/^[a-z][a-z0-9_]*$/i.test(machineName)) {
      continue;
    }

    const yaml = readFileSync(join(absDir, infoFile), 'utf8').slice(0, 8192);
    const typeMatch = yaml.match(/^\s*type\s*:\s*['"]?(module|theme)['"]?\s*$/m);

    if (!typeMatch) {
      continue;
    }

    const extType = typeMatch[1];

    if (extType === 'module') {
      return {
        kind: 'drupal-module',
        slug: machineName,
        mounts: [{ hostPath: absDir, vfsPath: `${DOCUMENT_ROOT}/modules/custom/${machineName}` }],
        async postMount({ php, documentRoot, log }) {
          log?.(`Enabling Drupal module "${machineName}"...`);
          await runPhpCode(
            php,
            `
            ${drupalBootstrapSnippet(phpSingleQuote(documentRoot))}
            \\Drupal::service('module_installer')->install([${phpSingleQuote(machineName)}]);
            `
          );
        },
      };
    }

    if (extType === 'theme') {
      return {
        kind: 'drupal-theme',
        slug: machineName,
        mounts: [{ hostPath: absDir, vfsPath: `${DOCUMENT_ROOT}/themes/custom/${machineName}` }],
        async postMount({ php, documentRoot, log }) {
          log?.(`Installing and activating Drupal theme "${machineName}"...`);
          await runPhpCode(
            php,
            `
            ${drupalBootstrapSnippet(phpSingleQuote(documentRoot))}
            \\Drupal::service('theme_installer')->install([${phpSingleQuote(machineName)}]);
            \\Drupal::configFactory()->getEditable('system.theme')->set('default', ${phpSingleQuote(machineName)})->save();
            `
          );
        },
      };
    }
  }

  // Fallback: custom modules/ or themes/ folder
  if (existsSync(join(absDir, 'modules')) || existsSync(join(absDir, 'themes'))) {
    const slug = basename(absDir);
    return {
      kind: 'drupal-sites-default',
      slug,
      mounts: [{ hostPath: absDir, vfsPath: `${DOCUMENT_ROOT}/sites/default` }],
    };
  }

  return null;
}
