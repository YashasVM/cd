import { createHash } from 'node:crypto';

// Independent reproducible Fisher-Yates permutations, unrelated to timings.
export function trialOrder(tools, seed, block) {
  const result = [...tools];
  let counter = 0;
  for (let i = result.length - 1; i > 0; i--) {
    const range = i + 1, limit = Math.floor(0x100000000 / range) * range;
    let value;
    do {
      value = createHash('sha256').update(JSON.stringify([seed, block, counter++])).digest().readUInt32BE(0);
    } while (value >= limit);
    const j = value % range;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
