// One active transfer keeps the screen awake and suspends decorative motion.
// A sender and receiver may overlap, so each caller gets its own stop handle.
export function createTransferActivity(host) {
  let active = 0;
  let lock = null;
  let requesting = null;
  let retryAfterVisibility = false;
  const listeners = new Set();

  function release() {
    const held = lock;
    lock = null;
    if (held) void Promise.resolve().then(() => held.release()).catch(() => {});
  }

  function acquire() {
    if (!active || host.document?.hidden || lock || requesting || typeof host.navigator?.wakeLock?.request !== 'function') return;
    requesting = Promise.resolve()
      .then(() => host.navigator.wakeLock.request('screen'))
      .then((held) => {
        if (!active || host.document?.hidden) {
          void Promise.resolve().then(() => held.release()).catch(() => {});
        } else {
          lock = held;
        }
      })
      .catch(() => {})
      .finally(() => {
        requesting = null;
        if (retryAfterVisibility) {
          retryAfterVisibility = false;
          acquire();
        }
      });
  }

  host.document?.addEventListener('visibilitychange', () => {
    if (host.document.hidden) {
      retryAfterVisibility = false;
      release();
    } else if (requesting) {
      retryAfterVisibility = true;
    } else acquire();
  });

  return {
    beginTransfer() {
      active += 1;
      if (active === 1) for (const listener of listeners) listener(true);
      acquire();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        active -= 1;
        if (active === 0) {
          release();
          for (const listener of listeners) listener(false);
        }
      };
    },
    onActivityChange(listener) {
      listeners.add(listener);
      listener(active > 0);
      return () => listeners.delete(listener);
    }
  };
}

export const { beginTransfer, onActivityChange } = createTransferActivity(globalThis);
