import assert from 'node:assert/strict';
import test from 'node:test';

import { withTimeout } from '../src/promise-timeout';

test('bounds stalled storage operations without delaying completed ones', async () => {
  assert.equal(await withTimeout(Promise.resolve('ready'), 20), 'ready');
  await assert.rejects(withTimeout(new Promise(() => {}), 5), /timed out/);
});
