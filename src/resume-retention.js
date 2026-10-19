const MAX_CHECKPOINTS_PER_CLEANUP = 128;
const CURSOR_KEY = '\u0000cd-resume-cleanup-cursor-v1';

function boundedLimit(value) {
  if (!Number.isFinite(value)) return MAX_CHECKPOINTS_PER_CLEANUP;
  return Math.max(0, Math.min(MAX_CHECKPOINTS_PER_CLEANUP, Math.floor(value)));
}

async function readKeysFromCursor(store) {
  const keys = (await store.keys()).filter((key) => key !== CURSOR_KEY);
  const saved = await store.get(CURSOR_KEY);
  const start = Number.isSafeInteger(saved?.offset) && saved.offset >= 0 ? saved.offset % Math.max(keys.length, 1) : 0;
  return { keys, start };
}

async function advanceCursor(store, keys, start, count) {
  if (keys.length) await store.put(CURSOR_KEY, { offset: (start + count) % keys.length });
}

async function removeExpiredStage(checkpoint, storage) {
  if (!checkpoint.stagingId || typeof checkpoint.stagingId !== 'string' || !/^cd-rx-[0-9a-f-]{36}$/.test(checkpoint.stagingId)) return;
  try { await (await storage.getDirectory()).removeEntry(checkpoint.stagingId); }
  catch (error) { if (error?.name !== 'NotFoundError') throw error; }
}

/**
 * Clean a rotating, bounded slice of resume storage. The cursor is stored in
 * each backing store so repeated page loads continue through large stores.
 * `keys()` is the existing resume KV interface; only the selected slice is
 * read or mutated here.
 */
export async function cleanExpiredResumeRecords({ checkpoints, secrets, storage, now = Date.now(), max = MAX_CHECKPOINTS_PER_CLEANUP }) {
  const limit = boundedLimit(max);
  if (!limit) return 0;
  // Split the inspection budget so a large checkpoint store cannot prevent
  // secret cleanup from making progress (or vice versa).
  const checkpointBudget = Math.ceil(limit / 2);
  const secretBudget = Math.floor(limit / 2);
  let removed = 0;

  const checkpointScan = await readKeysFromCursor(checkpoints);
  const checkpointCount = Math.min(checkpointBudget, checkpointScan.keys.length);
  for (let step = 0; step < checkpointCount; step++) {
    const key = checkpointScan.keys[(checkpointScan.start + step) % checkpointScan.keys.length];
    const checkpoint = await checkpoints.get(key);
    if (!checkpoint || !(checkpoint.expiresAt <= now)) continue;
    // A failed deletion must retain the only pointer to the plaintext stage.
    // Continue this bounded sweep so one locked file cannot starve the rest.
    try { await removeExpiredStage(checkpoint, storage); } catch { continue; }
    await checkpoints.delete(key);
    await secrets.delete(key);
    removed++;
  }
  await advanceCursor(checkpoints, checkpointScan.keys, checkpointScan.start, checkpointCount);

  if (secretBudget) {
    const secretScan = await readKeysFromCursor(secrets);
    const secretCount = Math.min(secretBudget, secretScan.keys.length);
    for (let step = 0; step < secretCount; step++) {
      const key = secretScan.keys[(secretScan.start + step) % secretScan.keys.length];
      const secret = await secrets.get(key);
      if (!secret) continue;
      const checkpoint = await checkpoints.get(key);
      if (secret.expiresAt <= now || (checkpoint && checkpoint.expiresAt <= now)) {
        await secrets.delete(key);
        removed++;
      }
    }
    await advanceCursor(secrets, secretScan.keys, secretScan.start, secretCount);
  }
  return removed;
}
