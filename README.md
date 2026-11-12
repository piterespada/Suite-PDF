# Suite-PDF

App web de una sola página que corre **100 % en tu navegador** (sin servidor, sin claves, sin subir nada). Funciona en Windows y Linux con cualquier navegador moderno. Pensada para preparar libros de Archive.org para leerlos en un Kobo.

## Qué hace

**1. Motor OCR**: convierte un PDF escaneado en un PDF con texto seleccionable. La imagen original no se toca: solo se añade una capa de texto invisible.
- Elimina sombras del lomo, normaliza el contraste y binariza de forma adaptativa antes del OCR.
- Idiomas de alfabeto latino (español, inglés, francés, alemán, italiano, portugués y más), solos o combinados.
- Procesa por lotes, con barra de progreso por etapas, cancelación y verificación del resultado.

**2. Índice y marcadores**: escribe marcadores nativos en un PDF que ya tiene texto, sin alterar imágenes ni maquetación.
- Lee primero el índice impreso del propio libro y calcula solo el desfase entre la página impresa y la página real del PDF (portada y preliminares).
- Confirma cada entrada buscando su título en el libro y combina regex, análisis tipográfico y estructura; el tamaño de letra de los títulos se detecta automáticamente.
- Tabla editable (título, nivel, página, eliminar), vista previa de cada página, botón para desplazar todas las páginas y marca ⚠ en lo que no se pudo confirmar.

## Cómo usarla

**En línea, sin descargar nada:** abre <https://piterespada.github.io/Suite-PDF/> en Chrome, Edge o Firefox. Las librerías (PDF.js, pdf-lib, Tesseract.js) las carga tu navegador solo y las guarda en caché; tus PDFs nunca salen de tu equipo.

**Sin conexión:** descarga el repositorio y abre `index.html` con doble clic, o sírvelo con `python3 -m http.server` y abre http://localhost:8000.

La primera vez se descargan las librerías y el modelo del idioma del OCR; después quedan en la caché del navegador.

### Publicar tu propia copia en GitHub Pages
En tu repositorio: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**. En un minuto queda disponible en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.

## Estructura

| Archivo | Función |
|---|---|
| `index.html` | Interfaz con las dos pestañas y la consola de estado |
| `css/styles.css` | Estilos, modo claro/oscuro automático |
| `js/config.js` | Versiones fijadas de las dependencias y lista de idiomas |
| `js/pdf-loader.js` | Lectura por fragmentos, renderizado y extracción de texto con PDF.js |
| `js/ocr.worker.js` | Worker: filtros de imagen, Tesseract.js y capa de texto invisible con pdf-lib |
| `js/toc-analyzer.js` | Índice impreso, desfase de páginas y detección de títulos |
| `js/toc.worker.js` | Worker: inyección de marcadores con pdf-lib y verificación |
| `js/ui.js` | Controladores, progreso, tabla editable, descargas y limpieza de memoria |

## Notas y límites

- La capa de texto usa Helvetica (Latin-1): letras como ł, č u ő se simplifican a su letra base.
- Si el libro no tiene índice y sus títulos son del mismo tamaño que el texto y sin negrita, la detección automática puede omitir entradas.
- Los workers se crean desde `Blob` para que todo funcione con doble clic (`file://`).

## Licencia

MIT. Ver [LICENSE](LICENSE).
