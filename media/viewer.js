(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const status = text => { $('status').textContent = text; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const scale = (a, s) => a.map(v => v * s);
  let meta, voxels, roiMask, received = 0, bounds, renderer;
  let visibleRois = new Set();
  let yaw = 0.6, pitch = 0.35, zoom = 1.7, pan = [0, 0];
  let renderPending = false;
  const slicePlanes = {
    axial: { x: 0, y: 1, fixed: 2, flipY: false },
    coronal: { x: 0, y: 2, fixed: 1, flipY: true },
    sagittal: { x: 1, y: 2, fixed: 0, flipY: true }
  };
  const sliceViews = Object.fromEntries(Object.keys(slicePlanes).map(name =>
    [name, { zoom: 1, shiftX: 0, shiftY: 0 }]));
  const sliceRenderPending = new Set();
  const sliceWheelDelta = Object.fromEntries(Object.keys(slicePlanes).map(name => [name, 0]));

  function currentWindow() {
    const width = Number($('width').value);
    const level = Number($('level').value);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(level)) return null;
    return { width, level };
  }

  function currentClip() {
    const low = [0, 1, 2].map((_, i) => Number($(`clip${'XYZ'[i]}0`).value) / 100);
    const high = [0, 1, 2].map((_, i) => Number($(`clip${'XYZ'[i]}1`).value) / 100);
    return { low, high };
  }

  function patientPoint(col, row, slice) {
    return add(add(add(meta.origin, scale(meta.row, col * meta.spacing[1])),
      scale(meta.column, row * meta.spacing[0])), scale(meta.normal, slice * meta.sliceSpacing));
  }

  function volumeIndex(point) {
    const relative = point.map((v, i) => v - meta.origin[i]);
    return [dot(relative, meta.row) / meta.spacing[1],
      dot(relative, meta.column) / meta.spacing[0], dot(relative, meta.normal) / meta.sliceSpacing];
  }

  function calcBounds() {
    const points = [];
    for (const x of [0, meta.columns - 1]) for (const y of [0, meta.rows - 1])
      for (const z of [0, meta.count - 1]) points.push(patientPoint(x, y, z));
    return [0, 1, 2].map(axis => [Math.min(...points.map(p => p[axis])), Math.max(...points.map(p => p[axis]))]);
  }

  function setupSliders() {
    const map = { axial: 2, coronal: 1, sagittal: 0 };
    for (const [name, axis] of Object.entries(map)) {
      const input = $(`${name}Pos`);
      input.min = String(bounds[axis][0]);
      input.max = String(bounds[axis][1]);
      input.step = 'any';
      input.value = String((bounds[axis][0] + bounds[axis][1]) / 2);
    }
  }

  function sampleNearest(point) {
    const [x, y, z] = volumeIndex(point).map(Math.round);
    if (x < 0 || x >= meta.columns || y < 0 || y >= meta.rows || z < 0 || z >= meta.count) return null;
    return voxels[(z * meta.rows + y) * meta.columns + x];
  }

  function roiColor(roi) { return `rgb(${roi.color.join(',')})`; }

  function setupRoiControls() {
    const controls = $('roiControls');
    controls.replaceChildren();
    visibleRois = new Set(meta.rois.map(roi => roi.number));
    if (!meta.rois.length) {
      controls.textContent = 'No matching ROI contours.';
      return;
    }
    for (const roi of meta.rois) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = true;
      input.addEventListener('change', () => {
        if (input.checked) visibleRois.add(roi.number);
        else visibleRois.delete(roi.number);
        renderSlices(); requestRender();
      });
      const swatch = document.createElement('span');
      swatch.className = 'roiSwatch'; swatch.style.backgroundColor = roiColor(roi);
      const text = document.createElement('span');
      text.textContent = roi.name ? `ROI ${roi.number}: ${roi.name}` : `ROI ${roi.number}`;
      label.append(input, swatch, text);
      controls.append(label);
    }
  }

  function contourIntersections(points, plane, fixed) {
    const intersections = [];
    const coplanar = [];
    for (let i = 0; i < points.length; i += 3) {
      const a = points.slice(i, i + 3);
      const j = (i + 3) % points.length;
      const b = points.slice(j, j + 3);
      const da = a[plane.fixed] - fixed, db = b[plane.fixed] - fixed;
      if (Math.abs(da) < 1e-5 && Math.abs(db) < 1e-5) {
        coplanar.push([a, b]);
      } else if ((da <= 0 && db > 0) || (db <= 0 && da > 0)) {
        const t = -da / (db - da);
        intersections.push(a.map((v, k) => v + t * (b[k] - v)));
      }
    }
    if (intersections.length >= 2) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const point of intersections) {
        minX = Math.min(minX, point[plane.x]); maxX = Math.max(maxX, point[plane.x]);
        minY = Math.min(minY, point[plane.y]); maxY = Math.max(maxY, point[plane.y]);
      }
      const extentX = maxX - minX, extentY = maxY - minY;
      const axis = extentX >= extentY ? plane.x : plane.y;
      intersections.sort((a, b) => a[axis] - b[axis]);
    }
    const segments = [...coplanar];
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const a = intersections[i], b = intersections[i + 1];
      if (Math.hypot(...a.map((v, k) => v - b[k])) > 1e-5) segments.push([a, b]);
    }
    return segments;
  }

  function drawCrossSectionRois(ctx, sections, plane, xy) {
    if (!sections.length) return;
    const maxGap = Math.max(meta.sliceSpacing * 1.5, 0.1);
    const allowance = Math.max(...meta.spacing) * 2;
    const links = [];
    for (let i = 0; i < sections.length; i++) {
      for (let j = 0; j < sections.length; j++) {
        const lower = sections[i], upper = sections[j];
        const gap = upper.height - lower.height;
        if (gap <= 1e-4 || gap > maxGap || lower.right[plane.x] + allowance < upper.left[plane.x] ||
            upper.right[plane.x] + allowance < lower.left[plane.x]) continue;
        links.push({ i, j, score: Math.abs(lower.center - upper.center) + Math.abs(lower.width - upper.width) * .25 + gap * .01 });
      }
    }
    links.sort((a, b) => a.score - b.score);
    const hasPrevious = new Set(), hasNext = new Set();
    ctx.beginPath();
    const line = (a, b) => { ctx.moveTo(...xy(a)); ctx.lineTo(...xy(b)); };
    for (const { i, j } of links) {
      if (hasNext.has(i) || hasPrevious.has(j)) continue;
      hasNext.add(i); hasPrevious.add(j);
      line(sections[i].left, sections[j].left);
      line(sections[i].right, sections[j].right);
    }
    for (let i = 0; i < sections.length; i++) {
      if (!hasPrevious.has(i) || !hasNext.has(i)) line(sections[i].left, sections[i].right);
    }
    ctx.stroke();
  }

  function drawSliceRois(ctx, plane, fixed, centerX, centerY, pixelsPerMm, w, h, ratio) {
    if (!meta.rois?.length) return;
    const xy = point => [w / 2 + (point[plane.x] - centerX) * pixelsPerMm,
      h / 2 + (point[plane.y] - centerY) * pixelsPerMm * (plane.flipY ? -1 : 1)];
    const tolerance = Math.max(0.5, meta.sliceSpacing / 2);
    ctx.lineWidth = Math.max(1.5, ratio * 1.5);
    for (const roi of meta.rois) {
      if (!visibleRois.has(roi.number)) continue;
      ctx.strokeStyle = roiColor(roi);
      const sections = [];
      for (const contour of roi.contours) {
        const points = contour.points;
        if (plane.fixed === 2) {
          let drawn = false;
          ctx.beginPath();
          for (let i = 0; i < points.length; i += 3) {
            const point = points.slice(i, i + 3);
            if (Math.abs(point[2] - fixed) > tolerance) { drawn = false; continue; }
            const [x, y] = xy(point);
            if (!drawn) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            drawn = true;
          }
          if (drawn) ctx.closePath();
          ctx.stroke();
        } else {
          for (const [a, b] of contourIntersections(points, plane, fixed)) {
            const [left, right] = a[plane.x] <= b[plane.x] ? [a, b] : [b, a];
            sections.push({ left, right, center: (left[plane.x] + right[plane.x]) / 2,
              width: right[plane.x] - left[plane.x], height: (left[plane.y] + right[plane.y]) / 2 });
          }
        }
      }
      if (plane.fixed !== 2) drawCrossSectionRois(ctx, sections, plane, xy);
    }
  }

  function drawSlice(name) {
    if (!voxels || received !== meta.count) return;
    const canvas = $(name);
    const region = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.min(2400, Math.max(1, Math.round(region.width * ratio)));
    const h = Math.min(1600, Math.max(1, Math.round(region.height * ratio)));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(w, h);
    const p = slicePlanes[name];
    const view = sliceViews[name];
    const spanX = bounds[p.x][1] - bounds[p.x][0];
    const spanY = bounds[p.y][1] - bounds[p.y][0];
    const pixelsPerMm = Math.min(w / (spanX || 1), h / (spanY || 1)) * view.zoom;
    const centerX = (bounds[p.x][0] + bounds[p.x][1]) / 2 + view.shiftX;
    const centerY = (bounds[p.y][0] + bounds[p.y][1]) / 2 + view.shiftY;
    const fixed = Number($(`${name}Pos`).value);
    const windowValue = currentWindow();
    if (!windowValue) return;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const point = [0, 0, 0];
        point[p.x] = centerX + (px + .5 - w / 2) / pixelsPerMm;
        point[p.y] = centerY + (py + .5 - h / 2) / pixelsPerMm * (p.flipY ? -1 : 1);
        point[p.fixed] = fixed;
        const value = sampleNearest(point);
        const offset = (py * w + px) * 4;
        if (value !== null) {
          const gray = Math.max(0, Math.min(255, Math.round((value - windowValue.level + windowValue.width / 2) * 255 / windowValue.width)));
          image.data[offset] = gray;
          image.data[offset + 1] = gray;
          image.data[offset + 2] = gray;
          image.data[offset + 3] = 255;
        } else { image.data[offset + 3] = 255; }
      }
    }
    ctx.putImageData(image, 0, 0);
    drawSliceRois(ctx, p, fixed, centerX, centerY, pixelsPerMm, w, h, ratio);
    const barMm = pixelsPerMm * 50 <= w * .5 ? 50 : 10;
    const barPx = barMm * pixelsPerMm;
    ctx.fillStyle = '#fff';
    ctx.fillRect(12, h - 20, barPx, 2);
    ctx.fillRect(12, h - 24, 2, 10);
    ctx.fillRect(12 + barPx - 2, h - 24, 2, 10);
    ctx.font = `${Math.max(11, Math.round(12 * ratio))}px sans-serif`;
    ctx.fillText(`${barMm} mm`, 12, h - 28);
  }

  function renderSlices() { for (const name of ['axial', 'coronal', 'sagittal']) drawSlice(name); }

  function requestSliceRender(name) {
    if (sliceRenderPending.has(name)) return;
    sliceRenderPending.add(name);
    requestAnimationFrame(() => { sliceRenderPending.delete(name); drawSlice(name); });
  }

  function zoomSlice(name, event) {
    if (!bounds) return;
    event.preventDefault();
    const canvas = $(name);
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.min(2400, Math.max(1, Math.round(rect.width * ratio)));
    const h = Math.min(1600, Math.max(1, Math.round(rect.height * ratio)));
    const p = slicePlanes[name];
    const spanX = bounds[p.x][1] - bounds[p.x][0];
    const spanY = bounds[p.y][1] - bounds[p.y][0];
    const basePixelsPerMm = Math.min(w / (spanX || 1), h / (spanY || 1));
    const view = sliceViews[name];
    const oldPixelsPerMm = basePixelsPerMm * view.zoom;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    const nextZoom = Math.max(0.5, Math.min(8, view.zoom * Math.exp(-delta * .001)));
    if (nextZoom === view.zoom) return;
    const nextPixelsPerMm = basePixelsPerMm * nextZoom;
    const dx = ((event.clientX - rect.left) / rect.width - .5) * w;
    const dy = ((event.clientY - rect.top) / rect.height - .5) * h;
    view.shiftX += dx * (1 / oldPixelsPerMm - 1 / nextPixelsPerMm);
    view.shiftY += dy * (p.flipY ? -1 : 1) * (1 / oldPixelsPerMm - 1 / nextPixelsPerMm);
    view.zoom = nextZoom;
    $(`${name}Zoom`).textContent = `${Math.round(nextZoom * 100)}%`;
    requestSliceRender(name);
  }

  function moveSlice(name, event) {
    if (!bounds) return;
    event.preventDefault();
    const normalized = event.deltaY * (event.deltaMode === 1 ? 100 / 3 : event.deltaMode === 2 ? 300 : 1);
    sliceWheelDelta[name] += normalized;
    const count = Math.max(-8, Math.min(8, Math.trunc(sliceWheelDelta[name] / 100)));
    if (!count) return;
    sliceWheelDelta[name] -= count * 100;
    const axis = slicePlanes[name].fixed;
    const step = Math.max(
      Math.abs(meta.row[axis] * meta.spacing[1]),
      Math.abs(meta.column[axis] * meta.spacing[0]),
      Math.abs(meta.normal[axis] * meta.sliceSpacing), 0.1);
    const input = $(`${name}Pos`);
    const next = Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + count * step));
    if (next === Number(input.value)) { sliceWheelDelta[name] = 0; return; }
    input.value = String(next);
    requestSliceRender(name);
  }

  const vertexSource = `#version 300 es
    in vec2 position; out vec2 uv;
    void main() { uv = position; gl_Position = vec4(position, 0.0, 1.0); }`;
  const fragmentSource = `#version 300 es
    precision highp float; precision highp sampler3D; precision highp usampler3D;
    in vec2 uv; out vec4 color;
    uniform sampler3D volume;
    uniform usampler3D roiMask;
    uniform vec3 roiColors[8];
    uniform vec3 sizeMm, rightVec, upVec, forwardVec, clipLow, clipHigh;
    uniform float aspect, zoom, level, windowWidth, opacity, roiOpacity, voxelScale;
    uniform vec2 pan;
    uniform int preset, roiCount;
    uniform uint visibleRois;
    vec2 hitBox(vec3 origin, vec3 direction, vec3 low, vec3 high) {
      vec3 t0 = (low - origin) / direction;
      vec3 t1 = (high - origin) / direction;
      vec3 nearV = min(t0, t1), farV = max(t0, t1);
      return vec2(max(max(nearV.x, nearV.y), nearV.z), min(min(farV.x, farV.y), farV.z));
    }
    void main() {
      vec2 screen = vec2(uv.x * aspect, uv.y) / zoom + pan;
      vec3 origin = (rightVec * screen.x + upVec * screen.y) * 0.8 - forwardVec * 2.0;
      vec3 direction = forwardVec;
      vec3 halfSize = sizeMm * 0.5;
      vec2 interval = hitBox(origin, direction, -halfSize + clipLow * sizeMm, -halfSize + clipHigh * sizeMm);
      if (interval.x > interval.y || interval.y < 0.0) { color = vec4(0.06, 0.06, 0.06, 1.0); return; }
      float start = max(0.0, interval.x);
      vec3 accum = vec3(0.0);
      vec3 roiSurface = vec3(0.0);
      float alpha = 0.0;
      bool roiHit = false;
      float dt = (interval.y - start) / 160.0;
      for (int i = 0; i < 160; i++) {
        vec3 pos = origin + direction * (start + (float(i) + 0.5) * dt);
        vec3 texCoord = pos / sizeMm + 0.5;
        float value = texture(volume, texCoord).r * voxelScale;
        float normalized = clamp((value - level) / windowWidth + 0.5, 0.0, 1.0);
        float density = preset == 1 ? smoothstep(0.35, 0.8, normalized) :
          preset == 2 ? smoothstep(0.2, 0.7, normalized) : smoothstep(0.15, 0.9, normalized);
        vec3 tint = preset == 1 ? vec3(1.0, 0.93, 0.82) : preset == 2 ? vec3(0.74, 0.85, 1.0) : vec3(1.0);
        float a = density * opacity * 0.045;
        accum += (1.0 - alpha) * a * normalized * tint;
        alpha += (1.0 - alpha) * a;
        if (!roiHit && roiCount > 0 && visibleRois != 0u) {
          uint bits = texture(roiMask, texCoord).r & visibleRois;
          if (bits != 0u) {
            vec3 roiTint = vec3(0.0);
            for (int j = 0; j < 8; j++) {
              if (j >= roiCount) break;
              if ((bits & (1u << uint(j))) != 0u) roiTint = roiColors[j];
            }
            roiSurface = roiTint;
            roiHit = true;
          }
        }
        if (alpha > 0.98 && (roiCount == 0 || roiHit)) break;
      }
      vec3 ctColor = accum + vec3(0.06) * (1.0 - alpha);
      color = vec4(roiHit ? mix(ctColor, roiSurface, roiOpacity) : ctColor, 1.0);
    }`;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function createRenderer() {
    const canvas = $('volume');
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) { $('fallback').hidden = false; throw new Error('WebGL2 is unavailable.'); }
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture);
    const byteVoxels = voxels instanceof Uint8Array;
    const linearSupported = byteVoxels || Boolean(gl.getExtension('OES_texture_float_linear'));
    $('volumeInterpolation').querySelector('[value="linear"]').disabled = !linearSupported;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const max = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    if (Math.max(meta.columns, meta.rows, meta.count) > max) throw new Error(`The volume exceeds the GPU 3D texture limit (${max}).`);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, byteVoxels ? gl.R8 : gl.R32F,
      meta.columns, meta.rows, meta.count, 0, gl.RED, byteVoxels ? gl.UNSIGNED_BYTE : gl.FLOAT, voxels);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not upload the volume to the GPU.');
    const roiTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, roiTexture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, roiMask ? meta.columns : 1,
      roiMask ? meta.rows : 1, roiMask ? meta.count : 1, 0,
      gl.RED_INTEGER, gl.UNSIGNED_BYTE, roiMask ? roiMask.data : new Uint8Array(1));
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not upload the 3D ROI mask to the GPU.');
    return { gl, program, vertices, texture, roiTexture, linearSupported };
  }

  function disposeRenderer() {
    if (!renderer) return;
    const { gl, program, vertices, texture, roiTexture } = renderer;
    gl.deleteTexture(texture);
    gl.deleteTexture(roiTexture);
    gl.deleteBuffer(vertices);
    gl.deleteProgram(program);
    renderer = null;
  }

  function drawVolume() {
    renderPending = false;
    if (!renderer || !meta) return;
    const { gl, program, vertices, texture, roiTexture, linearSupported } = renderer;
    const canvas = $('volume');
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const expanded = $('volumePanel').classList.contains('expanded');
    const width = Math.min(expanded ? 2048 : 1200, Math.max(1, Math.round(rect.width * ratio)));
    const height = Math.min(expanded ? 1280 : 800, Math.max(1, Math.round(rect.height * ratio)));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    const loc = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    const filter = $('volumeInterpolation').value === 'linear' && linearSupported ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, roiTexture);
    const float = (key, value) => gl.uniform1f(gl.getUniformLocation(program, key), value);
    const vec3 = (key, value) => gl.uniform3fv(gl.getUniformLocation(program, key), value);
    const vec2 = (key, value) => gl.uniform2fv(gl.getUniformLocation(program, key), value);
    const size = [meta.columns * meta.spacing[1], meta.rows * meta.spacing[0], meta.count * meta.sliceSpacing];
    const maxSize = Math.max(...size);
    const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    vec3('sizeMm', size.map(v => v / maxSize));
    vec3('rightVec', [c, s, 0]);
    vec3('upVec', [-s * sp, c * sp, cp]);
    vec3('forwardVec', [s * cp, -c * cp, sp]);
    const clip = currentClip();
    vec3('clipLow', clip.low); vec3('clipHigh', clip.high);
    float('aspect', canvas.width / canvas.height); float('zoom', zoom);
    vec2('pan', pan);
    const win = currentWindow();
    if (!win) return;
    float('level', win.level); float('windowWidth', win.width);
    float('voxelScale', meta.textureScale || 1);
    float('opacity', Number($('opacity').value) / 100);
    float('roiOpacity', Number($('roiOpacity').value) / 100);
    gl.uniform1i(gl.getUniformLocation(program, 'preset'), ['soft', 'bone', 'lung'].indexOf($('preset').value));
    gl.uniform1i(gl.getUniformLocation(program, 'volume'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'roiMask'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'roiCount'), roiMask?.rois.length || 0);
    let visibleBits = 0;
    if (roiMask) {
      const colors = new Float32Array(8 * 3);
      for (let i = 0; i < roiMask.rois.length; i++) {
        const roi = roiMask.rois[i];
        colors.set(roi.color.map(channel => channel / 255), i * 3);
        if (visibleRois.has(roi.number)) visibleBits |= 1 << i;
      }
      gl.uniform3fv(gl.getUniformLocation(program, 'roiColors[0]'), colors);
    }
    gl.uniform1ui(gl.getUniformLocation(program, 'visibleRois'), visibleBits);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function requestRender() {
    if (!renderPending) { renderPending = true; requestAnimationFrame(drawVolume); }
  }

  function setExpanded(targetId) {
    for (const button of document.querySelectorAll('.expandButton')) {
      const active = button.dataset.target === targetId;
      $(button.dataset.target).classList.toggle('expanded', active);
      button.setAttribute('aria-pressed', String(active));
      const label = `${active ? 'Restore' : 'Expand'} ${button.dataset.label}`;
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    document.body.classList.toggle('viewExpanded', Boolean(targetId));
    requestAnimationFrame(() => { renderSlices(); requestRender(); });
  }

  function showMeta() {
    const values = [
      ['Format', meta.modality || 'DICOM CT'], ['Slices', `${meta.count}`],
      ['Dimensions', `${meta.columns} × ${meta.rows}`],
      ['Pixel spacing', `${meta.spacing[0]} × ${meta.spacing[1]} mm`],
      ['Slice spacing', `${meta.sliceSpacing.toFixed(2)} mm`],
      [meta.modality === 'NIfTI' ? 'File' : 'Series number', meta.seriesNumber],
      ...(meta.datatype ? [['Data type', meta.datatype]] : []), ['ROIs', `${meta.rois.length}`]
    ];
    const dl = $('metadata');
    dl.replaceChildren();
    for (const [key, value] of values) {
      const dt = document.createElement('dt'); dt.textContent = key;
      const dd = document.createElement('dd'); dd.textContent = value;
      dl.append(dt, dd);
    }
  }

  window.addEventListener('message', event => {
    const message = event.data;
    try {
      if (message.type === 'status') status(message.text);
      else if (message.type === 'start') {
        meta = message.meta;
        roiMask = null;
        disposeRenderer();
        voxels = meta.voxelEncoding === 'uint8'
          ? new Uint8Array(meta.columns * meta.rows * meta.count)
          : new Float32Array(meta.columns * meta.rows * meta.count);
        received = 0;
        bounds = calcBounds();
        setupSliders();
        for (const name of Object.keys(sliceViews)) {
          Object.assign(sliceViews[name], { zoom: 1, shiftX: 0, shiftY: 0 });
          sliceWheelDelta[name] = 0;
          $(`${name}Zoom`).textContent = '100%';
        }
        setupRoiControls();
        showMeta();
        status('Loading 0%');
      } else if (message.type === 'slice') {
        if (!voxels || !meta || message.index !== received) throw new Error('Slices arrived out of order.');
        const binary = atob(message.pixels);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const slice = meta.voxelEncoding === 'uint8' ? bytes : new Float32Array(bytes.buffer);
        if (slice.length !== meta.rows * meta.columns) throw new Error('Invalid slice size.');
        voxels.set(slice, message.index * slice.length);
        received++;
        status(`Loading ${Math.round(received * 100 / meta.count)}%`);
        vscode.postMessage({ type: 'sliceAck', ok: true });
      } else if (message.type === 'complete') {
        if (received !== meta.count) throw new Error('Some slices are missing.');
        if (message.displayWindow) {
          $('level').value = String(message.displayWindow.level);
          $('width').value = String(message.displayWindow.width);
        }
        status('Building 3D ROI masks');
        roiMask = window.RoiMask.buildMask(meta);
        const maskInfo = [];
        if (meta.rois.length > window.RoiMask.MAX_ROIS)
          maskInfo.push(`3D masks show the first ${window.RoiMask.MAX_ROIS} ROIs.`);
        if (roiMask?.skippedContours)
          maskInfo.push(`${roiMask.skippedContours} contours could not be mapped to CT slices.`);
        if (maskInfo.length) {
          const note = document.createElement('p');
          note.className = 'roiMaskInfo';
          note.textContent = maskInfo.join(' ');
          $('roiControls').append(note);
        }
        renderer = createRenderer();
        if (roiMask) roiMask.data = null;
        renderSlices(); requestRender();
        status('Ready'); $('cancelLoad').disabled = true;
      } else if (message.type === 'cancel') { voxels = null; status('Loading cancelled'); }
      else if (message.type === 'error') { voxels = null; status(message.text); }
    } catch (error) {
      if (message.type === 'slice') vscode.postMessage({ type: 'sliceAck', ok: false });
      voxels = null;
      status(error.message || 'Could not display the series.');
    }
  });

  $('preset').addEventListener('change', () => {
    const values = { soft: [40, 400], bone: [300, 1500], lung: [-600, 1500] }[$('preset').value];
    $('level').value = values[0]; $('width').value = values[1];
    renderSlices(); requestRender();
  });
  $('volumeInterpolation').addEventListener('change', requestRender);
  for (const name of ['level', 'width']) $(name).addEventListener('change', () => {
    if (!currentWindow()) { status('Window width must be positive and window level must be numeric.'); return; }
    renderSlices(); requestRender();
  });
  for (const name of ['axial', 'coronal', 'sagittal']) $(`${name}Pos`).addEventListener('input', () => drawSlice(name));
  for (const name of Object.keys(slicePlanes)) $(name).addEventListener('wheel', event => {
    if (event.ctrlKey) { sliceWheelDelta[name] = 0; zoomSlice(name, event); }
    else moveSlice(name, event);
  }, { passive: false });
  for (const button of document.querySelectorAll('.expandButton')) {
    button.dataset.label = button.getAttribute('aria-label').replace(/^Expand /, '');
    button.addEventListener('click', () => {
      setExpanded($(button.dataset.target).classList.contains('expanded') ? null : button.dataset.target);
    });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('viewExpanded')) {
      setExpanded(null);
      event.preventDefault();
    }
  });
  for (const name of ['opacity', 'roiOpacity', 'clipX0', 'clipX1', 'clipY0', 'clipY1', 'clipZ0', 'clipZ1'])
    $(name).addEventListener('input', requestRender);
  $('resetCamera').addEventListener('click', () => { yaw = .6; pitch = .35; zoom = 1.7; pan = [0, 0]; requestRender(); });
  $('cancelLoad').addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
    voxels = null;
    status('Loading cancelled');
    $('cancelLoad').disabled = true;
  });
  const canvas = $('volume');
  let drag;
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => { drag = { x: event.clientX, y: event.clientY, button: event.button }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (drag.button === 2) { pan[0] -= dx / canvas.clientHeight / zoom; pan[1] += dy / canvas.clientHeight / zoom; }
    else { yaw += dx * .008; pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * .008)); }
    drag.x = event.clientX; drag.y = event.clientY; requestRender();
  });
  canvas.addEventListener('wheel', event => { event.preventDefault(); zoom = Math.max(.3, Math.min(6, zoom * Math.exp(-event.deltaY * .001))); requestRender(); }, { passive: false });
  canvas.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') yaw -= .1;
    else if (event.key === 'ArrowRight') yaw += .1;
    else if (event.key === 'ArrowUp') pitch = Math.max(-1.5, pitch - .1);
    else if (event.key === 'ArrowDown') pitch = Math.min(1.5, pitch + .1);
    else if (event.key === '+' || event.key === '=') zoom = Math.min(6, zoom * 1.15);
    else if (event.key === '-') zoom = Math.max(.3, zoom / 1.15);
    else return;
    event.preventDefault(); requestRender();
  });
  window.addEventListener('resize', () => { renderSlices(); requestRender(); });
  vscode.postMessage({ type: 'ready' });
})();
