// Shared Blueprint loader and runner for @cms-playground.
// Combines CMS-agnostic core steps with adapter-specific steps.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPhpCode, unpackZip } from './runtime.js';

export const CORE_STEPS = {
  async runPHP({ code }, context) {
    const cleaned = String(code).replace(/^\s*<\?(?:php)?\s*/i, '');
    await runPhpCode(context.php, `chdir(${JSON.stringify(context.documentRoot)});\n${cleaned}`);
  },

  async writeFile({ path, data }, context) {
    const target = resolveVfsPath(context.documentRoot, path);
    const parent = target.slice(0, target.lastIndexOf('/'));

    if (parent) {
      context.php.mkdir(parent);
    }

    context.php.writeFile(target, typeof data === 'string' ? data : new Uint8Array(data));
  },

  async mkdir({ path }, context) {
    context.php.mkdir(resolveVfsPath(context.documentRoot, path));
  },

  async unzip({ url, to = '' }, context) {
    const resolvedUrl = new URL(url, context.baseUrl).href;
    const response = await fetch(resolvedUrl, { redirect: 'follow' });

    if (!response.ok) {
      throw new Error(`Cannot download ${resolvedUrl}: HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const target = to ? resolveVfsPath(context.documentRoot, to) : context.documentRoot;

    await unpackZip(context.php, bytes, target);
  },
};

function resolveVfsPath(documentRoot, relativePath) {
  const clean = String(relativePath).replace(/^\/+/, '');

  if (clean.split('/').includes('..')) {
    throw new Error(`Invalid path "${relativePath}": parent traversal is not allowed`);
  }

  return `${documentRoot}/${clean}`;
}

/**
 * Loads a blueprint JSON from a local file path or HTTP(S) URL.
 */
export async function loadBlueprint(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { redirect: 'follow' });

    if (!response.ok) {
      throw new Error(`Cannot fetch blueprint ${source}: HTTP ${response.status}`);
    }

    const blueprint = await response.json();

    return { blueprint, baseUrl: source };
  }

  const absPath = resolve(source);
  const blueprint = JSON.parse(readFileSync(absPath, 'utf8'));

  return { blueprint, baseUrl: pathToFileURL(dirname(absPath) + '/').href };
}

/**
 * Executes blueprint steps using core steps + adapter-specific steps.
 */
export async function runBlueprint(blueprint, context, adapterSteps = {}) {
  const steps = blueprint?.steps ?? [];
  const registry = { ...CORE_STEPS, ...adapterSteps };

  for (const [index, step] of steps.entries()) {
    const fn = registry[step?.step];

    if (!fn) {
      throw new Error(
        `Blueprint step ${index + 1}: unknown step "${step?.step}". Known steps: ${Object.keys(registry).join(', ')}`
      );
    }

    context.log?.(`Blueprint step ${index + 1}/${steps.length}: ${step.step}`);
    await fn(step, context);
  }
}
