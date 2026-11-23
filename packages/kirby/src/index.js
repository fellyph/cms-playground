// Kirby CMS adapter for @cms-playground.
// Downloads official Kirby Starterkit (flat-file, zero DB) and creates a Panel admin account inside PHP-WASM.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  DOCUMENT_ROOT,
  fetchCachedBytes,
  moveDirectoryContents,
  runPhpCode,
} from '@cms-playground/core';

const KIRBY_VERSION_RE = /^(latest|default|[0-9]+(\.[0-9]+)*(-[a-zA-Z0-9.]+)?)$/;

export function validateKirbyVersion(version) {
  if (!version || version === 'latest' || version === 'default') {
    return 'latest';
  }

  const normalized = String(version).replace(/^v/i, '');

  if (!KIRBY_VERSION_RE.test(normalized)) {
    throw new Error(`Invalid Kirby version "${version}". Expected "latest" or a tag like "5.6.4".`);
  }

  return normalized;
}

export function kirbyDownloadUrl(version) {
  const resolved = validateKirbyVersion(version);

  if (resolved === 'latest') {
    return 'https://github.com/getkirby/starterkit/archive/refs/heads/main.zip';
  }

  return `https://github.com/getkirby/starterkit/archive/refs/tags/${resolved}.zip`;
}

const blueprintSteps = {
  async setSiteTitle({ title }, context) {
    context.php.writeFile('/tmp/kirby-title.json', JSON.stringify({ title: String(title ?? '') }));
    await runPhpCode(
      context.php,
      `
      $data = json_decode(file_get_contents('/tmp/kirby-title.json'), true);
      unlink('/tmp/kirby-title.json');
      $file = ${JSON.stringify(context.documentRoot)} . '/content/site.txt';
      $content = file_exists($file) ? file_get_contents($file) : '';
      $title = str_replace(["\\r", "\\n"], ' ', $data['title']);
      if (preg_match('/^Title\\s*:.*$/mi', $content)) {
          $content = preg_replace_callback(
              '/^Title\\s*:.*$/mi',
              fn () => 'Title: ' . $title,
              $content,
              1
          );
      } else {
          $content = "Title: " . $title . "\\n\\n----\\n\\n" . ltrim($content);
      }
      @mkdir(dirname($file), 0777, true);
      file_put_contents($file, $content);
      `
    );
  },

  async createPage({ slug, title, template = 'default', content = {} }, context) {
    if (!slug || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(String(slug).replace(/^\/+|\/+$/g, ''))) {
      throw new Error(`Invalid Kirby page slug "${slug}"`);
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(String(template))) {
      throw new Error(`Invalid Kirby template name "${template}"`);
    }

    context.php.writeFile(
      '/tmp/kirby-page.json',
      JSON.stringify({ slug: String(slug).replace(/^\/+|\/+$/g, ''), title: String(title ?? slug), template, content })
    );
    await runPhpCode(
      context.php,
      `
      $data = json_decode(file_get_contents('/tmp/kirby-page.json'), true);
      unlink('/tmp/kirby-page.json');
      $dir = ${JSON.stringify(context.documentRoot)} . '/content/' . $data['slug'];
      @mkdir($dir, 0777, true);
      $fields = array_merge(['Title' => $data['title']], is_array($data['content']) ? $data['content'] : []);
      $chunks = [];
      foreach ($fields as $key => $val) {
          $chunks[] = ucfirst((string) $key) . ': ' . (string) $val;
      }
      file_put_contents($dir . '/' . $data['template'] . '.txt', implode("\\n\\n----\\n\\n", $chunks) . "\\n");
      `
    );
  },
};

export const kirbyAdapter = {
  name: 'kirby',
  label: 'Kirby',
  aliases: ['kirby'],
  defaultPhp: '8.4',
  supportedPhp: ['8.2', '8.3', '8.4', '8.5'],
  phpExtensions: ['intl'],
  defaultVersion: 'latest',
  adminPath: '/panel',
  cliEntrypoint: null,
  blueprintSteps,
  blueprintStepSchemas: {
    setSiteTitle: {
      requiredFields: ['title'],
      optionalFields: [],
      description: 'Update the Kirby site title',
    },
    createPage: {
      requiredFields: ['slug'],
      optionalFields: ['title', 'template', 'content'],
      description: 'Create a flat-file Kirby page',
    },
  },

  async resolveBundle({ version, cacheDir, log }) {
    const resolvedVersion = validateKirbyVersion(version);
    const url = kirbyDownloadUrl(resolvedVersion);
    const zipPath = join(cacheDir, `kirby-starterkit-${resolvedVersion}.zip`);
    const zipBytes = await fetchCachedBytes(url, zipPath, { log });

    return {
      version: resolvedVersion,
      zipBytes,
      extractTo: '/tmp/kirby-extract',
    };
  },

  async configure({ php, documentRoot, url, password, site, log }) {
    if (!site && php.fileExists('/tmp/kirby-extract')) {
      await moveDirectoryContents(php, '/tmp/kirby-extract', documentRoot, { unwrapSingleDir: true });
    }

    if (!site) {
      log?.('Configuring Kirby URL and Panel admin account...');
      php.writeFile('/tmp/kirby-setup.json', JSON.stringify({ root: documentRoot, url, password }));
      await runPhpCode(
        php,
        `
        $cfg = json_decode(file_get_contents('/tmp/kirby-setup.json'), true);
        unlink('/tmp/kirby-setup.json');

        $configFile = $cfg['root'] . '/site/config/config.php';
        $config = file_exists($configFile) ? (require $configFile) : [];
        if (!is_array($config)) {
            $config = [];
        }
        $config['url'] = rtrim($cfg['url'], '/');
        @mkdir(dirname($configFile), 0777, true);
        file_put_contents($configFile, "<?php\\nreturn " . var_export($config, true) . ";\\n");

        require_once $cfg['root'] . '/kirby/bootstrap.php';
        $kirby = new Kirby\\Cms\\App(['roots' => ['index' => $cfg['root']]]);
        if ($kirby->users()->count() === 0) {
            $kirby->impersonate('kirby');
            $kirby->users()->create([
                'email'    => 'admin@example.com',
                'name'     => 'Admin',
                'password' => $cfg['password'],
                'role'     => 'admin',
            ]);
        }
        `
      );
    }

    return {
      username: 'admin@example.com',
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
    return detectKirbyAutoMount(dir);
  },
};

/**
 * Inspects a host directory for a Kirby plugin, site/ directory, or content/ directory.
 */
export function detectKirbyAutoMount(dir) {
  const absDir = resolve(dir);

  if (!existsSync(absDir)) {
    return null;
  }

  const slug = basename(absDir);

  // 1. Kirby Plugin: composer.json with type "kirby-plugin" or index.php calling Kirby::plugin(...)
  const composerPath = join(absDir, 'composer.json');
  const indexPath = join(absDir, 'index.php');

  if (existsSync(composerPath)) {
    try {
      const composer = JSON.parse(readFileSync(composerPath, 'utf8'));
      if (composer?.type === 'kirby-plugin') {
        return {
          kind: 'kirby-plugin',
          slug,
          mounts: [{ hostPath: absDir, vfsPath: `${DOCUMENT_ROOT}/site/plugins/${slug}` }],
        };
      }
    } catch {}
  }

  if (existsSync(indexPath)) {
    const content = readFileSync(indexPath, 'utf8').slice(0, 8192);
    if (/Kirby\s*::\s*plugin\s*\(/i.test(content)) {
      return {
        kind: 'kirby-plugin',
        slug,
        mounts: [{ hostPath: absDir, vfsPath: `${DOCUMENT_ROOT}/site/plugins/${slug}` }],
      };
    }
  }

  // 2. Kirby content/ directory (contains site.txt)
  if (existsSync(join(absDir, 'site.txt'))) {
    return {
      kind: 'kirby-content',
      slug,
      mounts: [{ hostPath: absDir, vfsPath: `${DOCUMENT_ROOT}/content` }],
    };
  }

  // 3. Kirby site/ directory (contains config/ and templates/ or blueprints/ or plugins/)
  if (
    existsSync(join(absDir, 'config')) &&
    (existsSync(join(absDir, 'templates')) || existsSync(join(absDir, 'blueprints')) || existsSync(join(absDir, 'plugins')))
  ) {
    return {
      kind: 'kirby-site',
      slug,
      mounts: [{ hostPath: absDir, vfsPath: `${DOCUMENT_ROOT}/site` }],
    };
  }

  return null;
}
