import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { shouldDismissSheet } from '../src/sheet-dismiss';

const source = readFileSync(fileURLToPath(new URL('../src/bottom-sheet.tsx', import.meta.url)), 'utf8');

test('a short downward drag keeps the sheet open', () => {
  assert.equal(shouldDismissSheet(80, 0.2), false);
});

test('a long downward drag closes the sheet', () => {
  assert.equal(shouldDismissSheet(90, 0.2), true);
});

test('a fast flick closes the sheet', () => {
  assert.equal(shouldDismissSheet(40, 1.3), true);
});

test('opening a sheet does not wait an extra JavaScript frame', () => {
  assert.match(source, /if \(open && !reduceMotion\) settleOpen\(\);/);
  assert.doesNotMatch(source, /requestAnimationFrame\(settleOpen\)/);
});
