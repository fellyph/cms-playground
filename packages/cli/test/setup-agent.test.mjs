import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  BUNDLED_SKILL_DIR,
  MCP_SERVER_NAME,
  parseJsonc,
  resolveAgentTargets,
  setupAgent,
} from '../src/setup-agent.js';

const tempDirs = [];

function makeTempEnv() {
  const root = mkdtempSync(join(tmpdir(), 'cms-playground-setup-agent-'));
  const homeDir = join(root, 'home');
  const projectDir = join(root, 'project');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  tempDirs.push(root);
  return { root, homeDir, projectDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('@cms-playground/cli setup-agent', () => {
  it('ships a bundled SKILL.md with valid YAML frontmatter and references', () => {
    const skillPath = join(BUNDLED_SKILL_DIR, 'SKILL.md');
    const blueprintsRef = join(BUNDLED_SKILL_DIR, 'references', 'blueprints.md');

    assert.equal(existsSync(skillPath), true);
    assert.equal(existsSync(blueprintsRef), true);

    const content = readFileSync(skillPath, 'utf8');
    assert.match(content, /^---\r?\n[\s\S]*name:\s*cms-playground[\s\S]*description:\s*".+"[\s\S]*---/);
  });

  it('rejects unknown agent selectors', () => {
    const { homeDir } = makeTempEnv();
    assert.throws(() => resolveAgentTargets(['unknown-client'], homeDir), /Unknown agent "unknown-client"/);
  });

  it('falls back to universal .agents skill with no MCP config when no client is detected', async () => {
    const { homeDir, projectDir } = makeTempEnv();

    const result = await setupAgent({
      agents: ['auto'],
      project: true,
      yes: true,
      homeDir,
      projectDir,
      isInteractive: false,
      log: () => {},
    });

    assert.equal(result.fallbackUniversal, true);
    assert.equal(existsSync(join(projectDir, '.agents', 'skills', 'cms-playground', 'SKILL.md')), true);
    assert.equal(existsSync(join(projectDir, '.mcp.json')), false);
    assert.equal(result.actions.every((a) => a.kind === 'skill'), true);
  });

  it('supports --dry-run without writing any files or directories', async () => {
    const { homeDir, projectDir } = makeTempEnv();
    mkdirSync(join(homeDir, '.claude'), { recursive: true });

    const result = await setupAgent({
      agents: ['auto'],
      project: true,
      dryRun: true,
      homeDir,
      projectDir,
      isInteractive: false,
      log: () => {},
    });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.targets, ['claude-code']);
    assert.equal(result.actions.some((a) => a.kind === 'skill' && a.action === 'create'), true);
    assert.equal(result.actions.some((a) => a.kind === 'mcp' && a.action === 'create'), true);
    assert.equal(existsSync(join(projectDir, '.claude')), false);
    assert.equal(existsSync(join(projectDir, '.mcp.json')), false);
  });

  it('merges MCP config safely without clobbering existing keys or JSONC configs, and is idempotent', async () => {
    const { homeDir, projectDir } = makeTempEnv();
    mkdirSync(join(homeDir, '.claude'), { recursive: true });

    const mcpPath = join(projectDir, '.mcp.json');
    writeFileSync(
      mcpPath,
      `{
  // Existing user comment
  "customTopLevel": true,
  "mcpServers": {
    "other-tool": { "command": "other", "args": ["serve"] },
  }
}
`,
      'utf8'
    );

    const first = await setupAgent({
      agents: ['claude-code'],
      project: true,
      yes: true,
      homeDir,
      projectDir,
      isInteractive: false,
      log: () => {},
    });

    const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.equal(parsed.customTopLevel, true);
    assert.deepEqual(parsed.mcpServers['other-tool'], { command: 'other', args: ['serve'] });
    assert.deepEqual(parsed.mcpServers[MCP_SERVER_NAME], {
      command: 'npx',
      args: ['-y', '@cms-playground/cli', 'mcp'],
    });
    assert.equal(first.actions.some((a) => a.kind === 'mcp' && a.action === 'update'), true);

    // Second run should be completely unchanged (idempotent).
    const second = await setupAgent({
      agents: ['claude-code'],
      project: true,
      yes: true,
      homeDir,
      projectDir,
      isInteractive: false,
      log: () => {},
    });

    assert.equal(second.actions.every((a) => a.action === 'unchanged'), true);
  });

  it('uses "servers" root key with type "stdio" for vscode target', async () => {
    const { homeDir, projectDir } = makeTempEnv();

    await setupAgent({
      agents: ['vscode'],
      project: true,
      yes: true,
      homeDir,
      projectDir,
      isInteractive: false,
      log: () => {},
    });

    const vscodeMcp = JSON.parse(readFileSync(join(projectDir, '.vscode', 'mcp.json'), 'utf8'));
    assert.deepEqual(vscodeMcp.servers[MCP_SERVER_NAME], {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@cms-playground/cli', 'mcp'],
    });
  });

  it('respects --skip-mcp and installs skill only', async () => {
    const { homeDir, projectDir } = makeTempEnv();

    const result = await setupAgent({
      agents: ['cursor'],
      project: true,
      skipMcp: true,
      yes: true,
      homeDir,
      projectDir,
      isInteractive: false,
      log: () => {},
    });

    assert.equal(existsSync(join(projectDir, '.cursor', 'skills', 'cms-playground', 'SKILL.md')), true);
    assert.equal(existsSync(join(projectDir, '.cursor', 'mcp.json')), false);
    assert.equal(result.actions.every((a) => a.kind === 'skill'), true);
  });

  it('refuses to overwrite locally modified skill files unless --force is passed', async () => {
    const { homeDir, projectDir } = makeTempEnv();
    const skillDir = join(projectDir, '.claude', 'skills', 'cms-playground');
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, 'SKILL.md');
    writeFileSync(skillFile, '# Local edit\n', 'utf8');

    await assert.rejects(
      () =>
        setupAgent({
          agents: ['claude-code'],
          project: true,
          yes: true,
          homeDir,
          projectDir,
          isInteractive: false,
          log: () => {},
        }),
      /local modifications.*--force/i
    );

    const forced = await setupAgent({
      agents: ['claude-code'],
      project: true,
      yes: true,
      force: true,
      homeDir,
      projectDir,
      isInteractive: false,
      log: () => {},
    });

    assert.equal(forced.actions.some((a) => a.path === skillFile && a.action === 'update'), true);
    assert.match(readFileSync(skillFile, 'utf8'), /name:\s*cms-playground/);
  });

  it('refuses symlinked MCP config files', async (t) => {
    const { root, homeDir, projectDir } = makeTempEnv();
    const realFile = join(root, 'target.json');
    writeFileSync(realFile, '{}', 'utf8');
    try {
      symlinkSync(realFile, join(projectDir, '.mcp.json'));
    } catch (error) {
      if (process.platform === 'win32' && error?.code === 'EPERM') {
        t.skip('Creating file symlinks requires Developer Mode or elevated privileges on Windows');
        return;
      }
      throw error;
    }

    await assert.rejects(
      () =>
        setupAgent({
          agents: ['generic'],
          project: true,
          yes: true,
          homeDir,
          projectDir,
          isInteractive: false,
          log: () => {},
        }),
      /Refusing symbolic link or non-file MCP config/
    );
  });

  it('parses JSONC with URLs, BOM, and trailing-comma-like substrings inside strings intact', () => {
    const parsed = parseJsonc(
      `\uFEFF{
  // comment
  "url": "https://example.com/a//b",
  "regex": "a,}b,]c",
  "escaped": "quote \\",} still string",
  /* block comment */
  "arr": [1, 2,],
  "ok": true,
}`,
      'test.json'
    );

    assert.deepEqual(parsed, {
      url: 'https://example.com/a//b',
      regex: 'a,}b,]c',
      escaped: 'quote ",} still string',
      arr: [1, 2],
      ok: true,
    });
  });

  it('refuses symlinked parent directories for skill and MCP paths', async (t) => {
    const { root, homeDir, projectDir } = makeTempEnv();
    const outsideDir = join(root, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    try {
      symlinkSync(outsideDir, join(projectDir, '.cursor'), 'dir');
    } catch (error) {
      if (process.platform === 'win32' && error?.code === 'EPERM') {
        t.skip('Creating directory symlinks requires Developer Mode or elevated privileges on Windows');
        return;
      }
      throw error;
    }

    await assert.rejects(
      () =>
        setupAgent({
          agents: ['cursor'],
          project: true,
          yes: true,
          homeDir,
          projectDir,
          isInteractive: false,
          log: () => {},
        }),
      /Refusing symbolic link or non-directory/
    );
  });

  it('preserves existing file permissions when updating an MCP config', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX file permission bits are not enforced on Windows');
      return;
    }

    const { homeDir, projectDir } = makeTempEnv();
    const mcpPath = join(projectDir, '.mcp.json');
    writeFileSync(mcpPath, '{"mcpServers":{}}\n', { encoding: 'utf8', mode: 0o600 });
    chmodSync(mcpPath, 0o600);

    await setupAgent({
      agents: ['claude-code'],
      project: true,
      yes: true,
      homeDir,
      projectDir,
      isInteractive: false,
      log: () => {},
    });

    const mode = statSync(mcpPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
