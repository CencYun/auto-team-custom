import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { createConcurrencyQueue } from './concurrency-queue.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

for (const limit of [1, 3]) {
  test(`a shared browser queue permits ${limit} operations and starts the next only after completion`, async () => {
    const queue = createConcurrencyQueue(() => limit);
    const holds = Array.from({ length: 5 }, deferred);
    const started = [];
    let active = 0;
    let peak = 0;
    const results = holds.map((hold, index) => queue.run(async () => {
      started.push(index);
      peak = Math.max(peak, ++active);
      await hold.promise;
      active -= 1;
      return index;
    }));
    await tick();
    assert.deepEqual(started, Array.from({ length: limit }, (_, index) => index));
    holds[0].resolve();
    await results[0];
    await tick();
    assert.deepEqual(started, Array.from({ length: limit + 1 }, (_, index) => index));
    holds.forEach((hold) => hold.resolve());
    assert.deepEqual(await Promise.all(results), [0, 1, 2, 3, 4]);
    assert.equal(peak, limit);
  });
}

test('failure releases the shared queue and each account keeps its own async network context', async () => {
  const network = new AsyncLocalStorage();
  const queue = createConcurrencyQueue(() => 1);
  const hold = deferred();
  const observed = [];
  const first = network.run('proxy-a', () => queue.run(async () => {
    await hold.promise;
    observed.push(network.getStore());
    throw new Error('fixture login failed');
  }));
  const failure = assert.rejects(first, /fixture login failed/);
  const second = network.run('proxy-b', () => queue.run(async () => {
    observed.push(network.getStore());
    return 'saved';
  }));
  hold.resolve();
  await failure;
  assert.equal(await second, 'saved');
  assert.deepEqual(observed, ['proxy-a', 'proxy-b']);
});
