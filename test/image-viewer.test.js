'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function viewer() {
  const elements = new Map(), frames = [], messages = [], draws = [], bitmaps = [];
  let messageHandler, webglCalls = 0;
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const handlers = {};
    const value = {
      value: id === 'width' ? '400' : id === 'level' ? '40' : 'dicom',
      textContent: '', handlers, disabled: false,
      addEventListener(name, callback) { handlers[name] = callback; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      replaceChildren() {}, append() {}, setPointerCapture() {},
      getContext(kind) {
        if (kind !== '2d') { webglCalls++; throw new Error('2D viewer must not request WebGL'); }
        return {
          fillRect() {},
          createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
          putImageData(image) { bitmaps.push(image); },
          drawImage(...args) { draws.push(args); }
        };
      }
    };
    elements.set(id, value);
    return value;
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../media/image-viewer.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }),
    document: { getElementById: element, createElement: name => element(`${name}-${elements.size}`) },
    window: { devicePixelRatio: 1, addEventListener(name, callback) { if (name === 'message') messageHandler = callback; } },
    requestAnimationFrame: callback => frames.push(callback),
    atob: value => Buffer.from(value, 'base64').toString('binary')
  });
  return {
    element, draws, bitmaps, messages, get webglCalls() { return webglCalls; },
    flush() { while (frames.length) frames.shift()(); },
    send(message) { messageHandler({ data: message }); },
    load(spacing = [2, 1]) {
      const pixels = new Float32Array([-200, 0, 100, 200]);
      messageHandler({ data: { type: 'image', pixels: Buffer.from(pixels.buffer).toString('base64'),
        meta: { rows: 2, columns: 2, spacing, seriesNumber: '1', displayWindow: { level: 0, width: 400 } } } });
      this.flush();
    }
  };
}

test('2D canvas uses native image pixels, physical aspect ratio and no WebGL', () => {
  const view = viewer();
  assert.equal(view.messages[0].type, 'ready');
  view.load();
  const [, x, y, width, height] = view.draws.at(-1);
  assert.equal(width / height, .5);
  assert.equal(x, 250); assert.equal(y, 0);
  assert.deepEqual([...view.bitmaps[0].data.filter((_, i) => i % 4 === 0)], [0, 128, 191, 255]);
  assert.equal(view.webglCalls, 0);
  assert.equal(view.element('status').textContent, 'Ready');
});

test('missing spacing uses square pixels; zoom, pan and reset affect the rendered image', () => {
  const view = viewer(); view.load(null);
  const initial = view.draws.at(-1);
  assert.equal(initial[3], initial[4]);
  let prevented = false;
  view.element('image').handlers.wheel({ deltaY: -100, deltaMode: 0, clientX: 400, clientY: 300,
    preventDefault() { prevented = true; } });
  view.flush();
  assert.ok(prevented); assert.ok(view.draws.at(-1)[3] > initial[3]);
  assert.notEqual(view.element('imageZoom').textContent, '100%');
  view.element('image').handlers.pointerdown({ button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  const beforePan = view.draws.at(-1)[1];
  view.element('image').handlers.pointermove({ clientX: 30, clientY: 10 });
  view.flush();
  assert.equal(view.draws.at(-1)[1], beforePan + 30);
  view.element('resetImage').handlers.click(); view.flush();
  assert.deepEqual(view.draws.at(-1).slice(1), initial.slice(1));
  assert.equal(view.element('imageZoom').textContent, '100%');
});

test('window changes redraw grayscale and invalid windows are rejected', () => {
  const view = viewer(); view.load();
  view.element('width').value = '200'; view.element('width').handlers.input(); view.flush();
  assert.deepEqual([...view.bitmaps.at(-1).data.filter((_, i) => i % 4 === 0)], [0, 128, 255, 255]);
  const count = view.bitmaps.length;
  view.element('width').value = '0'; view.element('width').handlers.input(); view.flush();
  assert.equal(view.bitmaps.length, count);
  assert.match(view.element('status').textContent, /positive/);
  view.element('preset').value = 'dicom'; view.element('preset').handlers.change(); view.flush();
  assert.equal(view.element('width').value, '400');
});

test('cancel ignores an image arriving after cancellation', () => {
  const view = viewer();
  view.element('cancelLoad').handlers.click(); view.load();
  assert.equal(view.draws.length, 0);
  assert.equal(view.messages.at(-1).type, 'cancel');
  assert.equal(view.element('status').textContent, 'Loading cancelled');
});

test('series button sends one request and search failure preserves the image and allows retry', () => {
  const view = viewer(); view.load();
  const button = view.element('loadSeries');
  assert.equal(button.disabled, false);
  button.handlers.click(); button.handlers.click();
  assert.equal(view.messages.filter(message => message.type === 'loadSeries').length, 1);
  assert.equal(button.disabled, true);
  assert.equal(view.element('status').textContent, 'Searching for DICOM series');
  view.send({ type: 'seriesResult', text: 'Series search was cancelled.' });
  assert.equal(button.disabled, false);
  const count = view.draws.length;
  view.element('resetImage').handlers.click(); view.flush();
  assert.equal(view.draws.length, count + 1);
  button.handlers.click();
  assert.equal(view.messages.filter(message => message.type === 'loadSeries').length, 2);
});
