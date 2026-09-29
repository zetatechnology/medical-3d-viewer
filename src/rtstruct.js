'use strict';

const { DicomError, parseDicom, TS_IMPLICIT, TS_EXPLICIT } = require('./dicom');

const RTSTRUCT = '1.2.840.10008.5.1.4.1.1.481.3';
const SEQUENCES = new Set([0x30060020, 0x30060039, 0x30060040, 0x30060016]);
const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const MAX_CONTOUR_POINTS = 1_000_000;

function tag(data, offset) {
  return ((data.readUInt16LE(offset) << 16) | data.readUInt16LE(offset + 2)) >>> 0;
}

function header(data, offset, explicit) {
  if (offset + 8 > data.length) throw new DicomError('RTSTRUCT', 'An RTSTRUCT element is truncated.');
  const id = tag(data, offset);
  if ((id >>> 16) === 0xfffe || !explicit) {
    return { id, length: data.readUInt32LE(offset + 4), start: offset + 8 };
  }
  const vr = data.toString('ascii', offset + 4, offset + 6);
  if (LONG_VR.has(vr)) {
    if (offset + 12 > data.length) throw new DicomError('RTSTRUCT', 'An RTSTRUCT element is truncated.');
    return { id, vr, length: data.readUInt32LE(offset + 8), start: offset + 12 };
  }
  return { id, vr, length: data.readUInt16LE(offset + 6), start: offset + 8 };
}

function textValue(data, entry) {
  return data.toString('utf8', entry.start, entry.start + entry.length).replace(/[\0 ]+$/g, '').trim();
}

function parseItems(data, start, end, explicit, undefinedLength, depth) {
  if (depth > 12) throw new DicomError('RTSTRUCT', 'RTSTRUCT nesting is too deep.');
  const items = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    const entry = header(data, cursor, explicit);
    if (entry.id === 0xfffee0dd) {
      if (!undefinedLength || entry.length !== 0) throw new DicomError('RTSTRUCT', 'Invalid RTSTRUCT sequence delimiter.');
      return { items, end: entry.start };
    }
    if (entry.id !== 0xfffee000) throw new DicomError('RTSTRUCT', 'Invalid RTSTRUCT item.');
    const itemEnd = entry.length === 0xffffffff ? end : entry.start + entry.length;
    if (itemEnd > end) throw new DicomError('RTSTRUCT', 'An RTSTRUCT item is truncated.');
    const parsed = parseElements(data, entry.start, itemEnd, explicit, entry.length === 0xffffffff, depth + 1);
    items.push(parsed.values);
    cursor = parsed.end;
  }
  if (undefinedLength || cursor !== end) throw new DicomError('RTSTRUCT', 'An RTSTRUCT sequence is truncated.');
  return { items, end: cursor };
}

function parseElements(data, start, end, explicit, undefinedLength = false, depth = 0) {
  const values = new Map();
  let cursor = start;
  while (cursor + 8 <= end) {
    const entry = header(data, cursor, explicit);
    if (entry.id === 0xfffee00d) {
      if (!undefinedLength || entry.length !== 0) throw new DicomError('RTSTRUCT', 'Invalid RTSTRUCT item delimiter.');
      return { values, end: entry.start };
    }
    if (SEQUENCES.has(entry.id) || entry.vr === 'SQ' || entry.length === 0xffffffff) {
      const sequenceEnd = entry.length === 0xffffffff ? end : entry.start + entry.length;
      if (sequenceEnd > end) throw new DicomError('RTSTRUCT', 'An RTSTRUCT sequence is truncated.');
      const parsed = parseItems(data, entry.start, sequenceEnd, explicit, entry.length === 0xffffffff, depth + 1);
      if (SEQUENCES.has(entry.id)) values.set(entry.id, parsed.items);
      cursor = parsed.end;
    } else {
      if (entry.length === 0xffffffff || entry.start + entry.length > end) {
        throw new DicomError('RTSTRUCT', 'Invalid RTSTRUCT element length.');
      }
      if ([0x30060022, 0x30060024, 0x30060026, 0x3006002a, 0x30060084,
        0x30060042, 0x30060046, 0x30060050, 0x00081155].includes(entry.id)) {
        values.set(entry.id, textValue(data, entry));
      }
      cursor = entry.start + entry.length;
    }
  }
  if (undefinedLength || cursor !== end) throw new DicomError('RTSTRUCT', 'An RTSTRUCT element is truncated.');
  return { values, end: cursor };
}

function parseRtstruct(data) {
  const meta = parseDicom(data, { headerOnly: true });
  if (meta.sopClass !== RTSTRUCT || meta.modality !== 'RTSTRUCT') {
    throw new DicomError('RTSTRUCT', 'This is not an RT Structure Set.');
  }
  if (![TS_IMPLICIT, TS_EXPLICIT].includes(meta.syntax)) throw new DicomError('TRANSFER_SYNTAX', 'Unsupported RTSTRUCT Transfer Syntax.');
  let cursor = 132;
  while (cursor + 8 <= data.length && (tag(data, cursor) >>> 16) === 0x0002) {
    const entry = header(data, cursor, true);
    cursor = entry.start + entry.length;
  }
  const root = parseElements(data, cursor, data.length, meta.syntax === TS_EXPLICIT).values;
  const definitions = new Map();
  for (const item of root.get(0x30060020) || []) {
    const number = Number(item.get(0x30060022));
    if (Number.isInteger(number)) definitions.set(number, {
      number, name: item.get(0x30060026) || '', frameOfReferenceUid: item.get(0x30060024)
    });
  }
  const rois = [];
  let pointCount = 0;
  for (const item of root.get(0x30060039) || []) {
    const number = Number(item.get(0x30060084));
    const definition = definitions.get(number);
    if (!definition) continue;
    const colorValues = (item.get(0x3006002a) || '').split('\\').map(Number);
    const color = colorValues.length === 3 && colorValues.every(v => Number.isInteger(v) && v >= 0 && v <= 255)
      ? colorValues : [255, 192, 0];
    const contours = [];
    for (const contour of item.get(0x30060040) || []) {
      if (contour.get(0x30060042) !== 'CLOSED_PLANAR') continue;
      const values = (contour.get(0x30060050) || '').split('\\').map(Number);
      const count = Number(contour.get(0x30060046));
      if (!Number.isInteger(count) || count < 3 || values.length !== count * 3 ||
          values.some(v => !Number.isFinite(v))) throw new DicomError('RTSTRUCT', 'Invalid ROI contour coordinates.');
      pointCount += count;
      if (pointCount > MAX_CONTOUR_POINTS) throw new DicomError('RTSTRUCT', 'ROI contour point limit exceeded.');
      contours.push({ points: values });
    }
    if (contours.length) rois.push({ number, name: definition.name,
      frameOfReferenceUid: definition.frameOfReferenceUid, color, contours });
  }
  return { rois };
}

module.exports = { RTSTRUCT, parseRtstruct };
