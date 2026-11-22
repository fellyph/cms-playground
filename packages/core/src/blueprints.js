// Shared Blueprint loader and runner for @cms-playground.
// Combines CMS-agnostic core steps with adapter-specific steps.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    const resolved = new URL(url, context.baseUrl);
    let bytes;

    if (resolved.protocol === 'file:') {
      let baseProtocol = null;
      try {
        baseProtocol = context.baseUrl ? new URL(context.baseUrl).protocol : null;
      } catch {}

      if (baseProtocol !== 'file:') {
        throw new Error(`Cannot read local file URL "${resolved.href}" from a non-local blueprint`);
      }

      bytes = new Uint8Array(readFileSync(fileURLToPath(resolved)));
    } else {
      const response = await fetch(resolved.href, { redirect: 'follow' });

      if (!response.ok) {
        throw new Error(`Cannot download ${resolved.href}: HTTP ${response.status}`);
      }

      bytes = new Uint8Array(await response.arrayBuffer());
    }

    const target = to ? resolveVfsPath(context.documentRoot, to) : context.documentRoot;

    await unpackZip(context.php, bytes, target);
  },
};

export function resolveVfsPath(documentRoot, relativePath) {
  if (typeof relativePath !== 'string') {
    throw new Error('Invalid path: expected a non-empty string');
  }

  if (relativePath.includes('\0') || relativePath.includes('\\')) {
    throw new Error(`Invalid path "${relativePath}": backslashes and null bytes are not allowed`);
  }

  const clean = relativePath.replace(/^\/+/, '');

  if (!clean) {
    throw new Error(`Invalid path "${relativePath}": path must not be empty`);
  }

  if (clean.split('/').includes('..')) {
    throw new Error(`Invalid path "${relativePath}": parent traversal is not allowed`);
  }

  return `${documentRoot}/${clean}`;
}

function validateBlueprint(blueprint, source) {
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) {
    throw new Error(`Invalid blueprint "${source}": expected a JSON object`);
  }

  if (blueprint.steps !== undefined && !Array.isArray(blueprint.steps)) {
    throw new Error(`Invalid blueprint "${source}": "steps" must be an array`);
  }

  return blueprint;
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

    const blueprint = validateBlueprint(await response.json(), source);

    return { blueprint, baseUrl: source };
  }

  const absPath = resolve(source);
  const blueprint = validateBlueprint(JSON.parse(readFileSync(absPath, 'utf8')), source);

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
