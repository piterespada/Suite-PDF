/* ui.js — Interfaz: pestañas, zonas de carga, progreso, consola, tabla editable de índice,
 * comunicación con los Web Workers y limpieza de memoria. Todo el texto visible está en español. */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const fmtTime = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };
  const baseName = (name) => name.replace(/\.pdf$/i, '');
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('pdfsuite.' + k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('pdfsuite.' + k, v); } catch (_) { /* sin almacenamiento */ } }
  };

  // =====================================================================
  // Consola de estado
  // =====================================================================
  const Log = {
    body: null, count: 0, lines: [],
    init() {
      this.body = $('#console-body');
      $('#console-toggle').addEventListener('click', () => {
        const c = $('#console'); const collapsed = c.classList.toggle('collapsed');
        $('#console-toggle').setAttribute('aria-expanded', String(!collapsed));
        $('#console-toggle').firstChild.textContent = collapsed ? '▲ Consola de estado ' : '▼ Consola de estado ';
        document.body.style.paddingBottom = collapsed ? '56px' : '300px';
        if (!collapsed) this.body.scrollTop = this.body.scrollHeight;
      });
      $('#console-clear').addEventListener('click', () => { this.body.innerHTML = ''; this.lines = []; this.count = 0; $('#console-count').textContent = '0'; });
      $('#console-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(this.lines.join('\n')); this.add('ok', 'APP', 'Registro copiado al portapapeles.'); }
        catch (_) { this.add('warn', 'APP', 'No se pudo copiar automáticamente; selecciona el texto manualmente.'); }
      });
    },
    add(level, src, msg) {
      const t = new Date().toLocaleTimeString('es', { hour12: false });
      const text = '[' + t + '] [' + src + '] ' + msg;
      this.lines.push(text);
      if (this.lines.length > 3000) this.lines.shift();
      const div = document.createElement('div');
      div.className = 'log-line ' + level;
      const a = document.createElement('span'); a.className = 't'; a.textContent = '[' + t + '] ';
      const b = document.createElement('span'); b.className = 's'; b.textContent = '[' + src + '] ';
      const c = document.createElement('span'); c.className = 'm'; c.textContent = msg;
      div.append(a, b, c);
      this.body.appendChild(div);
      while (this.body.childElementCount > 1500) this.body.removeChild(this.body.firstChild);
      this.count++;
      $('#console-count').textContent = String(this.count);
      const near = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 80;
      if (near) this.body.scrollTop = this.body.scrollHeight;
    }
  };

  // =====================================================================
  // Estado visual y progreso
  // =====================================================================
  function setStatus(prefix, kind, text) {
    const el = $('#' + prefix + '-status');
    el.className = 'status ' + kind;
    $('.status-text', el).textContent = text;
  }
  function setProgress(prefix, pct, stage, kind) {
    const bar = $('#' + prefix + '-bar');
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    bar.style.width = pct + '%';
    bar.classList.toggle('done', kind === 'done');
    bar.classList.toggle('fail', kind === 'fail');
    $('#' + prefix + '-pct').textContent = pct + '%';
    if (stage !== undefined) $('#' + prefix + '-stage').textContent = stage;
  }

  // =====================================================================
  // Cliente de Web Worker (RPC por mensajes) — se instancia desde un Blob
  // =====================================================================
  class WorkerClient {
    constructor(key, onEvent) {
      const src = window.WorkerSources && window.WorkerSources[key];
      if (!src) throw new Error('Falta el código del worker «' + key + '».');
      this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      try { this.w = new Worker(this.url); }
      catch (e) { URL.revokeObjectURL(this.url); throw new Error('Tu navegador no permitió crear el hilo de procesamiento: ' + e.message); }
      this.pending = new Map(); this.seq = 0; this.dead = false;
      this.w.onmessage = (e) => {
        const m = e.data;
        if (m && m.id !== undefined) {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); m.ok ? p.resolve(m) : p.reject(new Error(m.error || 'Error desconocido en el worker.')); }
        } else if (onEvent) onEvent(m);
      };
      this.w.onerror = (e) => { e.preventDefault && e.preventDefault(); this._rejectAll(new Error('Fallo en el hilo de procesamiento: ' + (e.message || 'error desconocido'))); };
    }
    call(type, payload, transfer) {
      return new Promise((resolve, reject) => {
        if (this.dead) return reject(new Error('Proceso detenido.'));
        const id = ++this.seq;
        this.pending.set(id, { resolve, reject });
        this.w.postMessage(Object.assign({ id, type }, payload || {}), transfer || []);
      });
    }
    _rejectAll(err) { this.pending.forEach((p) => p.reject(err)); this.pending.clear(); }
    terminate() {
      if (this.dead) return;
      this.dead = true;
      this.w.terminate();
      URL.revokeObjectURL(this.url);
      this._rejectAll(new Error('CANCELLED'));
    }
  }

  // =====================================================================
  // Descargas y limpieza de memoria
  // =====================================================================
  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => a.remove(), 0);
  }

  // =====================================================================
  // Zonas de arrastrar y soltar
  // =====================================================================
  function setupDropzone(zone, input, onFile, src) {
    const choose = (files) => {
      const list = Array.from(files || []);
      if (!list.length) return;
      if (list.length > 1) Log.add('warn', src, 'Se recibieron ' + list.length + ' archivos; se procesa un PDF a la vez, se usará «' + list[0].name + '».');
      onFile(list[0]);
    };
    input.addEventListener('change', () => { choose(input.files); input.value = ''; });
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', (e) => choose(e.dataTransfer && e.dataTransfer.files));
  }
  // Evita que el navegador abra el PDF si se suelta fuera de la zona
  ['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));

  function isPdfFile(f) { return f.type === 'application/pdf' || /\.pdf$/i.test(f.name); }

  function showFileInfo(el, file, pages) {
    el.classList.remove('hidden');
    el.innerHTML = '';
    const b = document.createElement('b'); b.textContent = file.name;
    const s1 = document.createElement('span'); s1.className = 'tag'; s1.textContent = fmtBytes(file.size);
    const s2 = document.createElement('span'); s2.className = 'tag'; s2.textContent = pages + (pages === 1 ? ' página' : ' páginas');
    el.append('📄 ', b, s1, s2);
  }

  async function verifySearchable(bytes, samplePages) {
    const doc = await PdfLoader.open(bytes);
    try {
      let chars = 0;
      for (const p of samplePages.slice(0, 3)) {
        if (p < 1 || p > doc.numPages) continue;
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        chars += tc.items.reduce((s, i) => s + (i.str || '').length, 0);
        page.cleanup();
      }
      return chars;
    } finally { await PdfLoader.destroy(doc); }
  }

  // =====================================================================
  // PESTAÑA 1: OCR
  // =====================================================================
  const Ocr = {
    file: null, bytes: null, doc: null, N: 0, busy: false, cancelled: false, worker: null,
    cur: 0, t0: 0, result: null, blobUrl: null, previewPage: 1, releaseTimer: null,

    init() {
      this.buildLanguages();
      setupDropzone($('#ocr-drop'), $('#ocr-file'), (f) => this.load(f), 'OCR');
      $('#ocr-start').addEventListener('click', () => this.start());
      $('#ocr-cancel').addEventListener('click', () => this.cancel());
      $('#ocr-download').addEventListener('click', () => this.download());
      $('#ocr-prev').addEventListener('click', () => this.preview(this.previewPage - 1));
      $('#ocr-next').addEventListener('click', () => this.preview(this.previewPage + 1));
      $$('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        const set = new Set(b.dataset.preset.split('+'));
        $$('#ocr-langs-main input, #ocr-langs-more input').forEach((i) => { i.checked = set.has(i.value); });
        this.savePrefs();
      }));
      $('#ocr-quality').value = prefs.get('quality', 'balanced');
      $('#ocr-batch').value = prefs.get('batch', '20');
      ['#ocr-quality', '#ocr-batch', '#ocr-psm'].forEach((s) => $(s).addEventListener('change', () => this.savePrefs()));
    },

    buildLanguages() {
      const saved = new Set(prefs.get('langs', 'spa').split(',').filter(Boolean));
      CFG.LANGUAGES.forEach(([code, name, main]) => {
        const label = document.createElement('label'); label.className = 'lang';
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = code; input.checked = saved.has(code);
        input.addEventListener('change', () => this.savePrefs());
        const span = document.createElement('span'); span.textContent = name;
        label.append(input, span);
        $(main ? '#ocr-langs-main' : '#ocr-langs-more').appendChild(label);
      });
    },
    selectedLangs() { return $$('#ocr-langs-main input:checked, #ocr-langs-more input:checked').map((i) => i.value).sort((a, b) => CFG.LANGUAGES.findIndex((l) => l[0] === a) - CFG.LANGUAGES.findIndex((l) => l[0] === b)); },
    savePrefs() { prefs.set('langs', this.selectedLangs().join(',')); prefs.set('quality', $('#ocr-quality').value); prefs.set('batch', $('#ocr-batch').value); },

    lock(on) {
      $('#ocr-start').disabled = on || !this.doc;
      $('#ocr-cancel').disabled = !on;
      $$('#tab-ocr select, #tab-ocr .chip-btn, #tab-ocr .lang input, #tab-ocr .check input').forEach((e) => { e.disabled = on; });
      $('#ocr-drop').style.pointerEvents = on ? 'none' : '';
      $('#ocr-drop').style.opacity = on ? '.55' : '';
    },

    async load(file) {
      if (this.busy) { Log.add('warn', 'OCR', 'Hay un proceso en curso; cancélalo antes de cargar otro archivo.'); return; }
      if (!isPdfFile(file)) { setStatus('ocr', 'error', 'El archivo «' + file.name + '» no es un PDF.'); Log.add('error', 'OCR', 'Formato no admitido: ' + file.name); return; }
      this.reset();
      this.busy = true;
      setStatus('ocr', 'working', 'Leyendo «' + file.name + '»…');
      Log.add('info', 'OCR', 'Leyendo ' + file.name + ' (' + fmtBytes(file.size) + ') en fragmentos de ' + fmtBytes(CFG.READ_CHUNK_BYTES) + '.');
      try {
        const t0 = performance.now();
        this.bytes = await PdfLoader.readFileChunked(file, (f) => setProgress('ocr', f * 100, 'Leyendo archivo'));
        setProgress('ocr', 100, 'Abriendo PDF');
        this.doc = await PdfLoader.open(this.bytes);
        this.file = file; this.N = this.doc.numPages;
        Log.add('ok', 'OCR', 'PDF abierto: ' + this.N + ' páginas (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s).');
        showFileInfo($('#ocr-fileinfo'), file, this.N);
        setProgress('ocr', 0, 'Sin actividad');
        setStatus('ocr', 'idle', 'Listo para procesar. Elige idioma(s) y pulsa «Iniciar OCR».');
        $('#ocr-start').disabled = false;
        await this.preview(1);
      } catch (e) {
        this.fail(e);
        this.doc = null; this.bytes = null;
      } finally { this.busy = false; }
    },

    async preview(p) {
      if (!this.doc) return;
      p = Math.max(1, Math.min(this.N, p));
      this.previewPage = p;
      const canvas = $('#ocr-preview');
      try {
        await PdfLoader.renderPreview(this.doc, p, canvas, 520);
        canvas.classList.add('on'); $('#ocr-preview-empty').classList.add('hidden');
      } catch (e) { Log.add('warn', 'OCR', 'No se pudo dibujar la vista previa: ' + e.message); }
      $('#ocr-pageinfo').textContent = 'Página ' + p + ' / ' + this.N;
      $('#ocr-prev').disabled = p <= 1; $('#ocr-next').disabled = p >= this.N;
    },

    fail(e) {
      const msg = e && e.message ? e.message : String(e);
      setStatus('ocr', 'error', msg);
      setProgress('ocr', parseInt($('#ocr-pct').textContent, 10) || 0, 'Error', 'fail');
      Log.add('error', 'OCR', msg);
    },

    revokeResult() {
      if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
      if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
      this.result = null;
      const b = $('#ocr-download'); b.disabled = true; b.textContent = '⬇ Descargar PDF con texto';
    },

    reset() {
      this.revokeResult();
      if (this.doc) PdfLoader.destroy(this.doc);
      PdfLoader.releaseRaster();
      this.doc = null; this.bytes = null; this.file = null; this.N = 0;
      const c = $('#ocr-preview'); c.width = 0; c.height = 0; c.classList.remove('on'); $('#ocr-preview-empty').classList.remove('hidden');
      $('#ocr-pageinfo').textContent = '—'; $('#ocr-prev').disabled = true; $('#ocr-next').disabled = true;
      $('#ocr-start').disabled = true; $('#ocr-batchinfo').textContent = 'Lote —'; $('#ocr-eta').textContent = '';
      $('#ocr-bar2').style.width = '0%'; $('#ocr-fileinfo').classList.add('hidden');
      setProgress('ocr', 0, 'Sin actividad');
    },

    setOverall(p, frac, label) {
      const overall = (p + frac) / this.N;
      const pct = Math.min(97, Math.floor(overall * 97));
      setProgress('ocr', pct, label);
      const el = performance.now() - this.t0;
      $('#ocr-eta').textContent = overall > 0.02 ? 'Transcurrido ' + fmtTime(el) + ' · restante ≈ ' + fmtTime(el / overall * (1 - overall)) : 'Transcurrido ' + fmtTime(el);
    },

    onEvent(m) {
      if (m.type === 'log') { Log.add(m.level || 'info', 'OCR·worker', m.msg); return; }
      if (m.type !== 'stage') return;
      const n = this.cur + 1;
      switch (m.stage) {
        case 'loading': setProgress('ocr', 1, 'Cargando PDF y librerías en el worker'); break;
        case 'filters': this.setOverall(this.cur, 0.1 + 0.2 * (m.value || 0), 'Aplicando filtros de contraste (página ' + n + ')'); break;
        case 'ocr-init': this.setOverall(this.cur, 0.3, 'Cargando motor OCR e idioma(s) (la primera vez descarga el modelo)'); break;
        case 'ocr': this.setOverall(this.cur, 0.3 + 0.62 * (m.value || 0), 'Ejecutando OCR (página ' + n + ' de ' + this.N + ')'); break;
        case 'write': this.setOverall(this.cur, 0.95, 'Escribiendo capa de texto (página ' + n + ')'); break;
        case 'save': setProgress('ocr', 98, 'Escribiendo metadatos PDF'); break;
        case 'verify': setProgress('ocr', 99, 'Validando integridad del PDF'); break;
        default: break;
      }
    },

    cancel() {
      if (!this.busy) return;
      this.cancelled = true;
      if (this.worker) this.worker.terminate();
      Log.add('warn', 'OCR', 'Cancelado por el usuario.');
    },

    async start() {
      if (!this.doc || this.busy) return;
      const langs = this.selectedLangs();
      if (!langs.length) { setStatus('ocr', 'error', 'Selecciona al menos un idioma.'); return; }
      this.savePrefs();
      this.revokeResult();
      this.busy = true; this.cancelled = false; this.lock(true);
      const N = this.N, batch = parseInt($('#ocr-batch').value, 10);
      const quality = $('#ocr-quality').value;
      const opts = { removeShadows: $('#ocr-shadows').checked, contrast: $('#ocr-contrast').checked, binarize: $('#ocr-binarize').checked, despeckle: $('#ocr-despeckle').checked };
      const cfg = { langs, quality, langPath: CFG.TESSDATA[quality], psm: $('#ocr-psm').value, cdn: CFG.CDN };
      this.t0 = performance.now();
      setStatus('ocr', 'working', 'Procesando «' + this.file.name + '»…');
      Log.add('info', 'OCR', 'Inicio: ' + N + ' páginas, idioma(s) ' + langs.join('+') + ', lotes de ' + batch + '. Filtros: ' + JSON.stringify(opts));
      try {
        this.worker = new WorkerClient('ocr', (m) => this.onEvent(m));
        const copy = this.bytes.slice(0);
        await this.worker.call('init', { cfg, opts, bytes: copy }, [copy.buffer]);
        const batches = Math.ceil(N / batch);
        for (let b = 0; b < batches; b++) {
          const from = b * batch, to = Math.min(N, from + batch);
          $('#ocr-batchinfo').textContent = 'Lote ' + (b + 1) + ' de ' + batches + ' · páginas ' + (from + 1) + '–' + to;
          Log.add('info', 'OCR', 'Lote ' + (b + 1) + '/' + batches + ': páginas ' + (from + 1) + '–' + to);
          $('#ocr-bar2').style.width = '0%';
          for (let p = from; p < to; p++) {
            if (this.cancelled) throw new Error('CANCELLED');
            this.cur = p;
            this.setOverall(p, 0, 'Renderizando página ' + (p + 1) + ' de ' + N);
            const r = await PdfLoader.renderPageToBitmap(this.doc, p + 1, CFG.OCR_LONG_SIDE);
            this.setOverall(p, 0.1, 'Aplicando filtros de contraste (página ' + (p + 1) + ')');
            const res = await this.worker.call('page', { index: p, bitmap: r.bitmap, width: r.width, height: r.height }, [r.bitmap]);
            Log.add(res.words ? 'info' : 'warn', 'OCR', 'Página ' + (p + 1) + '/' + N + ': ' + res.words + ' palabras en ' + (res.ms / 1000).toFixed(1) + ' s' + (res.words ? '' : ' (sin texto reconocido)'));
            $('#ocr-bar2').style.width = Math.round((p - from + 1) / (to - from) * 100) + '%';
            this.setOverall(p + 1, 0, 'Página ' + (p + 1) + ' completada');
          }
          await this.worker.call('recycle');
          PdfLoader.releaseRaster();
          Log.add('info', 'OCR', 'Lote ' + (b + 1) + ' completado; memoria del motor liberada.');
        }
        const out = await this.worker.call('finish');
        if (!out.words) throw new Error('El OCR no reconoció texto en ninguna página. Prueba otro idioma, calidad «Máxima precisión» o desactiva la binarización.');
        setProgress('ocr', 99, 'Validando integridad del PDF');
        const chars = await verifySearchable(out.bytes.slice(0), out.textPages);
        if (!chars) throw new Error('La validación falló: el PDF generado no expone texto seleccionable.');
        this.result = out.bytes;
        this.blobUrl = URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' }));
        const total = performance.now() - this.t0;
        setProgress('ocr', 100, 'Completado', 'done');
        $('#ocr-eta').textContent = 'Tiempo total ' + fmtTime(total);
        setStatus('ocr', 'success', 'Listo: ' + out.words + ' palabras reconocidas en ' + out.pageCount + ' páginas (' + fmtTime(total) + '). Integridad verificada.');
        Log.add('ok', 'OCR', 'Terminado en ' + fmtTime(total) + '. Archivo: ' + fmtBytes(out.bytes.length) + '. Validación de texto correcta (' + chars + ' caracteres en muestra).');
        $('#ocr-download').disabled = false;
      } catch (e) {
        if (this.cancelled || (e && e.message === 'CANCELLED')) {
          setStatus('ocr', 'idle', 'Proceso cancelado.'); setProgress('ocr', 0, 'Cancelado');
        } else {
          let msg = e && e.message ? e.message : String(e);
          if (/fetch|network|load|importScripts|NetworkError/i.test(msg)) msg += ' — Comprueba tu conexión: la primera vez se descargan las librerías y el idioma (luego quedan en caché).';
          this.fail(new Error(msg));
        }
      } finally {
        if (this.worker) { this.worker.terminate(); this.worker = null; }
        PdfLoader.releaseRaster();
        this.busy = false; this.lock(false);
      }
    },

    download() {
      if (!this.blobUrl || !this.file) return;
      triggerDownload(this.blobUrl, baseName(this.file.name) + '_ocr.pdf');
      Log.add('info', 'OCR', 'Descarga iniciada.');
      setStatus('ocr', 'success', 'Descarga iniciada. La memoria temporal se liberará en unos segundos.');
      const b = $('#ocr-download'); b.disabled = true;
      this.releaseTimer = setTimeout(() => {
        this.revokeResult();
        $('#ocr-download').textContent = 'Descargado ✓ (memoria liberada)';
        Log.add('ok', 'OCR', 'Memoria liberada (URL del blob revocada y búferes descartados).');
      }, 20000);
    }
  };

  // =====================================================================
  // PESTAÑA 2: Índice y marcadores
  // =====================================================================
  const Toc = {
    file: null, bytes: null, doc: null, N: 0, pages: null, entries: [], sel: null, busy: false, cancelled: false,
    worker: null, blobUrl: null, result: null, releaseTimer: null, previewPage: 1, manualSeq: 0,

    init() {
      setupDropzone($('#toc-drop'), $('#toc-file'), (f) => this.load(f), 'ÍNDICE');
      $('#toc-detect').addEventListener('click', () => this.detect());
      $('#toc-cancel').addEventListener('click', () => this.cancel());
      $('#toc-generate').addEventListener('click', () => this.generate());
      $('#toc-download').addEventListener('click', () => this.download());
      $('#toc-add').addEventListener('click', () => this.addEntry());
      $('#toc-shift-btn').addEventListener('click', () => this.shiftPages());
      $('#toc-sort').addEventListener('click', () => { this.entries.sort((a, b) => a.page - b.page); this.render(); Log.add('info', 'ÍNDICE', 'Entradas ordenadas por página.'); });
      $('#toc-clear').addEventListener('click', () => { if (this.entries.length && confirm('¿Vaciar toda la tabla de contenidos?')) { this.entries = []; this.sel = null; this.render(); } });
      $('#toc-prev').addEventListener('click', () => this.preview(this.previewPage - 1));
      $('#toc-next').addEventListener('click', () => this.preview(this.previewPage + 1));
      $('#toc-pageinput').addEventListener('change', (e) => this.preview(parseInt(e.target.value, 10) || 1));
      const body = $('#toc-body');
      body.addEventListener('input', (e) => this.onField(e));
      body.addEventListener('change', (e) => this.onField(e, true));
      body.addEventListener('click', (e) => this.onClick(e));
    },

    lock(on) {
      $('#toc-detect').disabled = on || !this.doc;
      $('#toc-cancel').disabled = !on;
      $('#toc-generate').disabled = on || !this.doc || !this.entries.length;
      $('#toc-drop').style.pointerEvents = on ? 'none' : ''; $('#toc-drop').style.opacity = on ? '.55' : '';
    },

    fail(e) {
      const msg = e && e.message ? e.message : String(e);
      setStatus('toc', 'error', msg); setProgress('toc', parseInt($('#toc-pct').textContent, 10) || 0, 'Error', 'fail'); Log.add('error', 'ÍNDICE', msg);
    },

    revokeResult() {
      if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
      if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
      this.result = null;
      const b = $('#toc-download'); b.disabled = true; b.textContent = '⬇ Descargar PDF';
    },

    reset() {
      this.revokeResult();
      if (this.doc) PdfLoader.destroy(this.doc);
      this.doc = null; this.bytes = null; this.file = null; this.N = 0; this.pages = null; this.entries = []; this.sel = null;
      const c = $('#toc-preview'); c.width = 0; c.height = 0; c.classList.remove('on'); $('#toc-preview-empty').classList.remove('hidden');
      ['#toc-prev', '#toc-next', '#toc-pageinput', '#toc-detect', '#toc-add', '#toc-sort', '#toc-clear', '#toc-generate'].forEach((s) => { $(s).disabled = true; });
      $('#toc-pagetotal').textContent = '/ —'; $('#toc-fileinfo').classList.add('hidden'); $('#toc-info').textContent = '';
      setProgress('toc', 0, 'Sin actividad'); this.render();
    },

    async load(file) {
      if (this.busy) { Log.add('warn', 'ÍNDICE', 'Hay un proceso en curso; cancélalo antes de cargar otro archivo.'); return; }
      if (!isPdfFile(file)) { setStatus('toc', 'error', 'El archivo «' + file.name + '» no es un PDF.'); Log.add('error', 'ÍNDICE', 'Formato no admitido: ' + file.name); return; }
      this.reset(); this.busy = true;
      setStatus('toc', 'working', 'Leyendo «' + file.name + '»…');
      Log.add('info', 'ÍNDICE', 'Leyendo ' + file.name + ' (' + fmtBytes(file.size) + ').');
      try {
        this.bytes = await PdfLoader.readFileChunked(file, (f) => setProgress('toc', f * 100, 'Leyendo archivo'));
        setProgress('toc', 100, 'Abriendo PDF');
        this.doc = await PdfLoader.open(this.bytes);
        this.file = file; this.N = this.doc.numPages;
        showFileInfo($('#toc-fileinfo'), file, this.N);
        let existing = 0; try { existing = await PdfLoader.countOutline(this.doc); } catch (_) { /* sin marcadores */ }
        Log.add('ok', 'ÍNDICE', 'PDF abierto: ' + this.N + ' páginas' + (existing ? '; ya contiene ' + existing + ' marcadores (se reemplazarán al generar).' : '.'));
        setProgress('toc', 0, 'Sin actividad');
        setStatus('toc', existing ? 'warn' : 'idle', existing ? 'Este PDF ya tiene ' + existing + ' marcadores: se reemplazarán por los de la tabla.' : 'Listo. Pulsa «Detectar capítulos» o agrega entradas a mano.');
        ['#toc-detect', '#toc-add', '#toc-prev', '#toc-next', '#toc-pageinput'].forEach((s) => { $(s).disabled = false; });
        $('#toc-pageinput').max = this.N; $('#toc-pagetotal').textContent = '/ ' + this.N;
        await this.preview(1);
      } catch (e) { this.fail(e); this.doc = null; this.bytes = null; }
      finally { this.busy = false; }
    },

    async preview(p) {
      if (!this.doc) return;
      p = Math.max(1, Math.min(this.N, p)); this.previewPage = p;
      const canvas = $('#toc-preview');
      try { await PdfLoader.renderPreview(this.doc, p, canvas, 460); canvas.classList.add('on'); $('#toc-preview-empty').classList.add('hidden'); }
      catch (e) { Log.add('warn', 'ÍNDICE', 'No se pudo dibujar la vista previa: ' + e.message); }
      $('#toc-pageinput').value = p; $('#toc-prev').disabled = p <= 1; $('#toc-next').disabled = p >= this.N;
    },

    cancel() {
      this.cancelled = true;
      if (this.worker) this.worker.terminate();
      Log.add('warn', 'ÍNDICE', 'Cancelado por el usuario.');
    },

    async detect() {
      if (!this.doc || this.busy) return;
      this.busy = true; this.cancelled = false; this.lock(true); this.revokeResult();
      const t0 = performance.now();
      try {
        setStatus('toc', 'working', 'Analizando el documento…');
        if (!this.pages) {
          Log.add('info', 'ÍNDICE', 'Extrayendo texto y metadatos tipográficos por lotes de 20 páginas…');
          this.pages = await PdfLoader.extractAllText(this.doc, {
            batchSize: 20, isCancelled: () => this.cancelled,
            onProgress: (p, n) => setProgress('toc', p / n * 85, 'Extrayendo texto de la página ' + p + ' de ' + n)
          });
          Log.add('info', 'ÍNDICE', 'Texto extraído en ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s.');
        }
        setProgress('toc', 90, 'Detectando capítulos'); await tick();
        const mode = $('#toc-mode').value;
        const res = TocAnalyzer.analyze(this.pages, mode, { maxLevels: parseInt($('#toc-levels').value, 10) });
        res.warnings.forEach((w) => Log.add('warn', 'ÍNDICE', w));
        this.entries = res.entries; this.sel = null; this.render();
        const infoEl = $('#toc-info');
        if (res.info) {
          const i = res.info;
          infoEl.textContent = 'Índice del libro en las páginas ' + i.tocPages[0] + (i.tocPages[1] !== i.tocPages[0] ? '–' + i.tocPages[1] : '') + ' del PDF · desfase ' + (i.offset >= 0 ? '+' : '') + i.offset + ' (la página impresa 1 = página ' + (1 + i.offset) + ' del PDF) · ' + i.confirmed + '/' + i.total + ' títulos confirmados' + (i.uncertain ? ' · ' + i.uncertain + ' por revisar ⚠' : '');
        } else if (res.auto) {
          infoEl.textContent = 'Sin índice impreso utilizable · texto base ≈ ' + res.auto.bodySize + ' pt, títulos desde ≈ ' + (Math.round(res.auto.bodySize * res.auto.ratio * 10) / 10) + ' pt (detectado automáticamente)';
        } else infoEl.textContent = '';
        setProgress('toc', 100, 'Detección completada', 'done');
        if (this.entries.length) {
          setStatus('toc', 'success', this.entries.length + ' entradas detectadas. Revisa, corrige y genera el PDF.');
          Log.add('ok', 'ÍNDICE', 'Detección ' + mode + ': ' + this.entries.length + ' entradas en ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s.');
        } else {
          setStatus('toc', 'warn', res.totalChars < 50 ? 'No hay texto en el PDF (¿es un escaneo?). Usa primero la pestaña de OCR.' : 'No se detectó ningún capítulo. Prueba otro modo, baja el tamaño mínimo o agrégalos a mano.');
        }
      } catch (e) {
        if (this.cancelled || (e && e.code === 'CANCELLED')) { setStatus('toc', 'idle', 'Proceso cancelado.'); setProgress('toc', 0, 'Cancelado'); }
        else this.fail(e);
      } finally { this.busy = false; this.lock(false); }
    },

    // ---------- Tabla editable ----------
    srcLabel(s) { return s === 'regex' ? 'Regex' : s === 'tipografia' ? 'Tipografía' : s === 'indice' ? 'Índice' : s === 'consenso' ? 'Regex + tipo' : 'Manual'; },

    shiftPages() {
      const d = parseInt($('#toc-shift').value, 10) || 0;
      if (!d || !this.entries.length) return;
      this.entries.forEach((e) => { e.page = Math.max(1, Math.min(this.N, e.page + d)); e.uncertain = false; });
      $('#toc-shift').value = 0;
      this.render();
      Log.add('info', 'ÍNDICE', 'Todas las páginas se desplazaron ' + (d > 0 ? '+' : '') + d + '.');
      if (this.sel) { const e = this.entries.find((x) => x.id === this.sel); if (e) this.preview(e.page); }
    },

    render() {
      const body = $('#toc-body');
      body.innerHTML = '';
      const included = this.entries.filter((e) => e.include).length;
      $('#toc-count').textContent = included + (included !== this.entries.length ? ' / ' + this.entries.length : '');
      ['#toc-sort', '#toc-clear', '#toc-shift-btn'].forEach((s) => { $(s).disabled = !this.entries.length; });
      $('#toc-generate').disabled = !this.doc || !this.entries.length || this.busy;
      if (!this.entries.length) {
        body.innerHTML = '<tr class="empty-row"><td colspan="6">Aún no hay entradas. Detecta capítulos o agrega las tuyas.</td></tr>';
        return;
      }
      const frag = document.createDocumentFragment();
      this.entries.forEach((e) => {
        const tr = document.createElement('tr');
        tr.dataset.id = e.id;
        if (e.id === this.sel) tr.classList.add('sel');
        if (!e.include) tr.classList.add('off');
        if (e.uncertain) { tr.classList.add('unc'); tr.title = 'No se pudo confirmar esta página en el texto del libro: revísala con la vista previa.'; }
        tr.innerHTML =
          '<td class="c-inc"><input type="checkbox" data-f="include" title="Incluir en el PDF"></td>' +
          '<td class="c-lvl"><select data-f="level" title="Jerarquía"><option value="1">1 · Capítulo</option><option value="2">2 · Sección</option><option value="3">3 · Subsección</option></select></td>' +
          '<td><input type="text" data-f="title" maxlength="300"></td>' +
          '<td class="c-pg"><input type="number" data-f="page" min="1"></td>' +
          '<td class="c-src"><span class="src-badge"></span></td>' +
          '<td class="c-act"><div class="row-act"><button data-a="up" title="Subir">↑</button><button data-a="down" title="Bajar">↓</button><button data-a="del" title="Eliminar">✕</button></div></td>';
        $('[data-f=include]', tr).checked = !!e.include;
        $('[data-f=level]', tr).value = String(e.level);
        const t = $('[data-f=title]', tr); t.value = e.title; t.style.paddingLeft = (8 + (e.level - 1) * 18) + 'px';
        const pg = $('[data-f=page]', tr); pg.value = e.page; pg.max = this.N;
        const badge = $('.src-badge', tr); badge.textContent = this.srcLabel(e.source) + (e.uncertain ? ' ⚠' : ''); badge.classList.add(e.uncertain ? 'unc' : e.source);
        frag.appendChild(tr);
      });
      body.appendChild(frag);
    },

    entryOf(el) { const tr = el.closest('tr'); return tr ? { tr, e: this.entries.find((x) => x.id === tr.dataset.id) } : {}; },

    onField(ev, isChange) {
      const f = ev.target.dataset && ev.target.dataset.f;
      if (!f) return;
      const { tr, e } = this.entryOf(ev.target);
      if (!e) return;
      if (f === 'title') e.title = ev.target.value;
      else if (f === 'include') { e.include = ev.target.checked; tr.classList.toggle('off', !e.include); this.render(); return; }
      else if (f === 'level') { e.level = parseInt(ev.target.value, 10); $('[data-f=title]', tr).style.paddingLeft = (8 + (e.level - 1) * 18) + 'px'; }
      else if (f === 'page' && isChange) {
        let p = parseInt(ev.target.value, 10);
        if (!(p >= 1 && p <= this.N)) { p = Math.max(1, Math.min(this.N, p || 1)); ev.target.value = p; }
        e.page = p; e.uncertain = false; tr.classList.remove('unc'); this.preview(p);
      }
    },

    onClick(ev) {
      const act = ev.target.dataset && ev.target.dataset.a;
      const { tr, e } = this.entryOf(ev.target);
      if (!e) return;
      const i = this.entries.indexOf(e);
      if (act === 'del') { this.entries.splice(i, 1); if (this.sel === e.id) this.sel = null; this.render(); return; }
      if (act === 'up' && i > 0) { [this.entries[i - 1], this.entries[i]] = [this.entries[i], this.entries[i - 1]]; this.render(); return; }
      if (act === 'down' && i < this.entries.length - 1) { [this.entries[i + 1], this.entries[i]] = [this.entries[i], this.entries[i + 1]]; this.render(); return; }
      if (this.sel !== e.id) {
        this.sel = e.id;
        $$('#toc-body tr.sel').forEach((r) => r.classList.remove('sel'));
        tr.classList.add('sel');
        this.preview(e.page);
      }
    },

    addEntry() {
      if (!this.doc) return;
      const e = { id: 'm' + (++this.manualSeq), title: 'Nueva sección', page: this.previewPage, level: 1, source: 'manual', include: true };
      const i = this.sel ? this.entries.findIndex((x) => x.id === this.sel) : -1;
      if (i >= 0) this.entries.splice(i + 1, 0, e); else this.entries.push(e);
      this.sel = e.id; this.render();
      const row = $('#toc-body tr.sel [data-f=title]'); if (row) { row.focus(); row.select(); row.scrollIntoView({ block: 'nearest' }); }
    },

    // ---------- Generación del PDF con marcadores ----------
    async generate() {
      if (!this.doc || this.busy) return;
      const chosen = this.entries.filter((e) => e.include && e.title.trim());
      if (!chosen.length) { setStatus('toc', 'error', 'No hay entradas incluidas con título para escribir.'); return; }
      this.busy = true; this.cancelled = false; this.lock(true); this.revokeResult();
      const t0 = performance.now();
      setStatus('toc', 'working', 'Escribiendo ' + chosen.length + ' marcadores…');
      Log.add('info', 'ÍNDICE', 'Generando PDF con ' + chosen.length + ' marcadores (sin modificar el contenido de las páginas).');
      try {
        this.worker = new WorkerClient('toc', (m) => {
          if (m.type === 'log') Log.add(m.level || 'info', 'ÍNDICE·worker', m.msg);
          else if (m.type === 'stage') setProgress('toc', (m.value || 0) * 100, m.detail || '');
        });
        const copy = this.bytes.slice(0);
        const out = await this.worker.call('inject', {
          bytes: copy, cdn: CFG.CDN,
          entries: chosen.map((e) => ({ title: e.title, page: e.page, level: e.level }))
        }, [copy.buffer]);
        // Segunda comprobación independiente con PDF.js (lo que verá un lector)
        setProgress('toc', 95, 'Validando marcadores con PDF.js');
        const check = await PdfLoader.open(out.bytes.slice(0));
        let n = 0; try { n = await PdfLoader.countOutline(check); } finally { await PdfLoader.destroy(check); }
        if (n !== out.outlineCount) throw new Error('La validación falló: PDF.js lee ' + n + ' marcadores y se escribieron ' + out.outlineCount + '.');
        this.result = out.bytes;
        this.blobUrl = URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' }));
        setProgress('toc', 100, 'Completado', 'done');
        setStatus('toc', 'success', 'Listo: ' + n + ' marcadores escritos y verificados (' + fmtTime(performance.now() - t0) + ').');
        Log.add('ok', 'ÍNDICE', 'PDF generado (' + fmtBytes(out.bytes.length) + '); PDF.js confirma ' + n + ' marcadores.');
        $('#toc-download').disabled = false;
      } catch (e) {
        if (this.cancelled || (e && e.message === 'CANCELLED')) { setStatus('toc', 'idle', 'Proceso cancelado.'); setProgress('toc', 0, 'Cancelado'); }
        else this.fail(e);
      } finally {
        if (this.worker) { this.worker.terminate(); this.worker = null; }
        this.busy = false; this.lock(false);
      }
    },

    download() {
      if (!this.blobUrl || !this.file) return;
      triggerDownload(this.blobUrl, baseName(this.file.name) + '_indice.pdf');
      Log.add('info', 'ÍNDICE', 'Descarga iniciada.');
      setStatus('toc', 'success', 'Descarga iniciada. La memoria temporal se liberará en unos segundos (puedes volver a generar).');
      $('#toc-download').disabled = true;
      this.releaseTimer = setTimeout(() => {
        this.revokeResult();
        $('#toc-download').textContent = 'Descargado ✓ (memoria liberada)';
        Log.add('ok', 'ÍNDICE', 'Memoria liberada (URL del blob revocada y búferes descartados).');
      }, 20000);
    }
  };

  // =====================================================================
  // Pestañas y arranque
  // =====================================================================
  function setupTabs() {
    const show = (name) => {
      $$('.tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); });
      $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
      try { history.replaceState(null, '', '#' + name); } catch (_) { /* file:// restringido */ }
    };
    $$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
    const h = (location.hash || '').replace('#', '');
    if (h === 'ocr' || h === 'toc') show(h);
  }

  function boot() {
    Log.init(); setupTabs(); Ocr.init(); Toc.init();
    window.addEventListener('error', (e) => Log.add('error', 'APP', 'Error no controlado: ' + (e.message || e)));
    window.addEventListener('unhandledrejection', (e) => Log.add('error', 'APP', 'Promesa rechazada: ' + ((e.reason && e.reason.message) || e.reason)));
    if (!window.pdfjsLib) {
      const msg = 'No se pudo cargar PDF.js desde la CDN. Conéctate a internet la primera vez para que el navegador lo guarde en caché.';
      setStatus('ocr', 'error', msg); setStatus('toc', 'error', msg); Log.add('error', 'APP', msg);
      return;
    }
    try { PdfLoader.configure(); } catch (e) { Log.add('error', 'APP', e.message); }
    Log.add('info', 'APP', 'Aplicación lista. Procesamiento 100 % local; hilos de trabajo disponibles: ' + (navigator.hardwareConcurrency || '?') + ' núcleos.');
    if (typeof OffscreenCanvas === 'undefined') Log.add('warn', 'APP', 'Tu navegador no soporta OffscreenCanvas: el OCR podría no funcionar. Usa una versión reciente de Chrome, Edge o Firefox.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
