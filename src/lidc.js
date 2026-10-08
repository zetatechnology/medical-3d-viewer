'use strict';

const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { DicomError } = require('./dicom');
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_CONTOUR_POINTS = 1_000_000;
const colors = [[255, 192, 0], [0, 200, 255], [255, 100, 160], [120, 230, 100]];
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = value => typeof value === 'string' ? value.trim() : '';
const invalid = message => new DicomError('LIDC_XML', message);

// Keep UIDs and nodule identifiers as strings, including leading zeros.
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true,
  parseTagValue: false, trimValues: true, processEntities: true });

function parseLidcXml(data, images) {
  if (Buffer.byteLength(data) > MAX_XML_BYTES) throw invalid('LIDC XML exceeds the 16 MiB limit.');
  const xml = data.toString('utf8');
  // LIDC annotations do not require DTDs or user-defined entities.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid('DTD and entity declarations are not supported in LIDC XML.');
  if (XMLValidator.validate(xml) !== true) throw invalid('Malformed annotation XML.');
  let document;
  try { document = parser.parse(xml); } catch { throw invalid('Could not parse annotation XML.'); }
  const root = document.LidcReadMessage;
  if (!root) return { rois: [], warnings: [] }; // Includes CXR-only IdriReadMessage.
  if (Array.isArray(root)) throw invalid('Invalid LIDC XML root.');
  const header = root.ResponseHeader;
  const seriesUid = text(header?.SeriesInstanceUid) || text(header?.SeriesInstanceUID);
  const studyUid = text(header?.StudyInstanceUID) || text(header?.StudyInstanceUid);
  if (!seriesUid || !studyUid) throw invalid('LIDC XML study or series UID is missing.');
  if (!images.length || seriesUid !== images[0].seriesUid || studyUid !== images[0].studyUid)
    return { rois: [], warnings: [] };
  const byUid = new Map(images.map(image => [image.sopInstanceUid, image]));
  const rois = [];
  let pointCount = 0, unmatched = 0, markers = 0;
  const sessions = array(root.readingSession);
  for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
    for (const nodule of array(sessions[sessionIndex].unblindedReadNodule)) {
      const contours = [];
      for (const roi of array(nodule.roi)) {
        const image = byUid.get(text(roi.imageSOP_UID));
        if (!image) { unmatched++; continue; }
        const edges = array(roi.edgeMap);
        if (edges.length < 3) { markers++; continue; }
        const inclusion = text(roi.inclusion).toUpperCase();
        if (!['TRUE', 'FALSE'].includes(inclusion)) throw invalid('Invalid LIDC contour inclusion flag.');
        const points = [];
        for (const edge of edges) {
          const xText = text(edge.xCoord), yText = text(edge.yCoord);
          const x = Number(xText), y = Number(yText);
          if (!xText || !yText || !Number.isInteger(x) || !Number.isInteger(y) ||
              x < 0 || x >= image.columns || y < 0 || y >= image.rows)
            throw invalid('LIDC contour contains invalid pixel coordinates.');
          if (++pointCount > MAX_CONTOUR_POINTS) throw invalid('LIDC contour point limit exceeded.');
          // DICOM: first orientation vector advances columns, second advances rows.
          for (let axis = 0; axis < 3; axis++) points.push(image.position[axis] +
            image.orientation[axis] * x * image.spacing[1] +
            image.orientation[axis + 3] * y * image.spacing[0]);
        }
        contours.push({ points, exclusion: inclusion === 'FALSE' });
      }
      if (contours.some(contour => !contour.exclusion)) rois.push({
        number: rois.length + 1,
        name: `LIDC Reader ${sessionIndex + 1}: ${text(nodule.noduleID) || 'Nodule'}`,
        source: 'LIDC XML', reader: sessionIndex + 1, noduleId: text(nodule.noduleID),
        frameOfReferenceUid: images[0].frameOfReferenceUid,
        color: colors[sessionIndex % colors.length], contours
      });
    }
  }
  const warnings = [];
  if (unmatched) warnings.push(`${unmatched} LIDC contours have no matching CT image.`);
  if (markers) warnings.push(`${markers} LIDC point annotations were skipped (no closed contour).`);
  return { rois, warnings };
}

module.exports = { parseLidcXml, MAX_XML_BYTES };
