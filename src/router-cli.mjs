import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main, fallback } from './router.mjs';

export * from './router.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    if (process.argv.length > 2) process.exitCode = 1;
    return fallback(error);
  }).then(output => {
    if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`);
  });
}
