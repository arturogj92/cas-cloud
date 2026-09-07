import AsyncStorage from '@react-native-async-storage/async-storage';

import type { RuntimeTask, RuntimeTaskPage } from './protocol';
import { withTimeout } from './promise-timeout';

export const TASK_CACHE_TTL_MS = 30_000;

const TASK_CACHE_PREFIX = 'cas.mobile.task-page-cache.v3';
const STORAGE_TIMEOUT_MS = 2_500;
const TASK_STATUSES = new Set<RuntimeTask['status']>(['pending', 'in_progress', 'in_testing', 'completed']);

export type TaskCacheEntry = {
  cachedAt: number;
  page: RuntimeTaskPage;
};

type TaskCacheStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem' | 'getAllKeys' | 'multiRemove'>;
type InFlightRequest = { version: string; isCurrent: () => boolean; promise: Promise<RuntimeTaskPage> };
const alwaysCurrent = () => true;

const memoryCache = new Map<string, TaskCacheEntry>();
const entryVersions = new Map<string, number>();
const hostVersions = new Map<string, number>();
const inFlightRequests = new Map<string, InFlightRequest>();
let allVersion = 0;

function taskCacheKey(hostRuntimeId: string, projectId: string, scope = '') {
  return `${TASK_CACHE_PREFIX}.${encodeURIComponent(hostRuntimeId)}.${encodeURIComponent(projectId)}.${encodeURIComponent(scope)}`;
}

function taskCacheHostPrefix(hostRuntimeId: string) {
  return `${TASK_CACHE_PREFIX}.${encodeURIComponent(hostRuntimeId)}.`;
}

function taskCacheVersion(hostRuntimeId: string, projectId: string) {
  const key = taskCacheKey(hostRuntimeId, projectId);
  return `${allVersion}:${hostVersions.get(hostRuntimeId) || 0}:${entryVersions.get(key) || 0}`;
}

function isRuntimeTask(value: unknown): value is RuntimeTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<RuntimeTask>;
  return Number.isSafeInteger(task.id)
    && typeof task.title === 'string'
    && typeof task.description === 'string'
    && typeof task.plan === 'string'
    && typeof task.implementation === 'string'
    && TASK_STATUSES.has(task.status as RuntimeTask['status'])
    && Array.isArray(task.labels)
    && task.labels.every((label) => typeof label === 'string' || (
      Boolean(label) && typeof label === 'object'
      && typeof label.text === 'string' && Number.isFinite(label.color)
    ))
    && (task.parentTaskId === null || Number.isSafeInteger(task.parentTaskId))
    && Number.isFinite(task.sortOrder)
    && typeof task.createdAt === 'string'
    && typeof task.updatedAt === 'string';
}

function parseTaskCache(raw: string | null): TaskCacheEntry | null {
  try {
    const parsed = raw ? JSON.parse(raw) as Partial<TaskCacheEntry> : null;
    if (!parsed || !Number.isFinite(parsed.cachedAt) || !Array.isArray(parsed.page?.tasks)) return null;
    const tasks = parsed.page!.tasks.filter(isRuntimeTask);
    if (tasks.length !== parsed.page!.tasks.length) return null;
    const { nextCursor, counts } = parsed.page!;
    if (nextCursor != null && typeof nextCursor !== 'string') return null;
    if (counts && [...TASK_STATUSES].some((status) => !Number.isSafeInteger(counts[status]) || counts[status] < 0)) return null;
    return { cachedAt: parsed.cachedAt!, page: { tasks, nextCursor, counts } };
  } catch {
    return null;
  }
}

export function isTaskCacheFresh(entry: TaskCacheEntry, now = Date.now()) {
  const age = now - entry.cachedAt;
  return age >= 0 && age < TASK_CACHE_TTL_MS;
}

export function peekTaskCache(hostRuntimeId: string, projectId: string, scope = '') {
  return memoryCache.get(taskCacheKey(hostRuntimeId, projectId, scope)) || null;
}

export async function loadTaskCache(
  hostRuntimeId: string,
  projectId: string,
  storage: TaskCacheStorage = AsyncStorage,
  scope = '',
): Promise<TaskCacheEntry | null> {
  const key = taskCacheKey(hostRuntimeId, projectId, scope);
  const remembered = peekTaskCache(hostRuntimeId, projectId, scope);
  if (remembered) return remembered;
  const version = taskCacheVersion(hostRuntimeId, projectId);
  try {
    const entry = parseTaskCache(await withTimeout(storage.getItem(key), STORAGE_TIMEOUT_MS));
    if (!entry || version !== taskCacheVersion(hostRuntimeId, projectId)) return null;
    memoryCache.set(key, entry);
    if (memoryCache.size > 20) memoryCache.delete(memoryCache.keys().next().value!);
    return entry;
  } catch {
    return null;
  }
}

export async function saveTaskCache(
  hostRuntimeId: string,
  projectId: string,
  page: RuntimeTaskPage,
  cachedAt = Date.now(),
  expectedVersion = taskCacheVersion(hostRuntimeId, projectId),
  storage: TaskCacheStorage = AsyncStorage,
  scope = '',
) {
  if (expectedVersion !== taskCacheVersion(hostRuntimeId, projectId)) return;
  const key = taskCacheKey(hostRuntimeId, projectId, scope);
  const entry = { cachedAt, page };
  memoryCache.set(key, entry);
  if (memoryCache.size > 20) memoryCache.delete(memoryCache.keys().next().value!);
  try {
    await storage.setItem(key, JSON.stringify(entry));
    if (expectedVersion !== taskCacheVersion(hostRuntimeId, projectId)) {
      memoryCache.delete(key);
      await storage.removeItem(key).catch(() => {});
    }
  } catch {
    // The in-memory page still avoids repeat reads during this app session.
  }
}

export async function invalidateTaskCache(
  hostRuntimeId?: string,
  projectId?: string,
  storage: TaskCacheStorage = AsyncStorage,
) {
  if (hostRuntimeId && projectId) {
    const key = taskCacheKey(hostRuntimeId, projectId);
    entryVersions.set(key, (entryVersions.get(key) || 0) + 1);
  } else if (hostRuntimeId) hostVersions.set(hostRuntimeId, (hostVersions.get(hostRuntimeId) || 0) + 1);
  else allVersion += 1;
  const prefix = hostRuntimeId && projectId ? taskCacheKey(hostRuntimeId, projectId)
    : hostRuntimeId ? taskCacheHostPrefix(hostRuntimeId) : `${TASK_CACHE_PREFIX}.`;
  for (const key of memoryCache.keys()) if (key.startsWith(prefix)) memoryCache.delete(key);
  try {
    const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(prefix));
    if (keys.length) await storage.multiRemove(keys);
  } catch {
    // Cached tasks expire quickly and are never authoritative.
  }
}

export async function loadCachedTaskPage({
  hostRuntimeId,
  projectId,
  force = false,
  scope = '',
  fetchTasks,
  onCached,
  isCurrent = alwaysCurrent,
  now = Date.now,
  storage = AsyncStorage,
}: {
  hostRuntimeId: string;
  projectId: string;
  force?: boolean;
  scope?: string;
  fetchTasks: () => Promise<RuntimeTaskPage>;
  onCached?: (page: RuntimeTaskPage) => void;
  isCurrent?: () => boolean;
  now?: () => number;
  storage?: TaskCacheStorage;
}): Promise<RuntimeTaskPage | null> {
  const version = taskCacheVersion(hostRuntimeId, projectId);
  const cached = force ? null : await loadTaskCache(hostRuntimeId, projectId, storage, scope);
  if (!isCurrent()) return null;
  if (cached) {
    onCached?.(cached.page);
    if (isTaskCacheFresh(cached, now())) return cached.page;
  }

  const key = taskCacheKey(hostRuntimeId, projectId, scope);
  const existing = inFlightRequests.get(key);
  const request = existing?.version === version && existing.isCurrent === isCurrent
    ? existing
    : { version, isCurrent, promise: fetchTasks() };
  if (request !== existing) {
    inFlightRequests.set(key, request);
    void request.promise.finally(() => {
      if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
    }).catch(() => {});
  }
  const page = await request.promise;
  if (!isCurrent()) return null;
  await saveTaskCache(hostRuntimeId, projectId, page, now(), version, storage, scope);
  return page;
}
