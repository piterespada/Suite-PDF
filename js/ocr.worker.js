/* ocr.worker.js — Hilo de procesamiento OCR.
 * Preprocesa la imagen (sombras, contraste, binarización adaptativa), ejecuta Tesseract.js
 * y escribe una capa de texto invisible sobre la página ORIGINAL con pdf-lib
 * (la imagen escaneada no se toca).
 *
 * Para funcionar con doble clic (file://), donde los navegadores bloquean Workers desde
 * archivos locales, el código del worker se registra como texto y la interfaz lo
 * instancia mediante un Blob. Contrato de mensajes: { id, type, ... } -> { id, ok, ... }
 * y mensajes sin id: { type: 'log' | 'stage' }. */
(function () {
  'use strict';

  function ocrWorkerMain() {
    'use strict';

    var S = { doc: null, pages: null, font: null, tess: null, cfg: null, opts: null, written: 0, textPages: [], substituted: 0 };
    var encCache = new Map();

    function log(level, msg) { self.postMessage({ type: 'log', level: level, msg: msg }); }
    function stage(name, page, value) { self.postMessage({ type: 'stage', stage: name, page: page, value: value }); }

    // ---------------- Preprocesamiento de imagen ----------------
    function flatField(gray, W, H) {
      // Estima el nivel de "papel" por bloques (percentil 90) y divide: elimina sombras del lomo.
      var B = Math.max(16, Math.round(Math.max(W, H) / 120));
      var gw = Math.ceil(W / B), gh = Math.ceil(H / B);
      var grid = new Float32Array(gw * gh), hist = new Uint32Array(256);
      for (var by = 0; by < gh; by++) {
        for (var bx = 0; bx < gw; bx++) {
          hist.fill(0);
          var x0 = bx * B, y0 = by * B, x1 = Math.min(W, x0 + B), y1 = Math.min(H, y0 + B), n = 0;
          for (var y = y0; y < y1; y++) { var o = y * W; for (var x = x0; x < x1; x++) { hist[gray[o + x]]++; n++; } }
          var target = n * 0.9, acc = 0, v = 255;
          for (var k = 0; k < 256; k++) { acc += hist[k]; if (acc >= target) { v = k; break; } }
          grid[by * gw + bx] = v;
        }
      }
      for (var pass = 0; pass < 2; pass++) {
        var tmp = new Float32Array(gw * gh);
        for (var j = 0; j < gh; j++) for (var i = 0; i < gw; i++) {
          var s = 0, c = 0;
          for (var dj = -1; dj <= 1; dj++) for (var di = -1; di <= 1; di++) {
            var jj = j + dj, ii = i + di;
            if (jj >= 0 && jj < gh && ii >= 0 && ii < gw) { s += grid[jj * gw + ii]; c++; }
          }
          tmp[j * gw + i] = s / c;
        }
        grid = tmp;
      }
      var xi0 = new Int32Array(W), xi1 = new Int32Array(W), fx = new Float32Array(W);
      for (var px = 0; px < W; px++) {
        var gx = (px + 0.5) / B - 0.5, a = Math.floor(gx);
        var fr = gx - a; if (a < 0) { a = 0; fr = 0; }
        var b = Math.min(a + 1, gw - 1); if (a > gw - 1) a = gw - 1;
        xi0[px] = a; xi1[px] = b; fx[px] = fr;
      }
      for (var py = 0; py < H; py++) {
        var gy = (py + 0.5) / B - 0.5, ya = Math.floor(gy), fy = gy - ya;
        if (ya < 0) { ya = 0; fy = 0; }
        var yb = Math.min(ya + 1, gh - 1); if (ya > gh - 1) ya = gh - 1;
        var r0 = ya * gw, r1 = yb * gw, row = py * W;
        for (var qx = 0; qx < W; qx++) {
          var t = fx[qx];
          var top = grid[r0 + xi0[qx]] * (1 - t) + grid[r0 + xi1[qx]] * t;
          var bot = grid[r1 + xi0[qx]] * (1 - t) + grid[r1 + xi1[qx]] * t;
          var bg = top * (1 - fy) + bot * fy;
          var val = gray[row + qx] * 255 / (bg < 40 ? 40 : bg);
          gray[row + qx] = val > 255 ? 255 : val;
        }
      }
    }

    function autoLevels(gray) {
      var hist = new Uint32Array(256), n = gray.length, i;
      for (i = 0; i < n; i++) hist[gray[i]]++;
      var lo = 0, hi = 255, acc = 0;
      for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.005) { lo = i; break; } }
      acc = 0;
      for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.005) { hi = i; break; } }
      if (hi - lo < 30) return;
      var scale = 255 / (hi - lo);
      for (i = 0; i < n; i++) { var v = (gray[i] - lo) * scale; gray[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
    }

    function bradley(gray, W, H, t) {
      // Umbralización adaptativa de Bradley-Roth con imagen integral.
      var half = Math.max(8, Math.round(W / 24)), iw = W + 1;
      var integ = new Uint32Array(iw * (H + 1));
      for (var y = 0; y < H; y++) {
        var row = 0;
        for (var x = 0; x < W; x++) { row += gray[y * W + x]; integ[(y + 1) * iw + x + 1] = integ[y * iw + x + 1] + row; }
      }
      var out = new Uint8ClampedArray(W * H);
      for (var yy = 0; yy < H; yy++) {
        var ya = Math.max(0, yy - half), yb = Math.min(H - 1, yy + half);
        for (var xx = 0; xx < W; xx++) {
          var xa = Math.max(0, xx - half), xb = Math.min(W - 1, xx + half);
          var count = (xb - xa + 1) * (yb - ya + 1);
          var sum = integ[(yb + 1) * iw + xb + 1] - integ[ya * iw + xb + 1] - integ[(yb + 1) * iw + xa] + integ[ya * iw + xa];
          out[yy * W + xx] = gray[yy * W + xx] * count <= sum * (1 - t) ? 0 : 255;
        }
      }
      return out;
    }

    function despeckle(bin, W, H) {
      var copy = bin.slice();
      for (var y = 1; y < H - 1; y++) for (var x = 1; x < W - 1; x++) {
        var i = y * W + x;
        if (copy[i] !== 0) continue;
        if (copy[i - 1] && copy[i + 1] && copy[i - W] && copy[i + W] && copy[i - W - 1] && copy[i - W + 1] && copy[i + W - 1] && copy[i + W + 1]) bin[i] = 255;
      }
    }

    async function preprocess(bitmap, o) {
      var W = bitmap.width, H = bitmap.height;
      var oc = new OffscreenCanvas(W, H);
      var ctx = oc.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      var img = ctx.getImageData(0, 0, W, H), d = img.data, n = W * H;
      var gray = new Uint8ClampedArray(n), i, j;
      for (i = 0, j = 0; j < n; i += 4, j++) gray[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (o.removeShadows) flatField(gray, W, H);
      if (o.contrast) autoLevels(gray);
      var out = gray;
      if (o.binarize) { out = bradley(gray, W, H, 0.15); if (o.despeckle) despeckle(out, W, H); }
      for (i = 0, j = 0; j < n; i += 4, j++) { var v = out[j]; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; }
      ctx.putImageData(img, 0, 0);
      var blob = await oc.convertToBlob({ type: 'image/png' });
      oc.width = 0; oc.height = 0;
      return blob;
    }

    // ---------------- Tesseract ----------------
    async function createTess(page) {
      var langs = S.cfg.langs.join('+');
      stage('ocr-init', page, 0);
      log('info', 'Iniciando Tesseract.js (' + langs + ', modelos «' + S.cfg.quality + '»)…');
      var t0 = Date.now();
      var w = await Tesseract.createWorker(langs, 1, {
        langPath: S.cfg.langPath,
        logger: function (m) {
          if (m && m.status === 'recognizing text') stage('ocr', S.currentPage, m.progress);
          else if (m && /loading|initializ/i.test(m.status || '')) stage('ocr-init', S.currentPage, m.progress || 0);
        }
      });
      await w.setParameters({ tessedit_pageseg_mode: String(S.cfg.psm), preserve_interword_spaces: '1', user_defined_dpi: '300' });
      log('info', 'Motor OCR listo en ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s.');
      return w;
    }

    function collectWords(data) {
      if (data && Array.isArray(data.words) && data.words.length) return data.words;
      var out = [];
      var blocks = (data && data.blocks) || [];
      for (var a = 0; a < blocks.length; a++) {
        var ps = blocks[a].paragraphs || [];
        for (var b = 0; b < ps.length; b++) {
          var ls = ps[b].lines || [];
          for (var c = 0; c < ls.length; c++) { var ws = ls[c].words || []; for (var d = 0; d < ws.length; d++) out.push(ws[d]); }
        }
      }
      return out;
    }

    // ---------------- Capa de texto invisible (pdf-lib) ----------------
    var EXTRA = { 'ł': 'l', 'Ł': 'L', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ħ': 'h', 'ı': 'i', 'ſ': 's' };
    function encodeSafe(text) {
      // Devuelve texto codificable en WinAnsi (Helvetica estándar); simplifica lo demás.
      if (encCache.has(text)) return encCache.get(text);
      var res = '';
      var chars = Array.from(text);
      for (var i = 0; i < chars.length; i++) {
        var ch = chars[i];
        var ok = false;
        try { S.font.encodeText(ch); ok = true; } catch (e) { ok = false; }
        if (ok) { res += ch; continue; }
        var alt = EXTRA[ch] || ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
        var safe = '';
        var altChars = Array.from(alt);
        for (var k = 0; k < altChars.length; k++) { try { S.font.encodeText(altChars[k]); safe += altChars[k]; } catch (e2) { /* se descarta */ } }
        S.substituted++;
        res += safe;
      }
      if (encCache.size > 50000) encCache.clear();
      encCache.set(text, res);
      return res;
    }

    function writeTextLayer(pageIndex, words, W, H) {
      var L = self.PDFLib;
      var page = S.pages[pageIndex];
      var cb = page.getCropBox();
      var rot = ((page.getRotation().angle % 360) + 360) % 360;
      var dispW = rot % 180 === 0 ? cb.width : cb.height;
      var dispH = rot % 180 === 0 ? cb.height : cb.width;
      var su = dispW / W, sv = dispH / H;
      var fontKey = page.node.newFontDictionary(S.font.name, S.font.ref);
      var M = rot === 90 ? [0, 1, -1, 0] : rot === 180 ? [-1, 0, 0, -1] : rot === 270 ? [0, -1, 1, 0] : [1, 0, 0, 1];
      var ops = [L.pushGraphicsState(), L.beginText(), L.PDFOperator.of('Tr', [L.PDFNumber.of(3)])];
      var count = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var raw = (w.text || '').trim();
        if (!raw || !w.bbox) continue;
        if (typeof w.confidence === 'number' && w.confidence < 15) continue;
        var txt = encodeSafe(raw);
        if (!txt) continue;
        var left = w.bbox.x0 * su, right = w.bbox.x1 * su, top = w.bbox.y0 * sv, bottom = w.bbox.y1 * sv;
        var h = bottom - top, wd = right - left;
        if (h <= 0 || wd <= 0) continue;
        var size = Math.max(1, h * 0.78);
        var natural = S.font.widthOfTextAtSize(txt, size);
        if (!natural) continue;
        var tz = Math.max(10, Math.min(500, wd / natural * 100));
        var u = left, v = bottom - h * 0.2, x, y;
        if (rot === 0) { x = cb.x + u; y = cb.y + (cb.height - v); }
        else if (rot === 90) { x = cb.x + v; y = cb.y + u; }
        else if (rot === 180) { x = cb.x + (cb.width - u); y = cb.y + v; }
        else { x = cb.x + (cb.width - v); y = cb.y + (cb.height - u); }
        ops.push(L.setFontAndSize(fontKey, size));
        ops.push(L.PDFOperator.of('Tz', [L.PDFNumber.of(tz)]));
        ops.push(L.setTextMatrix(M[0], M[1], M[2], M[3], x, y));
        ops.push(L.showText(S.font.encodeText(txt)));
        count++;
      }
      ops.push(L.endText(), L.popGraphicsState());
      if (count) page.pushOperators.apply(page, ops);
      return count;
    }

    // ---------------- Manejadores ----------------
    var handlers = {
      init: async function (m) {
        S.cfg = m.cfg; S.opts = m.opts;
        stage('loading', 0, 0);
        importScripts(S.cfg.cdn.pdfLib, S.cfg.cdn.tesseract);
        S.doc = await self.PDFLib.PDFDocument.load(m.bytes, { updateMetadata: false, ignoreEncryption: false });
        S.pages = S.doc.getPages();
        S.font = await S.doc.embedFont(self.PDFLib.StandardFonts.Helvetica);
        log('info', 'PDF cargado en el worker: ' + S.pages.length + ' páginas.');
        return { pageCount: S.pages.length };
      },

      page: async function (m) {
        S.currentPage = m.index + 1;
        var t0 = Date.now();
        stage('filters', S.currentPage, 0);
        var blob = await preprocess(m.bitmap, S.opts);
        stage('filters', S.currentPage, 1);
        if (!S.tess) S.tess = await createTess(S.currentPage);
        stage('ocr', S.currentPage, 0);
        var res = await S.tess.recognize(blob, {}, { text: true, blocks: true, hocr: false, tsv: false });
        var words = collectWords(res.data);
        stage('write', S.currentPage, 0);
        var n = writeTextLayer(m.index, words, m.width, m.height);
        S.written += n;
        if (n) S.textPages.push(m.index + 1);
        var ms = Date.now() - t0;
        return { index: m.index, words: n, ms: ms, conf: res.data && res.data.confidence };
      },

      recycle: async function () {
        // Libera el motor entre lotes para evitar acumulación de memoria WASM.
        if (S.tess) { try { await S.tess.terminate(); } catch (e) { /* nada */ } S.tess = null; }
        encCache.clear();
        return {};
      },

      finish: async function () {
        if (S.tess) { try { await S.tess.terminate(); } catch (e) { /* nada */ } S.tess = null; }
        stage('save', 0, 0);
        log('info', 'Escribiendo metadatos y capa de texto en el PDF…');
        var bytes = await S.doc.save({ useObjectStreams: false });
        stage('verify', 0, 0);
        var check = await self.PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
        var ok = check.getPageCount() === S.pages.length;
        if (!ok) throw new Error('Verificación fallida: el número de páginas no coincide.');
        if (S.substituted) log('warn', S.substituted + ' carácter(es) fuera de Latin-1 se simplificaron en la capa de texto.');
        var out = { bytes: bytes, pageCount: check.getPageCount(), words: S.written, textPages: S.textPages.slice(0, 200) };
        S.doc = null; S.pages = null; S.font = null;
        return out;
      }
    };

    self.onmessage = async function (e) {
      var m = e.data;
      try {
        var r = await handlers[m.type](m);
        var transfer = r && r.bytes ? [r.bytes.buffer] : [];
        self.postMessage(Object.assign({ id: m.id, ok: true }, r || {}), transfer);
      } catch (err) {
        self.postMessage({ id: m.id, ok: false, error: (err && err.message) ? err.message : String(err), name: err && err.name });
      }
    };
  }

  window.WorkerSources = window.WorkerSources || {};
  window.WorkerSources.ocr = '(' + ocrWorkerMain.toString() + ')();';
})();
