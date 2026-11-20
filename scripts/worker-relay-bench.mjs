import { loadTransferRoom, relayFixture } from './worker-relay-harness.mjs';

// Compare handler CPU/host-call overhead, NOT network or product throughput.
// Pass the original worker/index.ts as argv[2] for reproducible A/B results.
const frames = Number(process.env.CD_RELAY_BENCH_FRAMES ?? 100_000);
if (!Number.isSafeInteger(frames) || frames < 1000) throw new Error('CD_RELAY_BENCH_FRAMES must be >= 1000');
const variants = [['candidate', undefined], ...(process.argv[2] ? [['baseline', process.argv[2]]] : [])];
const results = await Promise.all(variants.map(async ([name, source]) => ({ name, Room: await loadTransferRoom(source), trials: [] })));
for (let run = 0; run < 5; run++) {
  // Alternate order to reduce drift from warmup and unrelated host activity.
  for (const result of run % 2 ? [...results].reverse() : results) {
    const { Room } = result;
    const { room, sender, receiver, counts } = await relayFixture(Room);
    sender.retain = receiver.retain = false;
    const record = new ArrayBuffer(256 * 1024);
    for (let i = 0; i < 1000; i++) await room.webSocketMessage(sender, record);
    counts.reads = counts.scans = counts.forwarded = 0;
    const started = performance.now();
    for (let i = 0; i < frames; i++) await room.webSocketMessage(sender, record);
    result.trials.push({ elapsedMs: performance.now() - started, ...counts });
  }
}
console.log(JSON.stringify({ scope: 'Node handler microbenchmark; mocked host APIs; no network throughput claim', frames, node: process.version,
  results: results.map(({ name, trials }) => ({ name, trials, medianMs: trials.map(t => t.elapsedMs).sort((a,b) => a-b)[2] })) }, null, 2));
