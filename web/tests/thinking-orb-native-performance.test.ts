import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../src/thinking-orb.native.tsx', import.meta.url)), 'utf8');

test('native Thinking Orbs keep the engine motion on one canvas', () => {
  assert.match(source, /@shopify\/react-native-skia/);
  assert.match(source, /createPicture/);
  assert.match(source, /MODE_FRAMES\[preset\.mode\]/);
  assert.match(source, /draw\(\(now \/ 1000\) \* preset\.speed\)/);
  assert.doesNotMatch(source, /lastPaint/);
  assert.doesNotMatch(source, /Animated\.loop|rotate:/);
  assert.doesNotMatch(source, /react-native-svg/);
});
