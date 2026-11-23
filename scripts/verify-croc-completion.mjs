// A green checksum benchmark is not automatically a green speed claim.
import { readFile } from 'node:fs/promises';
import { completionGates, summarize } from './bench-croc-matrix.mjs';

const minimum = Number(process.argv[3] || 1.5);
if (!process.argv[2] || ![1.5, 2].includes(minimum)) throw new Error('usage: node scripts/verify-croc-completion.mjs report.json [1.5|2]');
const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
const gates = completionGates(report);
const ok = minimum === 2 ? gates.completionPass2 : gates.completionPass1_5;
let failedCells;
try {
  failedCells = summarize(report.rows, report.options.runs).filter(cell => !(minimum === 2 ? cell.completionPass2 : cell.completionPass1_5))
    .map(cell => ({ case: cell.case, speedup: cell.speedup, repetitionsComplete: Object.values(cell.tools).every(tool => tool.complete) }));
} catch { failedCells = [{ error: 'invalid trial rows' }]; }
console.log(JSON.stringify({ ok, minimum, ...gates, failedCells,
  scope: 'Receiver, fsynced completion and total elapsed time against both croc configurations, in every configured cell, with at least five repetitions. Invitation-display timing is retained separately. This is not a worldwide claim.' }, null, 2));
if (!ok) process.exitCode = 1;
