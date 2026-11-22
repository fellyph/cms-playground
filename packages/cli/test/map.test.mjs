import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registerAdapter, unregisterAdapter } from '@cms-playground/core';
import { buildCliMap, buildCliPaths, parseCliArgs, run } from '../src/cli.js';

describe('@cms-playground/cli map command', () => {
  async function captureLogs(fn) {
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      const result = await fn();
      return { result, output: lines.join('\n') };
    } finally {
      console.log = origLog;
    }
  }

  it('parses map with --json and --paths flags', () => {
    const plain = parseCliArgs(['map'], { env: {} });
    assert.equal(plain.command, 'map');
    assert.equal(plain.options.json, false);
    assert.equal(plain.options.paths, false);

    const json = parseCliArgs(['map', '--json'], { env: {} });
    assert.equal(json.command, 'map');
    assert.equal(json.options.json, true);

    const paths = parseCliArgs(['map', '--paths'], { env: {} });
    assert.equal(paths.command, 'map');
    assert.equal(paths.options.paths, true);
  });

  it('returns commands, adapters, and blueprintSteps for map and map --json', async () => {
    for (const argv of [['map'], ['map', '--json']]) {
      const { result, output } = await captureLogs(() => run(argv, { env: {} }));
      assert.equal(result, 0);

      const payload = JSON.parse(output);
      assert.ok(payload.data);
      assert.ok(Array.isArray(payload.data.commands));
      assert.ok(Array.isArray(payload.data.adapters));
      assert.ok(Array.isArray(payload.data.blueprintSteps));

      // Verify command entries have required shape
      const commandIds = payload.data.commands.map((c) => c.id);
      for (const expectedId of ['start', 'run-blueprint', 'build-snapshot', 'cli', 'setup agent', 'list', 'map']) {
        assert.ok(commandIds.includes(expectedId), `Missing command "${expectedId}" in map`);
      }

      for (const cmd of payload.data.commands) {
        assert.equal(typeof cmd.id, 'string');
        assert.equal(typeof cmd.usage, 'string');
        assert.equal(typeof cmd.description, 'string');
        assert.ok(Array.isArray(cmd.flags));
      }

      // Verify adapters
      const joomla = payload.data.adapters.find((a) => a.name === 'joomla');
      const wp = payload.data.adapters.find((a) => a.name === 'wp');
      assert.ok(joomla);
      assert.equal(joomla.label, 'Joomla');
      assert.ok(Array.isArray(joomla.supportedPhp) && joomla.supportedPhp.length > 0);
      assert.equal(typeof joomla.defaultPhp, 'string');
      assert.ok(wp);
      assert.equal(wp.label, 'WordPress');

      // Verify core and adapter-specific blueprint steps with requiredFields
      const stepMap = new Map(payload.data.blueprintSteps.map((s) => [s.step, s]));
      assert.deepEqual(stepMap.get('runPHP')?.requiredFields, ['code']);
      assert.deepEqual(stepMap.get('writeFile')?.requiredFields, ['path', 'data']);
      assert.deepEqual(stepMap.get('mkdir')?.requiredFields, ['path']);
      assert.deepEqual(stepMap.get('unzip')?.requiredFields, ['url']);
      assert.equal(stepMap.get('setGlobalConfig')?.adapter, 'joomla');
      assert.deepEqual(stepMap.get('setGlobalConfig')?.requiredFields, ['values']);
      assert.equal(stepMap.get('activatePlugin')?.adapter, 'wp');
      assert.deepEqual(stepMap.get('activatePlugin')?.requiredFields, ['pluginPath']);
    }
  });

  it('dynamically reflects newly registered custom adapters and their blueprint steps', () => {
    const customAdapter = {
      name: 'customcms',
      label: 'CustomCMS',
      aliases: ['customcms', 'ccms'],
      defaultPhp: '8.4',
      supportedPhp: ['8.3', '8.4'],
      defaultVersion: '1.0',
      adminPath: '/admin/',
      cliEntrypoint: 'bin/console',
      resolveBundle: async () => ({}),
      configure: async () => ({}),
      getFileNotFoundAction: () => ({ type: '404' }),
      blueprintSteps: {
        seedDemo: async () => {},
      },
      blueprintStepSchemas: {
        seedDemo: {
          requiredFields: ['fixture'],
          optionalFields: ['reset'],
          description: 'Seed demo content',
        },
      },
    };

    registerAdapter(customAdapter);
    try {
      const map = buildCliMap();
      assert.ok(map.adapters.some((a) => a.name === 'customcms' && a.label === 'CustomCMS'));

      const step = map.blueprintSteps.find((s) => s.step === 'seedDemo');
      assert.ok(step);
      assert.equal(step.scope, 'adapter');
      assert.equal(step.adapter, 'customcms');
      assert.deepEqual(step.requiredFields, ['fixture']);

      const startCmd = map.commands.find((c) => c.id === 'start');
      assert.ok(startCmd.flags.some((f) => f.name === '--customcms'));

      const paths = buildCliPaths(map);
      assert.ok(paths.includes('cms-playground start --customcms'));
      assert.ok(paths.includes('cms-playground cli --customcms -- <args...>'));
    } finally {
      unregisterAdapter('customcms');
    }
  });

  it('outputs one canonical invocation per line for map --paths', async () => {
    const { result, output } = await captureLogs(() => run(['map', '--paths'], { env: {} }));
    assert.equal(result, 0);

    const lines = output.split('\n').filter(Boolean);
    assert.ok(lines.length >= 8);
    assert.ok(lines.every((line) => line.startsWith('cms-playground ')));
    assert.ok(lines.includes('cms-playground start --joomla'));
    assert.ok(lines.includes('cms-playground start --wp'));
    assert.ok(lines.includes('cms-playground map --paths'));

    const { result: jsonResult, output: jsonOutput } = await captureLogs(() =>
      run(['map', '--paths', '--json'], { env: {} })
    );
    assert.equal(jsonResult, 0);
    const parsed = JSON.parse(jsonOutput);
    assert.deepEqual(parsed.data.paths, lines);
  });
});
