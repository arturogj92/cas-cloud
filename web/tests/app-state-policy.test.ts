import assert from 'node:assert/strict';
import test from 'node:test';

import { connectionNoticeEligible, runtimeActivityForAppState } from '../src/app-state-policy';

test('native inactive transitions keep the current mobile socket', () => {
  assert.deepEqual(runtimeActivityForAppState('active', 'android'), { active: true, delayMs: 0 });
  assert.deepEqual(runtimeActivityForAppState('background', 'ios'), { active: false, delayMs: 0 });
  assert.deepEqual(runtimeActivityForAppState('background', 'web'), { active: true, delayMs: 0 });
  assert.equal(runtimeActivityForAppState('inactive', 'ios'), null);
});

test('Android gives transient system activities time to return before suspending', () => {
  assert.deepEqual(runtimeActivityForAppState('background', 'android'), { active: false, delayMs: 1_500 });
});

test('automatic reconnect stays silent while confirmed foreground outages remain visible', () => {
  assert.equal(connectionNoticeEligible('connecting', true), false);
  assert.equal(connectionNoticeEligible('offline', false), false);
  assert.equal(connectionNoticeEligible('error', false), false);
  assert.equal(connectionNoticeEligible('offline', true), true);
  assert.equal(connectionNoticeEligible('error', true), true);
  assert.equal(connectionNoticeEligible('online', true), false);
});
