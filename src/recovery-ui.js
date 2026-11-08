import { openResumeDatabase, createResumeKV, parseResumeLink, isOpaqueStagingId } from './resume-browser.js';

export function mountBrowserRecovery(container, { onResumeSend, onResumeReceive } = {}) {
  let stopped = false;
  const done = (async () => {
    const db = await openResumeDatabase();
    try {
      const checkpoints = createResumeKV(db, 'checkpoints');
      const secrets = createResumeKV(db, 'secrets');
      for (const key of await checkpoints.keys()) {
        const record = await checkpoints.get(key);
        const secret = await secrets.get(key);
        if (stopped || !record || record.expiresAt <= Date.now() || !secret?.link) continue;
        let parsed;
        try { parsed = parseResumeLink(secret.link); } catch { continue; }
        if (parsed.rootId !== record.rootId || parsed.url.origin !== location.origin) continue;
        const row = document.createElement('div');
        const label = document.createElement('p');
        label.textContent = `${record.filename} · ${record.role === 'sender' ? 'Send' : 'Receive'} saved progress`;
        row.append(label);
        const resume = document.createElement(record.role === 'sender' ? 'input' : 'button');
        if (record.role === 'sender') {
          resume.type = 'file';
          resume.setAttribute('aria-label', `Choose original file for ${record.filename}`);
          resume.addEventListener('change', () => { if (resume.files[0]) onResumeSend?.(resume.files[0], parsed.url.href); });
        } else {
          resume.type = 'button'; resume.textContent = 'Resume receive';
          resume.addEventListener('click', () => onResumeReceive?.(parsed.url.href));
        }
        const discard = document.createElement('button');
        discard.type = 'button'; discard.textContent = 'Discard';
        discard.addEventListener('click', async () => {
          try {
            if (record.role === 'receiver' && isOpaqueStagingId(record.stagingId)) {
              const directory = await navigator.storage.getDirectory();
              try { await directory.removeEntry(record.stagingId); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
            }
            await checkpoints.delete(key); await secrets.delete(key); row.remove();
          } catch { label.textContent = 'Could not discard saved progress. Try again.'; }
        });
        row.append(resume, discard);
        if (!stopped) container.append(row);
      }
      // Event handlers retain the database until the mounted panel stops.
      return db;
    } catch (error) { db.close(); throw error; }
  })();
  return { done, stop() { stopped = true; void done.then((db) => db.close(), () => {}); } };
}
