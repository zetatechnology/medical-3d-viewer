'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DicomError, readHeader, parseDicom, validateImage, validateSeries, decodePixels, CT_IMAGE } = require('./dicom');
const { RTSTRUCT, parseRtstruct } = require('./rtstruct');
const { parseLidcXml, MAX_XML_BYTES } = require('./lidc');
const { NiftiError, readNiftiFile, scanNiftiRange, decodeNiftiSlice } = require('./nifti');
const { prepareLabels } = require('./nifti-labels');

const MAX_FILES = 10000;
const MAX_VOXELS = 140_000_000;
const MAX_NIFTI_BYTES = MAX_VOXELS * 8 + 4096;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const activeLoads = new Set();

async function listFiles(root, token) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    if (token.isCancellationRequested) return null;
    const dir = pending.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        files.push(file);
        if (files.length > MAX_FILES) throw new Error(`The folder exceeds the ${MAX_FILES}-file limit.`);
      }
    }
  }
  return files;
}

async function findSeries(root, progress, token) {
  const files = await listFiles(root, token);
  if (!files) return null;
  const groups = new Map();
  const rtFiles = [];
  const xmlFiles = [];
  let unsupported = 0;
  for (let index = 0; index < files.length; index++) {
    if (token.isCancellationRequested) return null;
    const file = files[index];
    try {
      if (/\.xml$/i.test(file)) { xmlFiles.push(file); continue; }
      const meta = await readHeader(file);
      if (meta.sopClass === RTSTRUCT && meta.modality === 'RTSTRUCT') {
        rtFiles.push(file);
      } else if (meta.sopClass === '1.2.840.10008.5.1.4.1.1.2' && meta.modality === 'CT' && meta.seriesUid && meta.studyUid) {
        const key = `${meta.studyUid}\0${meta.seriesUid}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ file, meta });
      }
    } catch (error) {
      if (error instanceof DicomError && error.code !== 'FORMAT') unsupported++;
      else if (!(error instanceof DicomError)) unsupported++;
    }
    if (index % 10 === 0) progress.report({ message: `Scanning ${index + 1}/${files.length} files` });
  }
  return { groups, rtFiles, xmlFiles, unsupported, total: files.length };
}

function panelHtml(panel, extensionUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const maskScript = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'roi-mask.js'));
  const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'viewer.js'));
  const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'viewer.css'));
  const expandButton = (target, label) => `<button class="expandButton imageExpand" type="button" data-target="${target}" aria-controls="${target}" aria-pressed="false" aria-label="Expand ${label}" title="Expand ${label}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="iconExpand" d="M9 4H4v5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5"/><path class="iconRestore" d="M4 10h6V4 M20 10h-6V4 M20 14h-6v6 M4 14h6v6"/></svg></button>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource};">
    <meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="stylesheet" href="${style}">
    <title>Medical 3D Viewer</title></head><body>
    <header><strong>Medical 3D Viewer</strong><div class="loadStatus"><span id="status" role="status">Ready to load</span><progress id="loadProgress" max="100" aria-label="Volume loading progress"></progress></div><button id="cancelLoad" type="button">Cancel loading</button></header>
    <div id="notice">For research and development only. Not for diagnosis.</div>
    <main>
      <section id="volumePanel" aria-label="3D volume">
        <div class="panelTitle"><h2>3D Volume</h2><button id="resetCamera" type="button">Reset view</button></div>
        <div class="volumeStack"><canvas id="volume" tabindex="0" aria-label="3D CT image with ROI masks. Drag or use arrow keys to rotate, scroll or use plus and minus to zoom, and right-drag to pan."></canvas>${expandButton('volumePanel', '3D Volume')}</div>
        <div id="fallback" hidden>WebGL2 is unavailable. The 3D view cannot start.</div>
      </section>
      <section id="slices" aria-label="Slice views">
        <div id="axialPanel" class="slice"><h2>Axial <small>Top: A / Bottom: P / Left: R / Right: L · <span id="axialZoom">100%</span></small></h2><div class="sliceImage"><canvas id="axial" aria-label="Axial CT image. Scroll to move between slices; Ctrl+scroll to zoom." title="Scroll: change slice / Ctrl+scroll: zoom"></canvas>${expandButton('axialPanel', 'Axial view')}</div><input id="axialPos" aria-label="Axial slice position" type="range"></div>
        <div id="coronalPanel" class="slice"><h2>Coronal <small>Top: H / Bottom: F / Left: R / Right: L · <span id="coronalZoom">100%</span></small></h2><div class="sliceImage"><canvas id="coronal" aria-label="Coronal CT image. Scroll to move between slices; Ctrl+scroll to zoom." title="Scroll: change slice / Ctrl+scroll: zoom"></canvas>${expandButton('coronalPanel', 'Coronal view')}</div><input id="coronalPos" aria-label="Coronal slice position" type="range"></div>
        <div id="sagittalPanel" class="slice"><h2>Sagittal <small>Top: H / Bottom: F / Left: A / Right: P · <span id="sagittalZoom">100%</span></small></h2><div class="sliceImage"><canvas id="sagittal" aria-label="Sagittal CT image. Scroll to move between slices; Ctrl+scroll to zoom." title="Scroll: change slice / Ctrl+scroll: zoom"></canvas>${expandButton('sagittalPanel', 'Sagittal view')}</div><input id="sagittalPos" aria-label="Sagittal slice position" type="range"></div>
      </section>
      <aside aria-label="Display settings">
        <h2>Display settings</h2>
        <div id="niftiLabels" hidden>
          <h3>NIfTI labels</h3>
          <button id="loadLabels" type="button" disabled>Load NIfTI labels…</button>
          <button id="clearLabels" type="button" disabled>Remove labels</button>
          <p class="roiMaskInfo">Overlay a label .nii or .nii.gz on the current image.</p>
          <label id="labelOpacityControl">Label overlay opacity <input id="labelOpacity" type="range" min="0" max="100" value="45"></label>
        </div>
        <label>Preset <select id="preset"><option value="soft">Soft tissue</option><option value="bone">Bone</option><option value="lung">Lung</option></select></label>
        <label>Window level <input id="level" type="number" value="40" step="1"></label>
        <label>Window width <input id="width" type="number" value="400" min="1" step="1"></label>
        <label>Opacity <input id="opacity" type="range" min="0" max="100" value="35"></label>
        <label>3D CT sampling <select id="volumeInterpolation"><option value="nearest">Sharp (nearest voxel)</option><option value="linear">Smooth (linear)</option></select></label>
        <h3 id="roiHeading">ROI annotations</h3>
        <div id="roiControls" aria-label="ROI visibility settings"></div>
        <label>3D ROI opacity <input id="roiOpacity" type="range" min="0" max="100" value="60"></label>
        <h3>Clipping range</h3>
        <label>X min <input id="clipX0" type="range" min="0" max="100" value="0"></label>
        <label>X max <input id="clipX1" type="range" min="0" max="100" value="100"></label>
        <label>Y min <input id="clipY0" type="range" min="0" max="100" value="0"></label>
        <label>Y max <input id="clipY1" type="range" min="0" max="100" value="100"></label>
        <label>Z min <input id="clipZ0" type="range" min="0" max="100" value="0"></label>
        <label>Z max <input id="clipZ1" type="range" min="0" max="100" value="100"></label>
        <h3>Series information</h3><dl id="metadata"></dl>
      </aside>
    </main><script nonce="${nonce}" src="${maskScript}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function safeError(error) {
  if (error instanceof DicomError || error instanceof NiftiError) return error.message;
  if (error?.code === 'ENOENT') return 'File not found.';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'Permission denied while reading a file.';
  return 'Could not load the series. Check the file format and available memory.';
}

async function sendSlice(panel, cancellation, index, pixels, type = 'slice') {
  return new Promise(resolve => {
    cancellation.ack = resolve;
    void panel.webview.postMessage({ type, index,
      pixels: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength).toString('base64') })
      .then(delivered => { if (!delivered && cancellation.ack === resolve) { cancellation.ack = null; resolve(false); } })
      .catch(() => { if (cancellation.ack === resolve) { cancellation.ack = null; resolve(false); } });
  });
}

async function loadSeries(panel, records, rtFiles, cancellation, xmlFiles = []) {
  let total;
  try {
    const images = [];
    for (let i = 0; i < records.length; i++) {
      if (cancellation.cancelled) return;
      const data = await fs.readFile(records[i].file);
      images.push({ ...parseDicom(data), file: records[i].file });
      if (i % 10 === 0) await panel.webview.postMessage({ type: 'status', text: `Validating ${i + 1}/${records.length}` });
    }
    const volume = validateSeries(images);
    const frameOfReferenceUid = volume.images[0].frameOfReferenceUid;
    const rois = [];
    if (frameOfReferenceUid) {
      for (const file of rtFiles) {
        if (cancellation.cancelled) return;
        try {
          const structure = parseRtstruct(await fs.readFile(file));
          for (const roi of structure.rois) {
            if (roi.frameOfReferenceUid === frameOfReferenceUid) rois.push(roi);
          }
        } catch (error) {
          if (!(error instanceof DicomError)) throw error;
        }
      }
    }
    const roiWarnings = [];
    for (const file of xmlFiles) {
      if (cancellation.cancelled) return;
      try {
        if ((await fs.stat(file)).size > MAX_XML_BYTES)
          throw new DicomError('LIDC_XML', 'Annotation XML exceeds the 16 MiB limit.');
        const annotations = parseLidcXml(await fs.readFile(file), volume.images);
        rois.push(...annotations.rois);
        roiWarnings.push(...annotations.warnings);
      } catch (error) {
        roiWarnings.push(`Annotation XML skipped: ${safeError(error)}`);
      }
    }
    // Visibility controls and mask bits must have unique identifiers across files.
    const roiNumbers = new Set();
    let nextRoiNumber = 1;
    for (const roi of rois) {
      if (roiNumbers.has(roi.number)) {
        while (roiNumbers.has(nextRoiNumber)) nextRoiNumber++;
        roi.sourceNumber = roi.number;
        roi.number = nextRoiNumber;
      }
      roiNumbers.add(roi.number);
    }
    total = volume.rows * volume.columns * volume.images.length;
    if (total > MAX_VOXELS) throw new DicomError('MEMORY', 'The volume exceeds the size limit.');
    if (cancellation.cancelled) return;
    const meta = {
      rows: volume.rows, columns: volume.columns, count: volume.images.length,
      spacing: volume.spacing, sliceSpacing: volume.sliceSpacing,
      origin: volume.origin, row: volume.row, column: volume.column, normal: volume.normal,
      seriesNumber: volume.images[0].seriesNumber || '—', rois, roiWarnings
    };
    await panel.webview.postMessage({ type: 'start', meta });
    for (let i = 0; i < volume.images.length; i++) {
      if (cancellation.cancelled) {
        await panel.webview.postMessage({ type: 'cancel' });
        return;
      }
      const data = await fs.readFile(volume.images[i].file);
      const pixels = decodePixels(data, volume.images[i]);
      const acknowledged = await sendSlice(panel, cancellation, i, pixels);
      if (!acknowledged) return;
    }
    await panel.webview.postMessage({ type: 'complete' });
  } catch (error) {
    if (!cancellation.cancelled) await panel.webview.postMessage({ type: 'error', text: safeError(error) });
  }
}

async function loadNifti(panel, file, cancellation) {
  try {
    await panel.webview.postMessage({ type: 'status', text: 'Reading NIfTI volume' });
    const volume = await readNiftiFile(file, MAX_NIFTI_BYTES);
    const total = volume.rows * volume.columns * volume.count;
    if (total > MAX_VOXELS) throw new NiftiError('MEMORY', 'The volume exceeds the size limit.');
    if (cancellation.cancelled) return;
    const { minimum, maximum } = scanNiftiRange(volume);
    const integerType = !volume.datatypeName.startsWith('float');
    const voxelEncoding = integerType && Number.isInteger(volume.slope) && Number.isInteger(volume.intercept) &&
      minimum >= 0 && maximum <= 255 ? 'uint8' : 'float32';
    await panel.webview.postMessage({ type: 'start', meta: {
      rows: volume.rows, columns: volume.columns, count: volume.count,
      spacing: volume.spacing, sliceSpacing: volume.sliceSpacing,
      origin: volume.origin, row: volume.row, column: volume.column, normal: volume.normal,
      seriesNumber: path.basename(file), modality: 'NIfTI', datatype: volume.datatypeName,
      voxelEncoding, textureScale: voxelEncoding === 'uint8' ? 255 : 1, rois: []
    } });
    for (let i = 0; i < volume.count; i++) {
      if (cancellation.cancelled) {
        await panel.webview.postMessage({ type: 'cancel' });
        return;
      }
      const pixels = decodeNiftiSlice(volume, i, voxelEncoding);
      const acknowledged = await sendSlice(panel, cancellation, i, pixels);
      if (!acknowledged) return;
    }
    const displayWindow = Number.isFinite(minimum) && Number.isFinite(maximum)
      ? { level: (minimum + maximum) / 2, width: Math.max(maximum - minimum, 1) } : undefined;
    cancellation.niftiGeometry = {
      rows: volume.rows, columns: volume.columns, count: volume.count,
      spacing: volume.spacing, sliceSpacing: volume.sliceSpacing,
      origin: volume.origin, row: volume.row, column: volume.column, normal: volume.normal
    };
    await panel.webview.postMessage({ type: 'complete', displayWindow });
  } catch (error) {
    if (!cancellation.cancelled) await panel.webview.postMessage({ type: 'error', text: safeError(error) });
  }
}

async function loadNiftiLabels(panel, cancellation) {
  cancellation.labelsLoading = true;
  try {
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false,
      title: 'Select NIfTI label volume', filters: { NIfTI: ['nii', 'gz'] } });
    if (!selected?.length || cancellation.cancelled) return;
    if (selected[0].scheme !== 'file' || !/\.nii(?:\.gz)?$/i.test(selected[0].fsPath))
      throw new NiftiError('FORMAT', 'Select a local .nii or .nii.gz label volume.');
    await panel.webview.postMessage({ type: 'labelStatus', text: 'Reading NIfTI labels' });
    const volume = await readNiftiFile(selected[0].fsPath, MAX_NIFTI_BYTES);
    const labels = prepareLabels(cancellation.niftiGeometry, volume);
    if (cancellation.cancelled) return;
    await panel.webview.postMessage({ type: 'labelStart', rois: labels.rois });
    for (let index = 0; index < volume.count; index++) {
      if (cancellation.cancelled || !await sendSlice(panel, cancellation, index, labels.decodeSlice(index), 'labelSlice')) return;
    }
    await panel.webview.postMessage({ type: 'labelComplete' });
  } catch (error) {
    if (!cancellation.cancelled) await panel.webview.postMessage({ type: 'labelError', text: safeError(error) });
  } finally {
    cancellation.labelsLoading = false;
    if (!cancellation.cancelled) await panel.webview.postMessage({ type: 'labelIdle' });
  }
}

function imagePanelHtml(panel, extensionUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'image-viewer.js'));
  const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'viewer.css'));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="stylesheet" href="${style}">
    <title>DICOM 2D Viewer</title></head><body class="imageViewer">
    <header><strong>DICOM 2D Viewer</strong><span id="status" role="status">Ready to load</span><button id="cancelLoad" type="button">Cancel loading</button></header>
    <div id="notice">For research and development only. Not for diagnosis.</div>
    <main>
      <section aria-label="Single DICOM image">
        <div class="panelTitle"><h2>2D image <small id="imageZoom">100%</small></h2><button id="resetImage" type="button">Reset view</button></div>
        <canvas id="image" tabindex="0" aria-label="Single DICOM image. Scroll or use plus and minus to zoom; drag to pan." title="Scroll: zoom / Drag: pan"></canvas>
      </section>
      <aside aria-label="Display settings"><h2>Display settings</h2>
        <button id="loadSeries" type="button" hidden disabled>Load series in 3D</button>
        <label>Preset <select id="preset"><option value="dicom">DICOM window</option><option value="soft">Soft tissue</option><option value="bone">Bone</option><option value="lung">Lung</option></select></label>
        <label>Window level <input id="level" type="number" value="40" step="1"></label>
        <label>Window width <input id="width" type="number" value="400" min="1" step="1"></label>
        <h3>Image information</h3><dl id="metadata"></dl>
      </aside>
    </main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

async function loadImage(panel, file, cancellation) {
  try {
    await panel.webview.postMessage({ type: 'status', text: 'Reading DICOM image' });
    const stat = await fs.stat(file);
    if (stat.size > MAX_IMAGE_BYTES) throw new DicomError('MEMORY', 'The image file exceeds the 64 MiB size limit.');
    if (cancellation.cancelled) return;
    const data = await fs.readFile(file);
    const image = validateImage(parseDicom(data));
    if (Math.max(image.rows, image.columns) > 16384 || image.rows * image.columns > 16_777_216) {
      throw new DicomError('MEMORY', 'The image exceeds the 2D display size limit.');
    }
    const pixels = decodePixels(data, image);
    if (cancellation.cancelled) return;
    const spacing = [image.spacing, image.imagerSpacing].find(values =>
      values?.length === 2 && values.every(v => Number.isFinite(v) && v > 0)) || null;
    const canLoadSeries = image.sopClass === CT_IMAGE && image.modality === 'CT';
    const level = image.windowCenter?.[0];
    const width = image.windowWidth?.[0];
    let displayWindow = Number.isFinite(level) && Number.isFinite(width) && width > 0
      ? { level, width } : null;
    if (!canLoadSeries) {
      let minimum = Infinity, maximum = -Infinity;
      for (const pixel of pixels) { minimum = Math.min(minimum, pixel); maximum = Math.max(maximum, pixel); }
      // Some radiographs carry CT window values that clip almost the entire image.
      const overlap = displayWindow ? Math.max(0, Math.min(maximum, level + width / 2) -
        Math.max(minimum, level - width / 2)) : 0;
      if (!displayWindow || overlap < (maximum - minimum) * .1) {
        displayWindow = { level: (minimum + maximum) / 2, width: Math.max(maximum - minimum, 1) };
      }
    }
    displayWindow ||= { level: 40, width: 400 };
    const delivered = await panel.webview.postMessage({ type: 'image', meta: {
      rows: image.rows, columns: image.columns, spacing,
      seriesNumber: image.seriesNumber || '—', modality: image.modality || 'Unknown',
      photometric: image.photometric, canLoadSeries, displayWindow
    }, pixels: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength).toString('base64') });
    cancellation.imageLoaded = delivered;
    cancellation.canLoadSeries = canLoadSeries;
  } catch (error) {
    if (!cancellation.cancelled) await panel.webview.postMessage({ type: 'error', text: safeError(error) });
  }
}

function showViewer(panel, context, loader, html = panelHtml, seriesLoader) {
  const cancellation = { cancelled: false };
  activeLoads.add(cancellation);
  panel.onDidDispose(() => {
    cancellation.cancelled = true;
    cancellation.ack?.(false);
    cancellation.ack = null;
    activeLoads.delete(cancellation);
  });
  panel.webview.onDidReceiveMessage(message => {
    if (message?.type === 'ready') void loader(panel, cancellation);
    if (message?.type === 'loadLabels' && cancellation.niftiGeometry &&
        !cancellation.cancelled && !cancellation.labelsLoading) void loadNiftiLabels(panel, cancellation);
    if (message?.type === 'loadSeries' && seriesLoader && cancellation.imageLoaded && cancellation.canLoadSeries &&
        !cancellation.cancelled && !cancellation.seriesRequested) {
      cancellation.seriesRequested = true;
      void seriesLoader(panel, cancellation, nextLoader => {
        loader = nextLoader;
        seriesLoader = null;
        panel.webview.html = panelHtml(panel, context.extensionUri);
      });
    }
    if (message?.type === 'sliceAck' && cancellation.ack) {
      const resolve = cancellation.ack;
      cancellation.ack = null;
      resolve(message.ok === true);
    }
    if (message?.type === 'cancel') {
      cancellation.cancelled = true;
      cancellation.ack?.(false);
      cancellation.ack = null;
    }
  });
  panel.webview.html = html(panel, context.extensionUri);
}

async function loadFileSeries(panel, file, cancellation, show) {
  try {
    const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'Searching for DICOM series', cancellable: true }, async (progress, token) => {
      const found = await findSeries(path.dirname(file), progress, {
        get isCancellationRequested() { return cancellation.cancelled || token.isCancellationRequested; }
      });
      return token.isCancellationRequested ? null : found;
    });
    if (cancellation.cancelled) return;
    if (!found) throw new DicomError('CANCELLED', 'Series search was cancelled.');
    const normalized = value => {
      const absolute = path.resolve(value);
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    };
    const records = [...found.groups.values()].find(group =>
      group.some(record => normalized(record.file) === normalized(file)));
    if (!records) throw new DicomError('SERIES', 'No supported CT series found for this image.');
    if (records.length < 2) throw new DicomError('SERIES', '3D display requires at least two slices.');
    show((target, loadCancellation) => loadSeries(target, records, found.rtFiles, loadCancellation, found.xmlFiles));
  } catch (error) {
    if (!cancellation.cancelled) {
      cancellation.seriesRequested = false;
      await panel.webview.postMessage({ type: 'seriesResult', text: safeError(error) });
    }
  }
}

function showEditorError(panel, message) {
  const escaped = message.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  panel.webview.html = `<!DOCTYPE html><html lang="en"><meta charset="UTF-8"><body><p>${escaped}</p></body></html>`;
}

async function openFileViewer(context, document, panel, token) {
  if (token.isCancellationRequested) return;
  if (document.uri.scheme !== 'file') {
    showEditorError(panel, 'Only local DICOM and NIfTI files are supported.');
    return;
  }
  if (/\.nii(?:\.gz)?$/i.test(document.uri.fsPath)) {
    panel.webview.options = { ...panel.webview.options, enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
    showViewer(panel, context, (target, cancellation) => loadNifti(target, document.uri.fsPath, cancellation));
    return;
  }
  panel.webview.options = { ...panel.webview.options, enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
  showViewer(panel, context, (target, cancellation) => loadImage(target, document.uri.fsPath, cancellation),
    imagePanelHtml, (target, cancellation, show) => loadFileSeries(target, document.uri.fsPath, cancellation, show));
}

function activate(context) {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('dicom3d.seriesEditor', {
    openCustomDocument: uri => ({ uri, dispose() {} }),
    resolveCustomEditor: (document, panel, token) => openFileViewer(context, document, panel, token)
  }, { webviewOptions: { enableScripts: true, retainContextWhenHidden: true } }));
}

function deactivate() {
  for (const cancellation of activeLoads) {
    cancellation.cancelled = true;
    cancellation.ack?.(false);
  }
}

module.exports = { activate, deactivate };
