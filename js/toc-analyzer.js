/* toc-analyzer.js — Algoritmos de detección de capítulos.
 * Modo A: expresiones regulares sobre líneas de texto.
 * Modo B: análisis tipográfico (tamaño de letra, negrita, posición vertical).
 * Funciona en navegador (window.TocAnalyzer) y en Node (module.exports) para pruebas. */
(function (root) {
  'use strict';

  // ---------- Utilidades ----------
  const ROMAN_STRICT = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
  const isRoman = (s) => !!s && ROMAN_STRICT.test(s);
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const stripDigits = (s) => norm(s).replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const titleCase = (s) => s;

  const NUM_WORDS = '(?:uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|primero|primer|segundo|tercero|tercer|cuarto|quinto|sexto|s[eé]ptimo|octavo|noveno|d[eé]cimo|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)';
  const NUM = '(?:\\d{1,3}|[IVXLCDM]{1,8}|' + NUM_WORDS + ')';
  const RE_CHAPTER = new RegExp('^(cap[ií]tulo|cap\\.|chapter|chap\\.)\\s*(' + NUM + ')\\b\\s*[.:\\-–—)]*\\s*(.*)$', 'i');
  const RE_PART = new RegExp('^(parte|part|libro|book|t[ií]tulo)\\s+(' + NUM + ')\\b\\s*[.:\\-–—)]*\\s*(.*)$', 'i');
  const RE_SECTION = new RegExp('^(secci[oó]n|section)\\s+(' + NUM + ')\\b\\s*[.:\\-–—)]*\\s*(.*)$', 'i');
  const RE_ROMAN_ALONE = /^([IVXLCDM]{1,8})[.)]?$/;
  const RE_ROMAN_TITLE = /^([IVXLCDM]{2,8})[.)\-–—]\s+(\S.{1,80})$/;
  const RE_DECIMAL = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([A-ZÁÉÍÓÚÑÜ¿¡].{2,80})$/;
  const KEYWORDS = [
    'introducción', 'introduccion', 'prefacio', 'prólogo', 'prologo', 'índice', 'indice', 'epílogo', 'epilogo',
    'conclusiones', 'conclusión', 'conclusion', 'apéndice', 'apendice', 'bibliografía', 'bibliografia', 'agradecimientos',
    'dedicatoria', 'glosario', 'notas', 'presentación', 'presentacion', 'preámbulo', 'preambulo', 'advertencia', 'nota del autor', 'nota del editor',
    'introduction', 'preface', 'foreword', 'contents', 'table of contents', 'index', 'appendix', 'epilogue', 'afterword',
    'bibliography', 'acknowledgements', 'acknowledgments', 'dedication', 'glossary', 'notes', 'prologue', 'conclusions', 'conclusion'
  ];
  const KEYWORD_SET = new Set(KEYWORDS.map(norm));
  const RE_LEADERS = /(\.{3,}|(?:\.\s){3,}|…+)\s*\d{1,4}\s*$/;

  // ---------- Construcción de líneas a partir de ítems de PDF.js ----------
  function buildLines(page) {
    const items = page.items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lines = [];
    for (const it of items) {
      const tol = Math.max(2, it.size * 0.4);
      let line = null;
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
        if (Math.abs(lines[i].y - it.y) <= tol) { line = lines[i]; break; }
      }
      if (!line) { line = { y: it.y, parts: [] }; lines.push(line); }
      line.parts.push(it);
    }
    const out = [];
    for (const l of lines) {
      l.parts.sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd = null;
      let chars = 0, sizeAcc = 0, maxSize = 0;
      const fonts = {};
      for (const p of l.parts) {
        if (prevEnd !== null) {
          const gap = p.x - prevEnd;
          if (gap > p.size * 0.18 && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' ';
        }
        text += p.str;
        prevEnd = p.x + p.w;
        const n = p.str.replace(/\s/g, '').length;
        chars += n; sizeAcc += p.size * n; if (p.size > maxSize) maxSize = p.size;
        fonts[p.font] = (fonts[p.font] || 0) + n;
      }
      text = clean(text);
      if (!text) continue;
      const font = Object.keys(fonts).sort((a, b) => fonts[b] - fonts[a])[0] || '';
      const family = (l.parts.find((p) => p.font === font) || {}).family || '';
      out.push({
        text, y: l.y, x: l.parts[0].x, size: chars ? sizeAcc / chars : maxSize, maxSize, chars, font, family,
        page: page.pageNum, pageHeight: page.height, pageWidth: page.width,
        p: l.parts.map((q) => ({ s: q.str, x: q.x, w: q.w }))
      });
    }
    out.sort((a, b) => b.y - a.y); // de arriba a abajo
    out.forEach((l, i) => { l.idx = i; });
    return out;
  }

  // ---------- Ruido: encabezados repetidos y páginas de índice ----------
  function findRunningHeaders(pagesLines, n) {
    const counts = new Map();
    for (const lines of pagesLines) {
      const seen = new Set();
      for (const l of lines) {
        const inMargin = l.y > l.pageHeight * 0.9 || l.y < l.pageHeight * 0.1;
        if (!inMargin) continue;
        for (const k of ['e:' + norm(l.text), 'd:' + stripDigits(l.text)]) {
          if (k.length > 2 && !seen.has(k)) { seen.add(k); counts.set(k, (counts.get(k) || 0) + 1); }
        }
      }
    }
    const minExact = Math.max(3, Math.round(n * 0.05));
    const minDigits = Math.max(8, Math.round(n * 0.15)); // «Mi Libro 12», «Mi Libro 13»…
    const set = new Set();
    counts.forEach((c, k) => { if (c >= (k[0] === 'e' ? minExact : minDigits)) set.add(k); });
    return set;
  }
  const isRunning = (l, headers) => (l.y > l.pageHeight * 0.9 || l.y < l.pageHeight * 0.1) && (headers.has('e:' + norm(l.text)) || headers.has('d:' + stripDigits(l.text)));
  const looksLikeTocPage = (lines) => lines.filter((l) => RE_LEADERS.test(l.text)).length >= 4;

  function bodyStats(pagesLines) {
    const hist = new Map();
    const fontHist = new Map();
    for (const lines of pagesLines) for (const l of lines) {
      const k = Math.round(l.size * 2) / 2;
      hist.set(k, (hist.get(k) || 0) + l.chars);
      fontHist.set(l.font, (fontHist.get(l.font) || 0) + l.chars);
    }
    let bodySize = 0, best = -1, bodyFont = '', bf = -1;
    hist.forEach((v, k) => { if (v > best) { best = v; bodySize = k; } });
    fontHist.forEach((v, k) => { if (v > bf) { bf = v; bodyFont = k; } });
    return { bodySize, bodyFont };
  }

  let seq = 0;
  const mk = (title, page, level, source, extra) => Object.assign({ id: 'e' + (++seq), title: clean(title), page, level, source, include: true }, extra || {});

  // ---------- Modo A: expresiones regulares ----------
  function detectRegex(pages, opts) {
    const o = Object.assign({ skipTocPages: true, decimal: false, maxLevels: 3 }, opts || {});
    const pagesLines = pages.map(buildLines);
    const headers = findRunningHeaders(pagesLines, pages.length);
    const found = [];
    const warnings = [];

    pagesLines.forEach((lines, pi) => {
      if (o.skipTocPages && looksLikeTocPage(lines)) { warnings.push('Página ' + pages[pi].pageNum + ': parece un índice impreso; se omite.'); return; }
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const t = l.text;
        if (t.length > 90 || isRunning(l, headers)) continue;
        if (/[,;]$/.test(t)) continue;
        let m, level = null, title = null;

        const subtitleOf = () => {
          const nx = lines[i + 1];
          if (nx && nx.text.length <= 80 && !/[.,;]$/.test(nx.text) && (l.y - nx.y) < Math.max(l.size, nx.size) * 3.6 && !RE_CHAPTER.test(nx.text)) { return nx.text; }
          return '';
        };

        if ((m = t.match(RE_PART))) {
          level = 1; title = m[1] + ' ' + m[2] + (m[3] ? ' — ' + m[3] : (subtitleOf() ? ' — ' + subtitleOf() : ''));
          found.push(mk(title, pages[pi].pageNum, 1, 'regex', { kind: 'part', y: l.y }));
          continue;
        }
        if ((m = t.match(RE_CHAPTER))) {
          const rest = m[3] || subtitleOf();
          if (m[3] && m[3].length > 70) continue;
          if (/^[a-záéíóúñ]/.test(m[3] || '') && (m[3] || '').split(' ').length > 6) continue; // frase corriente
          title = m[1].replace(/\.$/, '') + ' ' + m[2] + (rest ? ' — ' + rest : '');
          found.push(mk(title, pages[pi].pageNum, 1, 'regex', { kind: 'chapter', y: l.y }));
          continue;
        }
        if ((m = t.match(RE_SECTION))) {
          const rest = m[3] || subtitleOf();
          found.push(mk(m[1] + ' ' + m[2] + (rest ? ' — ' + rest : ''), pages[pi].pageNum, 2, 'regex', { kind: 'section', y: l.y }));
          continue;
        }
        if ((m = t.match(RE_ROMAN_ALONE)) && isRoman(m[1]) && m[1].length >= 1 && /^[IVXLCDM]+[.)]?$/.test(t)) {
          if (m[1].length === 1 && !/^[IVX]$/.test(m[1])) continue;
          const rest = subtitleOf();
          found.push(mk(m[1] + (rest ? ' — ' + rest : ''), pages[pi].pageNum, 1, 'regex', { kind: 'roman', y: l.y }));
          continue;
        }
        if ((m = t.match(RE_ROMAN_TITLE)) && isRoman(m[1]) && !/[.]$/.test(m[2])) {
          found.push(mk(m[1] + ' — ' + m[2], pages[pi].pageNum, 1, 'regex', { kind: 'roman', y: l.y }));
          continue;
        }
        const key = norm(t.replace(/\s*\d+\s*$/, ''));
        if (KEYWORD_SET.has(key)) {
          found.push(mk(t.replace(/\s*\d+\s*$/, ''), pages[pi].pageNum, 1, 'regex', { kind: 'keyword', y: l.y }));
          continue;
        }
        if (o.decimal && (m = t.match(RE_DECIMAL)) && !RE_LEADERS.test(t)) {
          const lv = Math.min(o.maxLevels, m[1].split('.').length);
          found.push(mk(m[1] + ' ' + m[2], pages[pi].pageNum, lv, 'regex', { kind: 'decimal', y: l.y }));
        }
      }
    });

    // Si existen "Partes", los capítulos bajan a nivel 2 y las secciones a nivel 3.
    if (found.some((e) => e.kind === 'part')) {
      for (const e of found) {
        if (e.kind === 'chapter' || e.kind === 'roman') e.level = Math.min(o.maxLevels, 2);
        else if (e.kind === 'section') e.level = Math.min(o.maxLevels, 3);
      }
    }
    for (const e of found) e.level = Math.min(e.level, o.maxLevels);
    return { entries: dedupe(found), warnings };
  }

  // ---------- Modo B: análisis tipográfico ----------
  function detectTypographic(pages, opts) {
    const o = Object.assign({ sizeRatio: 0, includeBold: null, maxLevels: 3, skipTocPages: true }, opts || {});
    const pagesLines = pages.map(buildLines);
    const warnings = [];
    const { bodySize, bodyFont } = bodyStats(pagesLines);
    if (!bodySize) return { entries: [], warnings: ['No se encontró texto en el documento.'] };
    const headers = findRunningHeaders(pagesLines, pages.length);
    if (!(o.sizeRatio > 0)) { const a = autoRatio(pagesLines, bodySize, headers); o.sizeRatio = a.ratio; if (o.includeBold === null) o.includeBold = a.strong < pages.length * 0.02; }
    if (o.includeBold === null) o.includeBold = false;
    const boldRe = /bold|black|heavy|semibold|demi|negrita|\.b$|-b$|,bold/i;
    const cands = [];

    pagesLines.forEach((lines, pi) => {
      if (o.skipTocPages && looksLikeTocPage(lines)) return;
      // interlineado típico de la página para medir aislamiento
      const gaps = [];
      for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
      gaps.sort((a, b) => a - b);
      const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : bodySize * 1.3;

      let last = null;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const t = l.text;
        if (t.length < 2 || t.length > 120 || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{2}/.test(t)) continue;
        if (/^\d+$/.test(t) || isRunning(l, headers) || RE_LEADERS.test(t)) continue;
        const inMargin = l.y > l.pageHeight * 0.94 || l.y < l.pageHeight * 0.06;
        if (inMargin) continue;
        const strong = l.size >= bodySize * o.sizeRatio;
        const bold = boldRe.test(l.font) || boldRe.test(l.family) || (l.font !== bodyFont && l.size >= bodySize * 0.98 && boldRe.test(l.family + l.font));
        let accept = strong;
        if (!accept && o.includeBold && bold && l.size >= bodySize * 0.98 && t.length <= 70 && !/[.,;:]$/.test(t)) {
          const prevGap = i > 0 ? lines[i - 1].y - l.y : Infinity;
          const nextGap = i < lines.length - 1 ? l.y - lines[i + 1].y : Infinity;
          accept = prevGap > medGap * 1.4 && nextGap > medGap * 1.1;
        }
        if (!accept) { last = null; continue; }
        // Unir líneas consecutivas del mismo título (títulos de varias líneas)
        if (last && Math.abs(last.size - l.size) <= l.size * 0.04 && (last.y - l.y) < l.size * 2.2 && last.page === l.page) {
          last.text = clean(last.text + ' ' + t); last.y = l.y; continue;
        }
        const c = { text: t, size: l.size, page: pages[pi].pageNum, y: l.y, bold, strong };
        cands.push(c); last = c;
      }
    });

    // Agrupar tamaños en niveles (mayor tamaño = nivel 1)
    const sizes = Array.from(new Set(cands.filter((c) => c.strong).map((c) => Math.round(c.size * 2) / 2))).sort((a, b) => b - a);
    const clusters = [];
    for (const s of sizes) {
      const c = clusters.find((x) => Math.abs(x.ref - s) / x.ref < 0.08);
      if (c) c.members.push(s); else clusters.push({ ref: s, members: [s] });
    }
    const levelOf = (c) => {
      if (!c.strong) return Math.min(o.maxLevels, Math.max(1, clusters.length + 1));
      const s = Math.round(c.size * 2) / 2;
      const idx = clusters.findIndex((x) => x.members.includes(s));
      return Math.min(o.maxLevels, idx + 1);
    };
    // Límite por página para frenar falsos positivos (p. ej. portadas con muchos tamaños)
    const perPage = new Map();
    const entries = [];
    for (const c of cands) {
      const n = (perPage.get(c.page) || 0) + 1;
      perPage.set(c.page, n);
      if (n > 4) continue;
      entries.push(mk(c.text, c.page, levelOf(c), 'tipografia', { y: c.y, size: Math.round(c.size * 10) / 10 }));
    }
    warnings.push('Texto base ≈ ' + bodySize + ' pt; ' + clusters.length + ' nivel(es) tipográfico(s) detectado(s).');
    return { entries: dedupe(entries), warnings };
  }

  // ---------- Combinación y limpieza ----------
  function dedupe(entries) {
    const out = [];
    const seen = new Set();
    for (const e of entries.slice().sort((a, b) => (a.page - b.page) || ((b.y || 0) - (a.y || 0)))) {
      const k = e.page + '|' + norm(e.title);
      if (seen.has(k)) continue;
      seen.add(k);
      // Mismo título en la página anterior (encabezado repetido): se descarta
      const prev = out[out.length - 1];
      if (prev && prev.page === e.page - 1 && norm(prev.title) === norm(e.title)) continue;
      out.push(e);
    }
    return out;
  }

  function mergeResults(a, b) {
    // Prioriza regex; añade los tipográficos que no coincidan con un hallazgo regex en la misma página.
    const out = a.slice();
    for (const e of b) {
      const dup = out.some((x) => x.page === e.page && (norm(x.title).includes(norm(e.title)) || norm(e.title).includes(norm(x.title)) || Math.abs((x.y || 0) - (e.y || 0)) < 12));
      if (!dup) out.push(e);
    }
    return out.sort((x, y) => (x.page - y.page) || ((y.y || 0) - (x.y || 0)));
  }

  // ---------- Índice impreso del propio libro (modo prioritario) ----------
  const TOC_HEADERS = new Set(['contenido', 'contenidos', 'indice', 'indice general', 'tabla de contenido', 'tabla de contenidos', 'sumario', 'contenido general', 'contents', 'table of contents', 'summary'].map(norm));
  const STOP_LIST = /^(indice|lista|listado|list|tabla|table) (de|of) (figuras|ilustraciones|tablas|graficos|cuadros|mapas|laminas|figures|illustrations|tables|maps|plates)/;
  const RE_TOC_LEADER = /^(.*?\S)\s*(?:\.{2,}|(?:\.\s){2,}|…+|·{2,}|_{2,}|-{3,})\s*(\d{1,4}|[ivxlcdm]{1,7})\s*$/i;
  const NUMTOK = /^(\d{1,4}|[ivxlcdm]{1,7})$/i;
  const CONNECT = /(?:\b(?:de|del|la|el|los|las|y|e|en|a|al|con|por|para|the|of|and|in|to|for|an)|[,;:\-–—])$/i;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Interpreta una línea como entrada de índice: «Título ..... 25». */
  function parseTocLine(l) {
    let title, num;
    const m = l.text.match(RE_TOC_LEADER);
    if (m) { title = m[1]; num = m[2]; }
    else if (l.p && l.p.length >= 2) {
      const last = l.p[l.p.length - 1], prev = l.p[l.p.length - 2];
      const s = last.s.trim();
      if (NUMTOK.test(s) && (last.x - (prev.x + prev.w)) > l.size * 1.2 && last.x > l.pageWidth * 0.5) {
        num = s; title = l.text.slice(0, l.text.lastIndexOf(s)).trim();
      }
    }
    if (!num) return null;
    title = title.replace(/[\s.·…_\-–—]+$/, '').trim();
    if (title.length < 2 || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{2}/.test(title)) return null;
    const arabic = /^\d+$/.test(num);
    if (!arabic && !isRoman(num.toUpperCase())) return null;
    return { title, printed: arabic ? parseInt(num, 10) : null, roman: arabic ? null : num.toLowerCase(), left: l.x, y: l.y, size: l.size };
  }

  function scanTocPage(lines) {
    let entries = 0, desc = 0, prev = -1;
    for (const l of lines) {
      const e = parseTocLine(l);
      if (!e) continue;
      entries++;
      if (e.printed !== null) { if (prev >= 0 && e.printed < prev) desc++; prev = e.printed; }
    }
    return { entries, desc, total: lines.length, header: lines.slice(0, 6).some((l) => TOC_HEADERS.has(norm(l.text))) };
  }

  /** Localiza el bloque de páginas consecutivas que forman el índice impreso. */
  function findTocBlock(pagesLines) {
    const n = pagesLines.length;
    const scans = pagesLines.map(scanTocPage);
    const ok = (s, minE, minR, maxD) => s.entries >= minE && s.entries / Math.max(1, s.total) >= minR && s.desc <= Math.max(1, Math.floor(s.entries * maxD));
    const strong = scans.map((s) => ok(s, 4, 0.35, 0.15));
    const weak = scans.map((s) => ok(s, 2, 0.25, 0.2));
    let best = null;
    for (let i = 0; i < n;) {
      if (!(strong[i] || weak[i])) { i++; continue; }
      let j = i;
      while (j + 1 < n && (strong[j + 1] || weak[j + 1])) j++;
      const idx = [];
      for (let k = i; k <= j; k++) idx.push(k);
      if (idx.some((k) => strong[k])) {
        const score = idx.reduce((s, k) => s + scans[k].entries, 0) + (idx.some((k) => scans[k].header) ? 15 : 0);
        if (!best || score > best.score) best = { pages: idx, score };
      }
      i = j + 1;
    }
    return best;
  }

  /** Lee las entradas del bloque (títulos partidos en dos líneas, «Parte I» sin página, etc.). */
  function readTocBlock(pagesLines, blockPages) {
    const items = [], used = [];
    let pending = null, awaiting = [], lastPrinted = 0, tocTitle = '', stop = false;
    for (const idx of blockPages) {
      if (stop) break;
      used.push(idx);
      let first = true;
      for (const l of pagesLines[idx]) {
        const nt = norm(l.text);
        if (STOP_LIST.test(nt)) { stop = true; break; }
        if (TOC_HEADERS.has(nt)) { if (!tocTitle) tocTitle = l.text; pending = null; continue; }
        const e = parseTocLine(l);
        if (e) {
          if (first && e.printed !== null && items.length >= 5 && e.printed < lastPrinted * 0.5) { stop = true; break; }
          first = false;
          if (pending && (l.y - 0) <= pending.y && (pending.y - l.y) < Math.max(pending.size, l.size) * 2.6) {
            if (/^[a-záéíóúñ]/.test(e.title) || CONNECT.test(pending.text)) e.title = pending.text + ' ' + e.title;
            else if (pending.text.length <= 40 && (RE_CHAPTER.test(pending.text + ' x') || /^(cap[ií]tulo|chapter|parte|part)\s+\S+$/i.test(pending.text))) e.title = pending.text + ' — ' + e.title;
          }
          pending = null;
          e.pg = idx;
          awaiting.forEach((p) => { p.nextRef = e; });
          awaiting = [];
          if (e.printed !== null) lastPrinted = e.printed;
          items.push(e);
        } else {
          const pm = l.text.length <= 80 && RE_PART.test(l.text);
          if (pm) {
            const part = { title: l.text, printed: null, roman: null, isPart: true, left: l.x, y: l.y, size: l.size, pg: idx };
            items.push(part); awaiting.push(part); pending = null;
          } else if (l.text.length <= 100 && !/^\d+$/.test(l.text)) pending = { text: l.text, y: l.y, size: l.size };
          else pending = null;
        }
      }
    }
    return { items: items.filter((it) => !it.isPart || it.nextRef), tocTitle, used };
  }

  function inferLevels(items, maxLevels) {
    const plain = items.filter((i) => !i.isPart);
    const dotted = plain.filter((i) => /^\d+\.\d+/.test(i.title)).length;
    const hasParts = items.some((i) => i.isPart);
    if (plain.length && dotted >= plain.length * 0.3) {
      items.forEach((i) => { i.level = i.isPart ? 1 : clamp((i.title.match(/^(\d+(?:\.\d+)*)/) || [, '1'])[1].split('.').length, 1, maxLevels); });
      return;
    }
    const minLeft = new Map();
    plain.forEach((i) => { minLeft.set(i.pg, Math.min(minLeft.has(i.pg) ? minLeft.get(i.pg) : Infinity, i.left)); });
    const rels = Array.from(new Set(plain.map((i) => Math.round(i.left - minLeft.get(i.pg))))).sort((a, b) => a - b);
    const clusters = [];
    rels.forEach((r) => { const c = clusters[clusters.length - 1]; if (c && r - c.max < 6) c.max = r; else clusters.push({ min: r, max: r }); });
    plain.forEach((i) => {
      const rel = Math.round(i.left - minLeft.get(i.pg));
      const ci = Math.max(0, clusters.findIndex((c) => rel >= c.min && rel <= c.max));
      i.level = clamp(ci + 1 + (hasParts ? 1 : 0), 1, maxLevels);
    });
    items.filter((i) => i.isPart).forEach((i) => { i.level = 1; });
  }

  // ---- Coincidencia de títulos del índice con encabezados reales del cuerpo ----
  function titleKey(title) {
    let t = title.replace(/^(cap[ií]tulo|cap\.|chapter|parte|part|libro|book|secci[oó]n|section)\s*/i, '');
    t = t.replace(/^(\d{1,3}(?:\.\d{1,2})*|[IVXLCDM]{1,8})\s*[.:\-–—)]*\s*/, '');
    const k = norm(t);
    return k.length >= 4 ? k : norm(title);
  }
  function bigrams(s) { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.substr(i, 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
  function dice(a, b) {
    const A = bigrams(a), B = bigrams(b); let inter = 0, ta = 0, tb = 0;
    A.forEach((v) => { ta += v; }); B.forEach((v) => { tb += v; });
    A.forEach((v, k) => { if (B.has(k)) inter += Math.min(v, B.get(k)); });
    return ta + tb ? 2 * inter / (ta + tb) : 0;
  }
  function matchScore(nl, key, fuzzy) {
    if (!nl || !key) return 0;
    if (nl === key) return 1;
    if (key.length >= 6 && nl.length <= key.length * 1.8 + 14 && nl.includes(key)) return 0.9;
    if (key.length >= 10 && nl.length >= Math.max(8, key.length * 0.6) && nl.length <= key.length && key.includes(nl)) return 0.75;
    if (fuzzy && key.length >= 8 && Math.abs(nl.length - key.length) <= key.length * 0.4) { const d = dice(nl, key); if (d >= 0.82) return d * 0.85; }
    return 0;
  }

  /** Número de folio impreso en el margen superior o inferior de la página, si existe. */
  function pageLabel(lines) {
    for (const l of lines) {
      const H = l.pageHeight;
      if (!(l.y > H * 0.9 || l.y < H * 0.1)) continue;
      const m = l.text.match(/^[\s\-–—[(]*(\d{1,4})[\s\-–—\])]*$/) || l.text.match(/^(?:p[aá]g(?:ina|\.)?|page|p\.)\s*(\d{1,4})$/i);
      if (m) return parseInt(m[1], 10);
      if (l.p && l.p.length >= 2) {
        const a = l.p[0], b = l.p[1], z = l.p[l.p.length - 1], y = l.p[l.p.length - 2];
        if (/^\d{1,4}$/.test(a.s.trim()) && b.x - (a.x + a.w) > l.size * 1.5) return parseInt(a.s, 10);
        if (/^\d{1,4}$/.test(z.s.trim()) && z.x - (y.x + y.w) > l.size * 1.5) return parseInt(z.s, 10);
      }
    }
    return null;
  }

  const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  /**
   * Lee el índice impreso del libro y traduce los números de página impresos a páginas
   * reales del PDF (la portada y los preliminares desplazan la numeración).
   * Calibración: (1) folios impresos en los márgenes, (2) búsqueda de los títulos como
   * encabezados en el cuerpo del libro; cada entrada se confirma buscando su título cerca de la
   * página esperada. Devuelve null si no hay un índice utilizable.
   */
  function detectFromPrintedToc(pages, opts, ctx) {
    const o = Object.assign({ maxLevels: 3 }, opts || {});
    const N = pages.length, warnings = [];
    const pagesLines = ctx ? ctx.pagesLines : pages.map(buildLines);
    const block = ctx ? ctx.block : findTocBlock(pagesLines);
    if (!block) return null;
    const { items, tocTitle, used } = readTocBlock(pagesLines, block.pages);
    const numbered = items.filter((i) => !i.isPart && (i.printed !== null || i.roman));
    if (numbered.length < 3) return null;
    const tocSet = new Set(used);
    const tocFirst = used[0] + 1, tocLast = used[used.length - 1] + 1;
    inferLevels(items, o.maxLevels);
    const headers = ctx ? ctx.headers : findRunningHeaders(pagesLines, N);

    const search = (key, lo, hi, fuzzy) => {
      const res = [];
      lo = Math.max(0, lo); hi = Math.min(N - 1, hi);
      for (let pi = lo; pi <= hi; pi++) {
        if (tocSet.has(pi)) continue;
        const lines = pagesLines[pi];
        let best = 0;
        for (let li = 0; li < lines.length; li++) {
          const l = lines[li];
          if (l.chars > 200 || isRunning(l, headers)) continue;
          if (l.n === undefined) l.n = norm(l.text);
          let s = matchScore(l.n, key, fuzzy);
          if (s > 0 && ctx && ctx.headingSet) s = ctx.headingSet.has(l) ? Math.min(1, s + 0.05) : s * 0.9;
          if (s < 1 && li + 1 < lines.length) {
            const nx = lines[li + 1];
            if (nx.n === undefined) nx.n = norm(nx.text);
            if ((l.y - nx.y) < Math.max(l.size, nx.size) * 2.6) s = Math.max(s, matchScore(l.n + ' ' + nx.n, key, fuzzy) * 0.95);
          }
          if (s > best) best = s;
        }
        if (best > 0) res.push({ page: pi + 1, score: best });
      }
      return res;
    };

    // 1) Desfase por títulos (votación sobre coincidencias fuertes en todo el libro)
    const arabic = items.filter((i) => !i.isPart && i.printed !== null);
    arabic.forEach((i) => { i.key = titleKey(i.title); });
    const votes = new Map();
    let voters = 0;
    for (const it of arabic) {
      if (it.key.length < 6) continue;
      const c = search(it.key, 0, N - 1, false).filter((x) => x.score >= 0.9).slice(0, 4);
      if (!c.length) continue;
      voters++;
      c.forEach((x) => { const off = x.page - it.printed; votes.set(off, (votes.get(off) || 0) + 1 / c.length); });
    }
    let titleOffset = null, titleSupport = 0;
    votes.forEach((w, off) => { if (w > titleSupport) { titleSupport = w; titleOffset = off; } });
    if (!(titleSupport >= 2 && titleSupport >= voters * 0.3)) titleOffset = null;

    // 2) Desfase por folios impresos en los márgenes
    const rawOffs = [];
    pagesLines.forEach((lines, i) => { if (tocSet.has(i)) return; const lab = pageLabel(lines); if (lab !== null) rawOffs.push({ off: i + 1 - lab, label: lab }); });
    const freq = new Map();
    rawOffs.forEach((r) => freq.set(r.off, (freq.get(r.off) || 0) + 1));
    const valid = rawOffs.filter((r) => freq.get(r.off) >= 3);
    let labelOffset = null, labelSupport = 0;
    freq.forEach((c, off) => { if (c >= 3 && c > labelSupport) { labelSupport = c; labelOffset = off; } });

    let globalOffset = null, source = 'estimado';
    if (titleOffset !== null && labelOffset !== null) {
      if (titleOffset === labelOffset) { globalOffset = titleOffset; source = 'folios y títulos'; }
      else if (titleSupport >= 3) { globalOffset = titleOffset; source = 'títulos'; }
      else { globalOffset = labelOffset; source = 'folios'; }
    } else if (titleOffset !== null) { globalOffset = titleOffset; source = 'títulos'; }
    else if (labelOffset !== null) { globalOffset = labelOffset; source = 'folios'; }
    const useLabels = labelOffset !== null && globalOffset === labelOffset;
    if (globalOffset === null) {
      globalOffset = tocFirst > N / 2 ? 0 : tocLast;
      warnings.push('No se pudo calibrar el desfase de páginas automáticamente (se estimó +' + globalOffset + '). Revisa las páginas marcadas con ⚠ o usa «Desplazar páginas».');
    }
    const local = (p) => {
      if (!useLabels) return null;
      const near = valid.filter((r) => Math.abs(r.label - p) <= 12).map((r) => r.off);
      return near.length ? median(near) : null;
    };

    // 3) Resolución entrada por entrada, confirmando con el título cerca de la página esperada
    let confirmed = 0, uncertain = 0, prev = 0;
    for (const it of items) {
      if (it.isPart) continue;
      if (it.printed === null) { // páginas con numeración romana: se busca el título en los preliminares
        const key = titleKey(it.title);
        const c = search(key, 0, Math.min(N - 1, globalOffset + 1), true).filter((x) => x.score >= 0.8);
        if (c.length) { it.page = c[0].page; confirmed++; } else { it.page = clamp(tocLast + 1, 1, N); it.uncertain = true; uncertain++; }
        continue;
      }
      const off = local(it.printed);
      const E = clamp(it.printed + (off !== null ? off : globalOffset), 1, N);
      const near = search(it.key, E - 6, E + 4, true).filter((x) => x.score >= 0.7)
        .sort((a, b) => (b.score - a.score) || (Math.abs(a.page - E) - Math.abs(b.page - E)))[0];
      const alt = !near && ctx && ctx.cands ? bestCandidate(ctx.cands, it, E) : null;
      if (near) { it.page = near.page; confirmed++; }
      else if (alt) { it.page = alt.page; confirmed++; }
      else { it.page = E; if (off === null) { it.uncertain = true; uncertain++; } }
      if (it.page < prev && !it.uncertain) { it.uncertain = true; uncertain++; }
      prev = Math.max(prev, it.page);
    }
    items.forEach((it) => {
      if (it.isPart) { it.page = it.nextRef && it.nextRef.page ? it.nextRef.page : null; }
    });

    let extras = [];
    if (ctx && ctx.cands) {
      const have = new Set(items.filter((i) => i.page).map((i) => i.page));
      extras = ctx.cands.filter((c) => c.score >= 5 && c.kind && !have.has(c.page) && !tocSet.has(c.page - 1)).slice(0, 5);
      if (extras.length) warnings.push('Encabezados que parecen títulos pero no figuran en el índice del libro (no se agregaron): ' + extras.map((c) => 'p. ' + c.page + ' «' + c.title.slice(0, 40) + '»').join('; ') + '.');
    }
    let entries = items.filter((i) => i.page).map((i) => mk(i.title, i.page, i.level || 1, 'indice', i.uncertain ? { uncertain: true } : {}));
    const hasToc = entries.some((e) => /^(indice|contenido|tabla de contenido|sumario|contents)/.test(norm(e.title)) && e.page >= tocFirst && e.page <= tocLast);
    if (!hasToc) entries.push(mk((tocTitle || 'Índice').replace(/\s+/g, ' ').trim(), tocFirst, 1, 'indice'));
    entries = entries.sort((a, b) => a.page - b.page);

    warnings.unshift('Índice del libro encontrado en las páginas ' + tocFirst + (tocLast !== tocFirst ? '–' + tocLast : '') + ' del PDF (' + numbered.length + ' entradas).');
    if (source !== 'estimado') warnings.push('Desfase detectado por ' + source + ': la página impresa 1 es la página ' + (1 + globalOffset) + ' del PDF (' + (globalOffset >= 0 ? '+' : '') + globalOffset + '). ' + confirmed + ' de ' + numbered.length + ' títulos confirmados en el texto.');
    if (uncertain) warnings.push(uncertain + ' entrada(s) no se pudieron confirmar y están marcadas con ⚠ para que las revises.');
    return { entries, warnings, info: { tocPages: [tocFirst, tocLast], offset: globalOffset, source, confirmed, total: numbered.length, uncertain, extras: extras.length } };
  }

  // ---------- Detección por consenso (regex + tipografía + estructura) ----------
  const BOLD_RE = /bold|black|heavy|semibold|demi|negrita|\.b$|-b$|,bold/i;
  const WORDNUM = { uno: 1, una: 1, primero: 1, primer: 1, one: 1, first: 1, dos: 2, segundo: 2, two: 2, second: 2, tres: 3, tercero: 3, tercer: 3, three: 3, third: 3, cuatro: 4, cuarto: 4, four: 4, fourth: 4, cinco: 5, quinto: 5, five: 5, fifth: 5, seis: 6, sexto: 6, six: 6, sixth: 6, siete: 7, septimo: 7, seven: 7, seventh: 7, ocho: 8, octavo: 8, eight: 8, eighth: 8, nueve: 9, noveno: 9, nine: 9, ninth: 9, diez: 10, decimo: 10, ten: 10, tenth: 10, once: 11, eleven: 11, doce: 12, twelve: 12, trece: 13, catorce: 14, quince: 15 };
  function romanToInt(s) { const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }; let t = 0; for (let i = 0; i < s.length; i++) { const a = v[s[i]], b = v[s[i + 1]] || 0; t += a < b ? -a : a; } return t; }
  function numValue(tok) {
    if (tok === undefined || tok === null) return null;
    const t = norm(String(tok));
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const u = String(tok).toUpperCase();
    if (/^[IVXLCDM]+$/.test(u) && isRoman(u)) return romanToInt(u);
    return WORDNUM[t] !== undefined ? WORDNUM[t] : null;
  }
  const isBold = (l) => BOLD_RE.test(l.font) || BOLD_RE.test(l.family);

  /** Umbral de «tamaño de título» calculado solo: el menor tamaño que identifica pocos títulos. */
  function autoRatio(pagesLines, bodySize, headers) {
    const counts = new Map();
    for (const lines of pagesLines) for (const l of lines) {
      const t = l.text;
      if (t.length < 3 || t.length > 120 || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3}/.test(t)) continue;
      if (l.y > l.pageHeight * 0.94 || l.y < l.pageHeight * 0.06 || isRunning(l, headers) || RE_LEADERS.test(t)) continue;
      if (l.size >= bodySize * 1.08) { const k = Math.round(l.size * 2) / 2; counts.set(k, (counts.get(k) || 0) + 1); }
    }
    const sizes = Array.from(counts.keys()).sort((a, b) => a - b);
    const cap = Math.max(8, pagesLines.length * 0.8);
    let chosen = null, strong = 0;
    for (let i = 0; i < sizes.length; i++) {
      let suffix = 0;
      for (let j = i; j < sizes.length; j++) suffix += counts.get(sizes[j]);
      if (suffix <= cap && sizes[i] >= bodySize * 1.12) { chosen = sizes[i]; strong = suffix; break; }
    }
    if (chosen === null) { chosen = sizes.length ? sizes[sizes.length - 1] : bodySize * 1.3; strong = sizes.length ? counts.get(chosen) : 0; }
    return { ratio: Math.max(1.1, (chosen - 0.3) / bodySize), strong };
  }

  /** Cálculos compartidos por todas las estrategias (una sola pasada por el documento). */
  function prepare(pages) {
    const pagesLines = pages.map(buildLines);
    const headers = findRunningHeaders(pagesLines, pages.length);
    const { bodySize, bodyFont } = bodyStats(pagesLines);
    const auto = bodySize ? autoRatio(pagesLines, bodySize, headers) : { ratio: 1.25, strong: 0 };
    const block = findTocBlock(pagesLines);
    const tocIdx = new Set();
    pagesLines.forEach((lines, i) => { if (looksLikeTocPage(lines)) tocIdx.add(i); });
    if (block) readTocBlock(pagesLines, block.pages).used.forEach((i) => tocIdx.add(i));
    let dotted = 0;
    const tops = new Set();
    pagesLines.forEach((lines, i) => {
      if (tocIdx.has(i)) return;
      for (const l of lines) {
        const m = l.text.match(RE_DECIMAL);
        if (m && l.text.length <= 80 && !RE_LEADERS.test(l.text)) { if (m[1].includes('.')) dotted++; tops.add(m[1].split('.')[0]); }
      }
    });
    return { N: pages.length, pagesLines, headers, bodySize, bodyFont, ratio: auto.ratio, strongCount: auto.strong, block, tocIdx, decimalOk: dotted >= 3 && tops.size >= 3 };
  }

  /** Rasgos de expresión regular de una línea (capítulo, parte, romano, palabra clave…). */
  function classifyLine(l, lines, i, decimalOk) {
    const t = l.text;
    if (/[,;]$/.test(t) || t.length > 90) return null;
    const sub = () => {
      const nx = lines[i + 1];
      return (nx && nx.text.length <= 80 && !/[.,;]$/.test(nx.text) && (l.y - nx.y) < Math.max(l.size, nx.size) * 3.6 && !RE_CHAPTER.test(nx.text) && !RE_PART.test(nx.text)) ? nx.text : '';
    };
    let m;
    if ((m = t.match(RE_PART))) {
      const rest = m[3] || sub();
      return { kind: 'part', title: m[1] + ' ' + m[2] + (rest ? ' — ' + rest : ''), level: 1, base: 2.5, num: numValue(m[2]) };
    }
    if ((m = t.match(RE_CHAPTER))) {
      const tail = m[3] || '';
      if (tail.length > 70) return null;
      if (/^[a-záéíóúñ]/.test(tail) && tail.split(' ').length > 3) return null; // frase corriente, no título
      const rest = tail || sub();
      return { kind: 'chapter', title: m[1].replace(/\.$/, '') + ' ' + m[2] + (rest ? ' — ' + rest : ''), level: 1, base: 2.5, num: numValue(m[2]) };
    }
    if ((m = t.match(RE_SECTION))) {
      const rest = m[3] || sub();
      return { kind: 'section', title: m[1] + ' ' + m[2] + (rest ? ' — ' + rest : ''), level: 2, base: 2, num: numValue(m[2]) };
    }
    if ((m = t.match(RE_ROMAN_ALONE)) && isRoman(m[1]) && (m[1].length > 1 || /^[IVX]$/.test(m[1]))) {
      const rest = sub();
      return { kind: 'roman', title: m[1] + (rest ? ' — ' + rest : ''), level: 1, base: 2, num: numValue(m[1]) };
    }
    if ((m = t.match(RE_ROMAN_TITLE)) && isRoman(m[1]) && !/[.]$/.test(m[2])) {
      return { kind: 'roman', title: m[1] + ' — ' + m[2], level: 1, base: 2, num: numValue(m[1]) };
    }
    if (KEYWORD_SET.has(norm(t.replace(/\s*\d+\s*$/, '')))) {
      return { kind: 'keyword', title: t.replace(/\s*\d+\s*$/, ''), level: 1, base: 2.5, num: null };
    }
    if (decimalOk && (m = t.match(RE_DECIMAL)) && !RE_LEADERS.test(t)) {
      return { kind: 'decimal', title: m[1] + ' ' + m[2], level: Math.min(3, m[1].split('.').length), base: 1.5, num: null };
    }
    return null;
  }

  /** Los capítulos numerados deben formar una secuencia creciente: descarta menciones sueltas. */
  function sequenceFilter(cands) {
    const ch = cands.filter((c) => c.kind === 'chapter' && c.num !== null && c.score >= 2.5)
      .sort((a, b) => (a.page - b.page) || (b.y - a.y));
    if (!ch.length) return;
    const best = ch.map((c) => c.score), prev = ch.map(() => -1);
    for (let i = 0; i < ch.length; i++) for (let j = 0; j < i; j++) {
      if (ch[j].num < ch[i].num && best[j] + ch[i].score > best[i]) { best[i] = best[j] + ch[i].score; prev[i] = j; }
    }
    let end = 0;
    for (let i = 1; i < ch.length; i++) if (best[i] > best[end]) end = i;
    const chain = new Set();
    for (let k = end; k >= 0; k = prev[k]) chain.add(ch[k]);
    if (chain.size >= 3) {
      ch.forEach((c) => { if (chain.has(c)) c.score += 1.5; else c.score -= 3; });
    } else {
      const seen = new Map();
      ch.forEach((c) => { const o = seen.get(c.num); if (!o) seen.set(c.num, c); else if (c.score > o.score) { o.score -= 3; seen.set(c.num, c); } else c.score -= 3; });
    }
  }

  /** Puntúa cada posible título con todas las señales a la vez; devuelve los de puntuación ≥ 2,5. */
  function collectCandidates(ctx) {
    const { pagesLines, headers, bodySize, ratio } = ctx;
    const cands = [];
    pagesLines.forEach((lines, pi) => {
      if (ctx.tocIdx.has(pi) || !lines.length) return;
      const gaps = [];
      for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
      gaps.sort((a, b) => a - b);
      const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : bodySize * 1.3;
      const blocks = [];
      lines.forEach((l, i) => {
        const strong = l.size >= bodySize * ratio;
        const last = blocks[blocks.length - 1];
        if (strong && last && last.strong && Math.abs(last.line.size - l.size) <= l.size * 0.04 && (last.lastY - l.y) < l.size * 2.2) {
          last.text = clean(last.text + ' ' + l.text); last.lastY = l.y; last.end = i;
        } else blocks.push({ line: l, text: l.text, strong, start: i, end: i, firstY: l.y, lastY: l.y });
      });
      for (const b of blocks) {
        const l = b.line, t = b.text, H = l.pageHeight;
        if (t.length < 2 || t.length > 120 || /^\d+$/.test(t) || RE_LEADERS.test(t) || isRunning(l, headers)) continue;
        if (l.y > H * 0.94 || l.y < H * 0.06) continue;
        const cls = classifyLine(Object.assign({}, l, { text: t }), lines, b.start, ctx.decimalOk);
        const bold = isBold(l) && l.size >= bodySize * 0.98 && t.length <= 70 && !/[.,;:]$/.test(t);
        const prevGap = b.start > 0 ? lines[b.start - 1].y - b.firstY : Infinity;
        const nextGap = b.end < lines.length - 1 ? b.lastY - lines[b.end + 1].y : Infinity;
        const isolated = prevGap > medGap * 1.4 && nextGap > medGap * 1.1;
        let score = cls ? cls.base : 0;
        if (b.strong) score += 2.5 + (l.size >= bodySize * ratio * 1.4 ? 0.5 : 0);
        if (bold) score += isolated ? 2 : 0.5;
        if (isolated) score += 1;
        if (l.y > H * 0.4) score += 0.5;
        if (/[,;]$/.test(t)) score -= 3;
        if (t.length > 90) score -= 2;
        if (/^[a-záéíóúñ]/.test(t) && !cls) score -= 2;
        if (l.size < bodySize * 0.9) score -= 2;
        if (score < 2.5) continue;
        cands.push({ page: pi + 1, y: l.y, size: l.size, title: cls ? cls.title : clean(t), kind: cls ? cls.kind : null, num: cls ? cls.num : null, kindLevel: cls ? cls.level : null, score, strong: b.strong, bold, regex: !!cls, line: l });
      }
    });
    sequenceFilter(cands);
    const kept = cands.filter((c) => c.score >= 2.5);
    kept.forEach((c) => { c.key = titleKey(c.title); });
    return kept;
  }

  /** Convierte los candidatos aceptados (≥ 3,5) en entradas, con niveles y sin duplicados. */
  function acceptCandidates(ctx, cands, o) {
    const acc = cands.filter((c) => c.score >= 3.5).sort((a, b) => (a.page - b.page) || (b.y - a.y));
    const out = [];
    const perPage = new Map();
    for (const c of acc.slice().sort((a, b) => b.score - a.score)) {
      const arr = perPage.get(c.page) || [];
      const nc = norm(c.title);
      if (arr.some((k) => { const nk = norm(k.title); return nk === nc || nk.includes(nc) || nc.includes(nk) || Math.abs(k.y - c.y) < c.size * 1.2; })) continue;
      if (arr.length >= 3) continue;
      arr.push(c); perPage.set(c.page, arr); out.push(c);
    }
    out.sort((a, b) => (a.page - b.page) || (b.y - a.y));
    // Niveles: el tipo de encabezado manda; el resto, por jerarquía de tamaños
    const hasParts = out.some((c) => c.kind === 'part');
    const sizes = Array.from(new Set(out.filter((c) => c.strong).map((c) => Math.round(c.size * 2) / 2))).sort((a, b) => b - a);
    const clusters = [];
    sizes.forEach((s) => { const c = clusters.find((x) => Math.abs(x.ref - s) / x.ref < 0.08); if (c) c.m.push(s); else clusters.push({ ref: s, m: [s] }); });
    const hasKinds = out.some((c) => c.kind === 'chapter' || c.kind === 'part' || c.kind === 'roman');
    const sizeLevel = (c) => {
      if (!c.strong) return Math.max(clusters.length + 1, hasKinds ? 2 : 1);
      return Math.max(1, clusters.findIndex((x) => x.m.includes(Math.round(c.size * 2) / 2)) + 1);
    };
    const res = out.map((c) => {
      let level;
      if (c.kind === 'part') level = 1;
      else if (c.kind === 'chapter' || c.kind === 'roman') level = hasParts ? 2 : 1;
      else if (c.kind === 'keyword') level = 1;
      else if (c.kind === 'section') level = hasParts ? 3 : 2;
      else if (c.kind === 'decimal') level = c.kindLevel;
      else level = sizeLevel(c) + (hasParts ? 1 : 0);
      level = clamp(level, 1, o.maxLevels);
      const both = c.regex && (c.strong || c.bold);
      const source = both ? 'consenso' : (c.regex ? 'regex' : 'tipografia');
      const unsure = c.score < 3.9 && !both;
      return mk(c.title, c.page, level, source, Object.assign({ y: c.y }, unsure ? { uncertain: true } : {}));
    });
    const used = Array.from(new Set(res.map((e) => e.level))).sort((a, b) => a - b);
    res.forEach((e) => { e.level = used.indexOf(e.level) + 1; }); // sin saltos de nivel
    return res;
  }

  /** Mejor encabezado detectado cerca de la página esperada (por número de capítulo o parecido). */
  function bestCandidate(cands, it, E) {
    const cm = it.title.match(RE_CHAPTER);
    const chNum = cm ? numValue(cm[2]) : null;
    let best = null, bs = 0;
    for (const c of cands) {
      if (c.page < E - 6 || c.page > E + 4) continue;
      let s = 0;
      if (chNum !== null && c.kind === 'chapter' && c.num === chNum) s = 1;
      else if (c.key && it.key) s = dice(c.key, it.key);
      s -= Math.abs(c.page - E) * 0.02;
      if (s > bs) { bs = s; best = c; }
    }
    return bs >= 0.6 ? best : null;
  }

  function analyze(pages, mode, opts) {
    const o = Object.assign({ startPage: 2, maxLevels: 3, skipTocPages: true }, opts || {});
    const totalChars = pages.reduce((s, p) => s + p.items.reduce((t, i) => t + i.str.length, 0), 0);
    const warnings = [];
    if (totalChars < Math.max(50, pages.length * 15)) {
      warnings.push('El PDF casi no contiene texto: probablemente es un escaneo. Pasa primero por la pestaña de OCR.');
      return { entries: [], warnings, totalChars, info: null };
    }
    const ctx = prepare(pages);
    ctx.cands = collectCandidates(ctx);
    ctx.headingSet = new Set(ctx.cands.map((c) => c.line));
    warnings.push('Tamaño del texto base ≈ ' + ctx.bodySize + ' pt; los títulos se reconocen desde ≈ ' + (Math.round(ctx.bodySize * ctx.ratio * 10) / 10) + ' pt (calculado automáticamente).');
    let entries = [], info = null;
    if (mode === 'auto') {
      const r = detectFromPrintedToc(pages, o, ctx);
      if (r) { entries = r.entries; info = r.info; warnings.push(...r.warnings); }
      else warnings.push('No se encontró un índice impreso utilizable; se detectan los títulos combinando regex, tipografía y estructura.');
    }
    if (!info) {
      if (mode === 'regex') { const r = detectRegex(pages, o); entries = r.entries; warnings.push(...r.warnings); }
      else if (mode === 'typo') { const r = detectTypographic(pages, o); entries = r.entries; warnings.push(...r.warnings); }
      else entries = acceptCandidates(ctx, ctx.cands, o);
      entries = entries.filter((e) => e.page >= o.startPage); // la portada no cuenta
      const unsure = entries.filter((e) => e.uncertain).length;
      if (unsure) warnings.push(unsure + ' título(s) con evidencia débil quedaron marcados con ⚠ para que los revises.');
    }
    entries.forEach((e) => { delete e.kind; });
    return { entries, warnings, totalChars, info, auto: { bodySize: ctx.bodySize, ratio: ctx.ratio } };
  }

  const api = { analyze, detectRegex, detectTypographic, detectFromPrintedToc, buildLines, isRoman, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TocAnalyzer = api;
})(typeof self !== 'undefined' ? self : this);
