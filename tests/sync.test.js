import test from 'node:test';
import assert from 'node:assert/strict';
import { startPolling, POLL_INTERVAL_MS } from '../public/sync.js';

function clock(t) {
  let tick;
  let cleared = false;
  t.mock.method(globalThis, 'setInterval', (callback, interval) => {
    assert.equal(interval, POLL_INTERVAL_MS);
    assert.ok(interval <= 5000);
    tick = callback;
    return 42;
  });
  t.mock.method(globalThis, 'clearInterval', (id) => { assert.equal(id, 42); cleared = true; });
  return { tick: () => tick(), cleared: () => cleared };
}

test('poll cleanup clears its timer, aborts the request, ignores late results, and prevents overlap', async (t) => {
  const timer = clock(t);
  let resolve;
  let signal;
  let reads = 0;
  const received = [], connections = [];
  const stop = startPolling({
    read(options) { reads++; signal = options.signal; return new Promise((done) => { resolve = done; }); },
    onDishes: (dishes) => received.push(dishes),
    onConnection: (connected) => connections.push(connected)
  });
  const pending = timer.tick();
  await timer.tick();
  assert.equal(reads, 1);
  stop();
  assert.equal(timer.cleared(), true);
  assert.equal(signal.aborted, true);
  resolve([{ dishId: '1', version: 2 }]);
  await pending;
  await timer.tick();
  assert.equal(reads, 1);
  assert.deepEqual(received, []);
  assert.deepEqual(connections, []);
});

test('a temporary read failure leaves polling alive and the next successful tick recovers', async (t) => {
  const timer = clock(t);
  let reads = 0;
  const dishes = [{ dishId: '1', version: 2 }];
  const received = [], connections = [];
  const stop = startPolling({
    async read() { if (++reads === 1) throw new Error('Disconnected'); return dishes; },
    onDishes: (value) => received.push(value),
    onConnection: (connected) => connections.push(connected)
  });
  t.after(stop);
  await timer.tick();
  assert.deepEqual(received, []);
  await timer.tick();
  assert.equal(reads, 2);
  assert.deepEqual(connections, [false, true]);
  assert.deepEqual(received, [dishes]);
});
