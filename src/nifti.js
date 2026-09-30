'use strict';

const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gunzip = promisify(zlib.gunzip);
const NIFTI1_HEADER_SIZE = 348;

class NiftiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NiftiError';
    this.code = code;
  }
}

const TYPES = new Map([
  [2, { name: 'uint8', bytes: 1, read: 'readUInt8' }],
  [4, { name: 'int16', bytes: 2, read: 'readInt16' }],
  [8, { name: 'int32', bytes: 4, read: 'readInt32' }],
  [16, { name: 'float32', bytes: 4, read: 'readFloat' }],
  [64, { name: 'float64', bytes: 8, read: 'readDouble' }],
  [256, { name: 'int8', bytes: 1, read: 'readInt8' }],
  [512, { name: 'uint16', bytes: 2, read: 'readUInt16' }],
  [768, { name: 'uint32', bytes: 4, read: 'readUInt32' }]
]);

function norm(value) {
  return Math.hypot(value[0], value[1], value[2]);
}

function normalize(value) {
  const length = norm(value);
  if (!Number.isFinite(length) || length <= 0) throw new NiftiError('GEOMETRY', 'NIfTI voxel spacing is invalid.');
  return value.map(component => component / length);
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function qformMatrix(readFloat) {
  let b = readFloat(256), c = readFloat(260), d = readFloat(264);
  let aSquared = 1 - (b * b + c * c + d * d);
  let a;
  if (aSquared < 1e-7) {
    const length = Math.hypot(b, c, d);
    if (!length) throw new NiftiError('GEOMETRY', 'NIfTI qform quaternion is invalid.');
    b /= length; c /= length; d /= length;
    a = 0;
  } else a = Math.sqrt(aSquared);
  const dx = Math.abs(readFloat(80)) || 1;
  const dy = Math.abs(readFloat(84)) || 1;
  const dz = (readFloat(76) < 0 ? -1 : 1) * (Math.abs(readFloat(88)) || 1);
  const x = readFloat(268), y = readFloat(272), z = readFloat(276);
  return [
    [(a*a+b*b-c*c-d*d)*dx, 2*(b*c-a*d)*dy, 2*(b*d+a*c)*dz, x],
    [2*(b*c+a*d)*dx, (a*a+c*c-b*b-d*d)*dy, 2*(c*d-a*b)*dz, y],
    [2*(b*d-a*c)*dx, 2*(c*d+a*b)*dy, (a*a+d*d-c*c-b*b)*dz, z]
  ];
}

function parseNifti(data) {
  if (!Buffer.isBuffer(data) || data.length < NIFTI1_HEADER_SIZE + 4)
    throw new NiftiError('FORMAT', 'The file is too small to be a NIfTI-1 volume.');
  let suffix;
  if (data.readInt32LE(0) === NIFTI1_HEADER_SIZE) suffix = 'LE';
  else if (data.readInt32BE(0) === NIFTI1_HEADER_SIZE) suffix = 'BE';
  else throw new NiftiError('FORMAT', 'Only NIfTI-1 single-file volumes are supported.');
  const readInt16 = offset => data[`readInt16${suffix}`](offset);
  const readFloat = offset => data[`readFloat${suffix}`](offset);
  const magic = data.toString('ascii', 344, 348);
  if (magic !== 'n+1\0') throw new NiftiError('FORMAT', 'Only .nii single-file NIfTI-1 volumes are supported.');

  const dimensions = Array.from({ length: 8 }, (_, index) => readInt16(40 + index * 2));
  if (dimensions[0] < 3 || dimensions[1] <= 0 || dimensions[2] <= 0 || dimensions[3] <= 0)
    throw new NiftiError('DIMENSIONS', 'NIfTI must contain a three-dimensional volume.');
  for (let index = 4; index <= Math.min(dimensions[0], 7); index++) {
    if (dimensions[index] > 1) throw new NiftiError('DIMENSIONS', 'Time series and other volumes with more than three dimensions are not supported.');
  }
  const datatype = readInt16(70);
  const type = TYPES.get(datatype);
  if (!type || readInt16(72) !== type.bytes * 8)
    throw new NiftiError('DATATYPE', `Unsupported NIfTI datatype (${datatype}).`);
  const voxelOffset = Math.ceil(readFloat(108));
  const count = dimensions[1] * dimensions[2] * dimensions[3];
  const required = voxelOffset + count * type.bytes;
  if (!Number.isSafeInteger(count) || voxelOffset < 352 || required > data.length)
    throw new NiftiError('FORMAT', 'NIfTI voxel data is truncated or has an invalid offset.');

  let affine;
  if (readInt16(254) > 0) {
    affine = [280, 296, 312].map(offset => [0, 4, 8, 12].map(delta => readFloat(offset + delta)));
  } else if (readInt16(252) > 0) {
    affine = qformMatrix(readFloat);
  } else {
    affine = [
      [Math.abs(readFloat(80)) || 1, 0, 0, 0],
      [0, Math.abs(readFloat(84)) || 1, 0, 0],
      [0, 0, Math.abs(readFloat(88)) || 1, 0]
    ];
  }
  if (affine.some(row => row.some(value => !Number.isFinite(value))))
    throw new NiftiError('GEOMETRY', 'NIfTI affine transform contains invalid values.');

  // NIfTI world coordinates are RAS; the viewer and DICOM data use LPS.
  const rasToLps = vector => [-vector[0], -vector[1], vector[2]];
  const x = rasToLps(affine.map(row => row[0]));
  const y = rasToLps(affine.map(row => row[1]));
  const z = rasToLps(affine.map(row => row[2]));
  const row = normalize(x), column = normalize(y), normal = normalize(z);
  if (Math.abs(dot(row, column)) > 1e-4 || Math.abs(dot(row, normal)) > 1e-4 || Math.abs(dot(column, normal)) > 1e-4)
    throw new NiftiError('GEOMETRY', 'Sheared NIfTI affine transforms are not supported.');

  let slope = readFloat(112);
  let intercept = readFloat(116);
  if (!Number.isFinite(slope) || slope === 0) slope = 1;
  if (!Number.isFinite(intercept)) intercept = 0;
  const endian = suffix === 'LE' ? 'LE' : 'BE';
  const readName = type.bytes === 1 ? type.read : `${type.read}${endian}`;
  return {
    data, rows: dimensions[2], columns: dimensions[1], count: dimensions[3],
    spacing: [norm(y), norm(x)], sliceSpacing: norm(z),
    origin: rasToLps(affine.map(rowValue => rowValue[3])), row, column, normal,
    datatype, datatypeName: type.name, bytesPerVoxel: type.bytes, voxelOffset,
    slope, intercept, readName
  };
}

function scanNiftiRange(volume) {
  const length = volume.rows * volume.columns * volume.count;
  let minimum = Infinity, maximum = -Infinity;
  let offset = volume.voxelOffset;
  for (let i = 0; i < length; i++, offset += volume.bytesPerVoxel) {
    const value = volume.data[volume.readName](offset) * volume.slope + volume.intercept;
    if (Number.isFinite(value)) {
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
  }
  return { minimum, maximum };
}

function decodeNiftiSlice(volume, index, outputType = 'float32') {
  if (!Number.isInteger(index) || index < 0 || index >= volume.count)
    throw new NiftiError('DIMENSIONS', 'NIfTI slice index is out of range.');
  const length = volume.rows * volume.columns;
  const pixels = outputType === 'uint8' ? new Uint8Array(length) : new Float32Array(length);
  let minimum = Infinity, maximum = -Infinity;
  let offset = volume.voxelOffset + index * length * volume.bytesPerVoxel;
  for (let i = 0; i < length; i++, offset += volume.bytesPerVoxel) {
    const value = volume.data[volume.readName](offset) * volume.slope + volume.intercept;
    pixels[i] = value;
    if (Number.isFinite(value)) {
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
  }
  pixels.minimum = minimum;
  pixels.maximum = maximum;
  return pixels;
}

async function readNiftiFile(file, maxOutputLength) {
  const fs = require('node:fs/promises');
  let data = await fs.readFile(file);
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = await gunzip(data, { maxOutputLength });
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE')
        throw new NiftiError('MEMORY', 'The expanded NIfTI file exceeds the size limit.');
      throw new NiftiError('FORMAT', 'The .nii.gz file could not be decompressed.');
    }
  }
  return parseNifti(data);
}

module.exports = { NiftiError, parseNifti, scanNiftiRange, decodeNiftiSlice, readNiftiFile };
