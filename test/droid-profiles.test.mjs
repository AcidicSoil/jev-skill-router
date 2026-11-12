import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { makeBatches } from '../src/router.mjs';
import { join } from 'node:path';
import {
  backendCommand, ensureDecisionBackend, listDroidProfiles, loadDroidConfig, probeDecision,
} from '../src/local-droid.mjs';

const root = await mkdtemp(join(tmpdir(), 'jev-droid-profiles-'));
try {
  const file = join(root, 'droid.json');
  const config = {
    schema: 1,
    endpoint: 'http://127.0.0.1:8774',
    backend: { runtime: 'native', model: join(root, 'default.gguf'), auto_start: true },
    settings: { timeoutMs: 1000, recordSelections: false },
    profiles: {
      julia: {
        endpoint: 'http://127.0.0.1:8875',
        backend: { runtime: 'native', model: join(root, 'julia.gguf'), auto_start: true },
      },
      hosted: {
        endpoint: 'http://127.0.0.1:8876',
        backend: { runtime: 'gateway', model_id: 'model-b', auto_start: false },
      },
      intern: {
        endpoint: 'http://127.0.0.1:8877',
        backend: {
          runtime: 'managed', command: '/bin/echo',
          args: ['--model', 'intern'], auto_start: true,
          model_id: 'intern-decision-4b', idle_timeout_seconds: 60,
          load_mode: 'none', no_warmup: true,
        },
      },
    },
  };
  await writeFile(file, JSON.stringify(config));
  assert.deepEqual(await listDroidProfiles(file), ['default', 'julia', 'hosted', 'intern']);
  const standard = await loadDroidConfig(file);
  assert.equal(standard.profile, 'default');
  assert.equal(standard.endpoint, config.endpoint);
  assert.equal(standard.leaseDir, join(root, 'droid-leases'));
  const alternate = await loadDroidConfig(file, 'julia');
  assert.equal(alternate.endpoint, config.profiles.julia.endpoint);
  assert.equal(alternate.backend.start, 'process');
  assert.equal(alternate.leaseDir, join(root, 'droid-leases', 'julia'));
  const gateway = await loadDroidConfig(file, 'hosted');
  assert.equal(gateway.backend.model_id, 'model-b');
  assert.equal(gateway.backend.runtime, 'gateway');
  const intern = await loadDroidConfig(file, 'intern');
  assert.equal(intern.backend.runtime, 'managed');
  assert.deepEqual(backendCommand(intern), ['/bin/echo',
    ['--model', 'intern', '--port', '8877']]);
  const nativeWithLoadMode = {
    ...standard, backend: { ...standard.backend, load_mode: 'none', no_warmup: true, fit: 'off' },
  };
  assert(backendCommand(nativeWithLoadMode, 'test.gguf')[1].includes('--load-mode'));
  assert(backendCommand(nativeWithLoadMode, 'test.gguf')[1].includes('--no-warmup'));
  assert(backendCommand(nativeWithLoadMode, 'test.gguf')[1].includes('--fit'));

  await assert.rejects(loadDroidConfig(file, 'missing'), /JEV_DROID_PROFILE_UNKNOWN/);


  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push(new URL(url).pathname);
    if (url.endsWith('/v1/models')) return Response.json({
      data: [{ id: 'model-a' }, { id: 'model-b' }],
    });
    if (url.endsWith('/v1/systemone')) {
      assert.equal(JSON.parse(options.body).model, 'model-b');
      return Response.json({ model: 'model-b', answers: {
        probe: { type: 'noul', noul: 0.7 },
      } });
    }
    throw new Error('Gateway must not require a /health route');
  };
  assert.equal(await probeDecision(gateway, fakeFetch), 'model-b');
  assert.equal(await ensureDecisionBackend(gateway, fakeFetch), 'model-b');
  assert(!calls.includes('/health'));
  const noModels = async (url, options) => url.endsWith('/v1/models')
    ? new Response('{}', { status: 404 })
    : Response.json({ model: 'intern-decision-4b', answers: {
      probe: { type: 'noul', noul: 0.71 },
    } });
  assert.equal(await probeDecision(intern, noModels), 'intern-decision-4b');

  const substituted = async (url, options) => url.endsWith('/v1/systemone') ?
    Response.json({ model: 'model-a',
      answers: { probe: { type: 'noul', noul: 0.7 } } }) : fakeFetch(url, options);
  await assert.rejects(probeDecision(gateway, substituted), /JEV_DROID_DECISION_INVALID/);


  const ambiguous = { ...gateway, backend: { ...gateway.backend, model_id: undefined } };
  await assert.rejects(probeDecision(ambiguous, fakeFetch), /JEV_DROID_DECISION_INVALID/);
  const descriptions = Array.from({ length: 80 }, (_, index) => ({
    name: 'skill-' + index,
    description: 'Reason about the current software request safely. '.repeat(3),
  }));
  const batches = makeBatches('Review the project', descriptions, 'model-b', 5000);
  assert(batches.length > 1);
  assert(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 5000));
  assert.equal(batches.reduce((sum, batch) => sum + Object.keys(batch.questions).length, 0),
    descriptions.length);
  console.log('Droid model profiles: selection, native start ownership, gateway routing, multi-model probe.');
} finally {
  await rm(root, { recursive: true, force: true });
}
