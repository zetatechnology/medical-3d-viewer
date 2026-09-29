(() => {
  'use strict';

  const MAX_ROIS = 8;

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  function volumeIndex(meta, point) {
    const relative = point.map((value, i) => value - meta.origin[i]);
    return [dot(relative, meta.row) / meta.spacing[1],
      dot(relative, meta.column) / meta.spacing[0],
      dot(relative, meta.normal) / meta.sliceSpacing];
  }

  function fillContour(data, meta, points, bit) {
    const vertices = [];
    let zSum = 0, zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      const index = volumeIndex(meta, points.slice(i, i + 3));
      if (index.some(value => !Number.isFinite(value))) return false;
      vertices.push(index);
      zSum += index[2];
      zMin = Math.min(zMin, index[2]);
      zMax = Math.max(zMax, index[2]);
    }
    if (vertices.length < 3 || zMax - zMin > 0.25) return false;
    const slice = Math.round(zSum / vertices.length);
    if (slice < 0 || slice >= meta.count) return false;
    let minY = Infinity, maxY = -Infinity;
    for (const point of vertices) {
      minY = Math.min(minY, point[1]);
      maxY = Math.max(maxY, point[1]);
    }
    const firstRow = Math.max(0, Math.ceil(minY));
    const lastRow = Math.min(meta.rows - 1, Math.floor(maxY));
    const sliceOffset = slice * meta.rows * meta.columns;
    for (let row = firstRow; row <= lastRow; row++) {
      const crossings = [];
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length];
        if ((a[1] <= row && b[1] > row) || (b[1] <= row && a[1] > row)) {
          crossings.push(a[0] + (row - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
        }
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const firstColumn = Math.max(0, Math.ceil(crossings[i]));
        const lastColumn = Math.min(meta.columns - 1, Math.floor(crossings[i + 1]));
        for (let column = firstColumn; column <= lastColumn; column++) {
          data[sliceOffset + row * meta.columns + column] |= bit;
        }
      }
    }
    return true;
  }

  function buildMask(meta) {
    const rois = (meta.rois || []).slice(0, MAX_ROIS);
    if (!rois.length) return null;
    const data = new Uint8Array(meta.columns * meta.rows * meta.count);
    let skippedContours = 0;
    for (let i = 0; i < rois.length; i++) {
      const bit = 1 << i;
      for (const contour of rois[i].contours) {
        if (!fillContour(data, meta, contour.points, bit)) skippedContours++;
      }
    }
    return { data, rois, skippedContours };
  }

  const api = { MAX_ROIS, buildMask };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RoiMask = api;
})();
