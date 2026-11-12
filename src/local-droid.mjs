import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { route } from './router.mjs';

const invalid = code => Object.assign(new Error(code), { code });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const limits = {
  idle_timeout_seconds: [1, 3600],
  startup_timeout_seconds: [1, 300],
  gpu_layers: [0, 65535],
  ctx_size: [1, 1_000_000],
  batch_size: [1, 1_000_000],
  ubatch_size: [1, 1_000_000],
};

function loopbackEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        url.port && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password) {
      return url.origin;
    }
  } catch { /* Handled by the same configuration error. */ }
  throw invalid('JEV_DROID_CONFIG_INVALID');
}

export async function loadDroidConfig(file = process.env.JEV_DROID_CONFIG ||
  join(homedir(), '.config', 'jev-skill-router', 'droid.json')) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw invalid('JEV_DROID_CONFIG_INVALID');
  }
  if (!isObject(raw) || raw.schema !== 1 || !isObject(raw.backend) ||
      !['native', 'gateway'].includes(raw.backend.runtime) || !isObject(raw.settings)) {
    throw invalid('JEV_DROID_CONFIG_INVALID');
  }
  const endpoint = loopbackEndpoint(raw.endpoint);
  const backend = raw.backend;
  const settings = raw.settings;
  const range = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;
  if (!range(settings.timeoutMs ?? 12000, [100, 90000]) ||
      !range(settings.maxSkills ?? 3, [1, 20]) ||
      typeof (settings.threshold ?? 0.8) !== 'number' ||
      !((settings.threshold ?? 0.8) > 0.5) || (settings.threshold ?? 0.8) > 1 ||
      Object.entries(limits).some(([name, bounds]) => backend[name] !== undefined && !range(backend[name], bounds)) ||
      (backend.auto_start !== undefined && typeof backend.auto_start !== 'boolean') ||
      (backend.runtime === 'gateway' && backend.auto_start) ||
      (backend.runtime === 'native' && typeof backend.model !== 'string')) {
    throw invalid('JEV_DROID_CONFIG_INVALID');
  }
  const model = backend.model?.startsWith('~/') ? join(homedir(), backend.model.slice(2)) : backend.model;
  const config = {
    endpoint,
    backend: { ...backend, ...(model ? { model: isAbsolute(model) ? model : resolve(dirname(file), model) } : {}) },
    settings: {
      threshold: settings.threshold ?? 0.8,
      maxSkills: settings.maxSkills ?? 3,
      timeoutMs: settings.timeoutMs ?? 12000,
      codexBin: settings.codexBin ?? 'codex',
      recordSelections: settings.recordSelections ?? true,
      dataDir: settings.dataDir ?? join(homedir(), '.local', 'share', 'jev-skill-router'),
      apiKey: 'local',
    },
    leaseDir: join(dirname(file), 'droid-leases'),
  };
  if (!isAbsolute(config.settings.dataDir)) throw invalid('JEV_DROID_CONFIG_INVALID');
  return config;
}

export async function resolveNativeModel(model) {
  if (!model || !model.endsWith('.gguf')) throw invalid('JEV_DROID_MODEL_MISSING');
  try {
    if ((await stat(model)).isFile()) return model;
  } catch { /* Search only other cached revisions of this same file. */ }

  const snapshot = dirname(dirname(model));
  if (basename(snapshot) !== 'snapshots' || !basename(dirname(snapshot)).startsWith('models--')) {
    throw invalid('JEV_DROID_MODEL_MISSING');
  }
  const paths = [];
  for (const revision of await readdir(snapshot)) {
    const candidate = join(snapshot, revision, basename(model));
    try {
      if ((await stat(candidate)).isFile()) paths.push(candidate);
    } catch { /* A cached revision may not contain this file. */ }
  }
  const revisions = new Set(await Promise.all(paths.map(path => realpath(path))));
  if (revisions.size > 1) throw invalid('JEV_DROID_MODEL_AMBIGUOUS');
  if (revisions.size === 0) throw invalid('JEV_DROID_MODEL_MISSING');
  return paths[0];
}

export function backendCommand(config, model = config.backend.model) {
  if (config.backend.runtime !== 'native') throw invalid('JEV_DROID_RUNTIME_UNSUPPORTED');
  const backend = config.backend;
  const argv = [
    '--host', '127.0.0.1', '--port', new URL(config.endpoint).port,
    '--model', model, '--no-webui',
  ];
  for (const [option, flag] of Object.entries({
    gpu_layers: '--n-gpu-layers',
    ctx_size: '--ctx-size',
    batch_size: '--batch-size',
    ubatch_size: '--ubatch-size',
  })) {
    if (backend[option] !== undefined) argv.push(flag, String(backend[option]));
  }
  return [backend.llama_bin ?? 'llama-server', argv];
}

async function getJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, redirect: 'error' });
  if (!response.ok) throw invalid('JEV_DROID_DECISION_INVALID');
  return response.json();
}

export async function probeDecision(config, fetchImpl = fetch) {
  try {
    const signal = AbortSignal.timeout(config.settings.timeoutMs);
    const catalog = await getJson(config.endpoint + '/v1/models', { signal }, fetchImpl);
    if (!Array.isArray(catalog?.data) || catalog.data.length !== 1 ||
        typeof catalog.data[0]?.id !== 'string' || !catalog.data[0].id) {
      throw invalid('JEV_DROID_DECISION_INVALID');
    }
    const model = catalog.data[0].id;
    const request = {
      model, state: { purpose: 'protocol compatibility check' },
      questions: { probe: { type: 'noul', instructions: 'Is one equal to one?',
        criteria: { no: 'No', yes: 'Yes' } } },
    };
    const answer = await getJson(config.endpoint + '/v1/systemone', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }, fetchImpl);
    if (typeof answer?.model !== 'string' || !answer.model ||
        answer.answers?.probe?.type !== 'noul' ||
        !Number.isFinite(answer.answers.probe.noul) ||
        answer.answers.probe.noul < 0 || answer.answers.probe.noul > 1) {
      throw invalid('JEV_DROID_DECISION_INVALID');
    }
    return model;
  } catch {
    throw invalid('JEV_DROID_DECISION_INVALID');
  }
}

async function healthy(config, fetchImpl = fetch) {
  try {
    const response = await getJson(config.endpoint + '/health',
      { signal: AbortSignal.timeout(2000) }, fetchImpl);
    return response?.status === 'ok';
  } catch { return false; }
}

async function startOwnedService() {
  const child = spawn('systemctl', ['--user', 'start', 'jev-droid-backend.service'],
    { stdio: 'ignore' });
  return new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(invalid('JEV_DROID_SERVICE_FAILED')));
  });
}

export async function ensureDecisionBackend(config, fetchImpl = fetch) {
  if (!await healthy(config, fetchImpl)) {
    if (!config.backend.auto_start || config.backend.runtime !== 'native') {
      throw invalid('JEV_DROID_BACKEND_UNAVAILABLE');
    }
    await startOwnedService();
    const until = Date.now() + (config.backend.startup_timeout_seconds ?? 120) * 1000;
    while (Date.now() < until && !await healthy(config, fetchImpl)) await sleep(500);
    if (!await healthy(config, fetchImpl)) throw invalid('JEV_DROID_BACKEND_UNAVAILABLE');
  }
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
      model, recordModel: 'jev-local',
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

export async function serveNative(config) {
  const model = await resolveNativeModel(config.backend.model);
  const [binary, args] = backendCommand(config, model);
  await mkdir(config.leaseDir, { recursive: true, mode: 0o700 });
  await writeFile(join(config.leaseDir, 'activity'), String(Date.now()), { mode: 0o600 });
  const child = spawn(binary, args, { stdio: 'inherit' });
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
    const timeout = (config.backend.idle_timeout_seconds ?? 60) * 1000;
    while (!exited) {
      await sleep(2000);
      if (!await hasActiveLeases(config.leaseDir) &&
          Date.now() - await lastActivity(config.leaseDir) >= timeout) break;
    }
    return code;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    if (!exited) child.kill('SIGTERM');
    if (!exited) await new Promise(done => child.once('exit', done));
  }
}
