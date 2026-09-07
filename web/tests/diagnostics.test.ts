import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { diagnostic, getDiagnostics, initializeDiagnostics } from '../src/diagnostics';

const runtimeSource = readFileSync(fileURLToPath(new URL('../src/runtime.ts', import.meta.url).href), 'utf8');

test('diagnostic storage does not block runtime cache hydration', () => {
  assert.match(runtimeSource, /const \[savedConnection, cachedState[\s\S]*?\]\);\s+if \(!this\.enabled\) return;\s+void initializeDiagnostics\(\);/);
});

test('startup diagnostics preserve events recorded while storage is loading', async (t) => {
  let finishRead!: (value: string | null) => void;
  const writes: string[] = [];
  t.mock.method(AsyncStorage, 'getItem', () => new Promise((resolve) => { finishRead = resolve; }));
  t.mock.method(AsyncStorage, 'setItem', async (_key: string, value: string) => { writes.push(value); });
  t.mock.method(console, 'info', () => {});

  const first = initializeDiagnostics();
  const second = initializeDiagnostics();
  diagnostic('startup.early');
  finishRead(JSON.stringify([{ at: '2026-01-01T00:00:00.000Z', event: 'stored' }]));
  await Promise.all([first, second]);

  assert.deepEqual(getDiagnostics().map((entry) => entry.event), ['stored', 'startup.early']);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]).map((entry: { event: string }) => entry.event), ['stored', 'startup.early']);
});
