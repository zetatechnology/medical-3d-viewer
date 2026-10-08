(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const canvas = $('image');
  const bitmap = document.createElement('canvas');
  let meta, pixels, zoom = 1, pan = [0, 0], drag, pending = false, dirty = true, cancelled = false;
  const status = text => { $('status').textContent = text; };

  function currentWindow() {
    if (!$('level').value.trim() || !$('width').value.trim()) return null;
    const level = Number($('level').value), width = Number($('width').value);
    return Number.isFinite(level) && Number.isFinite(width) && width > 0 ? { level, width } : null;
  }

  function draw() {
    pending = false;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.min(2400, Math.max(1, Math.round(rect.width * ratio)));
    canvas.height = Math.min(1600, Math.max(1, Math.round(rect.height * ratio)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!pixels || !meta) return;
    const win = currentWindow();
    if (!win) return;
    if (dirty) {
      bitmap.width = meta.columns;
      bitmap.height = meta.rows;
      const source = bitmap.getContext('2d');
      const image = source.createImageData(meta.columns, meta.rows);
      for (let i = 0; i < pixels.length; i++) {
        const gray = Math.max(0, Math.min(255, Math.round((pixels[i] - win.level + win.width / 2) * 255 / win.width)));
        image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = gray;
        image.data[i * 4 + 3] = 255;
      }
      source.putImageData(image, 0, 0);
      dirty = false;
    }
    const width = meta.columns * (meta.spacing?.[1] || 1);
    const height = meta.rows * (meta.spacing?.[0] || 1);
    const fit = Math.min(canvas.width / width, canvas.height / height) * zoom;
    const drawWidth = width * fit, drawHeight = height * fit;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, (canvas.width - drawWidth) / 2 + pan[0] * canvas.width / rect.width,
      (canvas.height - drawHeight) / 2 + pan[1] * canvas.height / rect.height, drawWidth, drawHeight);
  }

  function requestRender() {
    if (!pending) { pending = true; requestAnimationFrame(draw); }
  }

  function setZoom(next, x = 0, y = 0) {
    next = Math.max(.25, Math.min(16, next));
    pan = pan.map((value, i) => [x, y][i] - ([x, y][i] - value) * next / zoom);
    zoom = next;
    $('imageZoom').textContent = `${Math.round(zoom * 100)}%`;
    requestRender();
  }

  function resetView() {
    zoom = 1; pan = [0, 0];
    $('imageZoom').textContent = '100%';
    requestRender();
  }

  function showMeta() {
    const values = [
      ['Format', 'DICOM CT'], ['Dimensions', `${meta.columns} × ${meta.rows}`],
      ['Pixel spacing', meta.spacing ? `${meta.spacing[0]} × ${meta.spacing[1]} mm` : 'Unknown (square pixels)'],
      ['Series number', meta.seriesNumber]
    ];
    $('metadata').replaceChildren();
    for (const [key, value] of values) {
      const dt = document.createElement('dt'); dt.textContent = key;
      const dd = document.createElement('dd'); dd.textContent = value;
      $('metadata').append(dt, dd);
    }
  }

  window.addEventListener('message', event => {
    if (cancelled) return;
    const message = event.data;
    try {
      if (message.type === 'status') status(message.text);
      else if (message.type === 'image') {
        const binary = atob(message.pixels);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        pixels = new Float32Array(bytes.buffer);
        meta = message.meta;
        if (pixels.length !== meta.rows * meta.columns) throw new Error('Invalid image size.');
        $('level').value = String(meta.displayWindow.level);
        $('width').value = String(meta.displayWindow.width);
        dirty = true;
        showMeta(); resetView();
        status('Ready'); $('cancelLoad').disabled = true; $('loadSeries').disabled = false;
      } else if (message.type === 'seriesResult') {
        status(message.text); $('loadSeries').disabled = false;
      } else if (message.type === 'error') {
        pixels = null; status(message.text); $('cancelLoad').disabled = true; requestRender();
      }
    } catch (error) {
      pixels = null; status(error.message || 'Could not display the image.');
      $('cancelLoad').disabled = true; requestRender();
    }
  });

  $('preset').addEventListener('change', () => {
    const win = $('preset').value === 'dicom' ? meta?.displayWindow :
      { soft: { level: 40, width: 400 }, bone: { level: 300, width: 1500 }, lung: { level: -600, width: 1500 } }[$('preset').value];
    if (!win) return;
    $('level').value = String(win.level); $('width').value = String(win.width);
    dirty = true; requestRender();
  });
  for (const name of ['level', 'width']) $(name).addEventListener('input', () => {
    if (!currentWindow()) { status('Window width must be positive and window level must be numeric.'); return; }
    dirty = true; requestRender();
    if (pixels) status('Ready');
  });
  $('resetImage').addEventListener('click', resetView);
  $('loadSeries').addEventListener('click', () => {
    if (!pixels || cancelled || $('loadSeries').disabled) return;
    $('loadSeries').disabled = true;
    status('Searching for DICOM series');
    vscode.postMessage({ type: 'loadSeries' });
  });
  $('cancelLoad').addEventListener('click', () => {
    cancelled = true; pixels = null;
    vscode.postMessage({ type: 'cancel' });
    status('Loading cancelled'); $('cancelLoad').disabled = true; requestRender();
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    setZoom(zoom * Math.exp(-delta * .001), event.clientX - rect.left - rect.width / 2,
      event.clientY - rect.top - rect.height / 2);
  }, { passive: false });
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    pan[0] += event.clientX - drag.x; pan[1] += event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY }; requestRender();
  });
  canvas.addEventListener('keydown', event => {
    if (event.key === '+' || event.key === '=') setZoom(zoom * 1.15);
    else if (event.key === '-') setZoom(zoom / 1.15);
    else if (event.key === '0') resetView();
    else return;
    event.preventDefault();
  });
  window.addEventListener('resize', requestRender);
  vscode.postMessage({ type: 'ready' });
})();
