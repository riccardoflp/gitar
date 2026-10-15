import * as assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildAnchors, mapPosition } from '../../src/flow/diff/scrollMap';

// 20px lines. Left: 10 context lines, a 1-line chunk, 10 context lines.
// Right: same context, but the chunk is 5 lines tall.
const { left, right } = buildAnchors([
  [200, 200], // chunk top
  [220, 300], // chunk bottom
  [420, 500], // content end
]);

test('context above the first chunk scrolls 1:1', () => {
  assert.equal(mapPosition(0, left, right), 0);
  assert.equal(mapPosition(150, left, right), 150);
  assert.equal(mapPosition(150, right, left), 150);
});

test('a chunk of different heights stretches linearly', () => {
  assert.equal(mapPosition(210, left, right), 250); // middle ↔ middle
  assert.equal(mapPosition(250, right, left), 210);
});

test('context after the chunk is 1:1 again, offset by the height difference', () => {
  assert.equal(mapPosition(320, left, right), 400);
  assert.equal(mapPosition(400, right, left), 320);
});

test('positions past the last anchor continue 1:1', () => {
  assert.equal(mapPosition(520, left, right), 600);
});

test('a zero-height side maps the whole other chunk onto its boundary', () => {
  // pure insertion: left has only a boundary at 200, right spans 200..300
  const a = buildAnchors([[200, 200], [200, 300]]);
  assert.equal(mapPosition(250, a.right, a.left), 200);
  // from the zero-height side, the boundary maps to the chunk's top
  assert.equal(mapPosition(200, a.left, a.right), 200);
});

test('anchors stay monotonic even if a pair goes backwards', () => {
  const a = buildAnchors([[100, 100], [90, 120]]);
  assert.deepEqual(a.left, [0, 100, 100]);
  assert.deepEqual(a.right, [0, 100, 120]);
});
