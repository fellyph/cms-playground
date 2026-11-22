// Configures coding agent clients with the bundled @cms-playground Skill and MCP server entry.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BUNDLED_SKILL_DIR = resolve(__dirname, '../skills/cms-playground');

export const MCP_SERVER_NAME = 'cms-playground';

export const MCP_STDIO_ENTRY = Object.freeze({
  command: 'npx',
  args: ['-y', '@cms-playground/cli', 'mcp'],
});

export const VSCODE_MCP_STDIO_ENTRY = Object.freeze({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@cms-playground/cli', 'mcp'],
});

/**
 * Supported coding agent client definitions.
 */
export const AGENT_TARGETS = Object.freeze({
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    detect: (home) => existsSync(join(home, '.claude')) || existsSync(join(home, '.claude.json')),
    skillDir: (home, project, isProject) =>
      isProject
        ? join(project, '.claude', 'skills', 'cms-playground')
        : join(home, '.claude', 'skills', 'cms-playground'),
    mcpConfig: (home, project, isProject) => ({
      path: isProject ? join(project, '.mcp.json') : join(home, '.claude.json'),
      rootKey: 'mcpServers',
      entry: MCP_STDIO_ENTRY,
    }),
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    detect: (home) => existsSync(join(home, '.cursor')),
    skillDir: (home, project, isProject) =>
      isProject
        ? join(project, '.cursor', 'skills', 'cms-playground')
        : join(home, '.cursor', 'skills', 'cms-playground'),
    mcpConfig: (home, project, isProject) => ({
      path: isProject ? join(project, '.cursor', 'mcp.json') : join(home, '.cursor', 'mcp.json'),
      rootKey: 'mcpServers',
      entry: MCP_STDIO_ENTRY,
    }),
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    detect: (home) => existsSync(join(home, '.codex')),
    skillDir: (home, project, isProject) =>
      isProject
        ? join(project, '.agents', 'skills', 'cms-playground')
        : join(home, '.codex', 'skills', 'cms-playground'),
    mcpConfig: () => null,
  },
  vscode: {
    id: 'vscode',
    label: 'VS Code',
    detect: (home) => existsSync(join(home, '.vscode')),
    skillDir: (home, project, isProject) =>
      isProject
        ? join(project, '.agents', 'skills', 'cms-playground')
        : join(home, '.agents', 'skills', 'cms-playground'),
    mcpConfig: (_home, project) => ({
      path: join(project, '.vscode', 'mcp.json'),
      rootKey: 'servers',
      entry: VSCODE_MCP_STDIO_ENTRY,
    }),
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    detect: (home) =>
      existsSync(join(home, '.gemini', 'antigravity')) || existsSync(join(home, '.gemini', 'config')),
    skillDir: (home, project, isProject) =>
      isProject
        ? join(project, '.agents', 'skills', 'cms-playground')
        : join(home, '.gemini', 'config', 'skills', 'cms-playground'),
    mcpConfig: (home, project, isProject) => ({
      path: isProject
        ? join(project, '.mcp.json')
        : join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      rootKey: 'mcpServers',
      entry: MCP_STDIO_ENTRY,
    }),
  },
  generic: {
    id: 'generic',
    label: 'Generic (.mcp.json)',
    detect: () => false,
    skillDir: (home, project, isProject) =>
      isProject
        ? join(project, '.agents', 'skills', 'cms-playground')
        : join(home, '.agents', 'skills', 'cms-playground'),
    mcpConfig: (_home, project) => ({
      path: join(project, '.mcp.json'),
      rootKey: 'mcpServers',
      entry: MCP_STDIO_ENTRY,
    }),
  },
});

export const SUPPORTED_AGENT_IDS = Object.freeze(Object.keys(AGENT_TARGETS));
export const ACCEPTED_AGENT_SELECTORS = Object.freeze(['auto', 'all', ...SUPPORTED_AGENT_IDS]);

/**
 * Validates and normalizes requested agent selectors.
 */
export function resolveAgentTargets(requestedAgents, homeDir) {
  const selectors =
    !requestedAgents || requestedAgents.length === 0 ? ['auto'] : requestedAgents;

  for (const selector of selectors) {
    if (!ACCEPTED_AGENT_SELECTORS.includes(selector)) {
      throw new Error(
        `Unknown agent "${selector}". Expected one of: ${ACCEPTED_AGENT_SELECTORS.join(', ')}`
      );
    }
  }

  const resolvedIds = new Set();
  let usedAuto = false;

  for (const selector of selectors) {
    if (selector === 'all') {
      for (const id of SUPPORTED_AGENT_IDS) {
        resolvedIds.add(id);
      }
      continue;
    }

    if (selector === 'auto') {
      usedAuto = true;
      for (const target of Object.values(AGENT_TARGETS)) {
        if (target.detect(homeDir)) {
          resolvedIds.add(target.id);
        }
      }
      continue;
    }

    resolvedIds.add(selector);
  }

  return {
    targets: Array.from(resolvedIds).map((id) => AGENT_TARGETS[id]),
    fallbackUniversal: usedAuto && resolvedIds.size === 0,
  };
}

/**
 * Strips JSONC comments (// and /* *\/) and trailing commas outside string literals.
 */
export function parseJsonc(rawText, filePath) {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < rawText.length) {
    const ch = rawText[i];
    const next = rawText[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < rawText.length && rawText[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < rawText.length && !(rawText[i] === '*' && rawText[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  // Strip trailing commas before closing } or ].
  const withoutTrailingCommas = out.replace(/,\s*([}\]])/g, '$1').trim();

  if (!withoutTrailingCommas) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(withoutTrailingCommas);
  } catch (err) {
    throw new Error(`Failed to parse MCP config ${filePath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid MCP config ${filePath}: expected a top-level JSON object.`);
  }

  return parsed;
}

/**
 * Recursively collects relative file paths under a directory.
 */
function listFilesRecursive(rootDir, relPrefix = '') {
  const entries = readdirSync(join(rootDir, relPrefix), { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relPath = relPrefix ? join(relPrefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(rootDir, relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }

  return files.sort();
}

/**
 * Throws if an existing path is a symbolic link or not of the expected type.
 */
function assertNotSymlink(targetPath, expectedType, label) {
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link or non-file ${label}: ${targetPath}`);
  }

  if (expectedType === 'file' && !stat.isFile()) {
    throw new Error(`Refusing symbolic link or non-file ${label}: ${targetPath}`);
  }

  if (expectedType === 'dir' && !stat.isDirectory()) {
    throw new Error(`Refusing symbolic link or non-directory ${label}: ${targetPath}`);
  }

  return stat;
}

/**
 * Atomically writes UTF-8 text to a file (creating parent directories if needed).
 */
function writeFileAtomic(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Plans and optionally executes agent setup (bundled Skill + MCP config).
 */
export async function setupAgent(options = {}) {
  const {
    agents = [],
    project = false,
    yes = false,
    skipMcp = false,
    dryRun = false,
    force = false,
    homeDir = homedir(),
    projectDir = process.cwd(),
    skillSourceDir = BUNDLED_SKILL_DIR,
    stdin = process.stdin,
    stdout = process.stdout,
    isInteractive = Boolean(stdin?.isTTY && stdout?.isTTY && !process.env.CI),
    log = (line) => console.log(line),
  } = options;

  const { targets, fallbackUniversal } = resolveAgentTargets(agents, homeDir);

  // Determine whether we should prompt for confirmation.
  const explicitAgentSpecified =
    agents.length > 0 && !agents.every((a) => a === 'auto');

  if (isInteractive && !yes && !dryRun && !explicitAgentSpecified) {
    const summary = fallbackUniversal
      ? 'No supported agent clients detected; will install universal skill to .agents/skills/cms-playground.'
      : `Detected agent client(s): ${targets.map((t) => t.label).join(', ')}`;

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(`${summary}\nProceed with setup? [Y/n] `);
      const normalized = answer.trim().toLowerCase();
      if (normalized && normalized !== 'y' && normalized !== 'yes') {
        return {
          cancelled: true,
          dryRun,
          targets: targets.map((t) => t.id),
          fallbackUniversal,
          actions: [],
        };
      }
    } finally {
      rl.close();
    }
  }

  // Load bundled skill files once.
  const bundledFiles = listFilesRecursive(skillSourceDir).map((relPath) => ({
    relPath,
    content: readFileSync(join(skillSourceDir, relPath), 'utf8'),
  }));

  const actions = [];
  const seenSkillDirs = new Set();
  const seenMcpPaths = new Set();

  // Compute skill destinations.
  const skillPlans = [];
  if (fallbackUniversal) {
    const destDir = project
      ? join(projectDir, '.agents', 'skills', 'cms-playground')
      : join(homeDir, '.agents', 'skills', 'cms-playground');
    skillPlans.push({ agent: 'universal', destDir });
  } else {
    for (const target of targets) {
      const destDir = target.skillDir(homeDir, projectDir, project);
      if (seenSkillDirs.has(destDir)) {
        continue;
      }
      seenSkillDirs.add(destDir);
      skillPlans.push({ agent: target.id, destDir });
    }
  }

  // Plan & apply skill file installs.
  for (const plan of skillPlans) {
    assertNotSymlink(plan.destDir, 'dir', 'skill directory');

    for (const file of bundledFiles) {
      const destPath = join(plan.destDir, file.relPath);
      const stat = assertNotSymlink(destPath, 'file', 'skill file');

      if (!stat) {
        if (!dryRun) {
          writeFileAtomic(destPath, file.content);
        }
        actions.push({ kind: 'skill', agent: plan.agent, path: destPath, action: 'create' });
        continue;
      }

      const existing = readFileSync(destPath, 'utf8');
      if (existing === file.content) {
        actions.push({ kind: 'skill', agent: plan.agent, path: destPath, action: 'unchanged' });
        continue;
      }

      if (!force) {
        if (dryRun) {
          actions.push({ kind: 'skill', agent: plan.agent, path: destPath, action: 'conflict' });
          continue;
        }
        throw new Error(
          `Skill file has local modifications: ${destPath}. Re-run with --force to overwrite.`
        );
      }

      if (!dryRun) {
        writeFileAtomic(destPath, file.content);
      }
      actions.push({ kind: 'skill', agent: plan.agent, path: destPath, action: 'update' });
    }
  }

  // Plan & apply MCP config merges (skipped on universal fallback or --skip-mcp).
  if (!skipMcp && !fallbackUniversal) {
    for (const target of targets) {
      const mcp = target.mcpConfig(homeDir, projectDir, project);
      if (!mcp) {
        continue;
      }
      if (seenMcpPaths.has(mcp.path)) {
        continue;
      }
      seenMcpPaths.add(mcp.path);

      const stat = assertNotSymlink(mcp.path, 'file', 'MCP config');
      let config = {};

      if (stat) {
        const raw = readFileSync(mcp.path, 'utf8');
        config = parseJsonc(raw, mcp.path);
      }

      const existingRoot = config[mcp.rootKey];
      if (
        existingRoot !== undefined &&
        (existingRoot === null || typeof existingRoot !== 'object' || Array.isArray(existingRoot))
      ) {
        throw new Error(
          `Invalid MCP config ${mcp.path}: "${mcp.rootKey}" must be a JSON object.`
        );
      }

      const servers = existingRoot ? { ...existingRoot } : {};
      const currentEntry = servers[MCP_SERVER_NAME];
      const desiredJson = JSON.stringify(mcp.entry);

      if (currentEntry && JSON.stringify(currentEntry) === desiredJson) {
        actions.push({ kind: 'mcp', agent: target.id, path: mcp.path, action: 'unchanged' });
        continue;
      }

      servers[MCP_SERVER_NAME] = { ...mcp.entry };
      const nextConfig = {
        ...config,
        [mcp.rootKey]: servers,
      };

      const actionType = stat ? 'update' : 'create';
      if (!dryRun) {
        writeFileAtomic(mcp.path, `${JSON.stringify(nextConfig, null, 2)}\n`);
      }
      actions.push({ kind: 'mcp', agent: target.id, path: mcp.path, action: actionType });
    }
  }

  // Print concise human summary.
  if (log) {
    const prefix = dryRun ? '[dry-run] ' : '';
    if (fallbackUniversal) {
      log(`${prefix}No supported agent clients detected; using universal .agents skill directory.`);
    } else {
      log(`${prefix}Configured agent target(s): ${targets.map((t) => t.id).join(', ')}`);
    }
    for (const item of actions) {
      log(`  ${prefix}${item.action.padEnd(9)} [${item.kind}] ${item.path}`);
    }
  }

  return {
    cancelled: false,
    dryRun,
    targets: targets.map((t) => t.id),
    fallbackUniversal,
    actions,
  };
}
