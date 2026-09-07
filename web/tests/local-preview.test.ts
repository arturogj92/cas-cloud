import assert from 'node:assert/strict';
import test from 'node:test';

import { localPreviewUrls } from '../src/local-preview';

test('finds the same safe localhost previews in every canonical agent message', () => {
  for (const agent of ['claude', 'codex', 'opencode', 'kimi', 'antigravity', 'grok']) {
    assert.deepEqual(localPreviewUrls(
      `${agent}: http://localhost:3000/dashboard, http://127.0.0.1:5173/ and http://[::1]:8080/docs. `
      + 'Ignore https://example.com and http://192.168.1.20:3000.'
    ), [
      'http://localhost:3000/dashboard',
      'http://127.0.0.1:5173/',
      'http://[::1]:8080/docs',
    ]);
  }
});

test('deduplicates repeated previews and ignores malformed ports', () => {
  assert.deepEqual(localPreviewUrls(
    '[app](http://localhost:3000) and http://localhost:3000 then http://localhost:70000'
  ), ['http://localhost:3000']);
});
