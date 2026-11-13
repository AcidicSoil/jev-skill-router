import { readCatalog, eligibleSkills } from './router.mjs';
import { basename } from 'node:path';
import { listDroidProfiles, loadDroidConfig, resolveNativeModel, runDroidEvent, serveNative } from './local-droid.mjs';
import { selectDroidProfile } from './droid-config.mjs';

const usage = `jev-droid — local Droid-Q skill routing

Usage:
  jev-droid models            List configured model profiles without loading models
  jev-droid list              List eligible Codex skills without loading a model
  jev-droid "task description" Recommend skills using the active model
  jev-droid NAME "task description"          Route this query through NAME
  jev-droid NAME                             Select NAME for future queries and hooks
  jev-droid --model NAME "task description"  Explicit one-query model override
  jev-droid --model NAME serve               Serve its local GGUF with idle unload
  jev-droid serve             Serve the default local GGUF with idle unload
  jev-droid --help            Show this help

Without arguments, reads a Codex UserPromptSubmit hook event on stdin.
Config: ~/.config/jev-skill-router/droid.json (override: JEV_DROID_CONFIG)`;

async function readEvent() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('JEV_DROID_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseNamedCommand(args) {
  if (args.length !== 3 || !args[1]?.trim() || args[2] === 'models') {
    throw new Error('JEV_DROID_ARGUMENT_INVALID');
  }
  return { action: args[2], profile: args[1] };
}

async function parseCommand(args) {
  if (args[0] === '--model') return parseNamedCommand(args);
  if (args.length > 1) {
    if (!(await listDroidProfiles()).includes(args[0])) {
      throw new Error('JEV_DROID_ARGUMENT_INVALID');
    }
    return { action: args.slice(1).join(' '), profile: args[0] };
  }
  const action = args[0];
  if (action && !['models', 'list', 'serve'].includes(action) &&
      (await listDroidProfiles()).includes(action)) {
    return { action: 'select', profile: action };
  }
  return { action, profile: undefined };
}

async function printProfiles() {
  const names = await listDroidProfiles();
  const active = (await loadDroidConfig()).profile;
  const profiles = await Promise.all(names.map(async name => {
    const config = await loadDroidConfig(undefined, name);
    const modelPath = config.backend.runtime === 'native' ? config.backend.model :
      config.backend.runtime === 'managed' && config.backend.args[0] === 'staged'
        ? config.backend.args[1] : null;
    let modelPresent = null;
    if (modelPath) {
      try { await resolveNativeModel(modelPath); modelPresent = true; }
      catch { modelPresent = false; }
    }
    return {
      name, active: name === active, runtime: config.backend.runtime, endpoint: config.endpoint,
      model: modelPath ? basename(modelPath) : config.backend.model_id ?? null,
      modelPresent, autoStart: !!config.backend.auto_start,
    };
  }));
  process.stdout.write(JSON.stringify({ profiles }) + '\n');
}

async function printSkills(config) {
  const catalog = await readCatalog(process.cwd(), {
    codexBin: config.settings.codexBin,
    signal: AbortSignal.timeout(config.settings.timeoutMs),
  });
  const skills = await eligibleSkills(catalog);
  process.stdout.write(JSON.stringify({
    apiKeyConfigured: true,
    catalogCount: catalog.skills.length,
    candidateCount: skills.length,
    catalogErrors: catalog.errors?.length ?? 0,
    skills: skills.map(({ name, path }) => ({ name, path })),
  }) + '\n');
}

async function routeCommand(action, config) {
  if (action !== undefined && !action.trim()) throw new Error('JEV_DROID_ARGUMENT_INVALID');
  const input = action === undefined
    ? await readEvent()
    : { hook_event_name: 'UserPromptSubmit', cwd: process.cwd(), prompt: action };
  if (input?.hook_event_name !== 'UserPromptSubmit') {
    process.stdout.write('{}\n');
    return;
  }
  const result = await runDroidEvent(input, config);
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function runConfiguredCommand(action, profile) {
  if (action === 'select') {
    await selectDroidProfile(profile);
    process.stdout.write('Selected model profile: ' + profile + '\n');
    return;
  }
  // The systemd backend unit always serves the root profile.
  const config = await loadDroidConfig(undefined,
    action === 'serve' && !profile ? 'default' : profile);
  if (action === 'list') return printSkills(config);
  if (action === 'serve') {
    process.exitCode = await serveNative(config);
    return;
  }
  return routeCommand(action, config);
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(usage + '\n');
    return;
  }
  const { action, profile } = await parseCommand(args);
  if (action === 'models') return printProfiles();
  return runConfiguredCommand(action, profile);
}

const hookMode = process.argv.length === 2;
main(process.argv.slice(2)).catch(error => {
  const code = /^JEV_[A-Z0-9_]+$/.test(error?.code ?? error?.message) ?
    error.code ?? error.message : 'JEV_DROID_UNAVAILABLE';
  if (hookMode) {
    process.stdout.write(JSON.stringify({
      systemMessage: `Local Droid skill router unavailable (${code}); normal Codex routing remains active.`,
    }) + '\n');
  } else {
    process.stderr.write(`jev-droid: ${code}\n`);
    process.exitCode = 2;
  }
});
