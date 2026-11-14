import { startRelaySend } from './relay-sender.js';
import { startResumableSend, openResumeDatabase, createResumeKV, isRetryableResumeError } from './resume-browser.js';

export function startBrowserSend(source, hooks = {}, { sharing = 'private', resumable = false, resumeLink = '' } = {}) {
  if (!['private', 'code'].includes(sharing)) throw new Error('Choose private link or short code sharing.');
  if (!resumable) return startRelaySend(source, hooks, { sharing: sharing === 'code' ? 'numeric' : 'private' });
  if (!(source instanceof File)) throw new Error('Choose the original file to send with resume enabled.');
  let active, timer, wakeRetry, cancelled = false, finished = false;
  let link = resumeLink;
  const done = (async () => {
    const db = await openResumeDatabase();
    try {
      for (let retries = 0; ; retries++) {
        if (cancelled) throw new Error('Transfer canceled.');
        hooks.onState?.('connecting');
        active = startResumableSend(source, {
          link, checkpoints: createResumeKV(db, 'checkpoints'), secrets: createResumeKV(db, 'secrets'),
          hooks: {
            ...hooks, onError() {},
            onShare(value) { link = value.url; hooks.onShare?.(value); hooks.onState?.('waiting'); hooks.onStatus?.('Waiting for the receiver. Keep this tab open; saved progress lasts up to 24 hours.'); },
            onProgress(done, total, ...args) { hooks.onState?.(done >= total ? 'verifying' : 'transferring'); hooks.onStatus?.(done >= total ? 'Verifying receipt on the other device…' : 'Sending with saved progress…'); hooks.onProgress?.(done, total, ...args); },
            onComplete() { hooks.onState?.('complete'); hooks.onComplete?.(); }
          }
        });
        try { return await active.done; }
        catch (error) {
          if (cancelled || !link || !isRetryableResumeError(error) || retries >= 3) throw error;
          hooks.onStatus?.('Connection interrupted. Reconnecting with saved progress…');
          await new Promise(resolve => { wakeRetry = resolve; timer = setTimeout(resolve, 1000 * 2 ** retries); });
        }
      }
    } finally {
      clearTimeout(timer);
      try { if (cancelled) await active?.cancel(); }
      finally { finished = true; db.close(); }
    }
  })();
  let cancelPromise;
  return { done, cancel() {
    cancelled = true;
    clearTimeout(timer);
    if (!finished) active?.cancel().catch(() => {});
    wakeRetry?.();
    cancelPromise ||= done.catch(() => {});
    return cancelPromise;
  } };
}
