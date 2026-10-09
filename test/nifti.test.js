'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNifti, scanNiftiRange, decodeNiftiSlice, NiftiError } = require('../src/nifti');
const { prepareLabels } = require('../src/nifti-labels');

function sample(options = {}) {
  const data = Buffer.alloc(352 + 2 * 2 * 2 * 2);
  data.writeInt32LE(348, 0);
  data.writeInt16LE(3, 40);
  data.writeInt16LE(2, 42); data.writeInt16LE(2, 44); data.writeInt16LE(2, 46);
  data.writeInt16LE(1, 48); data.writeInt16LE(1, 50); data.writeInt16LE(1, 52); data.writeInt16LE(1, 54);
  data.writeInt16LE(4, 70); data.writeInt16LE(16, 72);
  data.writeFloatLE(0.5, 80); data.writeFloatLE(0.75, 84); data.writeFloatLE(2, 88);
  data.writeFloatLE(352, 108); data.writeFloatLE(options.slope ?? 2, 112); data.writeFloatLE(options.intercept ?? -10, 116);
  data.writeInt16LE(1, 254);
  [-0.5, 0, 0, 10, 0, -0.75, 0, 20, 0, 0, 2, -30].forEach((value, index) => {
    const row = Math.floor(index / 4), column = index % 4;
    data.writeFloatLE(value, 280 + row * 16 + column * 4);
  });
  data.write('n+1\0', 344, 4, 'ascii');
  [0, 1, 2, 3, 4, 5, 6, 7].forEach((value, index) => data.writeInt16LE(value, 352 + index * 2));
  return data;
}

test('parses NIfTI-1 geometry and converts RAS coordinates to LPS', () => {
  const volume = parseNifti(sample());
  assert.deepEqual([volume.columns, volume.rows, volume.count], [2, 2, 2]);
  assert.deepEqual(volume.spacing, [0.75, 0.5]);
  assert.equal(volume.sliceSpacing, 2);
  assert.deepEqual(volume.origin, [-10, -20, -30]);
  assert.deepEqual(volume.row, [1, -0, 0]);
  assert.deepEqual(volume.column, [-0, 1, 0]);
  assert.deepEqual(volume.normal, [-0, -0, 1]);
});

test('decodes a slice and applies scaling', () => {
  const volume = parseNifti(sample());
  assert.deepEqual([...decodeNiftiSlice(volume, 1)], [-2, 0, 2, 4]);
  assert.deepEqual(scanNiftiRange(volume), { minimum: -10, maximum: 4 });
  const bytes = decodeNiftiSlice(parseNifti(sample({ slope: 1, intercept: 0 })), 0, 'uint8');
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes], [0, 1, 2, 3]);
});

test('rejects four-dimensional and truncated data', () => {
  const fourD = sample();
  fourD.writeInt16LE(4, 40); fourD.writeInt16LE(2, 48);
  assert.throws(() => parseNifti(fourD), error => error instanceof NiftiError && error.code === 'DIMENSIONS');
  assert.throws(() => parseNifti(sample().subarray(0, 355)), error => error instanceof NiftiError && error.code === 'FORMAT');
});

test('maps non-contiguous label IDs to independent mask bits with full precision', () => {
  const data = sample({ slope: 1, intercept: 0 });
  [0, 3, 1000, 3, 1000, 0, 3, 0].forEach((value, i) => data.writeInt16LE(value, 352 + i * 2));
  const volume = parseNifti(data);
  const labels = prepareLabels(volume, volume);
  assert.deepEqual(labels.rois.map(roi => roi.number), [3, 1000]);
  assert.deepEqual([...labels.decodeSlice(0)], [0, 1, 2, 1]);
  assert.deepEqual([...labels.decodeSlice(1)], [2, 0, 1, 0]);
  const scaled = parseNifti(sample({ slope: 16777218, intercept: 0 }));
  assert.equal(prepareLabels(scaled, scaled).rois[2].number, scaled.slope * 3);
});

test('rejects geometry mismatches, invalid labels, empty masks and excess labels', () => {
  const volume = parseNifti(sample({ slope: 1, intercept: 0 }));
  for (const change of [{ rows: 3 }, { origin: [1, 2, 3] }, { row: [-1, 0, 0] },
    { spacing: [1, 1] }, { sliceSpacing: 3 }]) {
    assert.throws(() => prepareLabels(volume, { ...volume, ...change }), /match/);
  }
  for (const options of [{ slope: 0.5, intercept: 0 }, { slope: 1, intercept: -1 }])
    assert.throws(() => prepareLabels(volume, parseNifti(sample(options))), /non-negative integer/);
  const empty = sample({ slope: 1, intercept: 0 }); empty.fill(0, 352);
  assert.throws(() => prepareLabels(volume, parseNifti(empty)), /only background/);
  const data = Buffer.alloc(352 + 66);
  sample({ slope: 1, intercept: 0 }).copy(data);
  data.writeInt16LE(33, 42); data.writeInt16LE(1, 44); data.writeInt16LE(1, 46);
  for (let i = 0; i < 33; i++) data.writeInt16LE(i + 1, 352 + i * 2);
  const many = parseNifti(data);
  assert.throws(() => prepareLabels(many, many), /Up to 32/);
});

test('supports 32 labels including the highest unsigned mask bit', () => {
  const data = Buffer.alloc(352 + 64);
  sample({ slope: 1, intercept: 0 }).copy(data);
  data.writeInt16LE(32, 42); data.writeInt16LE(1, 44); data.writeInt16LE(1, 46);
  for (let i = 0; i < 32; i++) data.writeInt16LE(i + 1, 352 + i * 2);
  const volume = parseNifti(data), labels = prepareLabels(volume, volume);
  assert.equal(labels.rois.length, 32);
  const slice = labels.decodeSlice(0);
  assert.ok(slice instanceof Uint32Array);
  assert.equal(slice[8], 256);
  assert.equal(slice[31], 0x80000000);
  assert.ok(labels.rois.every(roi => roi.color.length === 3 && roi.color.every(c => c >= 0 && c <= 255)));
});
