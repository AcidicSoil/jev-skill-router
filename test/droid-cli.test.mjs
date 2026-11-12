import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'jev-droid-cli-test-'));
try {
  const configPath = join(root, 'droid.json');
  const skillFile = join(root, 'skills', 'my-skill', 'SKILL.md');
  await mkdir(join(root, 'skills', 'my-skill'), { recursive: true });
  await writeFile(skillFile, 'test skill');
  const codex = join(root, 'fake-codex');
  await writeFile(codex, `#!/usr/bin/env node
const { createInterface } = require('node:readline');
createInterface({input:process.stdin}).on('line', line => {
  const message=JSON.parse(line);
  if(message.id===1) console.log(JSON.stringify({id:1,result:{}}));
  if(message.id===2) console.log(JSON.stringify({id:2,result:{data:[
    {cwd:process.cwd(),skills:[{name:'my-skill',enabled:true,path:${JSON.stringify(skillFile)},
      description:'Test the project'}],errors:[]}
  ]}}));
});`, { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({
    schema: 1, endpoint: 'http://127.0.0.1:18774',
    backend: { runtime: 'native', model: '/missing/model.gguf', auto_start: false },
    settings: { threshold: 0.9, maxSkills: 10, timeoutMs: 60000,
      codexBin: codex, dashboardAutoStart: false },
  }));
  const env = { ...process.env, JEV_DROID_CONFIG: configPath };
  const cmd = resolve('src/droid-cli.mjs');
  const help = await run(process.execPath, [cmd, '--help'], { cwd: root, env });
  assert.match(help.stdout, /jev-droid/);
  assert.match(help.stdout, /serve/);
  const bundled = await run(resolve('bin/jev-droid'), ['--help'], { cwd: root, env });
  assert.match(bundled.stdout, /jev-droid — local Droid-Q skill routing/);
  assert(!bundled.stdout.includes('systemMessage'), 'Droid CLI must not execute the imported plugin bootstrap');
  assert.equal(bundled.stderr, '');
  const listed = await run(process.execPath, [cmd, 'list'], { cwd: root, env });
  const output = JSON.parse(listed.stdout);
  assert.equal(output.candidateCount, 1);
  assert.equal(output.skills[0].name, 'my-skill');
  const ignored = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [cmd], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done(stdout) : reject(new Error(stderr)));
    child.stdin.end('{"hook_event_name":"Stop"}');
  });
  assert.equal(ignored.trim(), '{}');
  console.log('Droid CLI passed: help, metadata-only list, inert non-routing hook event.');
} finally {
  await rm(root, { recursive: true, force: true });
}
