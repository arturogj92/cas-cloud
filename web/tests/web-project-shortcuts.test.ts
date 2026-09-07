import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadWebProjectShortcuts,
  readWebProjectShortcuts,
  saveWebProjectShortcuts,
  type WebShortcutStorage,
} from '../src/web-project-shortcuts';

class MemoryStorage implements WebShortcutStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const desktopShortcuts = [
  { shortcutId: '7', projectPath: '/work/cas', agent: 'codex', useWorktree: true as const },
  { shortcutId: '8', projectPath: '/work/tmf', agent: 'claude', useWorktree: null },
];

test('copies desktop shortcuts once, then keeps each browser runtime independent', () => {
  const storage = new MemoryStorage();
  const initial = loadWebProjectShortcuts(storage, 'desktop-a', desktopShortcuts);
  assert.deepEqual(initial, [
    { shortcutId: 'web:7', projectPath: '/work/cas', agent: 'codex', useWorktree: true },
    { shortcutId: 'web:8', projectPath: '/work/tmf', agent: 'claude', useWorktree: null },
  ]);

  saveWebProjectShortcuts(storage, 'desktop-a', [{
    shortcutId: 'web:7',
    projectPath: '/work/cas',
    agent: 'grok',
    useWorktree: false,
  }]);

  assert.deepEqual(loadWebProjectShortcuts(storage, 'desktop-a', [{
    shortcutId: '99',
    projectPath: '/new-desktop-shortcut',
    agent: 'kimi',
    useWorktree: true,
  }]), [{
    shortcutId: 'web:7',
    projectPath: '/work/cas',
    agent: 'grok',
    useWorktree: false,
  }]);

  assert.deepEqual(loadWebProjectShortcuts(storage, 'desktop-b', desktopShortcuts), initial);
});

test('can read an existing local catalogue without initializing an offline runtime', () => {
  const storage = new MemoryStorage();
  assert.equal(readWebProjectShortcuts(storage, 'offline-desktop'), null);
  saveWebProjectShortcuts(storage, 'offline-desktop', [{
    shortcutId: 'local-1',
    projectPath: '/work',
    agent: 'cursor',
    useWorktree: true,
  }]);
  assert.deepEqual(readWebProjectShortcuts(storage, 'offline-desktop'), [{
    shortcutId: 'local-1',
    projectPath: '/work',
    agent: 'cursor',
    useWorktree: true,
  }]);
});

test('drops malformed saved entries and preserves future provider ids', () => {
  const storage = new MemoryStorage();
  saveWebProjectShortcuts(storage, 'cloud-a', [
    { shortcutId: 'local-1', projectPath: '/work', agent: 'future-agent', useWorktree: null },
    { shortcutId: '', projectPath: '/broken', agent: 'codex', useWorktree: true },
  ]);

  assert.deepEqual(loadWebProjectShortcuts(storage, 'cloud-a', []), [{
    shortcutId: 'local-1',
    projectPath: '/work',
    agent: 'future-agent',
    useWorktree: null,
  }]);
});
