import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanExpiredResumeRecords } from './resume-retention.js';

function makeKV(entries = []) {
  const values = new Map(entries);
  return {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async keys() { return [...values.keys()]; },
    values
  };
}

describe('resume retention', () => {
  it('rotates past a large live prefix and removes orphan secrets', async () => {
    const now = 10_000;
    const entries = Array.from({ length: 130 }, (_, i) => [`receiver:${String(i).padStart(3, '0')}`, { expiresAt: now + 1 }]);
    entries.push(['receiver:expired-late', { expiresAt: now - 1 }]);
    const checkpoints = makeKV(entries);
    const secrets = makeKV([['sender:orphan', { expiresAt: now - 1 }]]);
    const removedStages = [];
    const storage = { async getDirectory() { return { async removeEntry(name) { removedStages.push(name); } }; } };

    const firstRemoved = await cleanExpiredResumeRecords({ checkpoints, secrets, storage, now });
    assert.equal(secrets.values.has('sender:orphan'), false);
    assert.equal(checkpoints.values.has('receiver:expired-late'), true);
    assert.equal(firstRemoved, 1);

    await cleanExpiredResumeRecords({ checkpoints, secrets, storage, now });
    await cleanExpiredResumeRecords({ checkpoints, secrets, storage, now });
    assert.equal(checkpoints.values.has('receiver:expired-late'), false);
    assert.equal(checkpoints.values.size, 131); // 130 live records plus the private rotation marker
    assert.deepEqual(removedStages, []);
  });

  it('caps each invocation at the requested batch size and removes expired OPFS stages', async () => {
    let checkpointReads = 0;
    const values = new Map([
      ['receiver:expired', { expiresAt: 1, stagingId: `cd-rx-${'a'.repeat(36)}` }],
      ...Array.from({ length: 40 }, (_, i) => [`receiver:live:${i}`, { expiresAt: 10_000 }])
    ]);
    const checkpoints = {
      async get(key) { checkpointReads++; return values.get(key); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      async delete(key) { values.delete(key); },
      async keys() { return [...values.keys()]; }
    };
    const secrets = makeKV();
    const removedStages = [];
    const storage = { async getDirectory() { return { async removeEntry(name) { removedStages.push(name); } }; } };

    const removed = await cleanExpiredResumeRecords({ checkpoints, secrets, storage, now: 2, max: 2 });
    assert.equal(removed, 1);
    assert.ok(checkpointReads <= 2);
    assert.deepEqual(removedStages, [`cd-rx-${'a'.repeat(36)}`]);
    assert.equal(values.has('receiver:expired'), false);
  });

  it('keeps an unexpired secret while its checkpoint is being created', async () => {
    const now = 10_000;
    const checkpoints = makeKV();
    const secrets = makeKV([['sender:in-progress', { expiresAt: now + 1 }]]);

    const removed = await cleanExpiredResumeRecords({ checkpoints, secrets, storage: {}, now });

    assert.equal(removed, 0);
    assert.equal(secrets.values.has('sender:in-progress'), true);
  });

  it('rotates through more than 128 live secrets to remove a late orphan', async () => {
    const now = 10_000;
    const checkpoints = makeKV(Array.from({ length: 130 }, (_, i) => {
      const key = `sender:${String(i).padStart(3, '0')}`;
      return [key, { expiresAt: now + 1 }];
    }));
    const secrets = makeKV(Array.from({ length: 130 }, (_, i) => {
      const key = `sender:${String(i).padStart(3, '0')}`;
      return [key, { expiresAt: now + 1 }];
    }));
    secrets.values.set('sender:orphan-late', { expiresAt: now - 1 });

    for (let invocation = 0; invocation < 6; invocation++) {
      await cleanExpiredResumeRecords({ checkpoints, secrets, storage: {}, now });
    }

    assert.equal(secrets.values.has('sender:orphan-late'), false);
    assert.equal(secrets.values.size, 130 + 1); // live secrets plus the private rotation marker
  });
});
