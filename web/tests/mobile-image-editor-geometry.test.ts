import assert from 'node:assert/strict';
import test from 'node:test';

import {
  arrowPath,
  editorGestureMode,
  imagePointFromStage,
  viewportFromPinch,
  zoomFromPinch,
} from '../src/mobile-image-editor-geometry';

test('pinch always zooms instead of painting', () => {
  assert.equal(editorGestureMode('draw', 2), 'zoom');
  assert.equal(editorGestureMode('arrow', 1), 'arrow');
  assert.equal(editorGestureMode('move', 1), 'pan');
  assert.equal(editorGestureMode('text', 1), 'text');
});

test('arrow path points both head wings behind the tip', () => {
  assert.equal(
    arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 20),
    'M0.0 0.0 L100.0 0.0 M100.0 0.0 L82.0 8.7 M100.0 0.0 L82.0 -8.7',
  );
});

test('maps a panned and zoomed stage point back to image coordinates', () => {
  assert.deepEqual(imagePointFromStage({
    point: { x: 170, y: 115 },
    stage: { width: 300, height: 200 },
    fitted: { width: 200, height: 100 },
    image: { width: 1000, height: 500 },
    viewport: { x: 20, y: 15, scale: 1.5 },
  }), { x: 500, y: 250 });
});

test('clamps pinch zoom to the useful editor range', () => {
  assert.equal(zoomFromPinch(1, 100, 250), 2.5);
  assert.equal(zoomFromPinch(3, 100, 250), 4);
  assert.equal(zoomFromPinch(1, 100, 10), 1);
});

test('pinch zoom keeps the detail below the fingers in place', () => {
  assert.deepEqual(viewportFromPinch({
    viewport: { x: 0, y: 0, scale: 1 },
    startDistance: 100,
    currentDistance: 180,
    startCenter: { x: 150, y: 300 },
    currentCenter: { x: 165, y: 310 },
    stage: { width: 390, height: 844 },
  }), { x: 51, y: 107.6, scale: 1.8 });
});
