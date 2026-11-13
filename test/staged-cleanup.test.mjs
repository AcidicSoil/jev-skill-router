import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = await mkdtemp(join(tmpdir(), 'droid-staged-stop-'));
const before = new Set((await readdir('/dev/shm')).filter(name =>
  name.startsWith('jev-droid-gguf.')));
try {
  const mockDd = join(root, 'dd');
  const gguf = join(root, 'model.gguf');
  await writeFile(gguf, 'staging interruption test');
  await writeFile(mockDd, `#!/bin/bash
for argument in "$@"; do
  if [[ "$argument" == of=* ]]; then output="$(printf "%s" "$argument" | cut -c4-)"; fi
done
printf partial > "$output"
exec /bin/sleep 30
`, { mode: 0o700 });
  const child = spawn('bash', [
    resolve('scripts/serve-systemone.sh'),
    'staged', gguf, '--port', '18993',
  ], {
    env: {
      ...process.env,
      PATH: root + ':' + process.env.PATH,
      JEV_DROID_LEASE_DIR: join(root, 'runtime'),
    },
    stdio: 'ignore',
  });
  let stage;
  try {
    for (let i = 0; i < 120; i++) {
      const created = (await readdir('/dev/shm')).find(name =>
        name.startsWith('jev-droid-gguf.') && !before.has(name));
      if (created) {
        stage = join('/dev/shm', created);
        try {
          if ((await stat(join(stage, 'model.gguf'))).size > 0) break;
        } catch { /* Stage has not begun writing. */ }
      }
      await sleep(50);
    }
    assert(stage, 'runner did not start staging');
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(done => child.once('exit', done)),
      sleep(5000).then(() => { throw new Error('Staging did not stop'); }),
    ]);
    await assert.rejects(stat(stage), { code: 'ENOENT' },
      'a cancelled model stage must not leave a RAM-backed GGUF');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  console.log('Staging cleanup passed: SIGTERM leaves no RAM-backed GGUF.');
} finally {
  await rm(root, { recursive: true, force: true });
}
