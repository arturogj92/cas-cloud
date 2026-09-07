import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { MobileAttachment } from './mobile-attachments';
import { withoutHostHistory } from './host-scope';
import type { RuntimeCache, RuntimeHistoryConversation } from './runtime';
import { withTimeout } from './promise-timeout';

const CONNECTION_KEY = 'cas.mobile.connection.v1';
const PENDING_REVOCATION_KEY = 'cas.mobile.pending-revocation.v1';
const DEVICE_ID_KEY = 'cas.mobile.device-id.v1';
const CACHE_KEY = 'cas.mobile.runtime-cache.v3';
const HISTORY_CACHE_KEY = 'cas.mobile.history-cache.v1';
const LIST_PREFERENCES_KEY = 'cas.mobile.list-preferences.v1';
const THEME_KEY = 'cas.mobile.theme.v1';
const NOTIFICATIONS_ENABLED_KEY = 'cas.mobile.notifications-enabled.v1';
const WORKTREE_PREFERENCE_KEY = 'cas.mobile.worktree-preference.v1';
const PENDING_SENDS_KEY = 'cas.mobile.pending-sends.v1';
const PENDING_SENDS_FILE = 'cas-mobile-pending-sends.json';
const PENDING_SENDS_TEMP_FILE = `${PENDING_SENDS_FILE}.tmp`;
const PENDING_SENDS_BACKUP_FILE = `${PENDING_SENDS_FILE}.bak`;
const WEB_STATE_DB = 'codeagentswarm-mobile-state';
const WEB_STATE_STORE = 'key-value';
const WEB_CONNECTION_IDS_KEY = 'cas.mobile.connection-ids.v1';
const STORAGE_TIMEOUT_MS = 2_500;
const PENDING_STORAGE_TIMEOUT_MS = 30_000;
const MAX_HISTORY_CONVERSATIONS = 500;
let nativePendingWrite: Promise<void> = Promise.resolve();
let nativePairingWrite: Promise<void> = Promise.resolve();

function scopedKey(key: string, scope?: string) {
  return scope ? `${key}.${encodeURIComponent(scope)}` : key;
}

export type PersistedPendingSend = {
  id: string;
  createdAtMs?: number;
  text: string;
  attachments: MobileAttachment[];
  baselineMatches: number;
  queued?: boolean;
  delivered?: boolean;
  progress?: number;
  failed?: boolean;
  confirmed?: boolean;
};

export type PendingSendCache = Record<string, PersistedPendingSend[]>;

export type MobileListPreferences = {
  grouping: 'project' | 'status';
  density: 'roomy' | 'compact';
  pinnedQuotaAgent: string | null;
  collapsedGroups: string[];
};

export type MobileTheme = 'dark' | 'neon' | 'white' | 'sage';

export type SavedConnection = {
  relayOrigin: string;
  backendOrigin: string;
  deviceToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  runtimeId: string;
  publicKey: string;
  secretKey: string;
  desktopPublicKey: string;
};

export type PendingDeviceRevocation = Pick<SavedConnection, 'backendOrigin' | 'refreshToken'> & {
  id: string;
  replacementRuntimeId: string;
};

async function readSecret(key: string) {
  if (Platform.OS === 'web') return globalThis.localStorage?.getItem(key) || null;
  return withTimeout(SecureStore.getItemAsync(key), STORAGE_TIMEOUT_MS);
}

async function writeSecret(key: string, value: string | null) {
  if (Platform.OS === 'web') {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
    return;
  }
  if (value === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

export async function stableDeviceId() {
  const existing = await withTimeout(AsyncStorage.getItem(DEVICE_ID_KEY), STORAGE_TIMEOUT_MS).catch(() => null);
  if (existing && /^[a-f0-9-]{36}$/.test(existing)) return existing;
  const created = Crypto.randomUUID();
  await withTimeout(AsyncStorage.setItem(DEVICE_ID_KEY, created), STORAGE_TIMEOUT_MS).catch(() => {});
  return created;
}

function parseSavedConnection(raw: string | null) {
  const value = raw ? JSON.parse(raw) as Partial<SavedConnection> : null;
  return value
    && typeof value.relayOrigin === 'string'
    && typeof value.backendOrigin === 'string'
    && typeof value.deviceToken === 'string'
    && typeof value.refreshToken === 'string'
    && typeof value.accessExpiresAt === 'number'
    && typeof value.runtimeId === 'string'
    && typeof value.publicKey === 'string'
    && typeof value.secretKey === 'string'
    && typeof value.desktopPublicKey === 'string'
    ? value as SavedConnection
    : null;
}

export async function loadSavedConnection(scope?: string): Promise<SavedConnection | null> {
  try {
    return parseSavedConnection(await readSecret(scopedKey(CONNECTION_KEY, scope)));
  } catch {
    return null;
  }
}

export async function loadSavedConnectionStrict(scope?: string) {
  return parseSavedConnection(await readSecret(scopedKey(CONNECTION_KEY, scope)));
}

export function saveSavedConnection(connection: SavedConnection, scope?: string) {
  return writeSecret(scopedKey(CONNECTION_KEY, scope), JSON.stringify(connection));
}

export async function clearSavedConnection(expectedRefreshToken?: string, scope?: string) {
  if (expectedRefreshToken
    && (await loadSavedConnectionStrict(scope))?.refreshToken !== expectedRefreshToken) return;
  return writeSecret(scopedKey(CONNECTION_KEY, scope), null);
}

export function loadWebConnectionIds() {
  if (Platform.OS !== 'web') return [];
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(WEB_CONNECTION_IDS_KEY) || '[]');
    return Array.isArray(parsed) ? [...new Set(parsed.filter((value): value is string => typeof value === 'string' && Boolean(value)))] : [];
  } catch {
    return [];
  }
}

export function saveWebConnectionIds(runtimeIds: string[]) {
  if (Platform.OS !== 'web') return;
  globalThis.localStorage?.setItem(WEB_CONNECTION_IDS_KEY, JSON.stringify([...new Set(runtimeIds.filter(Boolean))]));
}

export async function loadConnectionIds() {
  if (Platform.OS === 'web') return loadWebConnectionIds();
  try {
    const parsed = JSON.parse(await withTimeout(AsyncStorage.getItem(WEB_CONNECTION_IDS_KEY), STORAGE_TIMEOUT_MS) || '[]');
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === 'string' && Boolean(value)))]
      : [];
  } catch {
    return [];
  }
}

export async function saveConnectionIds(runtimeIds: string[]) {
  const normalized = [...new Set(runtimeIds.filter(Boolean))];
  if (Platform.OS === 'web') {
    saveWebConnectionIds(normalized);
    return;
  }
  await withTimeout(AsyncStorage.setItem(WEB_CONNECTION_IDS_KEY, JSON.stringify(normalized)), STORAGE_TIMEOUT_MS);
}

export function updateConnectionIds(update: (runtimeIds: string[]) => string[]) {
  return withPairingStorageLock(async () => {
    const runtimeIds = update(await loadConnectionIds());
    await saveConnectionIds(runtimeIds);
    return runtimeIds;
  });
}

export async function loadPendingDeviceRevocation(scope?: string): Promise<PendingDeviceRevocation | null | undefined> {
  let raw: string | null;
  try {
    raw = Platform.OS === 'web'
      ? await readWebStateValue(scopedKey(PENDING_REVOCATION_KEY, scope))
      : await readSecret(scopedKey(PENDING_REVOCATION_KEY, scope));
  } catch {
    return undefined;
  }
  try {
    const value = raw ? JSON.parse(raw) as Partial<PendingDeviceRevocation> : null;
    return value
      && typeof value.backendOrigin === 'string'
      && typeof value.refreshToken === 'string'
      && typeof value.id === 'string'
      && typeof value.replacementRuntimeId === 'string'
      ? value as PendingDeviceRevocation
      : null;
  } catch {
    return null;
  }
}

export function savePendingDeviceRevocation(revocation: PendingDeviceRevocation, scope?: string) {
  if (Platform.OS === 'web') {
    return writeWebStateValue(scopedKey(PENDING_REVOCATION_KEY, scope), JSON.stringify(revocation));
  }
  return writeSecret(scopedKey(PENDING_REVOCATION_KEY, scope), JSON.stringify(revocation));
}

export async function clearPendingDeviceRevocation(expectedId?: string, scope?: string) {
  if (Platform.OS === 'web') {
    return clearWebStateValue(scopedKey(PENDING_REVOCATION_KEY, scope), expectedId);
  }
  if (expectedId) {
    const pending = await loadPendingDeviceRevocation(scope);
    if (pending === undefined) throw new Error('Pending device revocation could not be read');
    if (pending?.id !== expectedId) throw new Error('Pending device revocation changed');
  }
  return writeSecret(scopedKey(PENDING_REVOCATION_KEY, scope), null);
}

export function withPairingStorageLock<T>(action: () => Promise<T>) {
  if (Platform.OS !== 'web') {
    const pending = nativePairingWrite.then(action, action);
    nativePairingWrite = pending.then(() => {}, () => {});
    return pending;
  }
  if (!globalThis.navigator?.locks) {
    return Promise.reject(new Error('Browser pairing lock is unavailable'));
  }
  return globalThis.navigator.locks.request('cas.mobile.pairing-storage.v1', { mode: 'exclusive' }, action);
}

export async function loadRuntimeCache(scope?: string): Promise<RuntimeCache | null> {
  try {
    const raw = await withTimeout(AsyncStorage.getItem(scopedKey(CACHE_KEY, scope)), STORAGE_TIMEOUT_MS);
    return raw ? JSON.parse(raw) as RuntimeCache : null;
  } catch {
    return null;
  }
}

export async function saveRuntimeCache(cache: RuntimeCache, scope?: string) {
  try {
    await AsyncStorage.setItem(scopedKey(CACHE_KEY, scope), JSON.stringify(cache));
  } catch {
    // Cached state is an acceleration only. The runtime snapshot remains authoritative.
  }
}

export async function clearRuntimeCache(scope?: string) {
  await AsyncStorage.removeItem(scopedKey(CACHE_KEY, scope));
}

function isRuntimeHistoryConversation(value: unknown): value is RuntimeHistoryConversation {
  if (!value || typeof value !== 'object') return false;
  const conversation = value as Partial<RuntimeHistoryConversation>;
  return typeof conversation.id === 'string' && Boolean(conversation.id)
    && typeof conversation.sessionId === 'string' && Boolean(conversation.sessionId)
    && typeof conversation.agent === 'string' && Boolean(conversation.agent)
    && typeof conversation.title === 'string' && Boolean(conversation.title)
    && typeof conversation.projectPath === 'string' && Boolean(conversation.projectPath)
    && typeof conversation.projectDir === 'string'
    && typeof conversation.projectName === 'string' && Boolean(conversation.projectName)
    && Number.isFinite(conversation.timestamp);
}

export async function loadMobileHistory(runtimeId: string, legacyKey = false): Promise<RuntimeHistoryConversation[]> {
  try {
    const key = legacyKey ? HISTORY_CACHE_KEY : scopedKey(HISTORY_CACHE_KEY, runtimeId);
    const raw = await withTimeout(AsyncStorage.getItem(key), STORAGE_TIMEOUT_MS);
    const parsed = raw ? JSON.parse(raw) as { runtimeId?: unknown; conversations?: unknown } : null;
    return parsed?.runtimeId === runtimeId && Array.isArray(parsed.conversations)
      ? parsed.conversations.filter(isRuntimeHistoryConversation).slice(0, MAX_HISTORY_CONVERSATIONS)
      : [];
  } catch {
    return [];
  }
}

export async function saveMobileHistory(runtimeId: string, history: RuntimeHistoryConversation[]) {
  await withPairingStorageLock(async () => {
    if (!(runtimeId === 'multi-host' && (await loadConnectionIds()).length)
      && (await loadSavedConnectionStrict(runtimeId))?.runtimeId !== runtimeId
      && (await loadSavedConnectionStrict())?.runtimeId !== runtimeId) return;
    await AsyncStorage.setItem(scopedKey(HISTORY_CACHE_KEY, runtimeId), JSON.stringify({
      runtimeId,
      conversations: history.slice(0, MAX_HISTORY_CONVERSATIONS),
    }));
  }).catch(() => {});
}

export async function clearMobileHistory(runtimeId?: string) {
  await withPairingStorageLock(() => AsyncStorage.removeItem(scopedKey(HISTORY_CACHE_KEY, runtimeId))).catch(() => {});
}

export async function removeMobileHistoryHost(hostRuntimeId: string) {
  await withPairingStorageLock(async () => {
    const runtimeId = 'multi-host';
    const key = scopedKey(HISTORY_CACHE_KEY, runtimeId);
    const raw = await AsyncStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) as { runtimeId?: unknown; conversations?: unknown } : null;
    const history = parsed?.runtimeId === runtimeId && Array.isArray(parsed.conversations)
      ? parsed.conversations.filter(isRuntimeHistoryConversation)
      : [];
    await AsyncStorage.setItem(key, JSON.stringify({
      runtimeId,
      conversations: withoutHostHistory(history, hostRuntimeId).slice(0, MAX_HISTORY_CONVERSATIONS),
    }));
  }).catch(() => {});
}

export async function loadMobileListPreferences(): Promise<MobileListPreferences> {
  try {
    const raw = await withTimeout(AsyncStorage.getItem(LIST_PREFERENCES_KEY), STORAGE_TIMEOUT_MS);
    const value = raw ? JSON.parse(raw) as Partial<MobileListPreferences> : {};
    return {
      grouping: value.grouping === 'status' ? 'status' : 'project',
      density: value.density === 'compact' ? 'compact' : 'roomy',
      pinnedQuotaAgent: typeof value.pinnedQuotaAgent === 'string' && value.pinnedQuotaAgent ? value.pinnedQuotaAgent : null,
      collapsedGroups: Array.isArray(value.collapsedGroups)
        ? value.collapsedGroups.filter((key): key is string => typeof key === 'string')
        : [],
    };
  } catch {
    return { grouping: 'project', density: 'roomy', pinnedQuotaAgent: null, collapsedGroups: [] };
  }
}

export async function saveMobileListPreferences(preferences: MobileListPreferences) {
  await withTimeout(AsyncStorage.setItem(LIST_PREFERENCES_KEY, JSON.stringify(preferences)), STORAGE_TIMEOUT_MS).catch(() => {});
}

export async function loadMobileTheme(): Promise<MobileTheme | null> {
  let theme: string | null;
  let existingDeviceId: string | null;
  try {
    [theme, existingDeviceId] = await Promise.all([
      withTimeout(AsyncStorage.getItem(THEME_KEY), STORAGE_TIMEOUT_MS),
      withTimeout(AsyncStorage.getItem(DEVICE_ID_KEY), STORAGE_TIMEOUT_MS),
    ]);
  } catch {
    return null;
  }
  if (theme === 'dark' || theme === 'neon' || theme === 'white' || theme === 'sage') return theme;
  if (existingDeviceId) return null;
  await withTimeout(AsyncStorage.setItem(THEME_KEY, 'neon'), STORAGE_TIMEOUT_MS).catch(() => {});
  return 'neon';
}

export async function saveMobileTheme(theme: MobileTheme) {
  await withTimeout(AsyncStorage.setItem(THEME_KEY, theme), STORAGE_TIMEOUT_MS).catch(() => {});
}

export async function loadMobileNotificationsEnabled() {
  const value = await withTimeout(AsyncStorage.getItem(NOTIFICATIONS_ENABLED_KEY), STORAGE_TIMEOUT_MS).catch(() => null);
  return value !== 'false';
}

export async function saveMobileNotificationsEnabled(enabled: boolean) {
  await withTimeout(AsyncStorage.setItem(NOTIFICATIONS_ENABLED_KEY, String(enabled)), STORAGE_TIMEOUT_MS).catch(() => {});
}

export async function loadMobileWorktreePreference() {
  const value = await withTimeout(AsyncStorage.getItem(WORKTREE_PREFERENCE_KEY), STORAGE_TIMEOUT_MS).catch(() => null);
  return value === 'true' ? true : value === 'false' ? false : null;
}

export async function saveMobileWorktreePreference(enabled: boolean) {
  await withTimeout(AsyncStorage.setItem(WORKTREE_PREFERENCE_KEY, String(enabled)), STORAGE_TIMEOUT_MS).catch(() => {});
}

function openWebStateDatabase() {
  let expired = false;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(WEB_STATE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WEB_STATE_STORE)) {
        request.result.createObjectStore(WEB_STATE_STORE);
      }
    };
    request.onsuccess = () => {
      if (expired) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Browser storage is blocked'));
  });
  return withTimeout(opening, STORAGE_TIMEOUT_MS).catch((error) => {
    expired = true;
    throw error;
  });
}

async function readWebStateValue(key: string) {
  if (!globalThis.indexedDB) throw new Error('Browser storage is unavailable');
  const database = await openWebStateDatabase();
  const reading = new Promise<string | null>((resolve, reject) => {
    const request = database.transaction(WEB_STATE_STORE).objectStore(WEB_STATE_STORE).get(key);
    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
    request.onerror = () => reject(request.error);
  });
  return withTimeout(reading, STORAGE_TIMEOUT_MS).finally(() => database.close());
}

async function writeWebStateValue(key: string, value: string) {
  if (!globalThis.indexedDB) throw new Error('Browser storage is unavailable');
  const database = await openWebStateDatabase();
  const writing = new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(WEB_STATE_STORE, 'readwrite');
    transaction.objectStore(WEB_STATE_STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  await withTimeout(writing, STORAGE_TIMEOUT_MS).finally(() => database.close());
}

async function clearWebStateValue(key: string, expectedId?: string) {
  if (!globalThis.indexedDB) throw new Error('Browser storage is unavailable');
  const database = await openWebStateDatabase();
  const clearing = new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(WEB_STATE_STORE, 'readwrite');
    const store = transaction.objectStore(WEB_STATE_STORE);
    const request = store.get(key);
    let changed = false;
    request.onsuccess = () => {
      if (!expectedId) return void store.delete(key);
      try {
        if ((typeof request.result === 'string' ? JSON.parse(request.result) : null)?.id === expectedId) {
          store.delete(key);
          return;
        }
      } catch {
        // Fall through and abort a guarded clear that cannot identify the marker.
      }
      changed = true;
      transaction.abort();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(changed
      ? new Error('Pending device revocation changed')
      : transaction.error);
  });
  await withTimeout(clearing, STORAGE_TIMEOUT_MS).finally(() => database.close());
}

async function readPendingSendsJson() {
  if (Platform.OS !== 'web') {
    if (!FileSystem.documentDirectory) return null;
    await nativePendingWrite.catch(() => {});
    for (const name of [PENDING_SENDS_TEMP_FILE, PENDING_SENDS_FILE, PENDING_SENDS_BACKUP_FILE]) {
      const raw = await withTimeout(
        FileSystem.readAsStringAsync(`${FileSystem.documentDirectory}${name}`),
        PENDING_STORAGE_TIMEOUT_MS,
      ).catch(() => null);
      if (!raw) continue;
      try {
        JSON.parse(raw);
        return raw;
      } catch {
        // A previous write was interrupted; try the next complete copy.
      }
    }
    return null;
  }
  if (!globalThis.indexedDB) {
    return withTimeout(AsyncStorage.getItem(PENDING_SENDS_KEY), STORAGE_TIMEOUT_MS);
  }
  const database = await openWebStateDatabase();
  return new Promise<string | null>((resolve, reject) => {
    const request = database.transaction(WEB_STATE_STORE).objectStore(WEB_STATE_STORE).get(PENDING_SENDS_KEY);
    request.onsuccess = () => {
      database.close();
      resolve(typeof request.result === 'string' ? request.result : null);
    };
    request.onerror = () => {
      database.close();
      reject(request.error);
    };
  });
}

async function writePendingSendsJson(value: string) {
  if (Platform.OS !== 'web') {
    if (!FileSystem.documentDirectory) throw new Error('App storage is unavailable');
    const uri = `${FileSystem.documentDirectory}${PENDING_SENDS_FILE}`;
    const tempUri = `${FileSystem.documentDirectory}${PENDING_SENDS_TEMP_FILE}`;
    const backupUri = `${FileSystem.documentDirectory}${PENDING_SENDS_BACKUP_FILE}`;
    const write = async () => {
      await withTimeout(FileSystem.writeAsStringAsync(tempUri, value), PENDING_STORAGE_TIMEOUT_MS);
      await FileSystem.deleteAsync(backupUri, { idempotent: true });
      if ((await FileSystem.getInfoAsync(uri)).exists) {
        await FileSystem.moveAsync({ from: uri, to: backupUri });
      }
      try {
        await FileSystem.moveAsync({ from: tempUri, to: uri });
      } catch (error) {
        if ((await FileSystem.getInfoAsync(backupUri)).exists) {
          await FileSystem.moveAsync({ from: backupUri, to: uri });
        }
        throw error;
      }
      await FileSystem.deleteAsync(backupUri, { idempotent: true });
    };
    const pending = nativePendingWrite.then(write);
    nativePendingWrite = pending.catch(() => {});
    return pending;
  }
  if (!globalThis.indexedDB) {
    await withTimeout(AsyncStorage.setItem(PENDING_SENDS_KEY, value), STORAGE_TIMEOUT_MS);
    return;
  }
  const database = await openWebStateDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(WEB_STATE_STORE, 'readwrite');
    transaction.objectStore(WEB_STATE_STORE).put(value, PENDING_SENDS_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

export async function loadPendingSends(): Promise<PendingSendCache> {
  try {
    const raw = await readPendingSendsJson();
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([sessionId, entries]) => (
      Array.isArray(entries)
        ? [[sessionId, entries.filter((entry): entry is PersistedPendingSend => (
          Boolean(entry)
          && typeof entry.id === 'string'
          && typeof entry.text === 'string'
          && Array.isArray(entry.attachments)
          && typeof entry.baselineMatches === 'number'
        ))]]
        : []
    )));
  } catch {
    return {};
  }
}

export async function savePendingSends(cache: PendingSendCache) {
  try {
    await writePendingSendsJson(JSON.stringify(cache));
  } catch {
    // Pending UI state is best-effort; the desktop remains authoritative once a turn is accepted.
  }
}
