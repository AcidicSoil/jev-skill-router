import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fail, isObject } from './validation.mjs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const defaultFile = () => process.env.JEV_DROID_CONFIG ||
  join(homedir(), '.config', 'jev-skill-router', 'droid.json');
const limits = {
  idle_timeout_seconds: [1, 3600],
  startup_timeout_seconds: [1, 300],
  gpu_layers: [0, 65535],
  ctx_size: [1, 1_000_000],
  batch_size: [1, 1_000_000],
  ubatch_size: [1, 1_000_000],
};

async function readConfig(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (isObject(raw) && raw.schema === 1 && isObject(raw.settings) &&
        (raw.profiles === undefined || isObject(raw.profiles))) return raw;
  } catch { /* Invalid or unavailable configuration. */ }
  throw fail('JEV_DROID_CONFIG_INVALID');
}

function loopbackEndpoint(value) {
  let url;
  try { url = new URL(value); }
  catch { throw fail('JEV_DROID_CONFIG_INVALID'); }
  const valid = [
    url.protocol === 'http:',
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    Boolean(url.port),
    url.pathname === '/',
    !url.search, !url.hash, !url.username, !url.password,
  ].every(Boolean);
  if (!valid) throw fail('JEV_DROID_CONFIG_INVALID');
  return url.origin;
}

const range = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;
const settingsRanges = {
  timeoutMs: [100, 90000],
  maxSkills: [1, 20],
  batchBytes: [2000, 60000],
  concurrency: [1, 3],
};

function normalizeSettings(options) {
  const settings = {
    threshold: 0.8, maxSkills: 3, batchBytes: 60000,
    concurrency: 3, timeoutMs: 12000, codexBin: 'codex',
    recordSelections: true,
    dataDir: join(homedir(), '.local', 'share', 'jev-skill-router'),
    ...options, apiKey: 'local',
  };
  const valid = [
    Object.entries(settingsRanges).every(([name, bounds]) => range(settings[name], bounds)),
    Number.isFinite(settings.threshold) && settings.threshold > 0.5 && settings.threshold <= 1,
    typeof settings.codexBin === 'string' && Boolean(settings.codexBin.trim()),
    typeof settings.recordSelections === 'boolean',
    typeof settings.dataDir === 'string' && isAbsolute(settings.dataDir),
  ].every(Boolean);
  if (!valid) throw fail('JEV_DROID_CONFIG_INVALID');
  return settings;
}

function validBackendRuntime(backend) {
  return ['native', 'gateway', 'managed'].includes(backend.runtime) &&
    (backend.auto_start === undefined || typeof backend.auto_start === 'boolean') &&
    (backend.runtime !== 'gateway' || !backend.auto_start);
}

function validManagedEnvironment(env) {
  return env === undefined || (isObject(env) &&
    Object.entries(env).every(([key, value]) =>
      /^[A-Z][A-Z0-9_]*$/u.test(key) && typeof value === 'string'));
}

function validManagedCommand(backend) {
  return typeof backend.command === 'string' && isAbsolute(backend.command) &&
    Array.isArray(backend.args) &&
    backend.args.every(arg => typeof arg === 'string') &&
    validManagedEnvironment(backend.env);
}

function validBackendModel(backend) {
  return (backend.runtime !== 'managed' || validManagedCommand(backend)) &&
    (backend.runtime !== 'native' || typeof backend.model === 'string') &&
    (backend.model_id === undefined ||
      (typeof backend.model_id === 'string' && Boolean(backend.model_id.trim())));
}

function validBackendStart(backend, profile) {
  return (backend.start === undefined || ['systemd', 'process'].includes(backend.start)) &&
    (backend.runtime !== 'gateway' || backend.start === undefined) &&
    (profile === 'default' || backend.start !== 'systemd');
}

function validBackendLoadOptions(backend) {
  const fit = backend.fit === undefined || ['on', 'off'].includes(backend.fit);
  const load = backend.load_mode === undefined ||
    ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio'].includes(backend.load_mode);
  return fit && load &&
    (backend.no_warmup === undefined || typeof backend.no_warmup === 'boolean');
}

function normalizeBackend(backend, file, profile) {
  const validLimits = Object.entries(limits).every(([name, bounds]) =>
    backend[name] === undefined || range(backend[name], bounds));
  if (![validBackendRuntime(backend), validBackendModel(backend),
    validBackendStart(backend, profile), validLimits,
    validBackendLoadOptions(backend)].every(Boolean)) {
    throw fail('JEV_DROID_CONFIG_INVALID');
  }
  const model = backend.model?.startsWith('~/') ?
    join(homedir(), backend.model.slice(2)) : backend.model;
  return {
    ...backend,
    start: backend.start ?? (profile === 'default' ? 'systemd' : 'process'),
    ...(model ? { model: isAbsolute(model) ? model : resolve(dirname(file), model) } : {}),
  };
}

function selectProfile(raw, profile) {
  if (!/^[a-z][a-z0-9_-]{0,49}$/u.test(profile)) throw fail('JEV_DROID_PROFILE_UNKNOWN');
  const selected = profile === 'default' ? raw : raw.profiles?.[profile];
  if (!selected) throw fail('JEV_DROID_PROFILE_UNKNOWN');
  const valid = [
    isObject(selected),
    isObject(selected.backend),
    selected.settings === undefined || isObject(selected.settings),
  ].every(Boolean);
  if (!valid) throw fail('JEV_DROID_CONFIG_INVALID');
  return selected;
}

export async function listDroidProfiles(file = defaultFile()) {
  const raw = await readConfig(file);
  const names = Object.keys(raw.profiles ?? {});
  if (names.some(name => !/^[a-z][a-z0-9_-]{0,49}$/u.test(name) || name === 'default')) {
    throw fail('JEV_DROID_CONFIG_INVALID');
  }
  return ['default', ...names];
}

export async function loadDroidConfig(file = defaultFile(), profile = process.env.JEV_DROID_PROFILE || 'default') {
  const raw = await readConfig(file);
  const selected = selectProfile(raw, profile);
  return {
    file, profile,
    endpoint: loopbackEndpoint(selected.endpoint),
    backend: normalizeBackend(selected.backend, file, profile),
    settings: normalizeSettings({ ...raw.settings, ...(profile === 'default' ? {} : selected.settings) }),
    leaseDir: join(dirname(file), 'droid-leases', ...(profile === 'default' ? [] : [profile])),
  };
}

async function isRegularFile(path) {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

async function cachedModels(snapshot, filename) {
  let revisions;
  try { revisions = await readdir(snapshot); }
  catch { return []; }
  return (await Promise.all(revisions.map(async revision => {
    const candidate = join(snapshot, revision, filename);
    return await isRegularFile(candidate) ? candidate : null;
  }))).filter(Boolean);
}

export async function resolveNativeModel(model) {
  if (!model || !model.endsWith('.gguf')) throw fail('JEV_DROID_MODEL_MISSING');
  if (await isRegularFile(model)) return model;
  const snapshot = dirname(dirname(model));
  if (basename(snapshot) !== 'snapshots' ||
      !basename(dirname(snapshot)).startsWith('models--')) {
    throw fail('JEV_DROID_MODEL_MISSING');
  }
  const paths = await cachedModels(snapshot, basename(model));
  const revisions = new Set(await Promise.all(paths.map(path => realpath(path))));
  if (revisions.size === 0) throw fail('JEV_DROID_MODEL_MISSING');
  if (revisions.size > 1) throw fail('JEV_DROID_MODEL_AMBIGUOUS');
  return paths[0];
}

function nativeServerArgs(backend, endpoint, model) {
  const argv = [
    '--host', '127.0.0.1', '--port', new URL(endpoint).port,
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
  if (backend.load_mode !== undefined) argv.push('--load-mode', backend.load_mode);
  if (backend.no_warmup) argv.push('--no-warmup');
  if (backend.fit !== undefined) argv.push('--fit', backend.fit);
  return argv;
}

export function backendCommand(config, model = config.backend.model) {
  const backend = config.backend;
  if (backend.runtime === 'managed') {
    return [backend.command, [...backend.args, '--port', new URL(config.endpoint).port]];
  }
  if (backend.runtime !== 'native') throw fail('JEV_DROID_RUNTIME_UNSUPPORTED');
  return [backend.llama_bin ?? 'llama-server', nativeServerArgs(backend, config.endpoint, model)];
}
