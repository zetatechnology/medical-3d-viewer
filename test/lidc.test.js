'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLidcXml, MAX_XML_BYTES } = require('../src/lidc');
const images = [{ studyUid: '1.2', seriesUid: '1.2.3', sopInstanceUid: '1.2.3.4',
  frameOfReferenceUid: '1.2.5', columns: 10, rows: 10,
  position: [10, 20, 30], orientation: [0, 1, 0, -1, 0, 0], spacing: [2, 3] }];
const edge = (x, y) => `<edgeMap><xCoord>${x}</xCoord><yCoord>${y}</yCoord></edgeMap>`;
const contour = (uid = '1.2.3.4', inclusion = 'TRUE', edges = edge(1, 2) + edge(3, 2) + edge(3, 4)) =>
  `<roi><imageZposition>999</imageZposition><imageSOP_UID>${uid}</imageSOP_UID><inclusion>${inclusion}</inclusion>${edges}</roi>`;
const session = rois => `<readingSession><servicingRadiologistID>anonymous</servicingRadiologistID><unblindedReadNodule><noduleID>001 &amp; A</noduleID>${rois}</unblindedReadNodule></readingSession>`;
const xml = (body = session(contour()), series = '1.2.3', study = '1.2') =>
  `<?xml version="1.0"?><LidcReadMessage xmlns="http://www.nih.gov"><ResponseHeader><SeriesInstanceUid>${series}</SeriesInstanceUid><StudyInstanceUID>${study}</StudyInstanceUID></ResponseHeader>${body}</LidcReadMessage>`;

test('maps XML pixel coordinates using SOP UID and DICOM orientation, position and unequal spacing', () => {
  const result = parseLidcXml(xml(), images);
  assert.deepEqual(result.rois[0].contours[0].points, [6, 23, 30, 6, 29, 30, 2, 29, 30]);
  assert.equal(result.rois[0].name, 'LIDC Reader 1: 001 & A');
  assert.deepEqual(result.warnings, []);
});

test('keeps identical nodule IDs in separate reading sessions and preserves exclusions', () => {
  const result = parseLidcXml(xml(session(contour() + contour('1.2.3.4', 'FALSE')) + session(contour())), images);
  assert.equal(result.rois.length, 2);
  assert.equal(result.rois[1].reader, 2);
  assert.notEqual(result.rois[0].number, result.rois[1].number);
  assert.equal(result.rois[0].contours[1].exclusion, true);
});

test('accepts namespace prefixes and ignores other series, studies, CXR and unrelated XML', () => {
  const prefixed = xml().replace(/<(\/?)([A-Za-z][\w]*)/g, '<$1lidc:$2').replace('xmlns=', 'xmlns:lidc=');
  assert.equal(parseLidcXml(prefixed, images).rois.length, 1);
  for (const source of [xml(undefined, 'other'), xml(undefined, '1.2.3', 'other'),
    '<IdriReadMessage><CXRreadingSession/></IdriReadMessage>', '<unrelated/>'])
    assert.equal(parseLidcXml(source, images).rois.length, 0);
});

test('reports unmatched images and skips point annotations without fabricating contours', () => {
  const result = parseLidcXml(xml(session(contour('missing') + contour('1.2.3.4', 'TRUE', edge(1, 2)))), images);
  assert.equal(result.rois.length, 0);
  assert.equal(result.warnings.length, 2);
});

test('rejects malformed XML, DTDs, oversized input, invalid flags and coordinates', () => {
  for (const source of ['<LidcReadMessage>', '<!DOCTYPE x [<!ENTITY e "expanded">]><x/>',
    ' '.repeat(MAX_XML_BYTES + 1), xml(session(contour('1.2.3.4', 'invalid'))),
    xml(session(contour('1.2.3.4', 'TRUE', edge(1, 2) + edge(10, 2) + edge(3, 4)))),
    xml(session(contour('1.2.3.4', 'TRUE', edge('', 2) + edge(3, 2) + edge(3, 4))))])
    assert.throws(() => parseLidcXml(source, images), error => error.code === 'LIDC_XML');
});
