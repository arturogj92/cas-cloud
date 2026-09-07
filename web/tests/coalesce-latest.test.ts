import assert from 'node:assert/strict';
import test from 'node:test';

import { coalesceLatest } from '../src/coalesce-latest';

test('the first value renders immediately and a burst collapses into one trailing render', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen: number[] = [];
  const updates = coalesceLatest<number>((value) => seen.push(value), 40);
  updates.push(1);
  assert.deepEqual(seen, [1]);
  for (let value = 2; value <= 50; value += 1) updates.push(value);
  assert.deepEqual(seen, [1]);
  context.mock.timers.tick(40);
  assert.deepEqual(seen, [1, 50]);
  updates.push(51);
  assert.deepEqual(seen, [1, 50], 'a value inside the window waits for the trailing edge');
  context.mock.timers.tick(40);
  assert.deepEqual(seen, [1, 50, 51]);
});

test('cancel drops a pending value after unsubscribe', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen: number[] = [];
  const updates = coalesceLatest<number>((value) => seen.push(value), 40);
  updates.push(1);
  updates.push(2);
  updates.cancel();
  context.mock.timers.tick(70);
  assert.deepEqual(seen, [1]);
});
