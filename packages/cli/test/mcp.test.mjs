import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { MCP_TOOLS, createMcpServer } from '../src/mcp.js';
import { wantsJsonOutput } from '../src/cli.js';

function createMockDeps() {
  const closedIds = [];
  let portCounter = 9100;

  const mockAdapter = {
    name: 'joomla',
    aliases: ['joomla'],
    label: 'Joomla',
    defaultVersion: '5.4',
    defaultPhp: '8.4',
    supportedPhp: ['8.3', '8.4'],
    adminPath: '/administrator/',
    cliEntrypoint: 'cli/joomla.php',
  };

  return {
    closedIds,
    deps: {
      getAdapterImpl: (name) => (name === 'joomla' ? mockAdapter : null),
      listAdaptersImpl: () => [mockAdapter],
      startPlaygroundImpl: async ({ adapter, version, phpVersion, log }) => {
        const port = portCounter++;
        const url = `http://127.0.0.1:${port}`;
        log?.(`Booting ${adapter.label} on ${url}`);
        log?.('GET / 200 12 ms');
        return {
          url,
          port,
          adminUrl: `${url}/administrator/`,
          username: 'admin',
          password: 'secret',
          version: version ?? adapter.defaultVersion,
          phpVersion: phpVersion ?? adapter.defaultPhp,
          mounts: [],
          close: async () => {
            closedIds.push(url);
          },
        };
      },
      runBlueprintHeadlessImpl: async ({ adapter, version, phpVersion, log }) => {
        log?.('Running blueprint step 1/2');
        return {
          version: version ?? adapter.defaultVersion,
          phpVersion: phpVersion ?? adapter.defaultPhp,
          stepsRun: 2,
        };
      },
      runCmsCliImpl: async ({ args, log }) => {
        log?.(`Executing cli with ${args.join(' ')}`);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ args }),
          stderr: '',
        };
      },
      fetchImpl: async (url) => ({
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () =>
          Buffer.from(
            url.endsWith('/broken')
              ? '<html>Fatal error: Undefined function foo() in /var/www/html/index.php on line 4</html>'
              : '<html><body>Hello Playground</body></html>'
          ),
      }),
    },
  };
}

describe('@cms-playground/cli MCP server', () => {
  it('exempts `mcp` from automatic CLI --json mode even under CMS_PLAYGROUND_AGENT=1', () => {
    assert.equal(wantsJsonOutput(['mcp'], { CMS_PLAYGROUND_AGENT: '1' }), false);
    assert.equal(wantsJsonOutput(['mcp'], { CI: '1' }), false);
  });

  it('handles initialize, notifications, ping, and tools/list with JSON Schemas', async () => {
    const { deps } = createMockDeps();
    const server = createMcpServer(deps);

    const init = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });

    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'cms-playground');
    assert.ok(init.result.capabilities.tools);

    // Notification must return null (no response frame).
    const notif = await server.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.equal(notif, null);

    const ping = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.deepEqual(ping.result, {});

    const listed = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const names = listed.result.tools.map((t) => t.name);
    assert.deepEqual(names, [
      'list_adapters',
      'start_playground',
      'stop_playground',
      'run_blueprint',
      'run_cms_cli',
      'fetch_page',
      'read_php_logs',
    ]);
    for (const tool of listed.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
    }
    assert.equal(listed.result.tools.length, MCP_TOOLS.length);
  });

  it('supports start_playground, fetch_page, read_php_logs, run_cms_cli, run_blueprint, and stop_playground', async () => {
    const { deps, closedIds } = createMockDeps();
    const server = createMcpServer(deps);

    const call = async (id, name, args = {}) => {
      const res = await server.handleMessage({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      assert.equal(res.result.isError, false, res.result.content[0].text);
      return JSON.parse(res.result.content[0].text);
    };

    const adapters = await call(1, 'list_adapters');
    assert.equal(adapters.adapters.length, 1);
    assert.equal(adapters.adapters[0].name, 'joomla');

    const started = await call(2, 'start_playground', { cms: 'joomla', php: '8.4' });
    assert.equal(started.id, 'pg_1');
    assert.equal(started.cms, 'joomla');
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const fetched = await call(3, 'fetch_page', { id: 'pg_1', path: '/broken' });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.phpErrors.length, 1);
    assert.match(fetched.phpErrors[0], /Fatal error: Undefined function foo/);

    const logs = await call(4, 'read_php_logs', { id: 'pg_1', tail: 10 });
    assert.equal(logs.id, 'pg_1');
    assert.equal(logs.lines.length, 2);
    assert.match(logs.lines[0], /Booting Joomla/);

    const cliOut = await call(5, 'run_cms_cli', { id: 'pg_1', args: ['user:list'] });
    assert.equal(cliOut.exitCode, 0);
    assert.deepEqual(JSON.parse(cliOut.stdout).args, ['user:list']);

    const bpOut = await call(6, 'run_blueprint', { cms: 'joomla', blueprint: './bp.json' });
    assert.equal(bpOut.stepsRun, 2);

    // Ephemeral fetch_page should boot and immediately close its temporary instance.
    const eph = await call(7, 'fetch_page', { cms: 'joomla', path: '/' });
    assert.equal(eph.status, 200);
    assert.equal(eph.phpErrors.length, 0);
    assert.equal(closedIds.length, 1);

    const stopped = await call(8, 'stop_playground', { id: 'pg_1' });
    assert.deepEqual(stopped.stopped, ['pg_1']);
    assert.equal(closedIds.length, 2);
    assert.deepEqual(server.listManagedInstances(), []);
  });

  it('returns proper JSON-RPC errors and isError tool responses on failures', async () => {
    const { deps } = createMockDeps();
    const server = createMcpServer(deps);

    const unknownMethod = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'nope/method' });
    assert.equal(unknownMethod.error.code, -32601);

    const unknownTool = await server.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });
    assert.equal(unknownTool.error.code, -32602);

    const badCms = await server.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'start_playground', arguments: { cms: 'unknowncms' } },
    });
    assert.equal(badCms.result.isError, true);
    assert.match(badCms.result.content[0].text, /Unknown CMS adapter/);
  });

  it('speaks newline-delimited JSON-RPC over stdio and cleans up all instances on client disconnect', async () => {
    const { deps, closedIds } = createMockDeps();
    const server = createMcpServer(deps);

    const input = new PassThrough();
    const output = new PassThrough();
    const outChunks = [];
    output.on('data', (chunk) => outChunks.push(chunk.toString('utf8')));

    const serving = server.serveStdio({ input, output, registerSignals: false });

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write('not-valid-json\n');
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'start_playground', arguments: { cms: 'joomla' } },
      })}\n`
    );
    // Disconnect client without calling stop_playground.
    input.end();

    await serving;

    const frames = outChunks
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(frames.length, 3);
    assert.equal(frames[0].id, 1);
    assert.equal(frames[1].error.code, -32700);
    assert.equal(frames[2].id, 2);
    assert.equal(frames[2].result.isError, false);

    // Managed instance must have been cleaned up automatically when stdin ended.
    assert.equal(closedIds.length, 1);
    assert.deepEqual(server.listManagedInstances(), []);
  });
});
