import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveNative } from '../src/local-droid.mjs';

async function unusedPort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

async function waitForHealth(endpoint) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(endpoint + '/health', {
        signal: AbortSignal.timeout(300),
      });
      if (response.ok) return;
    } catch { /* The model is still starting. */ }
    await sleep(50);
  }
  throw new Error('Test backend never became healthy');
}

const root = await mkdtemp(join(tmpdir(), 'droid-active-request-'));
try {
  const backend = join(root, 'backend.mjs');
  const model = join(root, 'model.gguf');
  await writeFile(model, 'model fixture');
  await writeFile(backend, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/v1/systemone') {
    await sleep(2200);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
});
setTimeout(() => server.listen(port, '127.0.0.1'),
  Number(process.env.JEV_TEST_WARMUP_MS || 0));
process.on('SIGTERM', () => process.exit(0));
`, { mode: 0o700 });

  for (const [runtime, warmup] of [['native', 0], ['managed', 2200]]) {
    const endpoint = 'http://127.0.0.1:' + await unusedPort();
    const profileBackend = runtime === 'native'
      ? { runtime, model, llama_bin: backend }
      : { runtime, command: backend, args: [] };
    const config = {
      endpoint, profile: runtime,
      backend: {
        ...profileBackend,
        env: { JEV_TEST_WARMUP_MS: String(warmup) },
        idle_timeout_seconds: 1, startup_timeout_seconds: 10,
      },
      leaseDir: join(root, runtime, 'leases'),
    };
    const owner = serveNative(config);
    try {
      await waitForHealth(endpoint);
      const inference = () => fetch(endpoint + '/v1/systemone', {
        method: 'POST', body: '{}', signal: AbortSignal.timeout(8000),
      });
      const first = inference();
      await sleep(350);
      const responses = await Promise.all([first, inference()]);
      for (const response of responses) {
        assert.equal(response.status, 200,
          'overlapping inference must survive idle expiration: ' + runtime);
        assert.deepEqual(await response.json(), { ok: true });
      }
      const finished = Date.now();
      const exitCode = await Promise.race([
        owner,
        sleep(8000).then(() => { throw new Error('Model did not unload: ' + runtime); }),
      ]);
      assert.equal(exitCode, 0);
      assert(Date.now() - finished >= 900,
        'idle timer must begin after the response: ' + runtime);
    } finally {
      await owner;
    }
  }
  console.log('Model lifecycle passed: native/managed warmup, active inference and idle unload.');
} finally {
  await rm(root, { recursive: true, force: true });
}
