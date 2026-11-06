import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const install = process.argv[2];
assert(install, 'Usage: node benchmark-checkers.mjs /tmp/isolated-install');
const root = process.cwd();
const tools = [
  ['typescript', path.join(root, 'node_modules/.bin/tsc')],
  ['tsc-rs', path.join(install, 'node_modules/.bin/tsc-rs')],
  ['tsrs', path.join(install, 'node_modules/.bin/tsrs')],
];
const result = { root, versions: {}, samples: [], diagnostics: {} };
function run(executable, args) {
  const start = process.hrtime.bigint();
  const child = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
  if (child.error) throw child.error;
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, status: child.status, stdout: child.stdout, stderr: child.stderr };
}
for (const [name, executable] of tools) {
  result.versions[name] = run(executable, ['--version']).stdout.trim();
  const warmup = run(executable, ['--pretty', 'false']);
  assert.equal(warmup.status, 0, `${name}: ${warmup.stdout}${warmup.stderr}`);
}
for (let round = 0; round < 9; round++) {
  const order = tools.slice(round % tools.length).concat(tools.slice(0, round % tools.length));
  for (const [name, executable] of order) {
    const trial = run(executable, ['--pretty', 'false']);
    assert.equal(trial.status, 0, `${name}: ${trial.stdout}${trial.stderr}`);
    result.samples.push({ round, name, ...trial });
  }
}
const fixture = mkdtempSync(path.join(tmpdir(), 'cd-checker-diagnostics-'));
try {
  writeFileSync(path.join(fixture, 'bad.ts'), 'const invalid: number = "wrong";\nconst missing: { required: string } = {};\nexport { invalid, missing };\n');
  writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true }, files: ['bad.ts'] }));
  for (const [name, executable] of tools) {
    const checked = run(executable, ['--pretty', 'false', '-p', path.join(fixture, 'tsconfig.json')]);
    assert.notEqual(checked.status, 0, `${name} did not reject invalid fixture`);
    const codes = [...checked.stdout.matchAll(/error TS(\d+):/g)].map(match => Number(match[1])).sort();
    assert.deepEqual(codes, [2322, 2741], `${name}: diagnostics changed`);
    result.diagnostics[name] = checked;
  }
} finally { rmSync(fixture, { recursive: true, force: true }); }
const median = values => values.slice().sort((a,b) => a-b)[Math.floor(values.length/2)];
result.summary = Object.fromEntries(tools.map(([name]) => {
  const times = result.samples.filter(sample => sample.name === name).map(sample => sample.ms);
  return [name, { medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times) }];
}));
console.log(JSON.stringify(result, null, 2));
