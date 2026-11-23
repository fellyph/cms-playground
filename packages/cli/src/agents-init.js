// Scaffolds and idempotently updates the @cms-playground guidance block in AGENTS.md.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EXIT_CODES, PlaygroundError, getAdapter, listAdapters } from '@cms-playground/core';

export const AGENTS_FILENAME = 'AGENTS.md';
export const AGENTS_START_MARKER = '<!-- CMS-PLAYGROUND START -->';
export const AGENTS_END_MARKER = '<!-- CMS-PLAYGROUND END -->';

function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = 0;

  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }

  return count;
}

/**
 * Walks up from projectDir looking for `.cms-playground.json`.
 */
function findProjectConfig(projectDir) {
  let current = resolve(projectDir);

  while (true) {
    const candidate = join(current, '.cms-playground.json');
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { path: candidate, config: parsed };
        }
      } catch {
        // Ignore malformed config here; fall back to auto-mount heuristics.
        return null;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Detects the project's CMS from `.cms-playground.json` or registered adapter `--auto-mount` heuristics.
 */
export async function detectProjectCms(projectDir, { getAdapterImpl = getAdapter, listAdaptersImpl = listAdapters } = {}) {
  const absDir = resolve(projectDir);
  const foundConfig = findProjectConfig(absDir);

  if (foundConfig?.config?.cms && typeof foundConfig.config.cms === 'string') {
    const adapter = getAdapterImpl(foundConfig.config.cms);
    if (adapter) {
      return {
        cms: adapter.name,
        label: adapter.label,
        source: 'config',
        configPath: foundConfig.path,
        version: foundConfig.config.version ?? null,
        php: foundConfig.config.php ?? null,
        blueprint: foundConfig.config.blueprint ?? null,
        cliEntrypoint: adapter.cliEntrypoint ?? null,
        autoMountKind: null,
      };
    }
  }

  for (const adapter of listAdaptersImpl()) {
    if (typeof adapter.detectAutoMount !== 'function') {
      continue;
    }
    try {
      const detected = await adapter.detectAutoMount(absDir);
      if (detected) {
        return {
          cms: adapter.name,
          label: adapter.label,
          source: 'auto-mount',
          configPath: null,
          version: null,
          php: null,
          blueprint: null,
          cliEntrypoint: adapter.cliEntrypoint ?? null,
          autoMountKind: detected.kind ?? null,
        };
      }
    } catch {
      // Continue checking other adapters if a heuristic fails.
    }
  }

  return null;
}

/**
 * Renders the managed AGENTS.md block wrapped in start/end HTML comment markers.
 */
export function renderAgentsBlock(detected) {
  const lines = [
    AGENTS_START_MARKER,
    '## Local CMS Development (`@cms-playground`)',
    '',
  ];

  if (detected) {
    const cmsFlag = detected.version ? `--${detected.cms}=${detected.version}` : `--${detected.cms}`;
    const phpFlag = detected.php ? ` --php=${detected.php}` : '';
    const bpFlag = detected.blueprint ? ` --blueprint=${detected.blueprint}` : '';
    const autoMountFlag = detected.source === 'auto-mount' ? ' --auto-mount' : '';
    const contextNote =
      detected.source === 'auto-mount' && detected.autoMountKind
        ? `Detected **${detected.label}** (${detected.autoMountKind}) in this repository.`
        : `Configured for **${detected.label}** via \`.cms-playground.json\`.`;

    lines.push(
      `${contextNote} Use \`@cms-playground/cli\` to boot and test locally in WebAssembly (\`@php-wasm/node\`) with zero server or database setup.`,
      '',
      '```bash',
      `# Start a local ${detected.label} server (JSON ready-receipt on ephemeral port)`,
      `npx @cms-playground/cli start ${cmsFlag}${phpFlag}${autoMountFlag}${bpFlag} --port=0 --json`,
      '',
      `# Run a Blueprint headlessly`,
      `npx @cms-playground/cli run-blueprint ${cmsFlag}${phpFlag}${autoMountFlag} --blueprint=./blueprint.json --json`
    );

    if (detected.cliEntrypoint) {
      lines.push(
        '',
        `# Run ${detected.label}'s native CLI (${detected.cliEntrypoint}) without local PHP`,
        `npx @cms-playground/cli cli ${cmsFlag}${autoMountFlag} -- --help`
      );
    }

    lines.push(
      '',
      '# Inspect all commands, flags, adapters, and Blueprint step schemas',
      'npx @cms-playground/cli map --json',
      '```'
    );
  } else {
    lines.push(
      'Use `@cms-playground/cli` to run Joomla, WordPress, Drupal, TYPO3, or Kirby locally in WebAssembly (`@php-wasm/node`) with zero server or database setup.',
      '',
      '```bash',
      '# List registered CMS adapters and supported PHP versions',
      'npx @cms-playground/cli list --json',
      '',
      '# Start a disposable local CMS instance (replace --joomla with --wp, --drupal, --typo3, or --kirby)',
      'npx @cms-playground/cli start --joomla --auto-mount --port=0 --json',
      '',
      '# Inspect all commands, flags, adapters, and Blueprint step schemas',
      'npx @cms-playground/cli map --json',
      '```'
    );
  }

  lines.push(
    '',
    '- Pass `--json` (or set `CMS_PLAYGROUND_AGENT=1`) for machine-readable `{ data }` / `{ error }` receipts and classified exit codes.',
    '- Run `npx @cms-playground/cli mcp` (or `npx @cms-playground/cli setup agent`) to control Playgrounds over MCP.',
    AGENTS_END_MARKER
  );

  return lines.join('\n');
}

/**
 * Computes the updated AGENTS.md content, validating marker integrity.
 */
export function mergeAgentsContent(existingContent, block, filePath = AGENTS_FILENAME) {
  if (existingContent === null) {
    return {
      action: 'create',
      content: `${block}\n`,
    };
  }

  const startCount = countOccurrences(existingContent, AGENTS_START_MARKER);
  const endCount = countOccurrences(existingContent, AGENTS_END_MARKER);

  if (startCount > 1 || endCount > 1) {
    throw new PlaygroundError(
      `Duplicate @cms-playground markers found in ${filePath}. Remove extra "${AGENTS_START_MARKER}" / "${AGENTS_END_MARKER}" markers and retry.`,
      {
        code: 'invalid_agents_markers',
        exitCode: EXIT_CODES.VALIDATION,
        suggestions: [`Keep at most one "${AGENTS_START_MARKER}" and one "${AGENTS_END_MARKER}" marker in ${filePath}.`],
      }
    );
  }

  if (startCount !== endCount) {
    throw new PlaygroundError(
      `Malformed @cms-playground markers in ${filePath}: found ${startCount} start marker(s) and ${endCount} end marker(s).`,
      {
        code: 'invalid_agents_markers',
        exitCode: EXIT_CODES.VALIDATION,
        suggestions: [`Ensure both "${AGENTS_START_MARKER}" and "${AGENTS_END_MARKER}" are present in ${filePath}.`],
      }
    );
  }

  if (startCount === 1) {
    const startIdx = existingContent.indexOf(AGENTS_START_MARKER);
    const endIdx = existingContent.indexOf(AGENTS_END_MARKER);

    if (endIdx < startIdx) {
      throw new PlaygroundError(
        `Malformed @cms-playground markers in ${filePath}: end marker appears before start marker.`,
        {
          code: 'invalid_agents_markers',
          exitCode: EXIT_CODES.VALIDATION,
          suggestions: [`Place "${AGENTS_START_MARKER}" before "${AGENTS_END_MARKER}" in ${filePath}.`],
        }
      );
    }

    const updated =
      existingContent.slice(0, startIdx) +
      block +
      existingContent.slice(endIdx + AGENTS_END_MARKER.length);

    return {
      action: updated === existingContent ? 'unchanged' : 'update',
      content: updated,
    };
  }

  // No markers yet: append cleanly while preserving all existing content.
  if (existingContent.trim().length === 0) {
    const content = `${block}\n`;
    return {
      action: content === existingContent ? 'unchanged' : 'update',
      content,
    };
  }

  const separator = existingContent.endsWith('\n\n')
    ? ''
    : existingContent.endsWith('\n')
      ? '\n'
      : '\n\n';

  return {
    action: 'update',
    content: `${existingContent}${separator}${block}\n`,
  };
}

function writeFileAtomic(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Scaffolds or updates AGENTS.md in `projectDir` with a @cms-playground guidance block.
 */
export async function initAgentsFile(options = {}) {
  const {
    projectDir = process.cwd(),
    dryRun = false,
    getAdapterImpl = getAdapter,
    listAdaptersImpl = listAdapters,
    log = (line) => console.log(line),
  } = options;

  const absDir = resolve(projectDir);
  const targetPath = join(absDir, AGENTS_FILENAME);

  let existingContent = null;
  try {
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new PlaygroundError(`Refusing symbolic link or non-file AGENTS.md: ${targetPath}`, {
        code: 'invalid_agents_target',
        exitCode: EXIT_CODES.VALIDATION,
      });
    }
    existingContent = readFileSync(targetPath, 'utf8');
  } catch (err) {
    if (err instanceof PlaygroundError) {
      throw err;
    }
    if (!err || err.code !== 'ENOENT') {
      throw err;
    }
  }

  const detected = await detectProjectCms(absDir, { getAdapterImpl, listAdaptersImpl });
  const block = renderAgentsBlock(detected);
  const { action, content } = mergeAgentsContent(existingContent, block, targetPath);

  if (!dryRun && action !== 'unchanged') {
    writeFileAtomic(targetPath, content);
  }

  if (log) {
    const prefix = dryRun ? '[dry-run] ' : '';
    const cmsSummary = detected ? `${detected.label} (${detected.source})` : 'generic';
    log(`${prefix}${action.padEnd(9)} ${targetPath} (${cmsSummary})`);
  }

  return {
    path: targetPath,
    action,
    dryRun,
    detected,
  };
}
