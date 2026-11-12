/* pdf-loader.js — Lectura binaria por fragmentos, apertura/renderizado con PDF.js y
 * extracción de metadatos tipográficos. Expone el objeto global PdfLoader. */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG;

  class PdfError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  function configure() {
    if (!window.pdfjsLib) {
      throw new PdfError('NO_PDFJS', 'No se pudo cargar PDF.js. Revisa tu conexión la primera vez (después queda en caché del navegador).');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = CFG.CDN.pdfjsWorker;
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** Lee un File en fragmentos grandes hacia un único Uint8Array preasignado. */
  async function readFileChunked(file, onProgress) {
    const total = file.size;
    if (!total) throw new PdfError('EMPTY', 'El archivo está vacío (0 bytes).');
    const out = new Uint8Array(total);
    const chunk = CFG.READ_CHUNK_BYTES;
    let off = 0;
    while (off < total) {
      const end = Math.min(total, off + chunk);
      const buf = await file.slice(off, end).arrayBuffer();
      out.set(new Uint8Array(buf), off);
      off = end;
      if (onProgress) onProgress(off / total);
      await tick();
    }
    return out;
  }

  /** Comprobación rápida de cabecera %PDF- (permite basura inicial de hasta 1 KiB). */
  function looksLikePdf(bytes) {
    const n = Math.min(bytes.length, 1024);
    for (let i = 0; i < n - 4; i++) {
      if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
    }
    return false;
  }

  /** Abre el PDF con PDF.js y traduce los errores a mensajes claros. */
  async function open(bytes) {
    configure();
    if (!looksLikePdf(bytes)) throw new PdfError('INVALID', 'El archivo no parece un PDF válido (falta la cabecera %PDF).');
    let task;
    try {
      task = pdfjsLib.getDocument({
        data: bytes.slice(0), // copia: PDF.js puede transferir (vaciar) el búfer
        isEvalSupported: false,
        rangeChunkSize: CFG.READ_CHUNK_BYTES,
        disableAutoFetch: true,
        disableStream: true
      });
      const doc = await task.promise;
      if (!doc.numPages) { await doc.destroy(); throw new PdfError('EMPTY', 'El PDF no contiene páginas.'); }
      return doc;
    } catch (e) {
      if (e instanceof PdfError) throw e;
      const name = e && e.name;
      if (name === 'PasswordException') throw new PdfError('PASSWORD', 'El PDF está protegido con contraseña. Quita la protección e inténtalo de nuevo.');
      if (name === 'InvalidPDFException') throw new PdfError('INVALID', 'El archivo está dañado o no es un PDF válido.');
      if (name === 'MissingPDFException') throw new PdfError('INVALID', 'No se pudo leer el PDF.');
      throw new PdfError('UNKNOWN', 'No se pudo abrir el PDF: ' + (e && e.message ? e.message : e));
    }
  }

  async function destroy(doc) { try { if (doc) await doc.destroy(); } catch (_) { /* nada */ } }

  let rasterCanvas = null;

  /** Rasteriza una página (1-based) y devuelve un ImageBitmap transferible a un worker. */
  async function renderPageToBitmap(doc, pageNum, longSide) {
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(0.5, Math.min(4, (longSide || CFG.OCR_LONG_SIDE) / Math.max(base.width, base.height)));
    const vp = page.getViewport({ scale });
    if (!rasterCanvas) rasterCanvas = document.createElement('canvas');
    rasterCanvas.width = Math.round(vp.width);
    rasterCanvas.height = Math.round(vp.height);
    const ctx = rasterCanvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, rasterCanvas.width, rasterCanvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const bitmap = await createImageBitmap(rasterCanvas);
    page.cleanup();
    return { bitmap, width: rasterCanvas.width, height: rasterCanvas.height };
  }

  function releaseRaster() {
    if (rasterCanvas) { rasterCanvas.width = 0; rasterCanvas.height = 0; rasterCanvas = null; }
  }

  const previewTasks = new WeakMap();

  /** Dibuja una página en un canvas visible (vista previa). */
  async function renderPreview(doc, pageNum, canvas, maxWidth) {
    const prev = previewTasks.get(canvas);
    if (prev) { try { prev.cancel(); } catch (_) { /* nada */ } }
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.min(maxWidth || 520, base.width * 2);
    const vp = page.getViewport({ scale: (cssW / base.width) * dpr });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.style.width = Math.round(vp.width / dpr) + 'px';
    const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp });
    previewTasks.set(canvas, task);
    try { await task.promise; } catch (e) { if (!(e && e.name === 'RenderingCancelledException')) throw e; }
    page.cleanup();
  }

  /**
   * Extrae ítems de texto con tamaño de letra, fuente y coordenadas de todas las páginas,
   * procesando por lotes y cediendo el control entre lotes.
   * Devuelve [{ pageNum, width, height, items: [{ str, x, y, w, size, font, family }] }]
   */
  async function extractAllText(doc, opts) {
    const o = Object.assign({ batchSize: 20, onProgress: null, isCancelled: null }, opts || {});
    const pages = [];
    const n = doc.numPages;
    for (let start = 1; start <= n; start += o.batchSize) {
      const end = Math.min(n, start + o.batchSize - 1);
      for (let p = start; p <= end; p++) {
        if (o.isCancelled && o.isCancelled()) throw new PdfError('CANCELLED', 'Operación cancelada.');
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent({ disableCombineTextItems: false });
        const items = [];
        for (const it of tc.items) {
          if (!it.str || !it.str.trim()) continue;
          const tr = it.transform;
          const size = Math.hypot(tr[2], tr[3]) || it.height || 0;
          const st = tc.styles && tc.styles[it.fontName];
          items.push({ str: it.str, x: tr[4], y: tr[5], w: it.width || 0, size: Math.round(size * 100) / 100, font: it.fontName || '', family: (st && st.fontFamily) || '' });
        }
        pages.push({ pageNum: p, width: vp.width, height: vp.height, items });
        page.cleanup();
        if (o.onProgress) o.onProgress(p, n);
      }
      await tick(); // respiro para el hilo de la interfaz entre lotes
    }
    return pages;
  }

  /** Cuenta los marcadores (recursivo) de un documento ya abierto. */
  async function countOutline(doc) {
    const outline = await doc.getOutline();
    let count = 0;
    (function walk(list) { for (const o of list || []) { count++; walk(o.items); } })(outline);
    return count;
  }

  window.PdfLoader = { PdfError, configure, readFileChunked, looksLikePdf, open, destroy, renderPageToBitmap, releaseRaster, renderPreview, extractAllText, countOutline };
})();
