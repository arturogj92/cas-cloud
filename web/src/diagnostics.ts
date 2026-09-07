import AsyncStorage from '@react-native-async-storage/async-storage';

import { LatestValueWriter } from './latest-value-writer';
import { withTimeout } from './promise-timeout';

const STORAGE_KEY = 'cas.mobile.diagnostics.v1';
const MAX_ENTRIES = 200;
const STORAGE_TIMEOUT_MS = 2_500;
const SECRET_FIELD = /token|secret|key|payload|message|content|prompt/i;

export type DiagnosticEntry = {
  at: string;
  event: string;
  details?: Record<string, string | number | boolean | null>;
};

let entries: DiagnosticEntry[] = [];
let initialized = false;
let initialization: Promise<void> | null = null;
const writer = new LatestValueWriter<string>((value) => AsyncStorage.setItem(STORAGE_KEY, value));

function safeDetails(details?: Record<string, unknown>) {
  if (!details) return undefined;
  const safe = Object.fromEntries(Object.entries(details)
    .filter(([key, value]) => !SECRET_FIELD.test(key)
      && (value === null || ['string', 'number', 'boolean'].includes(typeof value)))
    .map(([key, value]) => [key, value as string | number | boolean | null]));
  return Object.keys(safe).length ? safe : undefined;
}

function persistDiagnostics() {
  void writer.set(JSON.stringify(entries)).catch(() => {});
}

export function initializeDiagnostics() {
  if (initialized) return Promise.resolve();
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const stored = await withTimeout(AsyncStorage.getItem(STORAGE_KEY), STORAGE_TIMEOUT_MS);
      const parsed = stored ? JSON.parse(stored) : [];
      if (Array.isArray(parsed)) {
        entries = [...new Map([...parsed.slice(-MAX_ENTRIES), ...entries]
          .map((entry) => [JSON.stringify(entry), entry] as const)).values()].slice(-MAX_ENTRIES);
      }
    } catch {
      // Keep events recorded while storage was unavailable.
    } finally {
      initialized = true;
      initialization = null;
      persistDiagnostics();
    }
  })();
  return initialization;
}

export function diagnostic(event: string, details?: Record<string, unknown>) {
  const filtered = safeDetails(details);
  const entry: DiagnosticEntry = {
    at: new Date().toISOString(),
    event,
    ...(filtered ? { details: filtered } : {}),
  };
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), entry];
  console.info('[mobile-connect]', JSON.stringify(entry));
  if (initialized) persistDiagnostics();
}

export function getDiagnostics() {
  return entries.map((entry) => ({ ...entry, details: entry.details ? { ...entry.details } : undefined }));
}

if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { __casMobileDiagnostics?: typeof getDiagnostics })
    .__casMobileDiagnostics = getDiagnostics;
}
