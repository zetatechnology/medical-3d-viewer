'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMask, MAX_ROIS } = require('../media/roi-mask');

const meta = {
  columns: 3, rows: 3, count: 2,
  origin: [0, 0, 0], row: [1, 0, 0], column: [0, 1, 0], normal: [0, 0, 1],
  spacing: [1, 1], sliceSpacing: 1
};

function square(x0, y0, x1, y1, z) {
  return { points: [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z] };
}

test('rasterizes closed contours into separate 3D ROI bits, preserving overlap', () => {
  const result = buildMask({ ...meta, rois: [
    { number: 1, contours: [square(-0.4, -0.4, 2.4, 2.4, 0), square(-0.4, -0.4, 2.4, 2.4, 1)] },
    { number: 2, contours: [square(0.6, 0.6, 1.4, 1.4, 0)] }
  ] });
  assert.equal(result.data.length, 18);
  assert.equal(result.data[4], 3);
  assert.equal(result.data[13], 1);
  assert.equal(result.data[0], 1);
  assert.equal(result.skippedContours, 0);
});

test('skips contours that are not parallel to CT slices', () => {
  const tilted = { points: [0, 0, 0, 2, 0, 0, 2, 2, 0.5, 0, 2, 0] };
  const result = buildMask({ ...meta, rois: [{ number: 1, contours: [tilted] }] });
  assert.equal(result.skippedContours, 1);
  assert.ok(result.data.every(value => value === 0));
  assert.equal(MAX_ROIS, 8);
});
