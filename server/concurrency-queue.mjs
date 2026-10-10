import { AsyncLocalStorage } from 'node:async_hooks';

// Shared by every browser authorization entry point, rather than per HTTP job.
// Capture the submitter's async context so a queued account keeps its proxy
// binding even when another account's completion drains this queue.
export function createConcurrencyQueue(getLimit) {
  let active = 0;
  const pending = [];
  const drain = () => {
    const limit = getLimit();
    while (active < limit && pending.length) {
      const { operation, context, resolve, reject } = pending.shift();
      active += 1;
      Promise.resolve().then(() => context(operation)).then(resolve, reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return {
    run(operation) {
      const context = AsyncLocalStorage.snapshot();
      return new Promise((resolve, reject) => {
        pending.push({ operation, context, resolve, reject });
        drain();
      });
    },
  };
}
