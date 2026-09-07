import type { RuntimeCommand, RuntimeTask, RuntimeTaskPage } from './protocol';

export async function fetchTaskPage(
  sendCommand: (command: RuntimeCommand) => Promise<unknown>,
  { runtimeId, projectId, status, query, cursor, searchable }: {
    runtimeId: string; projectId: string; status?: RuntimeTask['status']; query: string;
    cursor: string | null; searchable: boolean;
  },
  isCurrent: () => boolean,
): Promise<RuntimeTaskPage> {
  const tasks: RuntimeTask[] = [];
  const seen = new Set<string>();
  if (cursor) seen.add(cursor);
  do {
    if (!isCurrent()) throw new Error('Task page was cancelled');
    const limit = 25 - tasks.length;
    const page = await sendCommand({ type: 'tasks.list', runtimeId, payload: {
      projectId, limit, ...(cursor ? { cursor } : {}),
      ...(searchable && status ? { status } : {}),
      ...(searchable && query ? { query } : {}),
    } }) as RuntimeTaskPage;
    if (!Array.isArray(page?.tasks) || page.tasks.length > limit
      || (page.nextCursor != null && typeof page.nextCursor !== 'string')
      || (page.nextCursor && seen.has(page.nextCursor))) throw new Error('Invalid task page');
    if (searchable) return page;
    // ponytail: older hosts scan empty pages; return the first matches without filling all 25 slots.
    tasks.push(...page.tasks.filter((task) => (!status || task.status === status)
      && `${task.title} ${task.description} ${task.labels.map((label) => typeof label === 'string' ? label : label.text).join(' ')} ${task.id}`.toLowerCase().includes(query.toLowerCase())));
    cursor = page.nextCursor || null;
    if (cursor) seen.add(cursor);
  } while (cursor && !tasks.length);
  return { tasks, nextCursor: cursor };
}
