// Reuse the existing verified LAN harness, selecting only CD trials.
import { readFile } from 'node:fs/promises';
const harness = new URL('../../../scripts/bench-croc-lan.mjs', import.meta.url);
let source = await readFile(harness, 'utf8');
source = source.replace("'./harness.mjs'", JSON.stringify(new URL('../../../scripts/harness.mjs', import.meta.url).href))
  .replace("new URL('./bench-worker.wrangler.jsonc', import.meta.url)", JSON.stringify(new URL('../../../scripts/bench-worker.wrangler.jsonc', import.meta.url).href))
  .replace("const tools = ['cd', 'croc', 'croc-no-compress']", "const tools = ['cd']")
  .replace("['cd','croc','croc-no-compress'].map(tool", "['cd'].map(tool")
  .replace("['croc', 'croc-no-compress'].map(tool", "[].map(tool")
  .replace(/  report\.pass1_5 = .*\n/, '')
  .replace(/  report\.pass2 = .*\n/, '');
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
