import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');

test('new-session agent choices reserve their visible height before Project', () => {
  assert.match(source, /agentChoiceMotion: \{ flex: 1, minWidth: 0, minHeight: 50 \}/);
});
