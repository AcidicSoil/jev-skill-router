import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'inline',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
};

for (const [entry, output] of [
  ['router-cli', 'router'],
  ['droid-cli', 'jev-droid'],
]) {
  await build({
    ...common,
    entryPoints: [`src/${entry}.mjs`],
    outfile: `plugins/jev-skill-router/scripts/${output}.mjs`,
  });
}
