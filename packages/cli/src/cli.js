// CLI parser and command dispatcher for @cms-playground/cli.
//
// Usage:
//   cms-playground start          --joomla[=<ver>] [options]
//   cms-playground start          --wp[=<ver>]     [options]
//   cms-playground run-blueprint  --joomla --blueprint=<file|url> [options]
//   cms-playground build-snapshot --joomla --output=./site.zip [--blueprint=<file|url>] [options]
//   cms-playground cli            --joomla [--site=<dir>] -- <joomla.php args...>
//   cms-playground list

import {
  buildSnapshot,
  getAdapter,
  listAdapters,
  parseMountSpec,
  registerAdapter,
  runBlueprintHeadless,
  runCmsCli,
  startPlayground,
} from '@cms-playground/core';
import { joomlaAdapter } from '@cms-playground/joomla';
import { wordpressAdapter } from '@cms-playground/wordpress';

// Register built-in CMS adapters.
registerAdapter(joomlaAdapter);
registerAdapter(wordpressAdapter);

const VERBOSITY_LEVELS = ['quiet', 'normal', 'debug'];

export const HELP_TEXT = `
@cms-playground/cli — Run PHP CMSs locally in WebAssembly with zero setup

Usage:
  cms-playground start          --joomla[=<version>] [options]
  cms-playground start          --wp[=<version>]     [options]
  cms-playground run-blueprint  --joomla --blueprint=<file|url> [options]
  cms-playground build-snapshot --joomla --output=./snapshot.zip [options]
  cms-playground cli            --joomla [options] -- <cms-cli-args...>
  cms-playground list

Commands:
  start           Boot a CMS in PHP-WASM and start a local HTTP server
  run-blueprint   Run a Blueprint headlessly without starting an HTTP server
  build-snapshot  Boot a CMS, optionally run a Blueprint, and export a .zip snapshot
  cli             Run the CMS's native CLI (e.g. cli/joomla.php) in PHP-WASM
  list            Show registered CMS adapters and supported PHP versions

CMS Selection (pick one):
  --joomla[=<ver>]   Run Joomla (default: latest, e.g. --joomla or --joomla=6.2)
  --wp[=<ver>]       Run WordPress (default: latest, e.g. --wp or --wp=6.7)

Options:
  --php=<version>                PHP version (e.g. 8.3, 8.4, 8.5)
  --port=<number>                Local HTTP port (default: 8790)
  --host=<address>               Bind address (default: 127.0.0.1)
  --site=<dir>                   Mount an existing local site directory instead of a fresh bundle
  --blueprint=<src>              Blueprint JSON file path or URL to execute after boot
  --output=<path>                Output .zip path for build-snapshot
  --mount=<src:vfs>              Mount a host folder into VFS after configure (repeatable)
  --mount-before-install=<s:v>   Mount a host folder into VFS before configure (repeatable)
  --auto-mount[=dir]             Auto-detect and mount a Joomla extension or WP plugin/theme (default: CWD)
  --verbosity=<level>            Logging level: quiet, normal, debug (default: normal)
  --quiet                        Alias for --verbosity=quiet
  -h, --help                     Show this help message
`.trim();

/**
 * Parses argv into { command, cms, cmsVersion, options, passthrough }.
 * Supports optional-value CMS flags like `--joomla`, `--joomla=6.2`, `--wp`, `--wp=6.7`.
 */
export function parseCliArgs(argv) {
  const dashDash = argv.indexOf('--');
  const mainArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const passthrough = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  let command = null;
  let cms = null;
  let cmsVersion = null;
  const options = {
    php: null,
    port: 8790,
    host: '127.0.0.1',
    site: null,
    blueprint: null,
    output: null,
    mountsBeforeInstall: [],
    mounts: [],
    autoMount: null,
    verbosity: 'normal',
    quiet: false,
    help: false,
  };

  for (let i = 0; i < mainArgs.length; i++) {
    const arg = mainArgs[i];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
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
          throw new Error(`Multiple CMS flags specified (--${cms} and --${adapter.name}). Choose one.`);
        }

        cms = adapter.name;
        cmsVersion = inlineValue || null;
        continue;
      }

      const nextValue = () => {
        if (inlineValue !== null) {
          if (inlineValue === '') {
            throw new Error(`Option --${key} requires a value`);
          }

          return inlineValue;
        }

        const next = mainArgs[++i];

        if (next === undefined || next === '' || next.startsWith('--')) {
          throw new Error(`Option --${key} requires a value`);
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
            throw new Error(`Invalid port: ${options.port}`);
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
          options.mounts.push(parseMountSpec(nextValue()));
          break;
        case 'mount-before-install':
          options.mountsBeforeInstall.push(parseMountSpec(nextValue()));
          break;
        case 'verbosity': {
          const level = nextValue().toLowerCase();
          if (!VERBOSITY_LEVELS.includes(level)) {
            throw new Error(`Invalid verbosity "${level}". Expected one of: ${VERBOSITY_LEVELS.join(', ')}`);
          }
          options.verbosity = level;
          options.quiet = level === 'quiet';
          break;
        }
        default:
          throw new Error(`Unknown option: --${key}`);
      }

      continue;
    }

    if (!command) {
      command = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { command, cms, cmsVersion, options, passthrough };
}

/**
 * Main CLI entrypoint.
 */
export async function run(argv = process.argv.slice(2)) {
  const { command, cms, cmsVersion, options, passthrough } = parseCliArgs(argv);

  if (options.help || !command) {
    console.log(HELP_TEXT);
    return 0;
  }

  if (command === 'list') {
    for (const adapter of listAdapters()) {
      console.log(`--${adapter.name.padEnd(10)} ${adapter.label.padEnd(12)} PHP: ${adapter.supportedPhp.join(', ')} (default ${adapter.defaultPhp})`);
    }

    return 0;
  }

  if (!cms) {
    const flags = listAdapters().map((a) => `--${a.name}`).join(' or ');
    throw new Error(`Missing CMS flag. Specify ${flags} (e.g. cms-playground ${command} --joomla)`);
  }

  const adapter = getAdapter(cms);

  if (command === 'start') {
    const instance = await startPlayground({
      adapter,
      version: cmsVersion,
      phpVersion: options.php,
      port: options.port,
      host: options.host,
      site: options.site,
      mountsBeforeInstall: options.mountsBeforeInstall,
      mounts: options.mounts,
      autoMount: options.autoMount,
      blueprintSource: options.blueprint,
      verbosity: options.verbosity,
      quiet: options.quiet,
    });

    if (!options.quiet) {
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
        process.exit(0);
      }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return null;
  }

  if (command === 'run-blueprint') {
    const result = await runBlueprintHeadless({
      adapter,
      blueprintSource: options.blueprint,
      version: cmsVersion,
      phpVersion: options.php,
      site: options.site,
      mountsBeforeInstall: options.mountsBeforeInstall,
      mounts: options.mounts,
      autoMount: options.autoMount,
      verbosity: options.verbosity,
      quiet: options.quiet,
    });

    if (!options.quiet) {
      console.log(`Ran ${result.stepsRun} blueprint step(s) on ${adapter.label} ${result.version} (PHP ${result.phpVersion}).`);
    }

    return 0;
  }

  if (command === 'build-snapshot') {
    const result = await buildSnapshot({
      adapter,
      outputPath: options.output,
      blueprintSource: options.blueprint,
      version: cmsVersion,
      phpVersion: options.php,
      site: options.site,
      mountsBeforeInstall: options.mountsBeforeInstall,
      mounts: options.mounts,
      autoMount: options.autoMount,
      verbosity: options.verbosity,
      quiet: options.quiet,
    });

    if (!options.quiet) {
      console.log(`Snapshot written to ${result.outputPath} (${result.bytes} bytes).`);
    }

    return 0;
  }

  if (command === 'cli') {
    const { exitCode, stdout, stderr } = await runCmsCli({
      adapter,
      args: passthrough,
      site: options.site,
      version: cmsVersion,
      phpVersion: options.php,
      mountsBeforeInstall: options.mountsBeforeInstall,
      mounts: options.mounts,
      autoMount: options.autoMount,
      blueprintSource: options.blueprint,
      verbosity: options.verbosity,
      quiet: options.quiet,
      log: options.quiet ? () => {} : (msg) => console.error(msg),
    });

    if (stdout) {
      process.stdout.write(stdout);
    }

    if (stderr) {
      process.stderr.write(stderr);
    }

    return exitCode;
  }

  throw new Error(`Unknown command "${command}". Run "cms-playground --help" for usage.`);
}
