import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEB_HOST_ICON_IDS,
  WEB_HOST_ICONS_KEY,
  defaultWebHostIcon,
  loadWebHostIcons,
  saveWebHostIcon,
} from '../src/web-host-icons';

test('uses host-aware defaults and persists only supported browser choices', () => {
  assert.deepEqual(WEB_HOST_ICON_IDS, ['vps', 'mac', 'windows', 'linux', 'desktop', 'laptop', 'cloud', 'mini-pc', 'home-lab', 'nas']);
  assert.equal(defaultWebHostIcon({ kind: 'cloud', platform: 'win32' }), 'vps');
  assert.equal(defaultWebHostIcon({ kind: 'desktop', platform: 'darwin' }), 'mac');
  assert.equal(defaultWebHostIcon({ kind: 'desktop', platform: 'win32' }), 'windows');
  assert.equal(defaultWebHostIcon({ kind: 'desktop', platform: 'linux' }), 'linux');
  assert.equal(defaultWebHostIcon({ kind: 'desktop', platform: 'unknown' }), 'desktop');

  const values = new Map([[WEB_HOST_ICONS_KEY, JSON.stringify({ mac1: 'mac', bad: 'phone' })]]);
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const loaded = loadWebHostIcons(storage);
  assert.deepEqual(loaded, { mac1: 'mac' });
  assert.deepEqual(saveWebHostIcon(storage, loaded, 'mac2', 'mini-pc'), { mac1: 'mac', mac2: 'mini-pc' });
  assert.deepEqual(JSON.parse(values.get(WEB_HOST_ICONS_KEY) || '{}'), { mac1: 'mac', mac2: 'mini-pc' });
});
