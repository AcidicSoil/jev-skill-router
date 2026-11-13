import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
  const gateway = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'other' }, { id: 'selected' }] }));
      return;
    }
    if (request.url === '/v1/systemone' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const decision = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(decision.model, 'selected');
      response.end(JSON.stringify({
        model: 'selected',
        answers: Object.fromEntries(Object.keys(decision.questions).map(id =>
          [id, { type: 'noul', noul: 0.99 }])),
      }));
      return;
    }
    response.writeHead(404).end('{}');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${gateway.address().port}`;
    const stagedModel = join(root, 'clef.gguf');
    await writeFile(stagedModel, 'GGUF fixture');
    await writeFile(configPath, JSON.stringify({
      schema: 1, endpoint: 'http://127.0.0.1:18774',
      backend: { runtime: 'native', model: '/missing/model.gguf', auto_start: false },
      settings: { threshold: 0.9, maxSkills: 10, timeoutMs: 10000,
        codexBin: codex, recordSelections: false },
      profiles: {
        remote: { endpoint,
          backend: { runtime: 'gateway', model_id: 'selected', auto_start: false } },
        clef: { endpoint: 'http://127.0.0.1:18775',
          backend: { runtime: 'managed', command: '/bin/echo',
            args: ['staged', stagedModel], auto_start: true } },
      },
    }));
    const profiles = JSON.parse((await run(process.execPath, [cmd, 'models'], { cwd: root, env })).stdout);
    assert.deepEqual(profiles.profiles.map(profile => profile.name), ['default', 'remote', 'clef']);
    assert.equal(profiles.profiles[0].modelPresent, false);
    assert.equal(profiles.profiles[2].model, 'clef.gguf');
    assert.equal(profiles.profiles[2].modelPresent, true);
    const oneShot = await run(process.execPath,
      [cmd, 'remote', 'Test the project'], { cwd: root, env });
    assert.match(JSON.parse(oneShot.stdout).hookSpecificOutput.additionalContext, /my-skill/);
    const unmodified = JSON.parse((await run(process.execPath,
      [cmd, 'models'], { cwd: root, env })).stdout);
    assert.equal(unmodified.profiles.find(profile => profile.name === 'default').active, true);
    const naturalWords = await run(process.execPath,
      [cmd, 'remote', 'Test', 'the', 'project'], { cwd: root, env });
    assert.match(JSON.parse(naturalWords.stdout).hookSpecificOutput.additionalContext, /my-skill/);
    const shorthand = await run(process.execPath, [cmd, 'remote'], { cwd: root, env });
    assert.match(shorthand.stdout, /selected.*remote/i);
    const active = JSON.parse((await run(process.execPath, [cmd, 'models'], { cwd: root, env })).stdout);
    assert.equal(active.profiles.find(profile => profile.name === 'remote').active, true);
    const explicitServe = await run(process.execPath,
      [cmd, '--model', 'clef', 'serve'], { cwd: root, env });
    assert.match(explicitServe.stdout, /^staged .*clef[.]gguf --port [0-9]+/);
    const selectedWithoutFlag = await run(process.execPath,
      [cmd, 'Test the project'], { cwd: root, env });
    assert.match(JSON.parse(selectedWithoutFlag.stdout).hookSpecificOutput.additionalContext, /my-skill/);
    const named = await run(process.execPath,
      [cmd, '--model', 'remote', 'Test the project'], { cwd: root, env });
    const selected = JSON.parse(named.stdout);
    assert.match(selected.hookSpecificOutput.additionalContext, /my-skill/);
    const envSelected = await run(process.execPath, [cmd, 'Test the project'],
      { cwd: root, env: { ...env, JEV_DROID_PROFILE: 'remote' } });
    assert.match(JSON.parse(envSelected.stdout).hookSpecificOutput.additionalContext, /my-skill/);
    const singleWordTask = await run(process.execPath, [cmd, 'Test'],
      { cwd: root, env: { ...env, JEV_DROID_PROFILE: 'remote' } });
    assert.match(JSON.parse(singleWordTask.stdout).hookSpecificOutput.additionalContext, /my-skill/);
    const hooked = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [cmd], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? done(stdout) : reject(new Error(stderr)));
      child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit',
        cwd: root, prompt: 'Test the project' }));
    });
    assert.match(JSON.parse(hooked).hookSpecificOutput.additionalContext, /my-skill/);
    const reset = await run(process.execPath, [cmd, 'default'], { cwd: root, env });
    assert.match(reset.stdout, /default/);
    const afterReset = JSON.parse((await run(process.execPath, [cmd, 'models'], { cwd: root, env })).stdout);
    assert.equal(afterReset.profiles.find(profile => profile.name === 'default').active, true);
    await assert.rejects(run(process.execPath,
      [cmd, '--model', 'missing', 'Test the project'], { cwd: root, env }),
      /JEV_DROID_PROFILE_UNKNOWN/);
  } finally {
    await new Promise(resolve => gateway.close(resolve));
  }
  console.log('Droid CLI passed: help, metadata-only list, inert non-routing hook event.');
} finally {
  await rm(root, { recursive: true, force: true });
}
