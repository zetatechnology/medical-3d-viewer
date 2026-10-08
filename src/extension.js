'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DicomError, readHeader, parseDicom, validateImage, validateSeries, decodePixels } = require('./dicom');
const { RTSTRUCT, parseRtstruct } = require('./rtstruct');
const { NiftiError, readNiftiFile, scanNiftiRange, decodeNiftiSlice } = require('./nifti');

const MAX_FILES = 10000;
const MAX_VOXELS = 140_000_000;
const MAX_NIFTI_BYTES = MAX_VOXELS * 8 + 4096;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
let currentPanel;
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
  let unsupported = 0;
  for (let index = 0; index < files.length; index++) {
    if (token.isCancellationRequested) return null;
    const file = files[index];
    try {
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
  return { groups, rtFiles, unsupported, total: files.length };
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
        <label>Preset <select id="preset"><option value="soft">Soft tissue</option><option value="bone">Bone</option><option value="lung">Lung</option></select></label>
        <label>Window level <input id="level" type="number" value="40" step="1"></label>
        <label>Window width <input id="width" type="number" value="400" min="1" step="1"></label>
        <label>Opacity <input id="opacity" type="range" min="0" max="100" value="35"></label>
        <label>3D CT sampling <select id="volumeInterpolation"><option value="nearest">Sharp (nearest voxel)</option><option value="linear">Smooth (linear)</option></select></label>
        <h3>RT Structure Set</h3><div id="roiControls" aria-label="ROI visibility settings"></div>
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

async function sendSlice(panel, cancellation, index, pixels) {
  return new Promise(resolve => {
    cancellation.ack = resolve;
    void panel.webview.postMessage({ type: 'slice', index,
      pixels: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength).toString('base64') })
      .then(delivered => { if (!delivered && cancellation.ack === resolve) { cancellation.ack = null; resolve(false); } })
      .catch(() => { if (cancellation.ack === resolve) { cancellation.ack = null; resolve(false); } });
  });
}

async function loadSeries(panel, records, rtFiles, cancellation) {
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
    total = volume.rows * volume.columns * volume.images.length;
    if (total > MAX_VOXELS) throw new DicomError('MEMORY', 'The volume exceeds the size limit.');
    if (cancellation.cancelled) return;
    const meta = {
      rows: volume.rows, columns: volume.columns, count: volume.images.length,
      spacing: volume.spacing, sliceSpacing: volume.sliceSpacing,
      origin: volume.origin, row: volume.row, column: volume.column, normal: volume.normal,
      seriesNumber: volume.images[0].seriesNumber || '—', rois
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
    await panel.webview.postMessage({ type: 'complete', displayWindow });
  } catch (error) {
    if (!cancellation.cancelled) await panel.webview.postMessage({ type: 'error', text: safeError(error) });
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
        <canvas id="image" tabindex="0" aria-label="Single CT image. Scroll or use plus and minus to zoom; drag to pan." title="Scroll: zoom / Drag: pan"></canvas>
      </section>
      <aside aria-label="Display settings"><h2>Display settings</h2>
        <button id="loadSeries" type="button" disabled>Load series in 3D</button>
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
    const spacing = image.spacing?.length === 2 && image.spacing.every(v => Number.isFinite(v) && v > 0)
      ? image.spacing : null;
    const level = image.windowCenter?.[0];
    const width = image.windowWidth?.[0];
    const displayWindow = Number.isFinite(level) && Number.isFinite(width) && width > 0
      ? { level, width } : { level: 40, width: 400 };
    const delivered = await panel.webview.postMessage({ type: 'image', meta: {
      rows: image.rows, columns: image.columns, spacing,
      seriesNumber: image.seriesNumber || '—', displayWindow
    }, pixels: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength).toString('base64') });
    cancellation.imageLoaded = delivered;
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
    if (currentPanel === panel) currentPanel = undefined;
  });
  panel.webview.onDidReceiveMessage(message => {
    if (message?.type === 'ready') void loader(panel, cancellation);
    if (message?.type === 'loadSeries' && seriesLoader && cancellation.imageLoaded &&
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
    show((target, loadCancellation) => loadSeries(target, records, found.rtFiles, loadCancellation));
  } catch (error) {
    if (!cancellation.cancelled) {
      cancellation.seriesRequested = false;
      await panel.webview.postMessage({ type: 'seriesResult', text: safeError(error) });
    }
  }
}

async function openSeries(context) {
  const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
    canSelectMany: false, openLabel: 'Open CT series folder' });
  if (!selected?.length) return;
  let found;
  try {
    found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'Searching for DICOM series', cancellable: true },
    (progress, token) => findSeries(selected[0].fsPath, progress, token));
  } catch (error) {
    vscode.window.showErrorMessage(safeError(error));
    return;
  }
  if (!found) return;
  if (!found.groups.size) {
    vscode.window.showWarningMessage(found?.unsupported
      ? 'No supported CT series found. Check for unsupported or damaged files.'
      : 'No DICOM series found.');
    return;
  }
  const choices = [...found.groups.values()].map(records => ({
    label: `Series ${records[0].meta.seriesNumber || '—'} — ${records.length} slices`,
    description: records[0].meta.modality || 'Unknown',
    records
  }));
  const choice = await vscode.window.showQuickPick(choices, { placeHolder: 'Select a CT series to display' });
  if (!choice) return;
  currentPanel?.dispose();
  const panel = vscode.window.createWebviewPanel('dicom3d.viewer', 'Medical 3D Viewer',
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
  currentPanel = panel;
  showViewer(panel, context, (target, cancellation) => loadSeries(target, choice.records, found.rtFiles, cancellation));
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
  context.subscriptions.push(vscode.commands.registerCommand('dicom3d.openSeries', () => openSeries(context)));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('dicom3d.seriesEditor', {
    openCustomDocument: uri => ({ uri, dispose() {} }),
    resolveCustomEditor: (document, panel, token) => openFileViewer(context, document, panel, token)
  }, { webviewOptions: { enableScripts: true, retainContextWhenHidden: true } }));
  const openButton = vscode.window.createStatusBarItem('dicom3d.openSeries', vscode.StatusBarAlignment.Left, 100);
  openButton.text = '$(folder-opened) Open CT';
  openButton.tooltip = 'Select a folder containing a DICOM CT series';
  openButton.command = 'dicom3d.openSeries';
  openButton.show();
  context.subscriptions.push(openButton);
}

function deactivate() {
  for (const cancellation of activeLoads) {
    cancellation.cancelled = true;
    cancellation.ack?.(false);
  }
}

module.exports = { activate, deactivate };
