import assert from 'node:assert/strict';
import test from 'node:test';
import { featuredQuota } from '../src/quota-pick';

const snapshots = [
  { agent: 'codex', windows: [1], remaining: 0.42 },
  { agent: 'claude', windows: [1], remaining: 0.51 },
];
const tightest = (list: typeof snapshots) => list.reduce((best, item) => (
  !best || item.remaining < best.remaining ? item : best
), snapshots[0]);

test('without a pin, the tightest quota stays on the list', () => {
  assert.equal(featuredQuota(snapshots, null, tightest)?.agent, 'codex');
});

test('a pinned agent stays on the list even when another is tighter', () => {
  assert.equal(featuredQuota(snapshots, 'claude', tightest)?.agent, 'claude');
});

test('a missing pin falls back to the tightest quota', () => {
  assert.equal(featuredQuota(snapshots, 'grok', tightest)?.agent, 'codex');
});
