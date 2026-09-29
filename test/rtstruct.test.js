'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DicomError, TS_EXPLICIT, TS_IMPLICIT } = require('../src/dicom');
const { parseRtstruct } = require('../src/rtstruct');

function element(group, id, vr, value, implicit = false, undefinedLength = false) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'ascii');
  const padded = bytes.length % 2 ? Buffer.concat([bytes, Buffer.from([vr === 'UI' ? 0 : 32])]) : bytes;
  const long = ['SQ', 'OB', 'OW', 'UN'].includes(vr);
  const header = Buffer.alloc(implicit || !long ? 8 : 12);
  header.writeUInt16LE(group, 0); header.writeUInt16LE(id, 2);
  if (implicit) header.writeUInt32LE(undefinedLength ? 0xffffffff : padded.length, 4);
  else {
    header.write(vr, 4, 2, 'ascii');
    if (long) header.writeUInt32LE(undefinedLength ? 0xffffffff : padded.length, 8);
    else header.writeUInt16LE(padded.length, 6);
  }
  return Buffer.concat([header, padded]);
}

function delimiter(id) {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(0xfffe); b.writeUInt16LE(id, 2);
  return b;
}

function item(bytes, undefinedLength = false) {
  const header = delimiter(0xe000);
  header.writeUInt32LE(undefinedLength ? 0xffffffff : bytes.length, 4);
  return Buffer.concat([header, bytes, ...(undefinedLength ? [delimiter(0xe00d)] : [])]);
}

function sequence(id, items, implicit, undefinedLength = false) {
  return Buffer.concat([element(0x3006, id, 'SQ', Buffer.concat(items), implicit, undefinedLength),
    ...(undefinedLength ? [delimiter(0xe0dd)] : [])]);
}

function fixture(implicit = false, badCount = false) {
  const e = (g, id, vr, value) => element(g, id, vr, value, implicit);
  const definition = item(Buffer.concat([
    e(0x3006, 0x0022, 'IS', '1'), e(0x3006, 0x0024, 'UI', '1.2.3.4'),
    e(0x3006, 0x0026, 'LO', 'Test ROI')
  ]), true);
  const contour = item(Buffer.concat([
    e(0x3006, 0x0042, 'CS', 'CLOSED_PLANAR'),
    e(0x3006, 0x0046, 'IS', badCount ? '4' : '3'),
    e(0x3006, 0x0050, 'DS', '0\\0\\0\\1\\0\\0\\0\\1\\0')
  ]));
  const roi = item(Buffer.concat([
    e(0x3006, 0x0084, 'IS', '1'), e(0x3006, 0x002a, 'IS', '255\\0\\128'),
    sequence(0x0040, [contour], implicit, true)
  ]));
  const prefix = Buffer.alloc(132); prefix.write('DICM', 128);
  return Buffer.concat([
    prefix, element(0x0002, 0x0010, 'UI', implicit ? TS_IMPLICIT : TS_EXPLICIT),
    e(0x0008, 0x0016, 'UI', '1.2.840.10008.5.1.4.1.1.481.3'),
    e(0x0008, 0x0060, 'CS', 'RTSTRUCT'),
    sequence(0x0020, [definition], implicit, true),
    sequence(0x0039, [roi], implicit)
  ]);
}

for (const implicit of [false, true]) {
  test(`parses ${implicit ? 'implicit' : 'explicit'} VR RTSTRUCT contours`, () => {
    const parsed = parseRtstruct(fixture(implicit));
    assert.equal(parsed.rois.length, 1);
    assert.equal(parsed.rois[0].frameOfReferenceUid, '1.2.3.4');
    assert.equal(parsed.rois[0].name, 'Test ROI');
    assert.deepEqual(parsed.rois[0].color, [255, 0, 128]);
    assert.deepEqual(parsed.rois[0].contours[0].points, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
}

test('rejects contour coordinate count mismatch', () => {
  assert.throws(() => parseRtstruct(fixture(true, true)),
    error => error instanceof DicomError && error.code === 'RTSTRUCT');
});
