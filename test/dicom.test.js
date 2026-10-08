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
  for (const changes of [{ photometric: 'RGB' }, { modality: 'MR' }, { rows: 0 },
    { bitsAllocated: 8 }, { pixelLength: 2 }, { slope: [1, 2] }, { numberOfFrames: '2' }]) {
    assert.throws(() => validateImage({ ...meta, ...changes }), DicomError);
  }
  assert.throws(() => validateSeries([parseDicom(sample({ frames: '2' })), parseDicom(sample({ z: 1 }))]),
    error => error.code === 'SOP_CLASS');
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
  const reads = [], messages = [], scans = [], commands = new Map();
  let provider, listener, dispose;
  const panel = {
    onDidDispose(callback) { dispose = callback; },
    webview: {
      options: {}, cspSource: 'test:', asWebviewUri: uri => String(uri),
      onDidReceiveMessage(callback) { listener = callback; },
      async postMessage(message) {
        messages.push(message);
        if (message.type === 'slice') listener({ type: 'sliceAck', ok: true });
        return true;
      }
    }
  };
  const vscode = {
    Uri: { joinPath: (...parts) => parts.join('/') }, ViewColumn: { Active: 1 },
    StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return {}; } },
    window: {
      registerCustomEditorProvider(name, value) { provider = value; return {}; },
      createStatusBarItem: () => ({ show() {} }),
      showOpenDialog: async () => [{ fsPath: '/ct' }],
      showQuickPick: async choices => choices[0],
      withProgress: async (settings, callback) => callback({ report() {} }, { isCancellationRequested: options.cancelSearch === true }),
      createWebviewPanel: () => panel,
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
      if (name === './dicom') return { ...realRequire(name), readHeader: async name => parseDicom(files[name.replace(/\\/g, '/')]) };
      return realRequire(name);
    }
  }, { filename: file });
  module.exports.activate({ subscriptions: [], extensionUri: '/extension' });
  return { panel, reads, messages, scans, commands,
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

test('Open CT still scans and loads a full series through the 3D viewer', async () => {
  const harness = extensionHarness();
  await harness.commands.get('dicom3d.openSeries')();
  assert.match(harness.panel.webview.html, /roi-mask.js/);
  harness.send({ type: 'ready' });
  await waitForMessage(harness, 'complete');
  const start = harness.messages.find(message => message.type === 'start');
  assert.equal(start.meta.count, 2);
  assert.equal(harness.messages.filter(message => message.type === 'slice').length, 2);
  assert.ok(harness.reads.some(name => name.replace(/\\/g, '/') === '/ct/other.dcm'));
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
