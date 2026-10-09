'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDicom, validateImage, validateSeries, decodePixels, DicomError, TS_EXPLICIT, TS_IMPLICIT, CT_IMAGE } = require('../src/dicom');

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
  const bitsAllocated = options.bitsAllocated ?? 16;
  const bitsStored = options.bitsStored ?? 12;
  const pixels = Buffer.alloc(4 * bitsAllocated / 8);
  (options.pixels || [0, 100, 2048, 4095]).forEach((value, i) =>
    bitsAllocated === 8 ? pixels.writeUInt8(value, i) : pixels.writeUInt16LE(value, i * 2));
  const elements = [
    element(0x0008, 0x0016, 'UI', options.sopClass || CT_IMAGE),
    element(0x0008, 0x0060, 'CS', options.modality || 'CT'),
    element(0x0008, 0x0018, 'UI', `1.2.3.4.${(options.z ?? 0) + 1}`),
    element(0x0020, 0x000d, 'UI', '1.2.3'),
    element(0x0020, 0x000e, 'UI', '1.2.3.4'),
    element(0x0020, 0x0032, 'DS', `0\\0\\${options.z ?? 0}`),
    element(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0'),
    element(0x0028, 0x0004, 'CS', options.photometric || 'MONOCHROME2'),
    element(0x0028, 0x0030, 'DS', '0.7\\0.8'),
    us(0x0028, 0x0002, 1), us(0x0028, 0x0010, 2), us(0x0028, 0x0011, 2),
    us(0x0028, 0x0100, bitsAllocated), us(0x0028, 0x0101, bitsStored), us(0x0028, 0x0102, bitsStored - 1),
    us(0x0028, 0x0103, options.pixelRepresentation ?? 1),
    element(0x0028, 0x1052, 'DS', options.intercept ?? '-1024'), element(0x0028, 0x1053, 'DS', options.slope ?? '2'),
    ...(options.window ? [element(0x0028, 0x1050, 'DS', options.window.level),
      element(0x0028, 0x1051, 'DS', options.window.width)] : []),
    ...(options.frames ? [element(0x0028, 0x0008, 'IS', options.frames)] : []),
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

test('validates a single 2D CT image without reconstruction geometry', () => {
  const meta = parseDicom(sample());
  for (const key of ['position', 'orientation', 'spacing', 'seriesUid', 'studyUid']) delete meta[key];
  assert.equal(validateImage(meta), meta);
  assert.throws(() => validateSeries([meta]), error => error.code === 'SERIES');
});

test('2D validation rejects unsupported pixels, multiple frames and incomplete pixel data', () => {
  const meta = parseDicom(sample());
  for (const changes of [{ photometric: 'RGB' }, { samplesPerPixel: 3 }, { rows: 0 },
    { bitsAllocated: 32 }, { bitsStored: 17 }, { highBit: 12 }, { pixelLength: 2 }, { slope: [1, 2] }, { numberOfFrames: '2' }]) {
    assert.throws(() => validateImage({ ...meta, ...changes }), DicomError);
  }
  assert.throws(() => validateSeries([parseDicom(sample({ frames: '2' })), parseDicom(sample({ z: 1 }))]),
    error => error.code === 'SOP_CLASS');
});

test('2D decoding accepts other modalities, 8/14/16 bits and both monochrome polarities', () => {
  for (const bitsStored of [8, 14, 16]) {
    for (const pixelRepresentation of [0, 1]) {
      const maximum = 2 ** bitsStored - 1;
      const data = sample({ modality: 'DX', sopClass: '1.2.840.10008.5.1.4.1.1.1.1',
        bitsAllocated: bitsStored === 8 ? 8 : 16, bitsStored, pixelRepresentation,
        pixels: [0, 1, 2 ** (bitsStored - 1), maximum], slope: 1, intercept: 0, photometric: 'MONOCHROME1' });
      const meta = validateImage(parseDicom(data));
      assert.deepEqual([...decodePixels(data, meta)], pixelRepresentation === 0 ?
        [0, 1, 2 ** (bitsStored - 1), maximum] : [0, 1, -(2 ** (bitsStored - 1)), -1]);
      assert.throws(() => validateSeries([meta, meta]), error => error.code === 'SOP_CLASS');
    }
  }
});

test('parses multiple DICOM windows and frame count', () => {
  const meta = parseDicom(sample({ window: { level: '40\\300', width: '400\\1500' }, frames: '1' }));
  assert.deepEqual(meta.windowCenter, [40, 300]);
  assert.deepEqual(meta.windowWidth, [400, 1500]);
  assert.equal(meta.numberOfFrames, '1');
});

function extensionHarness(data = sample(), options = {}) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const file = require.resolve('../src/extension');
  const realRequire = createRequire(file);
  const files = { '/ct/clicked.dcm': data, '/ct/other.dcm': sample({ z: 1 }) };
  if (options.single) delete files['/ct/other.dcm'];
  Object.assign(files, options.files || {});
  const reads = [], messages = [], scans = [];
  let provider, listener, dispose;
  const panel = {
    onDidDispose(callback) { dispose = callback; },
    webview: {
      options: {}, cspSource: 'test:', asWebviewUri: uri => String(uri),
      onDidReceiveMessage(callback) { listener = callback; },
      async postMessage(message) {
        messages.push(message);
        if (message.type === 'slice' || message.type === 'labelSlice') listener({ type: 'sliceAck', ok: true });
        return true;
      }
    }
  };
  const vscode = {
    Uri: { joinPath: (...parts) => parts.join('/') },
    ProgressLocation: { Notification: 1 },
    window: {
      registerCustomEditorProvider(name, value) { provider = value; return {}; },
      showOpenDialog: async () => options.labelSelection,
      withProgress: async (settings, callback) => callback({ report() {} }, { isCancellationRequested: options.cancelSearch === true }),
      showErrorMessage: message => { throw new Error(message); }
    }
  };
  const fakeFs = {
    stat: async () => ({ size: options.size ?? data.length }),
    readFile: async name => { reads.push(name); return files[name.replace(/\\/g, '/')]; },
    readdir: async root => {
      scans.push(root);
      if (options.scanError) throw Object.assign(new Error('scan failed'), { code: 'EACCES' });
      return Object.keys(files).map(name => ({
        name: name.split('/').pop(), isDirectory: () => false, isFile: () => true
      }));
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, Buffer, process,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:fs/promises') return fakeFs;
      if (name === './nifti' && options.niftiVolumes) return {
        ...realRequire(name), readNiftiFile: async name => options.niftiVolumes[name]
      };
      if (name === './dicom') return { ...realRequire(name), readHeader: async name => parseDicom(files[name.replace(/\\/g, '/')]) };
      return realRequire(name);
    }
  }, { filename: file });
  module.exports.activate({ subscriptions: [], extensionUri: '/extension' });
  return { panel, reads, messages, scans,
    open: name => provider.resolveCustomEditor({ uri: { scheme: 'file', fsPath: name } }, panel, { isCancellationRequested: false }),
    send: message => listener(message), dispose: () => dispose() };
}

async function waitForMessage(harness, type) {
  for (let i = 0; i < 20; i++) {
    const message = harness.messages.find(message => message.type === type);
    if (message) return message;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`No ${type} message received`);
}

test('radiographs use auto contrast for incompatible windows and reject 3D requests', async () => {
  for (const window of [undefined, { level: '-600', width: '1600' }, { level: '7500', width: '15000' }]) {
    const harness = extensionHarness(sample({ modality: 'DX', sopClass: '1.2.840.10008.5.1.4.1.1.1.1',
      bitsStored: 14, pixelRepresentation: 0, pixels: [0, 5000, 10000, 15000], slope: 1, intercept: 0, window }));
    await harness.open('/ct/clicked.dcm'); harness.send({ type: 'ready' });
    const image = await waitForMessage(harness, 'image');
    assert.equal(image.meta.modality, 'DX');
    assert.equal(image.meta.canLoadSeries, false);
    assert.equal(image.meta.displayWindow.level, 7500);
    assert.equal(image.meta.displayWindow.width, 15000);
    harness.send({ type: 'loadSeries' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.scans.length, 0);
    harness.dispose();
  }
});

test('clicking DICOM reads only that file and sends a 2D image with the first DICOM window', async () => {
  const harness = extensionHarness(sample({ window: { level: '55\\300', width: '500\\1500' } }));
  await harness.open('/ct/clicked.dcm');
  assert.match(harness.panel.webview.html, /image-viewer.js/);
  harness.send({ type: 'ready' });
  const message = await waitForMessage(harness, 'image');
  assert.deepEqual(harness.reads, ['/ct/clicked.dcm']);
  assert.equal(message.meta.displayWindow.level, 55);
  assert.equal(message.meta.displayWindow.width, 500);
  assert.equal(Buffer.from(message.pixels, 'base64').readFloatLE(), -1024);
  harness.dispose();
});

test('2D loading supplies a default window and reports invalid or oversized files', async () => {
  for (const [data, options, expected] of [
    [sample(), {}, 'image'],
    [sample({ window: { level: '40', width: '0' } }), {}, 'image'],
    [sample({ window: { level: 'invalid', width: '400' } }), {}, 'image'],
    [Buffer.from('broken'), {}, 'error'],
    [sample(), { size: 64 * 1024 * 1024 + 1 }, 'error']
  ]) {
    const harness = extensionHarness(data, options);
    await harness.open('/ct/clicked.dcm'); harness.send({ type: 'ready' });
    const message = await waitForMessage(harness, expected);
    if (expected === 'image') assert.equal(message.meta.displayWindow.width, 400);
    if (options.size) assert.equal(harness.reads.length, 0);
    harness.dispose();
  }
});

test('cancel before file read suppresses image delivery', async () => {
  const harness = extensionHarness();
  await harness.open('/ct/clicked.dcm');
  harness.send({ type: 'ready' }); harness.send({ type: 'cancel' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.reads.length, 0);
  assert.equal(harness.messages.some(message => message.type === 'image'), false);
  harness.dispose();
});

test('NIfTI files continue to use the volume viewer', async () => {
  const harness = extensionHarness();
  await harness.open('/ct/volume.NII.GZ');
  assert.match(harness.panel.webview.html, /roi-mask.js/);
  assert.doesNotMatch(harness.panel.webview.html, /image-viewer.js/);
  harness.dispose();
});

test('2D series button loads the selected series in the same panel and ignores repeated requests', async () => {
  const harness = extensionHarness();
  await harness.open('/ct/clicked.dcm');
  assert.match(harness.panel.webview.html, />Load series in 3D</);
  harness.send({ type: 'ready' }); await waitForMessage(harness, 'image');
  assert.equal(harness.scans.length, 0);
  harness.send({ type: 'loadSeries', file: '/untrusted/path.dcm' });
  harness.send({ type: 'loadSeries' });
  for (let i = 0; i < 20 && !harness.panel.webview.html.includes('roi-mask.js'); i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.match(harness.panel.webview.html, /roi-mask.js/);
  assert.equal(harness.scans.length, 1);
  harness.send({ type: 'ready' }); await waitForMessage(harness, 'complete');
  assert.equal(harness.messages.find(message => message.type === 'start').meta.count, 2);
  assert.equal(harness.messages.filter(message => message.type === 'slice').length, 2);
  assert.ok(harness.reads.some(name => name.replace(/\\/g, '/') === '/ct/other.dcm'));
  harness.dispose();
});

test('series search cancellation, missing slices and read errors preserve 2D and allow retry', async () => {
  for (const [options, expected] of [
    [{ cancelSearch: true }, /cancelled/], [{ single: true }, /at least two/],
    [{ scanError: true }, /Permission denied/]
  ]) {
    const harness = extensionHarness(sample(), options);
    await harness.open('/ct/clicked.dcm');
    harness.send({ type: 'ready' }); await waitForMessage(harness, 'image');
    harness.send({ type: 'loadSeries' });
    const result = await waitForMessage(harness, 'seriesResult');
    assert.match(result.text, expected);
    assert.match(harness.panel.webview.html, /image-viewer.js/);
    harness.messages.length = 0;
    harness.send({ type: 'loadSeries' }); await waitForMessage(harness, 'seriesResult');
    harness.dispose();
  }
});

test('disposing the panel during series search prevents switching to 3D', async () => {
  const harness = extensionHarness();
  await harness.open('/ct/clicked.dcm');
  harness.send({ type: 'ready' }); await waitForMessage(harness, 'image');
  harness.send({ type: 'loadSeries' }); harness.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.panel.webview.html, /image-viewer.js/);
  assert.equal(harness.messages.some(message => message.type === 'start'), false);
});


test('the 2D series button discovers LIDC XML and delivers matching ROIs', async () => {
  const annotations = `<LidcReadMessage><ResponseHeader><StudyInstanceUID>1.2.3</StudyInstanceUID><SeriesInstanceUid>1.2.3.4</SeriesInstanceUid></ResponseHeader><readingSession><unblindedReadNodule><noduleID>001</noduleID><roi><imageSOP_UID>1.2.3.4.1</imageSOP_UID><inclusion>TRUE</inclusion><edgeMap><xCoord>0</xCoord><yCoord>0</yCoord></edgeMap><edgeMap><xCoord>1</xCoord><yCoord>0</yCoord></edgeMap><edgeMap><xCoord>1</xCoord><yCoord>1</yCoord></edgeMap></roi></unblindedReadNodule></readingSession></LidcReadMessage>`;
  const harness = extensionHarness(sample(), { files: { '/ct/annotations.XML': Buffer.from(annotations) } });
  await harness.open('/ct/clicked.dcm'); harness.send({ type: 'ready' });
  await waitForMessage(harness, 'image'); harness.send({ type: 'loadSeries' });
  for (let i = 0; i < 20 && !harness.panel.webview.html.includes('roi-mask.js'); i++)
    await new Promise(resolve => setImmediate(resolve));
  harness.send({ type: 'ready' });
  const start = await waitForMessage(harness, 'start');
  assert.equal(start.meta.rois.length, 1);
  assert.equal(start.meta.rois[0].name, 'LIDC Reader 1: 001');
  assert.ok(harness.reads.some(file => file.endsWith('annotations.XML')));
  await waitForMessage(harness, 'complete'); harness.dispose();
});

test('malformed annotation XML reports a warning without preventing CT loading', async () => {
  const harness = extensionHarness(sample(), { files: { '/ct/annotations.xml': Buffer.from('<broken>') } });
  await harness.open('/ct/clicked.dcm'); harness.send({ type: 'ready' });
  await waitForMessage(harness, 'image'); harness.send({ type: 'loadSeries' });
  for (let i = 0; i < 20 && !harness.panel.webview.html.includes('roi-mask.js'); i++)
    await new Promise(resolve => setImmediate(resolve));
  harness.send({ type: 'ready' });
  const start = await waitForMessage(harness, 'start');
  assert.equal(start.meta.rois.length, 0);
  assert.match(start.meta.roiWarnings[0], /Malformed annotation XML/);
  await waitForMessage(harness, 'complete'); harness.dispose();
});

test('NIfTI label dialog streams mask slices and rejects mismatched geometry without a volume error', async () => {
  const data = Buffer.alloc(360);
  data.writeInt32LE(348, 0); data.writeInt16LE(3, 40);
  for (const offset of [42, 44, 46]) data.writeInt16LE(2, offset);
  data.writeInt16LE(2, 70); data.writeInt16LE(8, 72);
  data.writeFloatLE(352, 108); data.write('n+1\0', 344, 4, 'ascii');
  Buffer.from([0, 1, 2, 1, 2, 0, 1, 0]).copy(data, 352);
  const volume = require('../src/nifti').parseNifti(data);
  for (const mismatch of [false, true]) {
    const harness = extensionHarness(sample(), {
      labelSelection: [{ scheme: 'file', fsPath: '/ct/labels.nii.gz' }],
      niftiVolumes: { '/ct/base.nii': volume, '/ct/labels.nii.gz': mismatch ? { ...volume, origin: [10, 0, 0] } : volume }
    });
    await harness.open('/ct/base.nii'); harness.send({ type: 'ready' });
    await waitForMessage(harness, 'complete'); harness.send({ type: 'loadLabels' });
    await waitForMessage(harness, 'labelIdle');
    assert.equal(harness.messages.some(message => message.type === 'error'), false);
    if (mismatch) {
      assert.match(harness.messages.find(message => message.type === 'labelError').text, /match/);
      assert.equal(harness.messages.some(message => message.type === 'labelStart'), false);
    } else {
      assert.deepEqual(harness.messages.find(message => message.type === 'labelStart').rois.map(roi => roi.number), [1, 2]);
      const slices = harness.messages.filter(message => message.type === 'labelSlice');
      assert.equal(slices.length, 2);
      const bytes = Buffer.from(slices[0].pixels, 'base64');
      assert.deepEqual([0, 1, 2, 3].map(i => bytes.readUInt32LE(i * 4)), [0, 1, 2, 1]);
      assert.ok(harness.messages.some(message => message.type === 'labelComplete'));
    }
    harness.dispose();
  }
});
