import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');

test('web scrollbars stay thin and omit browser arrow buttons', () => {
  assert.match(html, /scrollbar-width:\s*thin/);
  assert.match(html, /\*::\-webkit-scrollbar\s*\{[^}]*width:\s*8px/s);
  assert.match(html, /\*::\-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*999px/s);
  assert.match(html, /\*::\-webkit-scrollbar-button\s*\{[^}]*display:\s*none/s);
  assert.match(app, /--cas-scrollbar-thumb', colors\.borderStrong/);
  assert.match(app, /--cas-scrollbar-thumb-hover', colors\.muted/);
});
