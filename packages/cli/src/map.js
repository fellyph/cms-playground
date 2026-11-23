// Dynamic machine-readable CLI and Blueprint catalog for `cms-playground map`.

import { CORE_STEPS, CORE_STEP_SCHEMAS, listAdapters } from '@cms-playground/core';

const GLOBAL_FLAGS = Object.freeze([
  { name: '--cwd', value: '<path>', description: 'Resolve relative paths from <path>' },
  { name: '--json', value: null, description: 'Emit machine-readable JSON receipts to stdout and structured errors to stderr' },
  { name: '--verbosity', value: '<level>', description: 'Logging level: quiet, normal, debug (default: normal)' },
  { name: '--quiet', value: null, description: 'Alias for --verbosity=quiet' },
  { name: '--help', aliases: ['-h'], value: null, description: 'Show help message' },
]);

const SHARED_CMS_RUNTIME_FLAGS = Object.freeze([
  { name: '--php', value: '<version>', description: 'PHP version (e.g. 8.3, 8.4, 8.5)' },
  { name: '--site', value: '<dir>', description: 'Mount an existing local site directory instead of a fresh bundle' },
  { name: '--blueprint', value: '<file|url>', description: 'Blueprint JSON file path or URL to execute after boot' },
  { name: '--mount', value: '<src:vfs>', repeatable: true, description: 'Mount a host folder into VFS after configure' },
  { name: '--mount-before-install', value: '<src:vfs>', repeatable: true, description: 'Mount a host folder into VFS before configure' },
  { name: '--auto-mount', value: '[dir]', description: 'Auto-detect and mount a CMS extension/plugin/theme (default: CWD)' },
]);

function buildCmsSelectionFlags(adapters) {
  return adapters.map((adapter) => ({
    name: `--${adapter.name}`,
    aliases: (adapter.aliases ?? []).filter((a) => a !== adapter.name).map((a) => `--${a}`),
    value: '[version]',
    description: `Run ${adapter.label} (default: ${adapter.defaultVersion ?? 'latest'})`,
  }));
}

/**
 * Dynamically builds the machine-readable CLI & Blueprint catalog from registered adapters and core definitions.
 */
export function buildCliMap() {
  const registeredAdapters = listAdapters();
  const cmsFlags = buildCmsSelectionFlags(registeredAdapters);
  const cliAdapters = registeredAdapters.filter((a) => Boolean(a.cliEntrypoint));

  const commands = [
    {
      id: 'start',
      usage: 'cms-playground start --<cms>[=<version>] [options]',
      description: 'Boot a CMS in PHP-WASM and start a local HTTP server',
      flags: [
        ...cmsFlags,
        ...SHARED_CMS_RUNTIME_FLAGS,
        { name: '--port', value: '<number>', description: 'Local HTTP port (default: 8790, 0 for ephemeral)' },
        { name: '--host', value: '<address>', description: 'Bind address (default: 127.0.0.1)' },
        ...GLOBAL_FLAGS,
      ],
    },
    {
      id: 'run-blueprint',
      usage: 'cms-playground run-blueprint --<cms>[=<version>] --blueprint=<file|url> [options]',
      description: 'Run a Blueprint headlessly without starting an HTTP server',
      flags: [
        ...cmsFlags,
        ...SHARED_CMS_RUNTIME_FLAGS.map((flag) =>
          flag.name === '--blueprint' ? { ...flag, required: true } : flag
        ),
        ...GLOBAL_FLAGS,
      ],
    },
    {
      id: 'build-snapshot',
      usage: 'cms-playground build-snapshot --<cms>[=<version>] --output=<path> [options]',
      description: 'Boot a CMS, optionally run a Blueprint, and export a .zip snapshot',
      flags: [
        ...cmsFlags,
        { name: '--output', value: '<path>', required: true, description: 'Output .zip path for build-snapshot' },
        ...SHARED_CMS_RUNTIME_FLAGS,
        ...GLOBAL_FLAGS,
      ],
    },
    {
      id: 'cli',
      usage: 'cms-playground cli --<cms>[=<version>] [options] -- <cms-cli-args...>',
      description: 'Run the CMS\'s native CLI (e.g. cli/joomla.php) in PHP-WASM',
      flags: [
        ...buildCmsSelectionFlags(cliAdapters.length > 0 ? cliAdapters : registeredAdapters),
        ...SHARED_CMS_RUNTIME_FLAGS,
        ...GLOBAL_FLAGS,
      ],
    },
    {
      id: 'setup agent',
      usage: 'cms-playground setup agent [--agent <id>] [--project] [--yes] [--skip-mcp] [--dry-run] [--force]',
      description: 'Install the bundled Agent Skill and configure MCP for coding agents',
      flags: [
        { name: '--agent', value: '<id>', repeatable: true, description: 'Target agent (auto, all, claude-code, cursor, codex, vscode, antigravity, generic)' },
        { name: '--project', aliases: ['-p'], value: null, description: 'Install skill and MCP config into the current project' },
        { name: '--yes', aliases: ['-y'], value: null, description: 'Skip confirmation prompts' },
        { name: '--skip-mcp', value: null, description: 'Install the bundled skill without writing MCP config' },
        { name: '--dry-run', value: null, description: 'Preview planned file and config changes without writing' },
        { name: '--force', value: null, description: 'Overwrite locally modified skill files' },
        ...GLOBAL_FLAGS,
      ],
    },
    {
      id: 'mcp',
      usage: 'cms-playground mcp [--cwd=<path>]',
      description: 'Start a local stdio MCP server for coding agents',
      flags: [
        { name: '--cwd', value: '<path>', description: 'Resolve relative paths from <path>' },
        { name: '--help', aliases: ['-h'], value: null, description: 'Show help message' },
      ],
    },
    {
      id: 'list',
      usage: 'cms-playground list [--json]',
      description: 'Show registered CMS adapters and supported PHP versions',
      flags: [...GLOBAL_FLAGS],
    },
    {
      id: 'map',
      usage: 'cms-playground map [--json | --paths]',
      description: 'Output a machine-readable catalog of CLI commands, adapters, and Blueprint steps',
      flags: [
        { name: '--paths', value: null, description: 'Print canonical command invocations one per line' },
        ...GLOBAL_FLAGS,
      ],
    },
  ];

  const adapters = registeredAdapters.map((adapter) => ({
    name: adapter.name,
    aliases: [...(adapter.aliases ?? [])],
    label: adapter.label,
    defaultVersion: adapter.defaultVersion ?? null,
    defaultPhp: adapter.defaultPhp ?? null,
    supportedPhp: [...(adapter.supportedPhp ?? [])],
    adminPath: adapter.adminPath ?? '/',
    cliEntrypoint: adapter.cliEntrypoint ?? null,
  }));

  const blueprintSteps = [];

  for (const stepName of Object.keys(CORE_STEPS)) {
    const schema = CORE_STEP_SCHEMAS[stepName] ?? {};
    blueprintSteps.push({
      step: stepName,
      scope: 'core',
      adapter: null,
      requiredFields: [...(schema.requiredFields ?? [])],
      optionalFields: [...(schema.optionalFields ?? [])],
      description: schema.description ?? '',
    });
  }

  for (const adapter of registeredAdapters) {
    for (const stepName of Object.keys(adapter.blueprintSteps ?? {})) {
      const schema = adapter.blueprintStepSchemas?.[stepName] ?? {};
      blueprintSteps.push({
        step: stepName,
        scope: 'adapter',
        adapter: adapter.name,
        requiredFields: [...(schema.requiredFields ?? [])],
        optionalFields: [...(schema.optionalFields ?? [])],
        description: schema.description ?? '',
      });
    }
  }

  return { commands, adapters, blueprintSteps };
}

/**
 * Generates canonical one-per-line command invocations for `cms-playground map --paths`.
 */
export function buildCliPaths(map = buildCliMap()) {
  const paths = [];

  for (const adapter of map.adapters) {
    paths.push(`cms-playground start --${adapter.name}`);
  }

  for (const adapter of map.adapters) {
    paths.push(`cms-playground run-blueprint --${adapter.name} --blueprint=<file|url>`);
  }

  for (const adapter of map.adapters) {
    paths.push(`cms-playground build-snapshot --${adapter.name} --output=<path>`);
  }

  for (const adapter of map.adapters) {
    if (adapter.cliEntrypoint) {
      paths.push(`cms-playground cli --${adapter.name} -- <args...>`);
    }
  }

  paths.push('cms-playground setup agent');
  paths.push('cms-playground mcp');
  paths.push('cms-playground list');
  paths.push('cms-playground map');
  paths.push('cms-playground map --json');
  paths.push('cms-playground map --paths');

  return paths;
}
