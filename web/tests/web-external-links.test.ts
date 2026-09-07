import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');

test('web links open a separate tab while native keeps platform linking', () => {
  assert.match(source, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
  assert.match(source, /MarkdownInline[\s\S]*?openExternalUrl\(span\.url!\)/);
  assert.match(source, /const openPreview[\s\S]*?openExternalUrl\(url\)/);
  assert.match(source, /const openCloudProviderLogin[\s\S]*?openExternalUrl\(flow\.url\)/);
});
