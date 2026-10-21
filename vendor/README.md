# Bundled libraries

These files are copied unchanged from their npm packages, so the site works on GitHub Pages without
depending on outside CDNs. Each keeps its own licence.

| File | Package | Version | Licence |
| --- | --- | --- | --- |
| `preact-htm.js` | [htm](https://github.com/developit/htm) (`htm/preact/standalone`, includes [Preact](https://preactjs.com)) | 3.1.1 | MIT |
| `pdfjs/` | [pdfjs-dist](https://github.com/mozilla/pdf.js) (legacy build) | 4.10.38 | Apache-2.0 |
| `jszip.min.js` | [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | MIT or GPLv3 |
| `tesseract/tesseract.min.js`, `tesseract/worker.min.js` | [Tesseract.js](https://github.com/naptha/tesseract.js) | 5.1.1 | Apache-2.0 |
| `tesseract/core/` | [tesseract.js-core](https://github.com/naptha/tesseract.js-core) (LSTM builds) | 5.1.1 | Apache-2.0 |
| `tesseract/lang/eng.traineddata.gz` | [@tesseract.js-data/eng](https://github.com/naptha/tessdata) (`4.0.0_best_int`) | 1.0.0 | Apache-2.0 |

Fonts in `assets/fonts/`: [Literata](https://github.com/googlefonts/literata) and
[Public Sans](https://github.com/uswds/public-sans), both under the SIL Open Font License 1.1, from the
`@fontsource-variable` packages.

The embedding model is not bundled: when it is switched on, [Transformers.js](https://github.com/huggingface/transformers.js)
3.7.6 is loaded from jsDelivr and the [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
model (Apache-2.0) from Hugging Face the first time, then cached by the browser.
