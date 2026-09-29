'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDicom, validateSeries, decodePixels, DicomError, TS_EXPLICIT, TS_IMPLICIT, CT_IMAGE } = require('../src/dicom');

function element(group, id, vr, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'ascii');
  const padded = bytes.length % 2 ? Buffer.concat([bytes, Buffer.from([vr === 'UI' ? 0 : 32])]) : bytes;
  const long = ['OB', 'OW', 'SQ', 'UN'].includes(vr);
  const header = Buffer.alloc(long ? 12 : 8);
  header.writeUInt16LE(group, 0); header.writeUInt16LE(id, 2);
  header.write(vr, 4, 2, 'ascii');
  if (long) header.writeUInt32LE(padded.length, 8);
  else header.writeUInt16LE(padded.length, 6);
  return Buffer.concat([header, padded]);
}

function us(group, id, value) {
  const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value);
  return element(group, id, 'US', bytes);
}

function implicitElement(group, id, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'ascii');
  const padded = bytes.length % 2 ? Buffer.concat([bytes, Buffer.from([32])]) : bytes;
  const header = Buffer.alloc(8);
  header.writeUInt16LE(group, 0); header.writeUInt16LE(id, 2);
  header.writeUInt32LE(padded.length, 4);
  return Buffer.concat([header, padded]);
}

function sample(options = {}) {
  const pixels = Buffer.alloc(8);
  [0, 100, 2048, 4095].forEach((value, i) => pixels.writeUInt16LE(value, i * 2));
  const elements = [
    element(0x0008, 0x0016, 'UI', CT_IMAGE),
    element(0x0008, 0x0060, 'CS', 'CT'),
    element(0x0020, 0x000d, 'UI', '1.2.3'),
    element(0x0020, 0x000e, 'UI', '1.2.3.4'),
    element(0x0020, 0x0032, 'DS', `0\\0\\${options.z ?? 0}`),
    element(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0'),
    element(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
    element(0x0028, 0x0030, 'DS', '0.7\\0.8'),
    us(0x0028, 0x0002, 1), us(0x0028, 0x0010, 2), us(0x0028, 0x0011, 2),
    us(0x0028, 0x0100, 16), us(0x0028, 0x0101, 12), us(0x0028, 0x0102, 11),
    us(0x0028, 0x0103, 1),
    element(0x0028, 0x1052, 'DS', '-1024'), element(0x0028, 0x1053, 'DS', '2'),
    element(0x7fe0, 0x0010, 'OW', pixels)
  ];
  const prefix = Buffer.alloc(132); prefix.write('DICM', 128, 'ascii');
  return Buffer.concat([prefix, element(0x0002, 0x0010, 'UI', options.syntax || TS_EXPLICIT), ...elements]);
}

test('parses Part 10 metadata and signed pixels with rescale', () => {
  const data = sample();
  const meta = parseDicom(data);
  assert.equal(meta.seriesUid, '1.2.3.4');
  assert.deepEqual(meta.spacing, [0.7, 0.8]);
  assert.deepEqual([...decodePixels(data, meta)], [-1024, -824, -5120, -1026]);
});

test('sorts slices by patient geometry rather than input order', () => {
  const images = [2, 0, 1].map(z => parseDicom(sample({ z })));
  const volume = validateSeries(images);
  assert.deepEqual(volume.images.map(image => image.position[2]), [0, 1, 2]);
  assert.equal(volume.sliceSpacing, 1);
});

test('rejects missing slice and unsupported transfer syntax', () => {
  assert.throws(() => validateSeries([0, 1, 3].map(z => parseDicom(sample({ z })))),
    error => error instanceof DicomError && error.code === 'GEOMETRY');
  assert.throws(() => parseDicom(sample({ syntax: '1.2.840.10008.1.2.4.90' })),
    error => error instanceof DicomError && error.code === 'TRANSFER_SYNTAX');
});

test('reads implicit VR image metadata and pixels', () => {
  const prefix = Buffer.alloc(132); prefix.write('DICM', 128, 'ascii');
  const rows = Buffer.alloc(2); rows.writeUInt16LE(2);
  const pixels = Buffer.alloc(8); pixels.writeUInt16LE(42);
  const data = Buffer.concat([
    prefix, element(0x0002, 0x0010, 'UI', TS_IMPLICIT),
    implicitElement(0x0028, 0x0010, rows), implicitElement(0x0028, 0x0011, rows),
    implicitElement(0x7fe0, 0x0010, pixels)
  ]);
  const parsed = parseDicom(data);
  assert.equal(parsed.syntax, TS_IMPLICIT);
  assert.equal(parsed.rows, 2);
  assert.equal(parsed.pixelLength, 8);
});

test('skips undefined length sequence before pixel data', () => {
  const sequence = Buffer.alloc(12); sequence.writeUInt16LE(0x0008); sequence.writeUInt16LE(0x1110, 2);
  sequence.write('SQ', 4); sequence.writeUInt32LE(0xffffffff, 8);
  const item = Buffer.alloc(8); item.writeUInt16LE(0xfffe); item.writeUInt16LE(0xe000, 2); item.writeUInt32LE(0xffffffff, 4);
  const itemEnd = Buffer.alloc(8); itemEnd.writeUInt16LE(0xfffe); itemEnd.writeUInt16LE(0xe00d, 2);
  const sequenceEnd = Buffer.alloc(8); sequenceEnd.writeUInt16LE(0xfffe); sequenceEnd.writeUInt16LE(0xe0dd, 2);
  const source = sample();
  const pixelTag = source.indexOf(Buffer.from([0xe0, 0x7f, 0x10, 0x00]));
  const data = Buffer.concat([source.subarray(0, pixelTag), sequence, item,
    element(0x0008, 0x1150, 'UI', CT_IMAGE), itemEnd, sequenceEnd, source.subarray(pixelTag)]);
  assert.equal(parseDicom(data).pixelLength, 8);
});
