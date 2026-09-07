import assert from 'node:assert/strict';
import test from 'node:test';

import { LatestValueWriter } from '../src/latest-value-writer';

test('an older storage write cannot win after a newer pairing clears it', async () => {
  const releases: Array<() => void> = [];
  const stored: Array<string | null> = [];
  const writer = new LatestValueWriter<string | null>((value) => new Promise((resolve) => {
    releases.push(() => {
      stored.push(value);
      resolve();
    });
  }));

  const oldPairing = writer.set('old');
  await new Promise((resolve) => setImmediate(resolve));
  const newPairing = writer.set(null);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()?.();

  assert.equal(await oldPairing, false);
  assert.equal(await newPairing, true);
  assert.deepEqual(stored, ['old', null]);
});

test('a stale clear finishes before a newer revocation marker is saved', async () => {
  let releaseClear = () => {};
  const stored: Array<string | null> = [];
  const writer = new LatestValueWriter<string | null>((value) => (
    value === null
      ? new Promise<void>((resolve) => { releaseClear = () => { stored.push(value); resolve(); }; })
      : Promise.resolve().then(() => { stored.push(value); })
  ));

  const staleClear = writer.set(null);
  await new Promise((resolve) => setImmediate(resolve));
  const newMarker = writer.set('new-marker');
  releaseClear();

  assert.equal(await staleClear, false);
  assert.equal(await newMarker, true);
  assert.deepEqual(stored, [null, 'new-marker']);
});
