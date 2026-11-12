/* toc.worker.js — Hilo que inyecta marcadores (Outlines) con pdf-lib sin tocar el contenido
 * de las páginas (no se redibuja ni se reemplaza nada: solo se añade el árbol /Outlines al
 * catálogo). Verifica la integridad del resultado antes de devolverlo.
 * Se registra como texto y se instancia con un Blob (compatible con file://). */
(function () {
  'use strict';

  function tocWorkerMain() {
    'use strict';

    function log(level, msg) { self.postMessage({ type: 'log', level: level, msg: msg }); }
    function stage(name, value, detail) { self.postMessage({ type: 'stage', stage: name, value: value, detail: detail }); }

    function buildTree(entries) {
      var root = { level: 0, children: [] }, stack = [root], prevLevel = 0;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var lvl = Math.max(1, Math.min(e.level || 1, prevLevel + 1));
        prevLevel = lvl;
        while (stack.length > 1 && stack[stack.length - 1].level >= lvl) stack.pop();
        var node = { title: e.title, page: e.page, level: lvl, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      }
      return root;
    }

    function injectOutlines(doc, entries) {
      var L = self.PDFLib, ctx = doc.context, pages = doc.getPages();
      var tree = buildTree(entries);

      function build(children, parentRef) {
        var refs = children.map(function () { return ctx.nextRef(); });
        var total = 0;
        children.forEach(function (k, i) {
          var page = pages[k.page - 1];
          var cb = page.getCropBox();
          var dict = {
            Title: L.PDFHexString.fromText(k.title),
            Parent: parentRef,
            Dest: [page.ref, L.PDFName.of('XYZ'), cb.x, cb.y + cb.height, null]
          };
          if (i > 0) dict.Prev = refs[i - 1];
          if (i < children.length - 1) dict.Next = refs[i + 1];
          total += 1;
          if (k.children.length) {
            var sub = build(k.children, refs[i]);
            dict.First = sub.first; dict.Last = sub.last; dict.Count = sub.count;
            total += sub.count;
          }
          ctx.assign(refs[i], ctx.obj(dict));
        });
        return { first: refs[0], last: refs[refs.length - 1], count: total };
      }

      var outlinesRef = ctx.nextRef();
      var top = build(tree.children, outlinesRef);
      ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
      doc.catalog.set(L.PDFName.of('Outlines'), outlinesRef);
      doc.catalog.set(L.PDFName.of('PageMode'), L.PDFName.of('UseOutlines'));
      return top.count;
    }

    function countOutline(doc) {
      var L = self.PDFLib, ctx = doc.context;
      var root = doc.catalog.lookup(L.PDFName.of('Outlines'));
      if (!(root instanceof L.PDFDict)) return 0;
      function walk(dict) {
        var n = 0, ref = dict.get(L.PDFName.of('First'));
        while (ref) {
          var item = ctx.lookup(ref, L.PDFDict);
          n += 1 + walk(item);
          ref = item.get(L.PDFName.of('Next'));
        }
        return n;
      }
      return walk(root);
    }

    var handlers = {
      inject: async function (m) {
        stage('loading', 0.05, 'Cargando PDF');
        importScripts(m.cdn.pdfLib);
        var L = self.PDFLib;
        var original = await L.PDFDocument.load(m.bytes.slice(0), { updateMetadata: false });
        var doc = await L.PDFDocument.load(m.bytes, { updateMetadata: false });
        var pages = doc.getPages(), N = pages.length;
        log('info', 'PDF cargado: ' + N + ' páginas.');

        var entries = [];
        for (var i = 0; i < m.entries.length; i++) {
          var e = m.entries[i];
          var title = String(e.title || '').replace(/\s+/g, ' ').trim();
          var pg = Math.round(Number(e.page));
          if (!title) { log('warn', 'Entrada ' + (i + 1) + ' sin título: omitida.'); continue; }
          if (!(pg >= 1 && pg <= N)) { log('warn', 'Entrada «' + title + '» con página fuera de rango (' + e.page + '): omitida.'); continue; }
          entries.push({ title: title, page: pg, level: e.level });
        }
        if (!entries.length) throw new Error('No hay entradas válidas para escribir.');

        stage('building', 0.3, 'Construyendo marcadores');
        var hadOutline = doc.catalog.has(L.PDFName.of('Outlines'));
        var written = injectOutlines(doc, entries);
        log('info', (hadOutline ? 'Se reemplazaron los marcadores existentes. ' : '') + 'Marcadores escritos: ' + written + '.');

        stage('saving', 0.6, 'Escribiendo metadatos PDF');
        var bytes = await doc.save({ useObjectStreams: false });

        stage('verifying', 0.85, 'Verificando integridad');
        var check = await L.PDFDocument.load(bytes, { updateMetadata: false });
        if (check.getPageCount() !== N) throw new Error('Verificación fallida: cambió el número de páginas.');
        var found = countOutline(check);
        if (found !== entries.length) throw new Error('Verificación fallida: se esperaban ' + entries.length + ' marcadores y se hallaron ' + found + '.');
        // La maquetación no debe cambiar: tamaño, recuadro y rotación de cada página.
        var op = original.getPages(), cp = check.getPages();
        for (var p = 0; p < N; p++) {
          var a = op[p].getCropBox(), b = cp[p].getCropBox();
          if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height || op[p].getRotation().angle !== cp[p].getRotation().angle) {
            throw new Error('Verificación fallida: la geometría de la página ' + (p + 1) + ' cambió.');
          }
        }
        log('ok', 'Integridad verificada: ' + found + ' marcadores y ' + N + ' páginas sin cambios de geometría.');
        stage('done', 1, 'Listo');
        return { bytes: bytes, outlineCount: found, pageCount: N };
      }
    };

    self.onmessage = async function (e) {
      var m = e.data;
      try {
        var r = await handlers[m.type](m);
        self.postMessage(Object.assign({ id: m.id, ok: true }, r || {}), r && r.bytes ? [r.bytes.buffer] : []);
      } catch (err) {
        self.postMessage({ id: m.id, ok: false, error: (err && err.message) ? err.message : String(err), name: err && err.name });
      }
    };
  }

  window.WorkerSources = window.WorkerSources || {};
  window.WorkerSources.toc = '(' + tocWorkerMain.toString() + ')();';
})();
