import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { route } from './router.mjs';
import { fail } from './validation.mjs';
import { startModelProxy } from './model-proxy.mjs';
import { backendCommand, listDroidProfiles, loadDroidConfig, resolveNativeModel } from './droid-config.mjs';

export { backendCommand, listDroidProfiles, loadDroidConfig, resolveNativeModel };

async function getJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, redirect: 'error' });
  if (!response.ok) throw fail('JEV_DROID_DECISION_INVALID');
  return response.json();
}

function catalogModelIds(catalog) {
  if (!Array.isArray(catalog?.data) || !catalog.data.length) {
    throw fail('JEV_DROID_DECISION_INVALID');
  }
  const ids = catalog.data.map(item => item?.id);
  if (ids.some(id => typeof id !== 'string' || !id)) {
    throw fail('JEV_DROID_DECISION_INVALID');
  }
  return ids;
}

function selectedModelId(catalog, requested) {
  const ids = catalogModelIds(catalog);
  const model = requested ?? (ids.length === 1 ? ids[0] : null);
  if (!model || !ids.includes(model)) throw fail('JEV_DROID_DECISION_INVALID');
  return model;
}

function validProbeModel(answer, model, backend) {
  return typeof answer?.model === 'string' && Boolean(answer.model) &&
    (!backend.model_id || answer.model === model);
}

function validProbeScore(probe) {
  return probe?.type === 'noul' && Number.isFinite(probe?.noul) &&
    probe.noul >= 0 && probe.noul <= 1;
}

export async function probeDecision(config, fetchImpl = fetch) {
  try {
    const signal = AbortSignal.timeout(config.settings.timeoutMs);
    const model = config.backend.runtime === 'managed' && config.backend.model_id
      ? config.backend.model_id
      : selectedModelId(await getJson(config.endpoint + '/v1/models', { signal }, fetchImpl),
        config.backend.model_id);
    const request = {
      model, state: { purpose: 'protocol compatibility check' },
      questions: { probe: { type: 'noul', instructions: 'Is one equal to one?',
        criteria: { no: 'No', yes: 'Yes' } } },
    };
    const answer = await getJson(config.endpoint + '/v1/systemone', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }, fetchImpl);
    if (!(validProbeModel(answer, model, config.backend) && validProbeScore(answer?.answers?.probe))) {
      throw fail('JEV_DROID_DECISION_INVALID');
    }
    return model;
  } catch {
    throw fail('JEV_DROID_DECISION_INVALID');
  }
}

async function healthy(config, fetchImpl = fetch) {
  try {
    const response = await getJson(config.endpoint + '/health',
      { signal: AbortSignal.timeout(2000) }, fetchImpl);
    return response?.status === 'ok';
  } catch { return false; }
}

async function waitForReady(endpoint, timeoutMs, isAlive, fetchImpl = fetch) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive() && Date.now() < deadline) {
    if (await healthy({ endpoint }, fetchImpl)) return Date.now();
    await sleep(500);
  }
  return 0;
}

async function startOwnedBackend(config) {
  if (config.backend.start === 'systemd') {
    const child = spawn('systemctl', ['--user', 'start', 'jev-droid-backend.service'],
      { stdio: 'ignore' });
    return new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? done() : reject(fail('JEV_DROID_SERVICE_FAILED')));
    });
  }
  const log = await open(join(config.leaseDir, 'server.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [
      process.argv[1],
      '--model', config.profile, 'serve',
    ], {
      detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, JEV_DROID_CONFIG: config.file },
    });
    return await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); done(child.pid); });
    });
  } finally {
    await log.close();
  }
}

function requireRunningChild(pid) {
  if (!pid) return;
  try { process.kill(pid, 0); }
  catch { throw fail('JEV_DROID_SERVICE_FAILED'); }
}

async function awaitNativeReady(config, fetchImpl, childPid) {
  const timeoutMs = (config.backend.startup_timeout_seconds ?? 120) * 1000;
  const ready = await waitForReady(config.endpoint, timeoutMs, () => {
    requireRunningChild(childPid);
    return true;
  }, fetchImpl);
  if (!ready) throw fail('JEV_DROID_BACKEND_UNAVAILABLE');
}

export async function ensureDecisionBackend(config, fetchImpl = fetch) {
  if (config.backend.runtime === 'gateway') return probeDecision(config, fetchImpl);
  if (await healthy(config, fetchImpl)) return probeDecision(config, fetchImpl);
  if (!config.backend.auto_start || !['native', 'managed'].includes(config.backend.runtime)) {
    throw fail('JEV_DROID_BACKEND_UNAVAILABLE');
  }
  await mkdir(config.leaseDir, { recursive: true, mode: 0o700 });
  const childPid = await startOwnedBackend(config);
  await awaitNativeReady(config, fetchImpl, childPid);
  return probeDecision(config, fetchImpl);
}

async function withLease(dir, run) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, String(process.pid) + '-' + randomUUID());
  await writeFile(file, '', { mode: 0o600, flag: 'wx' });
  try {
    return await run();
  } finally {
    await rm(file);
    await writeFile(join(dir, 'activity'), String(Date.now()), { mode: 0o600 });
  }
}

export function runDroidEvent(input, config, dependencies = {}) {
  return withLease(config.leaseDir, async () => {
    const ready = dependencies.ensureBackend ?? ensureDecisionBackend;
    const model = await ready(config, dependencies.fetchImpl ?? fetch);
    return route(input, {
      ...config.settings, endpoint: config.endpoint + '/v1/systemone',
      model, recordModel: config.profile === 'default' || !config.profile ? 'jev-local' : 'jev-' + config.profile,
    }, dependencies);
  });
}

async function hasActiveLeases(dir) {
  try {
    const items = (await readdir(dir)).filter(name => name !== 'activity');
    return items.some(name => {
      const pid = Number(name.split('-')[0]);
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
  } catch { return false; }
}

async function lastActivity(dir) {
  try { return (await stat(join(dir, 'activity'))).mtimeMs; }
  catch { return Date.now(); }
}

async function ownedBackendCommand(config, endpoint = config.endpoint) {
  const model = config.backend.runtime === 'native'
    ? await resolveNativeModel(config.backend.model)
    : undefined;
  return backendCommand({ ...config, endpoint }, model);
}

function ownedBackendEnvironment(config) {
  return {
    ...process.env, ...config.backend.env, JEV_DROID_LEASE_DIR: config.leaseDir,
    JEV_LLAMA_LOAD_MODE: config.backend.load_mode ?? '',
    JEV_LLAMA_NO_WARMUP: config.backend.no_warmup ? '1' : '0',
    ...(config.backend.fit ? { JEV_LLAMA_FIT: config.backend.fit } : {}),
    ...(config.backend.ctx_size ? { JEV_LLAMA_CTX_SIZE: String(config.backend.ctx_size) } : {}),
    ...(config.backend.gpu_layers !== undefined
      ? { JEV_LLAMA_GPU_LAYERS: String(config.backend.gpu_layers) } : {}),
  };
}

async function waitForIdle(config, proxy, readyAt, isAlive) {
  const timeout = (config.backend.idle_timeout_seconds ?? 60) * 1000;
  while (isAlive()) {
    await sleep(500);
    if (proxy.active() || await hasActiveLeases(config.leaseDir)) continue;
    const latest = Math.max(readyAt, proxy.lastResponseAt(),
      await lastActivity(config.leaseDir));
    if (Date.now() - latest >= timeout) return;
  }
}

export async function serveNative(config) {
  const proxy = await startModelProxy(config.endpoint);
  try {
    const [binary, args] = await ownedBackendCommand(config, proxy.endpoint);
    await mkdir(config.leaseDir, { recursive: true, mode: 0o700 });
    await writeFile(join(config.leaseDir, 'activity'), String(Date.now()), { mode: 0o600 });
    const child = spawn(binary, args, {
      stdio: 'inherit', env: ownedBackendEnvironment(config),
    });
    let exited = false;
    let code = 0;
    child.once('exit', (exitCode, signal) => {
      exited = true;
      code = signal ? 128 : exitCode ?? 1;
    });
    child.once('error', () => { exited = true; code = 127; });
    const stop = () => child.kill('SIGTERM');
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    try {
      const readyAt = await waitForReady(proxy.endpoint,
        (config.backend.startup_timeout_seconds ?? 120) * 1000, () => !exited);
      if (readyAt) await waitForIdle(config, proxy, readyAt, () => !exited);
      else if (!exited) code = 1;
      return code;
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      if (!exited) child.kill('SIGTERM');
      if (!exited) await new Promise(done => child.once('exit', done));
    }
  } finally {
    await proxy.close();
  }
}
