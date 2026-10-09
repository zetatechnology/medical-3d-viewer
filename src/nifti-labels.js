'use strict';

const { NiftiError } = require('./nifti');
const MAX_LABELS = 32;
const COLORS = [[255, 80, 80], [80, 220, 100], [80, 160, 255], [255, 210, 60],
  [210, 100, 255], [60, 220, 220], [255, 140, 60], [255, 100, 180]];

function labelColor(index) {
  if (index < COLORS.length) return COLORS[index];
  // Spread additional colors around the hue wheel, varying brightness each cycle.
  const hue = (index * 0.61803398875) % 1 * 6;
  const brightness = index % 2 ? 220 : 255;
  const low = Math.round(brightness * .25);
  const rising = Math.round(low + (brightness - low) * (hue % 1));
  const falling = brightness + low - rising;
  return [[brightness, rising, low], [falling, brightness, low], [low, brightness, rising],
    [low, falling, brightness], [rising, low, brightness], [brightness, low, falling]][Math.floor(hue)];
}

function prepareLabels(base, labels) {
  for (const key of ['rows', 'columns', 'count']) {
    if (base[key] !== labels[key]) throw new NiftiError('GEOMETRY', 'Label dimensions must match the NIfTI image.');
  }
  for (const key of ['origin', 'row', 'column', 'normal', 'spacing', 'sliceSpacing']) {
    const a = [].concat(base[key]), b = [].concat(labels[key]);
    if (a.length !== b.length || a.some((value, i) => Math.abs(value - b[i]) > 1e-4))
      throw new NiftiError('GEOMETRY', 'Label position, orientation and voxel spacing must match the NIfTI image. Resample the labels to the image grid first.');
  }
  const values = new Set();
  const length = labels.rows * labels.columns * labels.count;
  for (let i = 0; i < length; i++) {
    const value = labels.data[labels.readName](labels.voxelOffset + i * labels.bytesPerVoxel) * labels.slope + labels.intercept;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new NiftiError('DATATYPE', 'Labels must contain non-negative integer values (0 is background).');
    if (value) values.add(value);
    if (values.size > MAX_LABELS)
      throw new NiftiError('DATATYPE', `Up to ${MAX_LABELS} non-zero labels are supported per overlay.`);
  }
  if (!values.size) throw new NiftiError('DATATYPE', 'The label volume contains only background (0).');
  const rois = [...values].sort((a, b) => a - b).map((number, index) =>
    ({ number, name: `Label ${number}`, color: labelColor(index), contours: [] }));
  const bits = new Map(rois.map((roi, index) => [roi.number, (1 << index) >>> 0]));
  return {
    rois,
    decodeSlice(index) {
      const count = labels.rows * labels.columns;
      const result = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        const value = labels.data[labels.readName](labels.voxelOffset + (index * count + i) * labels.bytesPerVoxel) * labels.slope + labels.intercept;
        result[i] = bits.get(value) || 0;
      }
      return result;
    }
  };
}

module.exports = { prepareLabels, MAX_LABELS };
