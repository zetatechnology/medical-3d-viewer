'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function viewer() {
  const elements = new Map(), messages = [];
  let receive;
  const gl = new Proxy({}, {
    get(target, key) {
      if (key === 'NO_ERROR') return 0;
      if (/^[A-Z_0-9]+$/.test(key)) return 1;
      if (key === 'getParameter') return () => 2048;
      if (key === 'getError') return () => 0;
      if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
      return () => ({});
    }
  });
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const value = {
      value: id === 'width' ? '400' : id === 'level' ? '40' : '0', hidden: false,
      textContent: '', disabled: false, handlers: {},
      classList: { contains: () => false },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      removeAttribute(name) { delete this[name]; },
      replaceChildren() {}, append() {}, querySelector: () => ({}),
      getBoundingClientRect: () => ({ width: 8, height: 8 }),
      getContext: kind => kind === 'webgl2' ? gl : {
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData() {}, fillRect() {}, fillText() {}
      }
    };
    elements.set(id, value);
    return value;
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../media/viewer.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }),
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {},
      createElement: name => element(`${name}-${elements.size}`) },
    window: { devicePixelRatio: 1, RoiMask: { buildMask: () => null, MAX_ROIS: 8 },
      addEventListener(name, callback) { if (name === 'message') receive = callback; } },
    requestAnimationFrame() {},
    atob: value => Buffer.from(value, 'base64').toString('binary')
  });
  return {
    element, messages, send: message => receive({ data: message }),
    start() {
      this.send({ type: 'start', meta: { rows: 2, columns: 2, count: 2, spacing: [1, 1],
        sliceSpacing: 1, origin: [0, 0, 0], row: [1, 0, 0], column: [0, 1, 0], normal: [0, 0, 1],
        seriesNumber: '1', rois: [] } });
    },
    slice(index) { this.send({ type: 'slice', index, pixels: Buffer.alloc(16).toString('base64') }); }
  };
}

test('3D progress changes from indeterminate to 0/50/100 percent and hides on completion', () => {
  const view = viewer(), bar = view.element('loadProgress');
  view.send({ type: 'status', text: 'Validating 1/2' });
  assert.equal(bar.hidden, false); assert.equal(bar.value, undefined);
  view.start();
  assert.equal(bar.value, 0);
  view.slice(0);
  assert.equal(bar.value, 50); assert.equal(view.element('status').textContent, 'Loading 50%');
  view.slice(1);
  assert.equal(bar.value, 100); assert.equal(view.element('status').textContent, 'Loading 100%');
  view.send({ type: 'complete' });
  assert.equal(bar.hidden, true); assert.equal(view.element('status').textContent, 'Ready');
  assert.equal(view.element('cancelLoad').disabled, true);
});

test('3D progress hides on host cancellation, load error and malformed slice', () => {
  for (const message of [{ type: 'cancel' }, { type: 'error', text: 'File not found.' },
    { type: 'slice', index: 1, pixels: '' }]) {
    const view = viewer(); view.start(); view.send(message);
    assert.equal(view.element('loadProgress').hidden, true);
    assert.equal(view.element('cancelLoad').disabled, true);
    if (message.type === 'slice') assert.equal(view.messages.at(-1).ok, false);
  }
});

test('cancel button hides progress; a subsequent load resets progress to zero', () => {
  const view = viewer(); view.start(); view.slice(0);
  view.element('cancelLoad').handlers.click();
  assert.equal(view.element('loadProgress').hidden, true);
  assert.equal(view.messages.at(-1).type, 'cancel');
  view.start();
  assert.equal(view.element('loadProgress').hidden, false);
  assert.equal(view.element('loadProgress').value, 0);
  assert.equal(view.element('cancelLoad').disabled, false);
});
