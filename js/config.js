/* config.js — Configuración global y versiones fijadas de las dependencias (CDN).
 * Las URLs de PDF.js del <script> en index.html deben coincidir con pdfjsMain.
 * Se usan scripts clásicos (no módulos) para que todo funcione con doble clic (file://). */
(function () {
  'use strict';

  window.APP_CONFIG = {
    CDN: {
      pdfjsMain: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
      pdfLib: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
      tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'
    },
    // Modelos de idioma de Tesseract (se descargan una vez y quedan en caché del navegador).
    TESSDATA: {
      balanced: 'https://tessdata.projectnaptha.com/4.0.0',
      fast: 'https://tessdata.projectnaptha.com/4.0.0_fast',
      best: 'https://tessdata.projectnaptha.com/4.0.0_best'
    },
    // Lectura binaria en fragmentos de 8 MiB (múltiplo de página de 64 bits).
    READ_CHUNK_BYTES: 8 * 1024 * 1024,
    // Lado mayor (px) al rasterizar una página para OCR.
    OCR_LONG_SIDE: 2600,
    LANGUAGES: [
      ['spa', 'Español', true], ['eng', 'Inglés', true], ['fra', 'Francés', true],
      ['deu', 'Alemán', true], ['ita', 'Italiano', true], ['por', 'Portugués', true],
      ['cat', 'Catalán'], ['glg', 'Gallego'], ['eus', 'Euskera'], ['nld', 'Neerlandés'],
      ['swe', 'Sueco'], ['dan', 'Danés'], ['nor', 'Noruego'], ['fin', 'Finés'],
      ['isl', 'Islandés'], ['pol', 'Polaco'], ['ces', 'Checo'], ['slk', 'Eslovaco'],
      ['hun', 'Húngaro'], ['ron', 'Rumano'], ['hrv', 'Croata'], ['slv', 'Esloveno'],
      ['lav', 'Letón'], ['lit', 'Lituano'], ['est', 'Estonio'], ['sqi', 'Albanés'],
      ['tur', 'Turco'], ['ind', 'Indonesio'], ['msa', 'Malayo'], ['afr', 'Afrikáans'],
      ['lat', 'Latín'], ['epo', 'Esperanto'], ['mlt', 'Maltés']
    ]
  };
})();
