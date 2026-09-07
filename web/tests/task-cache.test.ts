import assert from 'node:assert/strict';
import test from 'node:test';

import { invalidateTaskCache, loadCachedTaskPage, peekTaskCache, TASK_CACHE_TTL_MS } from '../src/task-cache';
import type { RuntimeTask, RuntimeTaskPage } from '../src/protocol';

class MemoryStorage {
  values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) || null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
  async getAllKeys() { return [...this.values.keys()]; }
  async multiRemove(keys: readonly string[]) { keys.forEach((key) => this.values.delete(key)); }
}

const task: RuntimeTask = {
  id: 1,
  title: 'Cache the Kanban',
  description: '',
  plan: '',
  implementation: '',
  status: 'in_progress',
  labels: [],
  parentTaskId: null,
  sortOrder: 0,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
};

test('reuses a fresh task page and refreshes it after expiry or invalidation', async () => {
  const storage = new MemoryStorage();
  let now = 1_000;
  let fetches = 0;
  const load = () => loadCachedTaskPage({
    hostRuntimeId: 'desktop-cache-test',
    projectId: 'project-1',
    storage,
    now: () => now,
    fetchTasks: async () => { fetches += 1; return { tasks: [{ ...task, title: `Fetch ${fetches}` }] }; },
  });

  assert.equal((await load())?.tasks[0]?.title, 'Fetch 1');
  assert.equal(peekTaskCache('desktop-cache-test', 'project-1')?.page.tasks[0]?.title, 'Fetch 1');
  assert.equal(peekTaskCache('another-host', 'project-1'), null);
  assert.equal(peekTaskCache('desktop-cache-test', 'project-1', 'another-stage'), null);
  assert.equal((await load())?.tasks[0]?.title, 'Fetch 1');
  assert.equal(fetches, 1);

  now += TASK_CACHE_TTL_MS;
  assert.equal((await load())?.tasks[0]?.title, 'Fetch 2');
  assert.equal(fetches, 2);

  await invalidateTaskCache('desktop-cache-test', 'project-1', storage);
  assert.equal(peekTaskCache('desktop-cache-test', 'project-1'), null);
  assert.equal((await load())?.tasks[0]?.title, 'Fetch 3');
  assert.equal(fetches, 3);
});

test('deduplicates concurrent task reads for the same host and project', async () => {
  const storage = new MemoryStorage();
  let finish!: (page: RuntimeTaskPage) => void;
  let fetches = 0;
  const fetchTasks = () => {
    fetches += 1;
    return new Promise<RuntimeTaskPage>((resolve) => { finish = resolve; });
  };
  const options = {
    hostRuntimeId: 'desktop-concurrent-test',
    projectId: 'project-1',
    storage,
    force: true,
    fetchTasks,
  };

  const first = loadCachedTaskPage(options);
  const second = loadCachedTaskPage(options);
  assert.equal(fetches, 1);
  finish({ tasks: [task] });
  assert.deepEqual(await Promise.all([first, second]), [{ tasks: [task] }, { tasks: [task] }]);
});

test('shows an expired page while its replacement is loading', async () => {
  const storage = new MemoryStorage();
  let now = 1_000;
  await loadCachedTaskPage({
    hostRuntimeId: 'desktop-stale-test',
    projectId: 'project-1',
    storage,
    now: () => now,
    fetchTasks: async () => ({ tasks: [{ ...task, title: 'Cached task' }] }),
  });

  now += TASK_CACHE_TTL_MS;
  let finish!: (page: RuntimeTaskPage) => void;
  let showCached!: () => void;
  const cachedShown = new Promise<void>((resolve) => { showCached = resolve; });
  const refresh = loadCachedTaskPage({
    hostRuntimeId: 'desktop-stale-test',
    projectId: 'project-1',
    storage,
    now: () => now,
    onCached: (tasks) => {
      assert.equal(tasks.tasks[0]?.title, 'Cached task');
      showCached();
    },
    fetchTasks: () => new Promise((resolve) => { finish = resolve; }),
  });

  await cachedShown;
  finish({ tasks: [{ ...task, title: 'Fresh task' }] });
  assert.equal((await refresh)?.tasks[0]?.title, 'Fresh task');
});


test('keeps pages and searches separate and invalidates every page of a project', async () => {
  const storage = new MemoryStorage();
  const load = (scope: string) => loadCachedTaskPage({
    hostRuntimeId: 'paged-host', projectId: '1', scope, storage,
    fetchTasks: async () => ({ tasks: [{ ...task, title: scope }], nextCursor: 'next', counts: { pending: 0, in_progress: 109, in_testing: 0, completed: 0 } }),
  });
  assert.equal((await load('first'))?.tasks[0].title, 'first');
  assert.equal((await load('second'))?.tasks[0].title, 'second');
  assert.equal((await load('search'))?.tasks[0].title, 'search');
  assert.equal((await load('first'))?.counts?.in_progress, 109);
  assert.equal(storage.values.size, 3);
  await invalidateTaskCache('paged-host', '1', storage);
  assert.equal(storage.values.size, 0);
});


test('reopening a board does not inherit the previous reader cancellation', async () => {
  const storage = new MemoryStorage();
  let active = true;
  let finish!: () => void;
  const first = loadCachedTaskPage({
    hostRuntimeId: 'reopen-host', projectId: '1', storage, force: true,
    isCurrent: () => active,
    fetchTasks: async () => { await new Promise<void>((resolve) => { finish = resolve; }); if (!active) throw new Error('cancelled'); return { tasks: [task] }; },
  });
  const cancelled = assert.rejects(first, /cancelled/);
  const second = loadCachedTaskPage({
    hostRuntimeId: 'reopen-host', projectId: '1', storage, force: true,
    isCurrent: () => true,
    fetchTasks: async () => ({ tasks: [{ ...task, title: 'Reopened' }] }),
  });
  active = false;
  finish();
  assert.equal((await second)?.tasks[0].title, 'Reopened');
  await cancelled;
});
