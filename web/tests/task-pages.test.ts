import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTaskPage } from '../src/task-pages';
import type { RuntimeCommand, RuntimeTask } from '../src/protocol';

const tasks: RuntimeTask[] = Array.from({ length: 109 }, (_, index) => ({
  id: index + 1, title: index === 108 ? 'ÁRBOL final' : `Task ${index + 1}`, description: '',
  labels: [], plan: '', implementation: '', status: index % 2 ? 'completed' : 'in_progress',
  parentTaskId: null, sortOrder: index, createdAt: '', updatedAt: '',
}));
const options = { runtimeId: 'old-host', projectId: '1', status: 'in_progress' as const, query: '', cursor: null, searchable: false };

test('older hosts use bounded pages and global Unicode search without unsupported fields', async () => {
  const commands: RuntimeCommand[] = [];
  const send = async (command: RuntimeCommand) => {
    commands.push(command);
    const { projectId, limit, cursor, ...unsupported } = command.payload!;
    assert.equal(projectId, '1');
    assert.deepEqual(unsupported, {});
    assert.ok(Number(limit) <= 25);
    const offset = Number(cursor || 0), end = offset + Number(limit);
    return { tasks: tasks.slice(offset, end), nextCursor: end < tasks.length ? String(end) : null };
  };
  const first = await fetchTaskPage(send, options, () => true);
  assert.equal(first.tasks.length, 13);
  assert.equal(first.tasks.at(-1)?.id, 25);
  assert.equal(first.nextCursor, '25');
  assert.equal(commands.length, 1);
  const second = await fetchTaskPage(send, { ...options, cursor: first.nextCursor! }, () => true);
  assert.equal(second.tasks[0].id, 27);
  assert.equal(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size, 25);
  const search = await fetchTaskPage(send, { ...options, query: 'árbol' }, () => true);
  assert.deepEqual(search.tasks.map((task) => task.id), [109]);
  assert.equal(search.nextCursor, null);
  let active = true, reads = 0;
  await assert.rejects(fetchTaskPage(async (command) => { reads++; active = false; return send(command); }, { ...options, query: 'missing' }, () => active));
  assert.equal(reads, 1);
});

test('a sparse older board returns its first task without scanning the remaining backlog', async () => {
  let calls = 0;
  const result = await fetchTaskPage(async () => {
    calls++;
    assert.equal(calls, 1, 'A visible task must not wait for another relay request');
    return { tasks: [{ ...tasks[0], status: 'in_progress' }], nextCursor: 'older-backlog' };
  }, options, () => true);
  assert.deepEqual(result.tasks.map((task) => task.id), [1]);
  assert.equal(result.nextCursor, 'older-backlog');
});

test('capable hosts receive filters once and repeated cursors cannot loop', async () => {
  let calls = 0;
  const result = await fetchTaskPage(async (command) => {
    calls++;
    assert.equal(command.payload?.status, 'in_progress');
    assert.equal(command.payload?.query, 'árbol');
    return { tasks: [tasks[108]], nextCursor: null };
  }, { ...options, searchable: true, query: 'árbol' }, () => true);
  assert.equal(calls, 1);
  assert.equal(result.tasks[0].id, 109);
  await assert.rejects(fetchTaskPage(async () => ({ tasks: [], nextCursor: 'same' }), { ...options, cursor: 'same' }, () => true), /Invalid task page/);
});
