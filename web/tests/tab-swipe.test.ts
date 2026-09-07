import assert from 'node:assert/strict';
import test from 'node:test';
import { isTabSwipeGesture, settledTab, tabDragOffset } from '../src/tab-swipe';

test('claims only a horizontal gesture toward the neighbouring tab', () => {
  assert.equal(isTabSwipeGesture('sessions', -40, 12), true);
  assert.equal(isTabSwipeGesture('sessions', 40, 12), false);
  assert.equal(isTabSwipeGesture('history', 40, 12), true);
  assert.equal(isTabSwipeGesture('history', 20, 40), false);
  assert.equal(isTabSwipeGesture('kanban', -40, 12), false);
});

test('keeps the two-screen track inside its bounds', () => {
  assert.equal(tabDragOffset('sessions', 390, -160), -160);
  assert.equal(tabDragOffset('sessions', 390, 40), 0);
  assert.equal(tabDragOffset('history', 390, 160), -230);
  assert.equal(tabDragOffset('history', 390, -40), -390);
  assert.equal(tabDragOffset('projects', 390, -40), 0);
});

test('settles by distance or velocity and otherwise returns home', () => {
  assert.equal(settledTab('sessions', -85, 0, 390), 'sessions');
  assert.equal(settledTab('sessions', -86, 0, 390), 'history');
  assert.equal(settledTab('sessions', -30, -.5, 390), 'history');
  assert.equal(settledTab('history', 86, 0, 390), 'sessions');
});
