import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../skills/cd-file-sharing/source.md', import.meta.url);
const destinations = [
  new URL('../skills/cd-file-sharing/SKILL.md', import.meta.url),
  new URL('../cmd/cdx/agentskill/SKILL.md', import.meta.url),
];
const check = process.argv.includes('--check');
const content = await readFile(source, 'utf8');
for (const destination of destinations) {
  if (check) {
    const actual = await readFile(destination, 'utf8');
    if (actual !== content) {
      throw new Error(`${destination.pathname} is stale; run node scripts/generate-sharing-skill.mjs`);
    }
  } else {
    await writeFile(destination, content);
  }
}
