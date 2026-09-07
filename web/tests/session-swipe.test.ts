import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SESSION_ACTIONS_WIDTH,
  SESSION_CLOSE_SWIPE_THRESHOLD,
  isSessionCloseArmed,
  isSessionSwipeGesture,
  shouldOpenSessionAfterScroll,
  shouldOpenSessionActions,
} from '../src/session-swipe';

test('a slightly diagonal swipe still counts as a swipe', () => {
  assert.equal(isSessionSwipeGesture(-120, 100), true);
  assert.equal(isSessionSwipeGesture(-130, 30), true);
});

test('a mostly vertical scroll does not start a swipe', () => {
  assert.equal(isSessionSwipeGesture(-40, 140), false);
  assert.equal(isSessionSwipeGesture(-40, 48), false);
});

test('a short flick does not open the actions', () => {
  assert.equal(isSessionSwipeGesture(-60, 0), true);
  assert.equal(shouldOpenSessionActions(-60, false), false);
});

test('a committed left swipe opens the actions', () => {
  assert.equal(shouldOpenSessionActions(-120, false), true);
});

test('close arms only beyond the second swipe threshold', () => {
  assert.equal(isSessionCloseArmed(-SESSION_ACTIONS_WIDTH), false);
  assert.equal(isSessionCloseArmed(-SESSION_ACTIONS_WIDTH - 60), false);
  assert.equal(isSessionCloseArmed(-SESSION_CLOSE_SWIPE_THRESHOLD + 1), false);
  assert.equal(isSessionCloseArmed(-SESSION_CLOSE_SWIPE_THRESHOLD), true);
});

test('a session opens only after scrolling has fully settled', () => {
  assert.equal(shouldOpenSessionAfterScroll(true, 0, 1_000), false);
  assert.equal(shouldOpenSessionAfterScroll(false, 900, 1_000), false);
  assert.equal(shouldOpenSessionAfterScroll(false, 800, 1_000), true);
});
