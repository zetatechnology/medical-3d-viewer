'use strict';

const fs = require('node:fs/promises');

const TS_IMPLICIT = '1.2.840.10008.1.2';
const TS_EXPLICIT = '1.2.840.10008.1.2.1';
const CT_IMAGE = '1.2.840.10008.5.1.4.1.1.2';
const HEADER_LIMIT = 4 * 1024 * 1024;

class DicomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DicomError';
    this.code = code;
  }
}

function tagAt(data, offset) {
  return ((data.readUInt16LE(offset) << 16) | data.readUInt16LE(offset + 2)) >>> 0;
}

function elementAt(data, offset, explicit) {
  if (offset + 8 > data.length) throw new DicomError('TRUNCATED', 'A DICOM element is truncated.');
  const tag = tagAt(data, offset);
  if ((tag >>> 16) === 0xfffe) return { tag, length: data.readUInt32LE(offset + 4), value: offset + 8 };
  if (!explicit) return { tag, length: data.readUInt32LE(offset + 4), value: offset + 8 };
  const vr = data.toString('ascii', offset + 4, offset + 6);
  const long = ['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV'].includes(vr);
  if (long) {
    if (offset + 12 > data.length) throw new DicomError('TRUNCATED', 'A DICOM element is truncated.');
    return { tag, vr, length: data.readUInt32LE(offset + 8), value: offset + 12 };
  }
  return { tag, vr, length: data.readUInt16LE(offset + 6), value: offset + 8 };
}

function nextOffset(data, entry, explicit) {
  if (entry.length !== 0xffffffff) {
    const next = entry.value + entry.length;
    if (!Number.isSafeInteger(next) || next > data.length) throw new DicomError('TRUNCATED', 'A DICOM element is truncated.');
    return next;
  }
  let cursor = entry.value;
  let depth = 1;
  while (cursor + 8 <= data.length) {
    const nested = elementAt(data, cursor, explicit);
    if (nested.tag === 0xfffee0dd || nested.tag === 0xfffee00d) {
      depth--;
      cursor = nested.value + nested.length;
      if (depth === 0) return cursor;
      continue;
    }
    if (nested.length === 0xffffffff) {
      depth++;
      cursor = nested.value;
    } else {
      cursor = nested.value + nested.length;
    }
  }
  throw new DicomError('TRUNCATED', 'Could not read an undefined-length DICOM element.');
}

function stringValue(data, e) {
  return data.toString('utf8', e.value, e.value + e.length).replace(/[\0 ]+$/g, '').trim();
}

function numbers(data, e) {
  const result = stringValue(data, e).split('\\').map(Number);
  if (result.some(v => !Number.isFinite(v))) throw new DicomError('METADATA', 'Invalid numeric metadata.');
  return result;
}

function scalar(data, e) {
  if (e.length < 2) throw new DicomError('METADATA', 'Invalid numeric metadata.');
  return data.readUInt16LE(e.value);
}

function parseDicom(data, options = {}) {
  if (data.length < 132 || data.toString('ascii', 128, 132) !== 'DICM') {
    throw new DicomError('FORMAT', 'This is not a DICOM Part 10 file.');
  }
  let cursor = 132;
  let syntax;
  while (cursor + 8 <= data.length && (tagAt(data, cursor) >>> 16) === 0x0002) {
    const e = elementAt(data, cursor, true);
    if (e.tag === 0x00020010) syntax = stringValue(data, e);
    cursor = nextOffset(data, e, true);
  }
  if (!syntax) throw new DicomError('METADATA', 'Transfer Syntax UID is missing.');
  if (syntax !== TS_IMPLICIT && syntax !== TS_EXPLICIT) {
    throw new DicomError('TRANSFER_SYNTAX', `Unsupported Transfer Syntax: ${syntax}`);
  }
  const explicit = syntax === TS_EXPLICIT;
  const out = { syntax, pixelOffset: -1, pixelLength: 0 };
  const textTags = new Map([
    [0x00080060, 'modality'], [0x0020000d, 'studyUid'], [0x0020000e, 'seriesUid'],
    [0x00200011, 'seriesNumber'], [0x0008103e, 'description'],
    [0x00080016, 'sopClass'], [0x00080018, 'sopInstanceUid'],
    [0x00200052, 'frameOfReferenceUid'], [0x00280004, 'photometric']
  ]);
  const numberTags = new Map([
    [0x00200032, 'position'], [0x00200037, 'orientation'], [0x00280030, 'spacing'],
    [0x00281052, 'intercept'], [0x00281053, 'slope']
  ]);
  const scalarTags = new Map([
    [0x00280002, 'samplesPerPixel'], [0x00280010, 'rows'], [0x00280011, 'columns'],
    [0x00280100, 'bitsAllocated'], [0x00280101, 'bitsStored'], [0x00280102, 'highBit'],
    [0x00280103, 'pixelRepresentation']
  ]);
  while (cursor + 8 <= data.length) {
    const e = elementAt(data, cursor, explicit);
    if (e.tag === 0x7fe00010) {
      out.pixelOffset = e.value;
      out.pixelLength = e.length;
      break;
    }
    if (e.length !== 0xffffffff && e.value + e.length > data.length) {
      throw new DicomError('TRUNCATED', 'A DICOM element is truncated.');
    }
    if (textTags.has(e.tag)) out[textTags.get(e.tag)] = stringValue(data, e);
    if (numberTags.has(e.tag)) out[numberTags.get(e.tag)] = numbers(data, e);
    if (scalarTags.has(e.tag)) out[scalarTags.get(e.tag)] = scalar(data, e);
    cursor = nextOffset(data, e, explicit);
  }
  if (out.pixelOffset < 0 && !options.headerOnly) throw new DicomError('PIXEL_DATA', 'Pixel Data is missing.');
  return out;
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(v) { return Math.hypot(...v); }
function close(a, b, tolerance) { return Math.abs(a - b) <= tolerance; }

function validateSeries(images) {
  if (images.length < 2) throw new DicomError('SERIES', '3D display requires at least two slices.');
  const first = images[0];
  for (const image of images) {
    if (image.sopClass !== CT_IMAGE || image.modality !== 'CT') throw new DicomError('SOP_CLASS', 'Only single-frame CT images are supported.');
    if (image.photometric !== 'MONOCHROME2' || image.samplesPerPixel !== 1 || image.bitsAllocated !== 16 ||
        ![12, 16].includes(image.bitsStored) || image.highBit !== image.bitsStored - 1 ||
        ![0, 1].includes(image.pixelRepresentation)) throw new DicomError('PIXEL_FORMAT', 'Unsupported pixel format.');
    if (!image.seriesUid || !image.studyUid || !image.position || image.position.length !== 3 ||
        !image.orientation || image.orientation.length !== 6 || !image.spacing || image.spacing.length !== 2 ||
        !image.rows || !image.columns || image.spacing.some(v => v <= 0) ||
        (image.slope && image.slope.length !== 1) || (image.intercept && image.intercept.length !== 1)) {
      throw new DicomError('METADATA', 'Metadata required for 3D reconstruction is missing.');
    }
    if (image.rows !== first.rows || image.columns !== first.columns ||
        image.spacing.some((v, i) => !close(v, first.spacing[i], 1e-4)) ||
        image.orientation.some((v, i) => !close(v, first.orientation[i], 1e-4)) ||
        image.seriesUid !== first.seriesUid || image.studyUid !== first.studyUid ||
        image.frameOfReferenceUid !== first.frameOfReferenceUid) {
      throw new DicomError('GEOMETRY', 'Dimensions, pixel spacing, or orientation differ between slices.');
    }
    if (image.pixelOffset < 0 || image.pixelLength < image.rows * image.columns * 2) {
      throw new DicomError('PIXEL_DATA', 'Pixel Data is incomplete.');
    }
  }
  const row = first.orientation.slice(0, 3);
  const column = first.orientation.slice(3, 6);
  if (!close(norm(row), 1, 1e-3) || !close(norm(column), 1, 1e-3) || !close(dot(row, column), 0, 1e-3)) {
    throw new DicomError('GEOMETRY', 'Invalid image orientation.');
  }
  const normal = cross(row, column);
  const sorted = images.map(image => ({ ...image, location: dot(image.position, normal) }))
    .sort((a, b) => a.location - b.location);
  const step = sorted[1].location - sorted[0].location;
  if (step <= 1e-3) throw new DicomError('GEOMETRY', 'Duplicate slices detected.');
  const tolerance = Math.max(0.1, step * 0.05);
  for (let i = 1; i < sorted.length; i++) {
    if (!close(sorted[i].location - sorted[i - 1].location, step, tolerance)) {
      throw new DicomError('GEOMETRY', 'Slice spacing is uneven or slices are missing.');
    }
    const expected = sorted[0].position.map((v, j) => v + normal[j] * step * i);
    if (norm(sorted[i].position.map((v, j) => v - expected[j])) > tolerance) {
      throw new DicomError('GEOMETRY', 'Slice positions are not aligned.');
    }
  }
  return { images: sorted, rows: first.rows, columns: first.columns, spacing: first.spacing,
    origin: sorted[0].position, row, column, normal, sliceSpacing: step };
}

function decodePixels(data, meta) {
  const count = meta.rows * meta.columns;
  if (meta.pixelOffset + count * 2 > data.length) throw new DicomError('PIXEL_DATA', 'Pixel Data is truncated.');
  const output = new Float32Array(count);
  const mask = (1 << meta.bitsStored) - 1;
  const sign = 1 << (meta.bitsStored - 1);
  const slope = meta.slope?.[0] ?? 1;
  const intercept = meta.intercept?.[0] ?? 0;
  for (let i = 0; i < count; i++) {
    let raw = data.readUInt16LE(meta.pixelOffset + i * 2) & mask;
    if (meta.pixelRepresentation === 1 && (raw & sign)) raw -= (1 << meta.bitsStored);
    output[i] = raw * slope + intercept;
  }
  return output;
}

async function readHeader(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(stat.size, HEADER_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseDicom(buffer.subarray(0, bytesRead), { headerOnly: true });
  } finally { await handle.close(); }
}

module.exports = { DicomError, parseDicom, validateSeries, decodePixels, readHeader,
  TS_IMPLICIT, TS_EXPLICIT, CT_IMAGE };
