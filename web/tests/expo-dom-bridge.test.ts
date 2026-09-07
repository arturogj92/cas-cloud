import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patch, patchSizeObserver } = require('../scripts/patch-expo-dom.cjs');

test('Expo DOM actions connect when Android injects the bridge after module evaluation', async () => {
  const source = fs.readFileSync(path.join(path.dirname(require.resolve('expo/package.json')), 'src/dom/marshal.tsx'), 'utf8');
  const patched = patch(source);
  assert.equal(patched, source, 'The install-time Expo DOM fix must be applied');
  assert.equal(patch(patched), patched);
  const listeners = new Set<(event: unknown) => void>();
  const window: any = {
    addEventListener: (_: string, listener: (event: unknown) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: unknown) => void) => listeners.delete(listener),
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(patched, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, window, console,
    require: () => ({ DOM_EVENT: 'event', NATIVE_ACTION: 'action', NATIVE_ACTION_RESULT: 'result' }),
  });
  window.$$EXPO_INITIAL_PROPS = {};
  window.ReactNativeWebView = { postMessage: (json: string) => {
    const { data } = JSON.parse(json);
    for (const listener of listeners) listener({ detail: { type: 'result', data: { ...data, result: 'ready' } } });
  } };
  assert.equal(await exports.getActionsObject().onReady(), 'ready');
  assert.equal(listeners.size, 0);
});

test('Expo DOM measures initial and changing height even when Android injects after DOMContentLoaded', () => {
  const source = fs.readFileSync(path.join(path.dirname(require.resolve('expo/package.json')), 'src/dom/injection.ts'), 'utf8');
  const patched = patchSizeObserver(source);
  assert.equal(patched, source, 'The install-time size observer fix must be applied');
  assert.equal(patchSizeObserver(patched), patched);
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(patched, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
  for (const readyState of ['loading', 'complete']) {
    const messages: any[] = [];
    let loaded: (() => void) | undefined;
    let resized: ((entries: unknown[]) => void) | undefined;
    const body = { clientWidth: 220, clientHeight: 140 };
    vm.runInNewContext(exports.getInjectBodySizeObserverScript(), {
      document: { readyState, body },
      window: {
        addEventListener: (_: string, callback: () => void) => { loaded = callback; },
        ReactNativeWebView: { postMessage: (value: string) => messages.push(JSON.parse(value)) },
      },
      ResizeObserver: class {
        constructor(callback: (entries: unknown[]) => void) { resized = callback; }
        observe(element: unknown) { assert.equal(element, body); }
      },
    });
    if (readyState === 'loading') loaded!();
    assert.deepEqual(messages.map((message) => message.data), [{ width: 220, height: 140 }]);
    resized!([{ contentRect: { width: 220, height: 80 } }]);
    assert.deepEqual(messages[1].data, { width: 220, height: 80 });
  }
});
