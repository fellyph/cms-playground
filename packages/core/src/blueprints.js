// Shared Blueprint loader and runner for @cms-playground.
// Combines CMS-agnostic core steps with adapter-specific steps.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT_CODES, PlaygroundError, formatJsonPointer } from './errors.js';
import { runPhpCode, unpackZip } from './runtime.js';

export const CORE_STEP_SCHEMAS = Object.freeze({
  runPHP: Object.freeze({
    requiredFields: ['code'],
    optionalFields: [],
    description: 'Execute PHP code inside the site document root',
  }),
  writeFile: Object.freeze({
    requiredFields: ['path', 'data'],
    optionalFields: [],
    description: 'Write a file relative to the site document root',
  }),
  mkdir: Object.freeze({
    requiredFields: ['path'],
    optionalFields: [],
    description: 'Create a directory relative to the site document root',
  }),
  unzip: Object.freeze({
    requiredFields: ['url'],
    optionalFields: ['to'],
    description: 'Download or read a zip archive and unpack it into the VFS',
  }),
});

export const CORE_STEPS = {
  async runPHP({ code }, context) {
    if (typeof code !== 'string') {
      throw new PlaygroundError('Blueprint step runPHP requires a string "code" property', {
        code: 'invalid_blueprint_step',
        exitCode: EXIT_CODES.VALIDATION,
        pointer: context.stepIndex !== undefined ? formatJsonPointer('steps', context.stepIndex, 'code') : undefined,
      });
    }
    const cleaned = code.replace(/^\s*<\?(?:php)?\s*/i, '');
    await runPhpCode(context.php, `chdir(${JSON.stringify(context.documentRoot)});\n${cleaned}`);
  },

  async writeFile({ path, data }, context) {
    let target;
    try {
      target = resolveVfsPath(context.documentRoot, path);
    } catch (error) {
      throw new PlaygroundError(error.message, {
        code: 'invalid_blueprint_step',
        exitCode: EXIT_CODES.VALIDATION,
        pointer: context.stepIndex !== undefined ? formatJsonPointer('steps', context.stepIndex, 'path') : undefined,
        cause: error,
      });
    }
    const parent = target.slice(0, target.lastIndexOf('/'));

    if (parent) {
      context.php.mkdir(parent);
    }

    context.php.writeFile(target, typeof data === 'string' ? data : new Uint8Array(data));
  },

  async mkdir({ path }, context) {
    let target;
    try {
      target = resolveVfsPath(context.documentRoot, path);
    } catch (error) {
      throw new PlaygroundError(error.message, {
        code: 'invalid_blueprint_step',
        exitCode: EXIT_CODES.VALIDATION,
        pointer: context.stepIndex !== undefined ? formatJsonPointer('steps', context.stepIndex, 'path') : undefined,
        cause: error,
      });
    }
    context.php.mkdir(target);
  },

  async unzip({ url, to = '' }, context) {
    if (typeof url !== 'string' || !url) {
      throw new PlaygroundError('Blueprint step unzip requires a non-empty "url" property', {
        code: 'invalid_blueprint_step',
        exitCode: EXIT_CODES.VALIDATION,
        pointer: context.stepIndex !== undefined ? formatJsonPointer('steps', context.stepIndex, 'url') : undefined,
      });
    }

    const resolved = new URL(url, context.baseUrl);
    let bytes;

    if (resolved.protocol === 'file:') {
      let baseProtocol = null;
      try {
        baseProtocol = context.baseUrl ? new URL(context.baseUrl).protocol : null;
      } catch {}

      if (baseProtocol !== 'file:') {
        throw new PlaygroundError(
          `Cannot read local file URL "${resolved.href}" from a non-local blueprint`,
          {
            code: 'invalid_blueprint_step',
            exitCode: EXIT_CODES.VALIDATION,
            pointer: context.stepIndex !== undefined ? formatJsonPointer('steps', context.stepIndex, 'url') : undefined,
          }
        );
      }

      bytes = new Uint8Array(readFileSync(fileURLToPath(resolved)));
    } else {
      const response = await fetch(resolved.href, { redirect: 'follow' });

      if (!response.ok) {
        throw new PlaygroundError(`Cannot download ${resolved.href}: HTTP ${response.status}`, {
          code: 'download_failed',
          exitCode: EXIT_CODES.NETWORK,
          retryable: true,
          pointer: context.stepIndex !== undefined ? formatJsonPointer('steps', context.stepIndex, 'url') : undefined,
        });
      }

      bytes = new Uint8Array(await response.arrayBuffer());
    }

    let target;
    try {
      target = to ? resolveVfsPath(context.documentRoot, to) : context.documentRoot;
    } catch (error) {
      throw new PlaygroundError(error.message, {
        code: 'invalid_blueprint_step',
        exitCode: EXIT_CODES.VALIDATION,
        pointer: context.stepIndex !== undefined ? formatJsonPointer('steps', context.stepIndex, 'to') : undefined,
        cause: error,
      });
    }

    await unpackZip(context.php, bytes, target);
  },
};

export function resolveVfsPath(documentRoot, relativePath) {
  if (typeof relativePath !== 'string') {
    throw new PlaygroundError('Invalid path: expected a non-empty string', {
      code: 'invalid_path',
      exitCode: EXIT_CODES.VALIDATION,
    });
  }

  if (relativePath.includes('\0') || relativePath.includes('\\')) {
    throw new PlaygroundError(
      `Invalid path "${relativePath}": backslashes and null bytes are not allowed`,
      {
        code: 'invalid_path',
        exitCode: EXIT_CODES.VALIDATION,
      }
    );
  }

  const clean = relativePath.replace(/^\/+/, '');

  if (!clean) {
    throw new PlaygroundError(`Invalid path "${relativePath}": path must not be empty`, {
      code: 'invalid_path',
      exitCode: EXIT_CODES.VALIDATION,
    });
  }

  if (clean.split('/').includes('..')) {
    throw new PlaygroundError(`Invalid path "${relativePath}": parent traversal is not allowed`, {
      code: 'invalid_path',
      exitCode: EXIT_CODES.VALIDATION,
    });
  }

  return `${documentRoot}/${clean}`;
}

function validateBlueprint(blueprint, source) {
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) {
    throw new PlaygroundError(`Invalid blueprint "${source}": expected a JSON object`, {
      code: 'invalid_blueprint',
      exitCode: EXIT_CODES.VALIDATION,
      pointer: '',
    });
  }

  if (blueprint.steps !== undefined && !Array.isArray(blueprint.steps)) {
    throw new PlaygroundError(`Invalid blueprint "${source}": "steps" must be an array`, {
      code: 'invalid_blueprint',
      exitCode: EXIT_CODES.VALIDATION,
      pointer: formatJsonPointer('steps'),
    });
  }

  if (Array.isArray(blueprint.steps)) {
    for (const [index, step] of blueprint.steps.entries()) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new PlaygroundError(`Invalid blueprint "${source}": step ${index + 1} must be an object`, {
          code: 'invalid_blueprint_step',
          exitCode: EXIT_CODES.VALIDATION,
          pointer: formatJsonPointer('steps', index),
        });
      }
    }
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
      throw new PlaygroundError(`Cannot fetch blueprint ${source}: HTTP ${response.status}`, {
        code: response.status === 404 ? 'blueprint_not_found' : 'blueprint_fetch_failed',
        exitCode: response.status === 404 ? EXIT_CODES.NOT_FOUND : EXIT_CODES.NETWORK,
        retryable: response.status !== 404,
      });
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new PlaygroundError(`Invalid blueprint "${source}": malformed JSON (${error.message})`, {
        code: 'invalid_blueprint',
        exitCode: EXIT_CODES.VALIDATION,
        pointer: '',
        cause: error,
      });
    }

    const blueprint = validateBlueprint(parsed, source);

    return { blueprint, baseUrl: source };
  }

  const absPath = resolve(source);
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new PlaygroundError(`Blueprint file does not exist: ${absPath}`, {
        code: 'blueprint_not_found',
        exitCode: EXIT_CODES.NOT_FOUND,
        suggestions: ['Verify the --blueprint path or pass --cwd=<project-dir>.'],
        cause: error,
      });
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PlaygroundError(`Invalid blueprint "${source}": malformed JSON (${error.message})`, {
      code: 'invalid_blueprint',
      exitCode: EXIT_CODES.VALIDATION,
      pointer: '',
      cause: error,
    });
  }

  const blueprint = validateBlueprint(parsed, source);

  return { blueprint, baseUrl: pathToFileURL(dirname(absPath) + '/').href };
}

/**
 * Executes blueprint steps using core steps + adapter-specific steps.
 */
export async function runBlueprint(blueprint, context, adapterSteps = {}) {
  const steps = blueprint?.steps ?? [];
  const registry = { ...CORE_STEPS, ...adapterSteps };

  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new PlaygroundError(`Blueprint step ${index + 1}: expected a step object`, {
        code: 'invalid_blueprint_step',
        exitCode: EXIT_CODES.VALIDATION,
        pointer: formatJsonPointer('steps', index),
      });
    }

    const fn = registry[step.step];

    if (!fn) {
      const known = Object.keys(registry).join(', ');
      throw new PlaygroundError(
        `Blueprint step ${index + 1}: unknown step "${step.step}". Known steps: ${known}`,
        {
          code: 'invalid_blueprint_step',
          exitCode: EXIT_CODES.VALIDATION,
          pointer: formatJsonPointer('steps', index, 'step'),
          suggestions: [`Known steps: ${known}`],
        }
      );
    }

    context.log?.(`Blueprint step ${index + 1}/${steps.length}: ${step.step}`);
    try {
      await fn(step, { ...context, stepIndex: index });
    } catch (error) {
      if (error instanceof PlaygroundError) {
        if (error.pointer === undefined) {
          error.pointer = formatJsonPointer('steps', index);
        }
        throw error;
      }
      throw error;
    }
  }
}
