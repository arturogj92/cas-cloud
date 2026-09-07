import assert from 'node:assert/strict';
import test from 'node:test';
import { orderTimelineItems, retainedTimelineStart } from '../src/timeline-order';

test('keeps untimestamped tool items beside the message that preceded them', () => {
  const items = [
    { id: 'new-user', startedAtMs: 200 },
    { id: 'new-tool' },
    { id: 'old-user', startedAtMs: 100 },
    { id: 'old-tool' },
  ];

  assert.deepEqual(orderTimelineItems(items).map(({ id }) => id), [
    'old-user',
    'old-tool',
    'new-user',
    'new-tool',
  ]);
});

test('retained window counts only messages, so a tool-heavy turn keeps the messages around it', () => {
  const isMessage = (item: { kind: string }) => item.kind === 'message';
  const items = [
    { id: 'u1', kind: 'message' },
    { id: 'a1', kind: 'message' },
    { id: 'u2', kind: 'message' },
    ...Array.from({ length: 30 }, (_, index) => ({ id: `tool-${index}`, kind: 'work' })),
    { id: 'todo', kind: 'hidden' },
    { id: 'a2', kind: 'message' },
  ];

  assert.equal(retainedTimelineStart(items, 16, isMessage), 0);
  assert.equal(retainedTimelineStart(items, 2, isMessage), 2);
  assert.equal(retainedTimelineStart(items, 1, isMessage), 3); // the turn's tool steps stay with a2
  assert.equal(retainedTimelineStart([], 16, isMessage), 0);
});
