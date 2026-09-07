import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraZoomFromPinch } from '../src/scanner-zoom';

test('pinch zoom changes the camera and stays inside its useful range', () => {
  assert.equal(cameraZoomFromPinch(0, 100, 200), 0.4);
  assert.equal(cameraZoomFromPinch(0.5, 200, 50), 0);
  assert.equal(cameraZoomFromPinch(0.5, 100, 500), 0.7);
});
