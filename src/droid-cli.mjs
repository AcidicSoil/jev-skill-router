import { readCatalog, eligibleSkills } from './router.mjs';
import { loadDroidConfig, runDroidEvent, serveNative } from './local-droid.mjs';

const usage = `jev-droid — local Droid-Q skill routing

Usage:
  jev-droid list              List eligible Codex skills without loading a model
  jev-droid "task description" Recommend skills using the configured local model
  jev-droid serve             Serve the configured local GGUF with idle unload
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

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(usage + '\n');
    return;
  }
  if (args.length > 1) throw new Error('JEV_DROID_ARGUMENT_INVALID');
  const config = await loadDroidConfig();
  if (args[0] === 'serve') {
    process.exitCode = await serveNative(config);
    return;
  }
  if (args[0] === 'list') {
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
    return;
  }
  if (args.length && !args[0].trim()) throw new Error('JEV_DROID_ARGUMENT_INVALID');
  const input = args.length
    ? { hook_event_name: 'UserPromptSubmit', cwd: process.cwd(), prompt: args[0] }
    : await readEvent();
  if (input?.hook_event_name !== 'UserPromptSubmit') {
    process.stdout.write('{}\n');
    return;
  }
  const result = await runDroidEvent(input, config);
  process.stdout.write(JSON.stringify(result) + '\n');
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
