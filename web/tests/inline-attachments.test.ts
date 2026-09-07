import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentMarker, attachmentMessageParts } from '../src/inline-attachments';

test('interleaves photos and files using Desktop per-type ordinals', () => {
  const attachments = [{ type: 'file' }, { type: 'image' }, { type: 'image' }];
  assert.equal(attachmentMarker(attachments, 2), '[[Image 2]]');
  assert.deepEqual(attachmentMessageParts('Before [[Image 2]] middle [[File 1]] after [[Image 1]]', attachments), [
    { text: 'Before ' }, { index: 2 }, { text: ' middle ' }, { index: 0 }, { text: ' after ' }, { index: 1 },
  ]);
});

test('keeps legacy payloads and treats unknown or repeated markers as text', () => {
  assert.deepEqual(attachmentMessageParts('See this', [{ type: 'image' }]), [{ text: 'See this' }, { index: 0 }]);
  assert.deepEqual(attachmentMessageParts('[[File 9]] [[Image 1]] [[Image 1]]', [{ type: 'image' }]), [
    { text: '[[File 9]] ' }, { index: 0 }, { text: ' [[Image 1]]' },
  ]);
});
