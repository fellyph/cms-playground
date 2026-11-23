// Local stdio MCP (Model Context Protocol) server for @cms-playground/cli.
// Exposes stateful PHP-WASM CMS tools over newline-delimited JSON-RPC 2.0 on stdin/stdout.

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import {
  getAdapter,
  listAdapters,
  parseMountSpec,
  runBlueprintHeadless,
  runCmsCli,
  startPlayground,
} from '@cms-playground/core';

export const MCP_SERVER_INFO = Object.freeze({
  name: 'cms-playground',
  version: '0.1.0',
});

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-03-26', '2024-11-05']);
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const MAX_LOG_LINES = 500;
const MAX_FETCH_BODY_BYTES = 64 * 1024;

const PHP_ERROR_REGEX =
  /(?:^|\b)(?:Fatal error|Parse error|Warning|Notice|Deprecated|Uncaught [A-Za-z0-9_\\]+):\s*.+/gm;

export const MCP_TOOLS = Object.freeze([
  {
    name: 'list_adapters',
    description: 'List all registered CMS adapters, aliases, and supported PHP versions.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'start_playground',
    description:
      'Boot a PHP-WASM CMS instance (e.g. joomla, wp, drupal, typo3, kirby) and start a local HTTP server. Returns an instance id, URLs, and credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        cms: {
          type: 'string',
          description: 'CMS adapter name or alias (e.g. joomla, wp, wordpress, drupal, typo3, kirby).',
        },
        version: { type: 'string', description: 'Optional CMS version (defaults to adapter latest).' },
        php: { type: 'string', description: 'Optional PHP version (e.g. 8.3, 8.4).' },
        port: {
          type: 'integer',
          minimum: 0,
          maximum: 65535,
          description: 'Local HTTP port (defaults to 0 for an ephemeral free port).',
        },
        host: { type: 'string', description: 'Bind address (default 127.0.0.1).' },
        site: { type: 'string', description: 'Existing local site directory to mount instead of a fresh bundle.' },
        blueprint: { type: 'string', description: 'Blueprint JSON file path or URL to execute after boot.' },
        autoMount: {
          oneOf: [{ type: 'boolean' }, { type: 'string' }],
          description: 'Auto-detect and mount a local CMS extension/plugin/theme (true for cwd or explicit path).',
        },
        mounts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repeatable host:vfs mount specs applied after CMS configure.',
        },
        mountsBeforeInstall: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repeatable host:vfs mount specs applied before CMS configure.',
        },
        verbosity: {
          type: 'string',
          enum: ['quiet', 'normal', 'debug'],
          description: 'Logging level captured in instance logs (default normal).',
        },
      },
      required: ['cms'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_playground',
    description: 'Stop a running managed Playground instance (or all instances when all=true).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Instance id returned by start_playground.' },
        all: { type: 'boolean', description: 'Stop all running managed instances.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_blueprint',
    description: 'Execute a Blueprint JSON file or URL headlessly in PHP-WASM without starting an HTTP server.',
    inputSchema: {
      type: 'object',
      properties: {
        cms: { type: 'string', description: 'CMS adapter name or alias.' },
        blueprint: { type: 'string', description: 'Blueprint JSON file path or HTTP(S) URL.' },
        version: { type: 'string', description: 'Optional CMS version.' },
        php: { type: 'string', description: 'Optional PHP version.' },
        site: { type: 'string', description: 'Optional local site directory to mount.' },
        autoMount: {
          oneOf: [{ type: 'boolean' }, { type: 'string' }],
          description: 'Auto-detect and mount a local extension/plugin/theme.',
        },
        mounts: { type: 'array', items: { type: 'string' } },
        mountsBeforeInstall: { type: 'array', items: { type: 'string' } },
        verbosity: { type: 'string', enum: ['quiet', 'normal', 'debug'] },
      },
      required: ['cms', 'blueprint'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_cms_cli',
    description: 'Run the CMS native CLI (e.g. cli/joomla.php, typo3) in PHP-WASM and return exitCode, stdout, and stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional running instance id (inherits cms, version, php, and site).' },
        cms: { type: 'string', description: 'CMS adapter name or alias (required if id is not provided).' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments forwarded to the CMS native CLI.',
        },
        site: { type: 'string', description: 'Optional local site directory.' },
        version: { type: 'string', description: 'Optional CMS version.' },
        php: { type: 'string', description: 'Optional PHP version.' },
        blueprint: { type: 'string', description: 'Optional Blueprint file path or URL.' },
        autoMount: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
        mounts: { type: 'array', items: { type: 'string' } },
        mountsBeforeInstall: { type: 'array', items: { type: 'string' } },
        verbosity: { type: 'string', enum: ['quiet', 'normal', 'debug'] },
      },
      required: ['args'],
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_page',
    description:
      'Request an HTTP path on a running managed Playground instance (via id) or a one-shot ephemeral instance (via cms), returning status, headers, body, and detected PHP errors.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Running instance id returned by start_playground.' },
        cms: { type: 'string', description: 'CMS adapter name for a one-shot ephemeral fetch when id is omitted.' },
        path: { type: 'string', description: 'Request path (default "/").' },
        method: { type: 'string', description: 'HTTP method (default "GET").' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional HTTP request headers.',
        },
        body: { type: 'string', description: 'Optional HTTP request body.' },
        site: { type: 'string', description: 'Local site directory (ephemeral mode).' },
        version: { type: 'string', description: 'CMS version (ephemeral mode).' },
        php: { type: 'string', description: 'PHP version (ephemeral mode).' },
        blueprint: { type: 'string', description: 'Blueprint file path or URL (ephemeral mode).' },
        autoMount: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_php_logs',
    description: 'Read recent captured runtime and PHP log lines for a running managed Playground instance.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Instance id returned by start_playground.' },
        tail: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum number of recent log lines to return (default 100).',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
]);

function resolveMaybeUrl(value, baseDir) {
  if (!value) {
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return resolve(baseDir, value);
}

function resolveAutoMount(autoMount, baseDir) {
  if (!autoMount) {
    return null;
  }
  if (autoMount === true) {
    return baseDir;
  }
  return resolve(baseDir, autoMount);
}

function parseMountList(list, baseDir) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((spec) => parseMountSpec(spec, baseDir));
}

function extractPhpErrors(text) {
  if (!text) {
    return [];
  }
  const matches = text.match(PHP_ERROR_REGEX) ?? [];
  return Array.from(new Set(matches.map((line) => line.trim())));
}

function appendLog(buffer, message) {
  const text = String(message ?? '').trimEnd();
  if (!text) {
    return;
  }
  const timestamp = new Date().toISOString();
  for (const line of text.split(/\r?\n/)) {
    buffer.push(`[${timestamp}] ${line}`);
  }
  if (buffer.length > MAX_LOG_LINES) {
    buffer.splice(0, buffer.length - MAX_LOG_LINES);
  }
}

/**
 * Creates a stateful MCP server instance that manages PHP-WASM Playgrounds
 * and speaks JSON-RPC 2.0 over stdio.
 */
export function createMcpServer(deps = {}) {
  const {
    cwd = process.cwd(),
    getAdapterImpl = getAdapter,
    listAdaptersImpl = listAdapters,
    startPlaygroundImpl = startPlayground,
    runBlueprintHeadlessImpl = runBlueprintHeadless,
    runCmsCliImpl = runCmsCli,
    fetchImpl = globalThis.fetch,
  } = deps;

  const baseDir = resolve(cwd);
  const instances = new Map();
  let nextId = 1;

  function requireAdapter(cmsName) {
    if (!cmsName || typeof cmsName !== 'string') {
      throw new Error('Parameter "cms" is required.');
    }
    const adapter = getAdapterImpl(cmsName);
    if (!adapter) {
      const available = listAdaptersImpl().map((a) => a.name).join(', ');
      throw new Error(`Unknown CMS adapter "${cmsName}". Available: ${available}`);
    }
    return adapter;
  }

  function requireInstance(id) {
    if (!id || typeof id !== 'string') {
      throw new Error('Parameter "id" is required.');
    }
    const entry = instances.get(id);
    if (!entry) {
      throw new Error(`No running Playground instance found with id "${id}".`);
    }
    return entry;
  }

  async function closeAll() {
    const entries = Array.from(instances.values());
    instances.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          await entry.instance.close();
        } catch {
          // Best-effort cleanup on shutdown.
        }
      })
    );
    return entries.map((e) => e.id);
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case 'list_adapters': {
        const adapters = listAdaptersImpl().map((adapter) => ({
          name: adapter.name,
          aliases: [...(adapter.aliases ?? [])],
          label: adapter.label,
          defaultVersion: adapter.defaultVersion ?? null,
          defaultPhp: adapter.defaultPhp ?? null,
          supportedPhp: [...(adapter.supportedPhp ?? [])],
          adminPath: adapter.adminPath ?? '/',
          cliEntrypoint: adapter.cliEntrypoint ?? null,
        }));
        return { adapters };
      }

      case 'start_playground': {
        const adapter = requireAdapter(args.cms);
        const logs = [];
        const sitePath = args.site ? resolve(baseDir, args.site) : null;

        const instance = await startPlaygroundImpl({
          adapter,
          version: args.version ?? null,
          phpVersion: args.php ?? null,
          port: args.port ?? 0,
          host: args.host ?? '127.0.0.1',
          site: sitePath,
          mountsBeforeInstall: parseMountList(args.mountsBeforeInstall, baseDir),
          mounts: parseMountList(args.mounts, baseDir),
          autoMount: resolveAutoMount(args.autoMount, baseDir),
          blueprintSource: resolveMaybeUrl(args.blueprint, baseDir),
          verbosity: args.verbosity ?? 'normal',
          quiet: args.verbosity === 'quiet',
          log: (msg) => appendLog(logs, msg),
        });

        const id = `pg_${nextId++}`;
        instances.set(id, {
          id,
          cms: adapter.name,
          label: adapter.label,
          version: instance.version,
          phpVersion: instance.phpVersion,
          url: instance.url,
          adminUrl: instance.adminUrl,
          username: instance.username,
          password: instance.password,
          site: sitePath,
          instance,
          logs,
        });

        return {
          id,
          cms: adapter.name,
          label: adapter.label,
          version: instance.version,
          phpVersion: instance.phpVersion,
          url: instance.url,
          adminUrl: instance.adminUrl,
          username: instance.username,
          password: instance.password,
          mounts: instance.mounts ?? [],
        };
      }

      case 'stop_playground': {
        if (args.all) {
          const stopped = await closeAll();
          return { stopped };
        }
        const entry = requireInstance(args.id);
        instances.delete(entry.id);
        await entry.instance.close();
        return { stopped: [entry.id] };
      }

      case 'run_blueprint': {
        const adapter = requireAdapter(args.cms);
        if (!args.blueprint || typeof args.blueprint !== 'string') {
          throw new Error('Parameter "blueprint" is required.');
        }
        const logs = [];
        const result = await runBlueprintHeadlessImpl({
          adapter,
          blueprintSource: resolveMaybeUrl(args.blueprint, baseDir),
          version: args.version ?? null,
          phpVersion: args.php ?? null,
          site: args.site ? resolve(baseDir, args.site) : null,
          mountsBeforeInstall: parseMountList(args.mountsBeforeInstall, baseDir),
          mounts: parseMountList(args.mounts, baseDir),
          autoMount: resolveAutoMount(args.autoMount, baseDir),
          verbosity: args.verbosity ?? 'normal',
          quiet: args.verbosity === 'quiet',
          log: (msg) => appendLog(logs, msg),
        });

        return {
          cms: adapter.name,
          label: adapter.label,
          version: result.version,
          phpVersion: result.phpVersion,
          stepsRun: result.stepsRun,
          logs,
        };
      }

      case 'run_cms_cli': {
        if (!Array.isArray(args.args)) {
          throw new Error('Parameter "args" must be an array of strings.');
        }
        let adapter;
        let site = args.site ? resolve(baseDir, args.site) : null;
        let version = args.version ?? null;
        let phpVersion = args.php ?? null;

        if (args.id) {
          const entry = requireInstance(args.id);
          adapter = requireAdapter(args.cms ?? entry.cms);
          site = site ?? entry.site;
          version = version ?? entry.version;
          phpVersion = phpVersion ?? entry.phpVersion;
        } else {
          adapter = requireAdapter(args.cms);
        }

        const logs = [];
        const result = await runCmsCliImpl({
          adapter,
          args: args.args.map(String),
          site,
          version,
          phpVersion,
          mountsBeforeInstall: parseMountList(args.mountsBeforeInstall, baseDir),
          mounts: parseMountList(args.mounts, baseDir),
          autoMount: resolveAutoMount(args.autoMount, baseDir),
          blueprintSource: resolveMaybeUrl(args.blueprint, baseDir),
          verbosity: args.verbosity ?? 'normal',
          quiet: args.verbosity === 'quiet',
          log: (msg) => appendLog(logs, msg),
        });

        return {
          exitCode: result.exitCode,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          logs,
        };
      }

      case 'fetch_page': {
        const reqPath = typeof args.path === 'string' && args.path.length > 0
          ? (args.path.startsWith('/') ? args.path : `/${args.path}`)
          : '/';
        const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';

        let targetUrl;
        let ephemeralInstance = null;
        const ephemeralLogs = [];

        if (args.id) {
          const entry = requireInstance(args.id);
          targetUrl = `${entry.url}${reqPath}`;
        } else if (args.cms) {
          const adapter = requireAdapter(args.cms);
          ephemeralInstance = await startPlaygroundImpl({
            adapter,
            version: args.version ?? null,
            phpVersion: args.php ?? null,
            port: 0,
            host: '127.0.0.1',
            site: args.site ? resolve(baseDir, args.site) : null,
            autoMount: resolveAutoMount(args.autoMount, baseDir),
            blueprintSource: resolveMaybeUrl(args.blueprint, baseDir),
            verbosity: 'normal',
            quiet: false,
            log: (msg) => appendLog(ephemeralLogs, msg),
          });
          targetUrl = `${ephemeralInstance.url}${reqPath}`;
        } else {
          throw new Error('Provide either "id" (running instance) or "cms" (ephemeral fetch).');
        }

        try {
          const res = await fetchImpl(targetUrl, {
            method,
            headers: args.headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : args.body,
          });

          const rawBytes = Buffer.from(await res.arrayBuffer());
          const truncated = rawBytes.length > MAX_FETCH_BODY_BYTES;
          const bodyText = rawBytes.subarray(0, MAX_FETCH_BODY_BYTES).toString('utf8');
          const phpErrors = extractPhpErrors(bodyText);

          return {
            url: targetUrl,
            path: reqPath,
            method,
            status: res.status,
            statusText: res.statusText,
            headers: Object.fromEntries(res.headers.entries()),
            bytes: rawBytes.length,
            truncated,
            body: bodyText,
            phpErrors,
          };
        } finally {
          if (ephemeralInstance) {
            await ephemeralInstance.close();
          }
        }
      }

      case 'read_php_logs': {
        const entry = requireInstance(args.id);
        const tail = Number.isInteger(args.tail) && args.tail > 0 ? Math.min(args.tail, MAX_LOG_LINES) : 100;
        return {
          id: entry.id,
          totalLines: entry.logs.length,
          lines: entry.logs.slice(-tail),
        };
      }

      default:
        return null;
    }
  }

  /**
   * Handles a single parsed JSON-RPC 2.0 request or notification.
   * Returns a JSON-RPC response object, or null for notifications.
   */
  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: -32600, message: 'Invalid Request: expected JSON-RPC 2.0 object.' },
      };
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined;
    const { id, method, params } = message;

    // Notifications (no id) must not produce a response.
    if (!hasId) {
      return null;
    }

    if (typeof method !== 'string') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid Request: method must be a string.' },
      };
    }

    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;

      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: MCP_SERVER_INFO,
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS,
        },
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      const known = MCP_TOOLS.some((t) => t.name === toolName);

      if (!known) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool "${toolName}".` },
        };
      }

      try {
        const result = await callTool(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: false,
          },
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: error?.message ?? String(error),
                    code: error?.code ?? 'tool_error',
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  /**
   * Connects the server to a stdio stream pair and cleans up all managed
   * Playground instances automatically when the input stream closes.
   */
  async function serveStdio({
    input = process.stdin,
    output = process.stdout,
    registerSignals = true,
  } = {}) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let pending = Promise.resolve();
    let shuttingDown = false;

    const writeResponse = (response) => {
      if (!response || output.writableEnded || output.destroyed) {
        return;
      }
      output.write(`${JSON.stringify(response)}\n`);
    };

    const shutdown = async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      rl.close();
      await pending;
      await closeAll();
    };

    const onSignal = () => {
      shutdown().catch(() => {});
    };

    if (registerSignals) {
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    }

    try {
      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        pending = pending.then(async () => {
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch (err) {
            writeResponse({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: `Parse error: ${err.message}` },
            });
            return;
          }

          const response = await handleMessage(parsed);
          writeResponse(response);
        });
      }

      await pending;
    } finally {
      if (registerSignals) {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
      await closeAll();
    }
  }

  return {
    handleMessage,
    serveStdio,
    closeAll,
    listManagedInstances: () => Array.from(instances.keys()),
  };
}

/**
 * CLI entrypoint for `cms-playground mcp`.
 */
export async function runMcpServer(options = {}) {
  const server = createMcpServer(options);
  await server.serveStdio(options);
  return 0;
}
