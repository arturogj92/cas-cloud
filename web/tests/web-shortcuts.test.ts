import assert from 'node:assert/strict';
import test from 'node:test';
import { WEB_SHORTCUTS, webShortcutAction } from '../src/web-shortcuts';

const press = (code: string, modifiers: Partial<{ altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => webShortcutAction({
  code,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...modifiers,
});

test('maps every Alt shortcut to its action', () => {
  assert.deepEqual(press('KeyN', { altKey: true }), { type: 'new-session' });
  assert.deepEqual(press('Digit1', { altKey: true }), { type: 'select-index', index: 0 });
  assert.deepEqual(press('Digit9', { altKey: true }), { type: 'select-index', index: 8 });
  assert.deepEqual(press('ArrowUp', { altKey: true }), { type: 'select-adjacent', delta: -1 });
  assert.deepEqual(press('ArrowDown', { altKey: true }), { type: 'select-adjacent', delta: 1 });
  assert.deepEqual(press('KeyA', { altKey: true }), { type: 'focus-search' });
  assert.deepEqual(press('KeyI', { altKey: true }), { type: 'show-history' });
  assert.deepEqual(press('Escape'), { type: 'escape' });
});

test('ignores anything the browser or the app already owns', () => {
  assert.equal(press('Digit0', { altKey: true }), null);
  assert.equal(press('KeyN', { metaKey: true }), null);
  assert.equal(press('KeyN', { ctrlKey: true }), null);
  assert.equal(press('Digit1', { altKey: true, metaKey: true }), null);
  assert.equal(press('KeyA', { altKey: true, shiftKey: true }), null);
  assert.equal(press('KeyN'), null);
  assert.equal(press('KeyZ', { altKey: true }), null);
  assert.equal(press('Escape', { altKey: true }), null);
});

test('publishes the catalogue shown in Settings', () => {
  assert.equal(WEB_SHORTCUTS.length, 6);
  assert.deepEqual(WEB_SHORTCUTS[0], { keys: '⌥ N', label: 'New agent' });
  assert.deepEqual(WEB_SHORTCUTS.at(-1), { keys: 'Esc', label: 'Close / back to list' });
});
