// CLI parser and command dispatcher for @cms-playground/cli.
//
// Usage:
//   cms-playground start          --joomla[=<ver>] [options]
//   cms-playground start          --wp[=<ver>]     [options]
//   cms-playground run-blueprint  --joomla --blueprint=<file|url> [options]
//   cms-playground build-snapshot --joomla --output=./site.zip [--blueprint=<file|url>] [options]
//   cms-playground cli            --joomla [--site=<dir>] -- <joomla.php args...>
//   cms-playground setup agent    [--agent <id>] [--project] [--yes] [--skip-mcp] [--dry-run]
//   cms-playground list

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXIT_CODES,
  PlaygroundError,
  buildSnapshot,
  getAdapter,
  listAdapters,
  parseMountSpec,
  registerAdapter,
  runBlueprintHeadless,
  runCmsCli,
  startPlayground,
} from '@cms-playground/core';
import { drupalAdapter } from '@cms-playground/drupal';
import { joomlaAdapter } from '@cms-playground/joomla';
import { kirbyAdapter } from '@cms-playground/kirby';
import { typo3Adapter } from '@cms-playground/typo3';
import { wordpressAdapter } from '@cms-playground/wordpress';
import { buildCliMap, buildCliPaths } from './map.js';
import { setupAgent } from './setup-agent.js';

export { buildCliMap, buildCliPaths };

// Register built-in CMS adapters.
registerAdapter(joomlaAdapter);
registerAdapter(wordpressAdapter);
registerAdapter(drupalAdapter);
registerAdapter(typo3Adapter);
registerAdapter(kirbyAdapter);

const VERBOSITY_LEVELS = ['quiet', 'normal', 'debug'];

export const HELP_TEXT = `
@cms-playground/cli — Run PHP CMSs locally in WebAssembly with zero setup

Usage:
  cms-playground start          --joomla[=<version>] [options]
  cms-playground start          --wp[=<version>]     [options]
  cms-playground start          --drupal[=<version>] [options]
  cms-playground start          --typo3[=<version>]  [options]
  cms-playground start          --kirby[=<version>]  [options]
  cms-playground run-blueprint  --joomla --blueprint=<file|url> [options]
  cms-playground build-snapshot --joomla --output=./snapshot.zip [options]
  cms-playground cli            --joomla [options] -- <cms-cli-args...>
  cms-playground setup agent    [--agent <id>] [--project] [--yes] [--skip-mcp] [--dry-run]
  cms-playground list
  cms-playground map            [--json | --paths]

Commands:
  start           Boot a CMS in PHP-WASM and start a local HTTP server
  run-blueprint   Run a Blueprint headlessly without starting an HTTP server
  build-snapshot  Boot a CMS, optionally run a Blueprint, and export a .zip snapshot
  cli             Run the CMS's native CLI (e.g. cli/joomla.php) in PHP-WASM
  setup agent     Install the bundled Agent Skill and configure MCP for coding agents
  list            Show registered CMS adapters and supported PHP versions
  map             Output a machine-readable catalog of commands, adapters, and Blueprint steps

CMS Selection (pick one):
  --joomla[=<ver>]   Run Joomla (default: latest, e.g. --joomla or --joomla=6.2)
  --wp[=<ver>]       Run WordPress (default: latest, e.g. --wp or --wp=6.7)
  --drupal[=<ver>]   Run Drupal (default: latest, e.g. --drupal or --drupal=11.4.13)
  --typo3[=<ver>]    Run TYPO3 (default: 13, e.g. --typo3 or --typo3=13.4)
  --kirby[=<ver>]    Run Kirby (default: latest, e.g. --kirby or --kirby=5.6.4)

Options:
  --php=<version>                PHP version (e.g. 8.3, 8.4, 8.5)
  --port=<number>                Local HTTP port (default: 8790)
  --host=<address>               Bind address (default: 127.0.0.1)
  --site=<dir>                   Mount an existing local site directory instead of a fresh bundle
  --blueprint=<src>              Blueprint JSON file path or URL to execute after boot
  --output=<path>                Output .zip path for build-snapshot
  --mount=<src:vfs>              Mount a host folder into VFS after configure (repeatable)
  --mount-before-install=<s:v>   Mount a host folder into VFS before configure (repeatable)
  --auto-mount[=dir]             Auto-detect and mount a local CMS extension, theme, or content directory (default: CWD)
  --cwd=<path>                   Resolve relative paths (--site, --blueprint, --mount, --auto-mount, --output) from <path>
  --json                         Emit machine-readable JSON receipts to stdout and structured errors to stderr
  --paths                        Print canonical command invocations one per line (for map)
  --verbosity=<level>            Logging level: quiet, normal, debug (default: normal)
  --quiet                        Alias for --verbosity=quiet
  -h, --help                     Show this help message

Environment:
  CMS_PLAYGROUND_AGENT=1 | CI=1  Enable agent mode (--json, non-interactive, no ANSI colors)

Setup Agent Options (cms-playground setup agent):
  --agent <id>                   Target agent (auto, all, claude-code, cursor, codex, vscode, antigravity, generic)
  -p, --project                  Install skill and MCP config into the current project
  -y, --yes                      Skip confirmation prompts
  --skip-mcp                     Install the bundled skill without writing MCP config
  --dry-run                      Preview planned file and config changes without writing
  --force                        Overwrite locally modified skill files
`.trim();

/**
 * Returns true when running in agent mode (CMS_PLAYGROUND_AGENT=1 or CI=1).
 */
export function isAgentMode(env = process.env) {
  return env?.CMS_PLAYGROUND_AGENT === '1' || env?.CI === '1';
}

/**
 * Lightweight check for JSON output mode that works even when full argument parsing fails.
 */
export function wantsJsonOutput(argv = [], env = process.env) {
  if (isAgentMode(env)) {
    return true;
  }

  const dashDash = argv.indexOf('--');
  const mainArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);

  return mainArgs.includes('--json');
}

/**
 * Pre-scans mainArgs for --cwd=<path> / --cwd <path> before all other options are parsed.
 */
function extractCwdArg(mainArgs, baseCwd) {
  let rawCwd = null;

  for (let i = 0; i < mainArgs.length; i++) {
    const arg = mainArgs[i];

    if (arg === '--cwd') {
      const next = mainArgs[++i];
      if (next === undefined || next === '' || next.startsWith('--')) {
        throw new PlaygroundError('Option --cwd requires a value', {
          code: 'missing_option',
          exitCode: EXIT_CODES.VALIDATION,
          suggestions: ['Pass --cwd=<path> with a directory path.'],
        });
      }
      rawCwd = next;
      continue;
    }

    if (arg.startsWith('--cwd=')) {
      const val = arg.slice('--cwd='.length);
      if (val === '') {
        throw new PlaygroundError('Option --cwd requires a value', {
          code: 'missing_option',
          exitCode: EXIT_CODES.VALIDATION,
          suggestions: ['Pass --cwd=<path> with a directory path.'],
        });
      }
      rawCwd = val;
    }
  }

  return rawCwd ? resolve(baseCwd, rawCwd) : null;
}

/**
 * Parses argv into { command, subcommand, cms, cmsVersion, options, passthrough }.
 * Supports optional-value CMS flags like `--joomla`, `--joomla=6.2`, `--wp`, `--wp=6.7`.
 */
export function parseCliArgs(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const dashDash = argv.indexOf('--');
  const mainArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const passthrough = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  const resolvedCwd = extractCwdArg(mainArgs, cwd);
  const effectiveCwd = resolvedCwd ?? resolve(cwd);
  const agentMode = isAgentMode(env);

  let command = null;
  let subcommand = null;
  let cms = null;
  let cmsVersion = null;
  const options = {
    php: null,
    port: 8790,
    host: '127.0.0.1',
    site: null,
    blueprint: null,
    output: null,
    cwd: resolvedCwd,
    json: agentMode,
    paths: false,
    agentMode,
    noColor: agentMode,
    mountsBeforeInstall: [],
    mounts: [],
    autoMount: null,
    agents: [],
    project: false,
    yes: agentMode,
    skipMcp: false,
    dryRun: false,
    force: false,
    verbosity: 'normal',
    quiet: false,
    help: false,
  };

  for (let i = 0; i < mainArgs.length; i++) {
    const arg = mainArgs[i];

    if (arg === '--cwd') {
      i++;
      continue;
    }

    if (arg.startsWith('--cwd=')) {
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--paths') {
      options.paths = true;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }

    if (arg === '-p' || arg === '--project') {
      options.project = true;
      continue;
    }

    if (arg === '-y' || arg === '--yes') {
      options.yes = true;
      continue;
    }

    if (arg === '--skip-mcp') {
      options.skipMcp = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--quiet') {
      options.quiet = true;
      options.verbosity = 'quiet';
      continue;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

      if (key === 'auto-mount') {
        options.autoMount = inlineValue || true;
        continue;
      }

      // Check if flag matches a registered CMS adapter (--joomla, --wp, --wordpress, ...).
      const adapter = getAdapter(key);

      if (adapter) {
        if (cms && cms !== adapter.name) {
          throw new PlaygroundError(
            `Multiple CMS flags specified (--${cms} and --${adapter.name}). Choose one.`,
            {
              code: 'multiple_cms',
              exitCode: EXIT_CODES.VALIDATION,
              suggestions: [`Specify either --${cms} or --${adapter.name}, not both.`],
            }
          );
        }

        cms = adapter.name;
        cmsVersion = inlineValue || null;
        continue;
      }

      const nextValue = () => {
        if (inlineValue !== null) {
          if (inlineValue === '') {
            throw new PlaygroundError(`Option --${key} requires a value`, {
              code: 'missing_option',
              exitCode: EXIT_CODES.VALIDATION,
            });
          }

          return inlineValue;
        }

        const next = mainArgs[++i];

        if (next === undefined || next === '' || next.startsWith('--')) {
          throw new PlaygroundError(`Option --${key} requires a value`, {
            code: 'missing_option',
            exitCode: EXIT_CODES.VALIDATION,
          });
        }

        return next;
      };

      switch (key) {
        case 'php':
          options.php = nextValue();
          break;
        case 'port':
          options.port = Number(nextValue());
          if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
            throw new PlaygroundError(`Invalid port: ${options.port}`, {
              code: 'invalid_port',
              exitCode: EXIT_CODES.VALIDATION,
              suggestions: ['Specify an integer port between 0 and 65535 (use 0 for an ephemeral port).'],
            });
          }
          break;
        case 'host':
          options.host = nextValue();
          break;
        case 'site':
          options.site = nextValue();
          break;
        case 'blueprint':
          options.blueprint = nextValue();
          break;
        case 'output':
          options.output = nextValue();
          break;
        case 'mount':
          options.mounts.push(parseMountSpec(nextValue(), effectiveCwd));
          break;
        case 'mount-before-install':
          options.mountsBeforeInstall.push(parseMountSpec(nextValue(), effectiveCwd));
          break;
        case 'agent':
          options.agents.push(nextValue());
          break;
        case 'verbosity': {
          const level = nextValue().toLowerCase();
          if (!VERBOSITY_LEVELS.includes(level)) {
            throw new PlaygroundError(
              `Invalid verbosity "${level}". Expected one of: ${VERBOSITY_LEVELS.join(', ')}`,
              {
                code: 'invalid_verbosity',
                exitCode: EXIT_CODES.VALIDATION,
                suggestions: [`Use one of: ${VERBOSITY_LEVELS.join(', ')}`],
              }
            );
          }
          options.verbosity = level;
          options.quiet = level === 'quiet';
          break;
        }
        default:
          throw new PlaygroundError(`Unknown option: --${key}`, {
            code: 'invalid_option',
            exitCode: EXIT_CODES.VALIDATION,
            recovery: 'cms-playground --help',
            suggestions: ['Run "cms-playground --help" to see supported options.'],
          });
      }

      continue;
    }

    if (!command) {
      command = arg;
    } else if (command === 'setup' && !subcommand) {
      subcommand = arg;
    } else {
      throw new PlaygroundError(`Unexpected argument: ${arg}`, {
        code: 'invalid_option',
        exitCode: EXIT_CODES.VALIDATION,
        recovery: 'cms-playground --help',
      });
    }
  }

  return { command, subcommand, cms, cmsVersion, options, passthrough };
}

function resolveMaybeUrl(value, baseDir) {
  if (!value) {
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return resolve(baseDir, value);
}

function resolveAutoMountPath(autoMount, baseDir) {
  if (!autoMount) {
    return null;
  }

  if (autoMount === true) {
    return baseDir;
  }

  return resolve(baseDir, autoMount);
}

function emitJson(data) {
  console.log(JSON.stringify({ data }));
}

/**
 * Main CLI entrypoint.
 */
export async function run(argv = process.argv.slice(2), { env = process.env, cwd = process.cwd() } = {}) {
  const { command, subcommand, cms, cmsVersion, options, passthrough } = parseCliArgs(argv, {
    env,
    cwd,
  });

  if (options.noColor) {
    process.env.NO_COLOR = '1';
  }

  if (options.cwd) {
    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      throw new PlaygroundError(`Working directory does not exist: ${options.cwd}`, {
        code: 'cwd_not_found',
        exitCode: EXIT_CODES.NOT_FOUND,
        suggestions: ['Verify the directory passed to --cwd=<path>.'],
      });
    }
  }

  const baseDir = options.cwd ?? resolve(cwd);
  const effectiveQuiet = options.quiet || options.json;

  if (options.help || !command) {
    if (options.json) {
      emitJson({
        help: HELP_TEXT,
        commands: ['start', 'run-blueprint', 'build-snapshot', 'cli', 'setup agent', 'list', 'map'],
      });
    } else {
      console.log(HELP_TEXT);
    }

    return EXIT_CODES.OK;
  }

  if (command === 'map') {
    const cliMap = buildCliMap();

    if (options.paths) {
      const paths = buildCliPaths(cliMap);
      if (options.json) {
        emitJson({ paths });
      } else {
        console.log(paths.join('\n'));
      }
      return EXIT_CODES.OK;
    }

    if (options.json) {
      emitJson(cliMap);
    } else {
      console.log(JSON.stringify({ data: cliMap }, null, 2));
    }

    return EXIT_CODES.OK;
  }

  if (command === 'list') {
    const adapters = listAdapters();

    if (options.json) {
      emitJson({
        adapters: adapters.map((adapter) => ({
          name: adapter.name,
          aliases: adapter.aliases ?? [],
          label: adapter.label,
          defaultVersion: adapter.defaultVersion ?? null,
          defaultPhp: adapter.defaultPhp ?? null,
          supportedPhp: adapter.supportedPhp ?? [],
          adminPath: adapter.adminPath ?? '/',
          cliEntrypoint: adapter.cliEntrypoint ?? null,
        })),
      });
    } else {
      for (const adapter of adapters) {
        console.log(
          `--${adapter.name.padEnd(10)} ${adapter.label.padEnd(12)} PHP: ${adapter.supportedPhp.join(', ')} (default ${adapter.defaultPhp})`
        );
      }
    }

    return EXIT_CODES.OK;
  }

  if (command === 'setup') {
    if (subcommand !== 'agent') {
      throw new PlaygroundError(
        `Unknown setup target "${subcommand ?? ''}". Usage: cms-playground setup agent [options]`,
        {
          code: 'unknown_command',
          exitCode: EXIT_CODES.VALIDATION,
          recovery: 'cms-playground setup agent',
        }
      );
    }

    const result = await setupAgent({
      agents: options.agents,
      project: options.project,
      yes: options.yes || options.json,
      skipMcp: options.skipMcp,
      dryRun: options.dryRun,
      force: options.force,
      projectDir: baseDir,
      ...(options.json || options.agentMode ? { isInteractive: false } : {}),
      log: effectiveQuiet ? () => {} : (line) => console.log(line),
    });

    if (result.cancelled) {
      return EXIT_CODES.CANCELLED;
    }

    if (options.json) {
      emitJson(result);
    }

    return EXIT_CODES.OK;
  }

  if (!cms) {
    const flags = listAdapters().map((a) => `--${a.name}`).join(' or ');
    throw new PlaygroundError(
      `Missing CMS flag. Specify ${flags} (e.g. cms-playground ${command} --joomla)`,
      {
        code: 'missing_cms',
        exitCode: EXIT_CODES.VALIDATION,
        recovery: `cms-playground ${command} --joomla`,
        suggestions: [`Specify one of: ${flags}`],
      }
    );
  }

  const adapter = getAdapter(cms);
  const resolvedSite = options.site ? resolve(baseDir, options.site) : null;
  const resolvedBlueprint = resolveMaybeUrl(options.blueprint, baseDir);
  const resolvedOutput = options.output ? resolve(baseDir, options.output) : null;
  const resolvedAutoMount = resolveAutoMountPath(options.autoMount, baseDir);

  if (command === 'start') {
    const instance = await startPlayground({
      adapter,
      version: cmsVersion,
      phpVersion: options.php,
      port: options.port,
      host: options.host,
      site: resolvedSite,
      mountsBeforeInstall: options.mountsBeforeInstall,
      mounts: options.mounts,
      autoMount: resolvedAutoMount,
      blueprintSource: resolvedBlueprint,
      verbosity: options.verbosity,
      quiet: effectiveQuiet,
    });

    if (options.json) {
      emitJson({
        url: instance.url,
        adminUrl: instance.adminUrl,
        username: instance.username,
        password: instance.password,
        cms: adapter.name,
        version: instance.version,
        phpVersion: instance.phpVersion,
        mounts: instance.mounts,
        pid: process.pid,
      });
    } else if (!options.quiet) {
      console.log('');
      console.log(`${adapter.label} ${instance.version} (PHP ${instance.phpVersion}) is running:`);
      console.log(`  Site:  ${instance.url}/`);
      console.log(`  Admin: ${instance.adminUrl}`);
      console.log(`  Login: ${instance.username} / ${instance.password}`);
      console.log('Press Ctrl+C to stop.');
    }

    const shutdown = async () => {
      try {
        await instance.close();
      } finally {
        process.exit(EXIT_CODES.OK);
      }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return null;
  }

  if (command === 'run-blueprint') {
    const result = await runBlueprintHeadless({
      adapter,
      blueprintSource: resolvedBlueprint,
      version: cmsVersion,
      phpVersion: options.php,
      site: resolvedSite,
      mountsBeforeInstall: options.mountsBeforeInstall,
      mounts: options.mounts,
      autoMount: resolvedAutoMount,
      verbosity: options.verbosity,
      quiet: effectiveQuiet,
    });

    if (options.json) {
      emitJson({
        cms: adapter.name,
        version: result.version,
        phpVersion: result.phpVersion,
        stepsRun: result.stepsRun,
        mounts: result.mounts,
      });
    } else if (!options.quiet) {
      console.log(
        `Ran ${result.stepsRun} blueprint step(s) on ${adapter.label} ${result.version} (PHP ${result.phpVersion}).`
      );
    }

    return EXIT_CODES.OK;
  }

  if (command === 'build-snapshot') {
    const result = await buildSnapshot({
      adapter,
      outputPath: resolvedOutput,
      blueprintSource: resolvedBlueprint,
      version: cmsVersion,
      phpVersion: options.php,
      site: resolvedSite,
      mountsBeforeInstall: options.mountsBeforeInstall,
      mounts: options.mounts,
      autoMount: resolvedAutoMount,
      verbosity: options.verbosity,
      quiet: effectiveQuiet,
    });

    if (options.json) {
      emitJson({
        cms: adapter.name,
        version: result.version,
        phpVersion: result.phpVersion,
        outputPath: result.outputPath,
        bytes: result.bytes,
        mounts: result.mounts,
      });
    } else if (!options.quiet) {
      console.log(`Snapshot written to ${result.outputPath} (${result.bytes} bytes).`);
    }

    return EXIT_CODES.OK;
  }

  if (command === 'cli') {
    const { exitCode, stdout, stderr, version, phpVersion } = await runCmsCli({
      adapter,
      args: passthrough,
      site: resolvedSite,
      version: cmsVersion,
      phpVersion: options.php,
      mountsBeforeInstall: options.mountsBeforeInstall,
      mounts: options.mounts,
      autoMount: resolvedAutoMount,
      blueprintSource: resolvedBlueprint,
      verbosity: options.verbosity,
      quiet: effectiveQuiet,
      log: effectiveQuiet ? () => {} : (msg) => console.error(msg),
    });

    if (options.json) {
      emitJson({
        cms: adapter.name,
        version,
        phpVersion,
        exitCode,
        stdout,
        stderr,
      });
    } else {
      if (stdout) {
        process.stdout.write(stdout);
      }

      if (stderr) {
        process.stderr.write(stderr);
      }
    }

    return exitCode;
  }

  throw new PlaygroundError(
    `Unknown command "${command}". Run "cms-playground --help" for usage.`,
    {
      code: 'unknown_command',
      exitCode: EXIT_CODES.VALIDATION,
      recovery: 'cms-playground --help',
    }
  );
}
