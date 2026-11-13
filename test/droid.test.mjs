import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backendCommand,
  loadDroidConfig,
  probeDecision,
  resolveNativeModel,
  runDroidEvent,
  serveNative,
} from '../src/local-droid.mjs';

const root = await mkdtemp(join(tmpdir(), 'jev-droid-fork-test-'));
try {
  const configPath = join(root, 'droid.json');
  const local = {
    schema: 1,
    project: '/sandbox/test-only-droid-checkout',
    endpoint: 'http://127.0.0.1:8774',
    backend: {
      runtime: 'native', model: join(root, 'model.gguf'),
      llama_bin: '/bin/echo', auto_start: true, idle_timeout_seconds: 60,
    },
    settings: {
      model: 'jev-latest', threshold: 0.9, maxSkills: 10,
      timeoutMs: 60000, codexBin: '/bin/echo', dashboardAutoStart: false,
    },
  };
  await writeFile(configPath, JSON.stringify(local));
  const config = await loadDroidConfig(configPath);
  assert.equal(config.endpoint, local.endpoint);
  assert.equal(config.settings.timeoutMs, 60000);
  assert.equal(config.settings.maxSkills, 10);
  assert.equal(config.project, undefined, 'production must not require sandbox checkout');
  assert.equal(config.leaseDir, join(root, 'droid-leases'));
  assert.deepEqual(backendCommand(config)[0], '/bin/echo');

  for (const endpoint of [
    'https://api.typesafe.ai/v1/systemone',
    'http://example.org:8774',
    'http://127.0.0.1:8774/evil',
  ]) {
    await writeFile(configPath, JSON.stringify({ ...local, endpoint }));
    await assert.rejects(loadDroidConfig(configPath), /JEV_DROID_CONFIG_INVALID/);
  }
  await writeFile(configPath, JSON.stringify(local));

  const snapshot = join(root, 'models--example--decision', 'snapshots');
  const current = join(snapshot, 'new', 'local.gguf');
  await mkdir(join(snapshot, 'new'), { recursive: true });
  await writeFile(current, 'native-model');
  const stale = join(snapshot, 'old', 'local.gguf');
  assert.equal(await resolveNativeModel(stale), current);
  await mkdir(join(snapshot, 'another'));
  const other = join(snapshot, 'another', 'local.gguf');
  await writeFile(other, 'different-model');
  await assert.rejects(resolveNativeModel(stale), /JEV_DROID_MODEL_AMBIGUOUS/);

  const decisions = [];
  const localFetch = async (url, options = {}) => {
    decisions.push([url, options]);
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'native-model' }] });
    if (url.endsWith('/v1/systemone')) return Response.json({
      model: 'native-model', answers: { probe: { type: 'noul', noul: 0.8 } },
    });
    throw new Error('Unexpected URL');
  };
  assert.equal(await probeDecision(config, localFetch), 'native-model');
  assert(decisions.every(([url]) => url.startsWith(local.endpoint)));
  await assert.rejects(probeDecision(config, async (url) => (
    url.endsWith('/v1/models') ? Response.json({ data: [] }) : Response.json({})
  )), /JEV_DROID_DECISION_INVALID/);

  const skillDir = join(root, 'example-skill');
  await mkdir(skillDir);
  const skillFile = join(skillDir, 'SKILL.md');
  await writeFile(skillFile, 'This helps test Python code.');
  const catalog = { skills: [{ name: 'test-skill', description: 'Test Python code',
    path: skillFile, enabled: true }] };
  let requested = 0;
  const event = { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'Test Python code' };
  const configWithHistory = {
    ...config, settings: { ...config.settings, dataDir: join(root, 'history') },
  };
  const result = await runDroidEvent(event, configWithHistory, {
    ensureBackend: async () => 'native-model',
    discover: async () => catalog,
    fetchImpl: async (url, options) => {
      requested++;
      assert.equal(url, config.endpoint + '/v1/systemone');
      assert.equal(JSON.parse(options.body).model, 'native-model');
      return Response.json({ answers: { s0: { type: 'noul', noul: 0.98 } } });
    },
  });
  assert.equal(requested, 1);
  assert.equal(result.systemMessage, undefined, 'local native routing must record valid history');
  const history = JSON.parse((await readFile(join(root, 'history',
    new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')).trim());
  assert.equal(history.model, 'jev-local');
  assert.equal(history.selected[0].name, 'test-skill');
  assert.match(result.hookSpecificOutput.additionalContext, /test-skill/);
  assert(!JSON.stringify(result).includes('/sandbox/test-only-droid-checkout'));
  assert.equal((await readFile(configPath, 'utf8')).includes('sandbox/test-only'), true,
    'never rewrite unrelated configuration or upstream testing copies');
  const fakeServer = join(root, 'fake-llama');
  const serverOutput = join(root, 'fake-llama-args');
  await writeFile(fakeServer, `#!/usr/bin/env node
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(serverOutput)}, process.argv.slice(2).join('\\n'));
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok' }));
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, { mode: 0o700 });
  const executableModel = join(root, 'native.gguf');
  await writeFile(executableModel, 'fixture');
  const idleConfig = {
    ...config,
    leaseDir: join(root, 'idle-leases'),
    backend: { ...config.backend, model: executableModel,
      llama_bin: fakeServer, idle_timeout_seconds: 1 },
  };
  assert.equal(await serveNative(idleConfig), 0);
  assert.match(await readFile(serverOutput, 'utf8'), /--model/);
  assert.match(await readFile(serverOutput, 'utf8'), /--no-webui/);

  console.log('Droid fork check passed: local config, no sandbox dependency, native probing, GGUF resolution, direct skill routing.');
} finally {
  await rm(root, { recursive: true, force: true });
}
