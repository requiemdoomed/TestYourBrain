// Text extraction from PDF, PowerPoint, Word, plain-text and image files, in the browser.
//
// Every extractor returns { unit, segments, ocr_count } with one segment per page / slide / section,
// so each piece of text keeps a pointer back to where it came from:
//   segment = { location: 1-based number, label: "Slide 4", text, title, ocr }
//
// PDF pages are read with pdf.js, PowerPoint and Word files are unzipped with JSZip and their XML read
// directly, and pages or slides without text go through Tesseract OCR (all bundled in /vendor).

import { cleanText } from "./text.js";
import { decodeText, ExtractionError, extractPlainText, finishExtraction } from "./extract-text.js";

export { detectFileType, ExtractionError, SUPPORTED_EXTENSIONS } from "./extract-text.js";

const OCR_MIN_CHARS = 40; // pages with less extractable text than this get OCR'd
const vendor = (path) => new URL(`../../vendor/${path}`, import.meta.url).href;

// ------------------------------------------------------------------ loading the bundled libraries

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.onload = resolve;
        el.onerror = () => {
          scripts.delete(src);
          reject(new Error(`Could not load ${src.split("/").pop()}.`));
        };
        document.head.append(el);
      }),
    );
  }
  return scripts.get(src);
}

let pdfjsPromise = null;
async function pdfjs() {
  pdfjsPromise ??= import(vendor("pdfjs/pdf.min.mjs")).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = vendor("pdfjs/pdf.worker.min.mjs");
    return lib;
  });
  return pdfjsPromise;
}

async function jszip() {
  await loadScript(vendor("jszip.min.js"));
  return window.JSZip;
}

// ------------------------------------------------------------------ OCR

let ocrWorker = null;
let ocrIdle = null;

async function getOcrWorker() {
  clearTimeout(ocrIdle);
  if (!ocrWorker) {
    ocrWorker = (async () => {
      await loadScript(vendor("tesseract/tesseract.min.js"));
      return window.Tesseract.createWorker("eng", 1, {
        workerPath: vendor("tesseract/worker.min.js"),
        corePath: vendor("tesseract/core"),
        langPath: vendor("tesseract/lang"),
      });
    })().catch((err) => {
      ocrWorker = null;
      throw err;
    });
  }
  return ocrWorker;
}

function releaseOcrSoon() {
  clearTimeout(ocrIdle);
  ocrIdle = setTimeout(async () => {
    const w = ocrWorker;
    ocrWorker = null;
    if (w) (await w).terminate().catch(() => {});
  }, 60000);
}

/** Read the text in an image (canvas, ImageBitmap, Blob or bytes). Returns "" when OCR is off or fails. */
async function ocrImage(image, options) {
  if (!options.ocr) return "";
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(image);
    return data.text ?? "";
  } catch (err) {
    console.warn("OCR failed:", err);
    if (options.ocrRequired) throw new ExtractionError(`OCR failed: ${err.message ?? err}`);
    return "";
  } finally {
    releaseOcrSoon();
  }
}

/** Decode common image formats to a canvas (Tesseract reads TIFF itself). */
async function imageSource(blob, type = "") {
  if (/tiff?$/i.test(type)) return new Uint8Array(await blob.arrayBuffer());
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return canvas;
  } catch {
    return new Uint8Array(await blob.arrayBuffer());
  }
}

// ------------------------------------------------------------------ PDF

async function openPdf(bytes) {
  const lib = await pdfjs();
  try {
    return await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  } catch (err) {
    if (err?.name === "PasswordException") throw new ExtractionError("This PDF is password-protected.");
    throw new ExtractionError(`Could not open PDF: ${err?.message ?? err}`);
  }
}

/** Lay out pdf.js text items as lines (top to bottom, left to right) and guess the page heading. */
function layoutPage(items, pageHeight) {
  const lines = [];
  for (const it of items) {
    if (typeof it.str !== "string" || !it.str.trim()) continue;
    const [, , c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || it.height || 10;
    let line = lines.find((l) => Math.abs(l.y - y) < Math.max(2, size * 0.45));
    if (!line) {
      line = { y, size, items: [] };
      lines.push(line);
    }
    line.size = Math.max(line.size, size);
    line.items.push({ x, str: it.str, width: it.width ?? 0, size });
  }
  lines.sort((a, b) => b.y - a.y);
  const textLines = [];
  let title = null;
  let titleSize = 0;
  let prev = null;
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = "";
    let end = null;
    for (const it of line.items) {
      if (end !== null && it.x - end > it.size * 0.15 && !text.endsWith(" ") && !it.str.startsWith(" ")) text += " ";
      text += it.str;
      end = it.x + it.width;
    }
    text = text.trim();
    if (prev && prev.y - line.y > Math.max(prev.size, line.size) * 1.9) textLines.push(""); // a gap: new block
    textLines.push(text);
    prev = line;
    // Prefer big text in the top 40% of the page
    if (text.length >= 3 && text.length <= 120 && pageHeight - line.y <= pageHeight * 0.4) {
      if (title === null || line.size > titleSize + 0.5) [title, titleSize] = [text, line.size];
    }
  }
  return { text: textLines.join("\n"), title };
}

async function renderPdfPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function extractPdf(bytes, options) {
  const doc = await openPdf(bytes);
  const result = { unit: "page", segments: [], ocr_count: 0 };
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      options.onStatus?.(`Reading page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      const { height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const laid = layoutPage(content.items, height);
      let text = cleanText(laid.text);
      let title = laid.title;
      let usedOcr = false;
      if (text.length < OCR_MIN_CHARS && options.ocr) {
        options.onStatus?.(`Reading page ${i} of ${doc.numPages} with OCR`);
        const canvas = await renderPdfPageToCanvas(page, 2.5);
        const ocrText = cleanText(await ocrImage(canvas, options));
        if (ocrText.length > text.length) {
          [text, usedOcr] = [ocrText, true];
          result.ocr_count += 1;
          title = text.split("\n", 1)[0].slice(0, 120) || null;
        }
      }
      result.segments.push({ location: i, label: `Page ${i}`, text, title, ocr: usedOcr });
      page.cleanup();
    }
  } finally {
    doc.destroy();
  }
  return result;
}

// ------------------------------------------------------------------ Office files (shared XML helpers)

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
};

const parseXml = (s) => new DOMParser().parseFromString(s, "application/xml");
const kids = (el, ns, name) => [...el.children].filter((c) => c.namespaceURI === NS[ns] && c.localName === name);
const kid = (el, ns, name) => kids(el, ns, name)[0] ?? null;
const all = (el, ns, name) => [...el.getElementsByTagNameNS(NS[ns], name)];

function resolvePath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Relationships of a part: id -> { type, path } */
async function relationships(zip, partPath) {
  const dir = partPath.split("/").slice(0, -1).join("/");
  const name = partPath.split("/").pop();
  const file = zip.file(`${dir ? dir + "/" : ""}_rels/${name}.rels`);
  const map = new Map();
  if (!file) return map;
  const xml = parseXml(await file.async("string"));
  for (const rel of xml.getElementsByTagName("Relationship")) {
    if (rel.getAttribute("TargetMode") === "External") continue;
    map.set(rel.getAttribute("Id"), {
      type: rel.getAttribute("Type") ?? "",
      path: resolvePath(partPath, rel.getAttribute("Target") ?? ""),
    });
  }
  return map;
}

async function openZip(bytes, what) {
  const JSZip = await jszip();
  try {
    return await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new ExtractionError(`Could not open ${what}: ${err?.message ?? err}`);
  }
}

// ------------------------------------------------------------------ PPTX

/** Text of a DrawingML text body: one line per paragraph. */
function drawingText(txBody) {
  return kids(txBody, "a", "p")
    .map((p) => {
      let s = "";
      for (const node of p.getElementsByTagName("*")) {
        if (node.namespaceURI !== NS.a) continue;
        if (node.localName === "t") s += node.textContent;
        else if (node.localName === "br") s += "\n";
      }
      return s;
    })
    .filter((t) => t.trim())
    .join("\n");
}

function* shapeTexts(container, pictures) {
  for (const shape of container.children) {
    const name = shape.localName;
    if (name === "grpSp") {
      yield* shapeTexts(shape, pictures);
    } else if (name === "sp") {
      const body = kid(shape, "p", "txBody");
      if (body) {
        const txt = drawingText(body);
        if (txt.trim()) yield txt;
      }
    } else if (name === "graphicFrame") {
      for (const row of all(shape, "a", "tr")) {
        const cells = all(row, "a", "tc")
          .map((tc) => {
            const body = kid(tc, "a", "txBody");
            return body ? drawingText(body).trim() : "";
          })
          .filter(Boolean);
        if (cells.length) yield cells.join(" | ");
      }
    } else if (name === "pic") {
      const blip = all(shape, "a", "blip")[0];
      const id = blip?.getAttributeNS(NS.r, "embed");
      if (id) pictures.push(id);
    }
  }
}

function placeholder(sp) {
  const nvPr = all(sp, "p", "nvPr")[0];
  return nvPr ? kid(nvPr, "p", "ph") : null;
}

async function extractPptx(bytes, options) {
  const zip = await openZip(bytes, "PowerPoint file");
  const presPath = "ppt/presentation.xml";
  if (!zip.file(presPath)) throw new ExtractionError("Could not open PowerPoint file: it has no slides part.");
  const pres = parseXml(await zip.file(presPath).async("string"));
  const presRels = await relationships(zip, presPath);
  const slidePaths = all(pres, "p", "sldId")
    .map((s) => presRels.get(s.getAttributeNS(NS.r, "id"))?.path)
    .filter((p) => p && zip.file(p));

  const result = { unit: "slide", segments: [], ocr_count: 0 };
  for (let i = 0; i < slidePaths.length; i++) {
    const loc = i + 1;
    options.onStatus?.(`Reading slide ${loc} of ${slidePaths.length}`);
    const path = slidePaths[i];
    const xml = parseXml(await zip.file(path).async("string"));
    const rels = await relationships(zip, path);
    const tree = all(xml, "p", "spTree")[0];
    if (!tree) continue;

    // The title is the placeholder with index 0 (python-pptx's slide.shapes.title)
    let title = null;
    for (const sp of all(tree, "p", "sp")) {
      const ph = placeholder(sp);
      if (ph && (!ph.getAttribute("idx") || ph.getAttribute("idx") === "0")) {
        const body = kid(sp, "p", "txBody");
        title = body ? drawingText(body).trim() || null : null;
        break;
      }
    }
    const pictures = [];
    let text = cleanText([...shapeTexts(tree, pictures)].join("\n"));

    let notes = "";
    const notesRel = [...rels.values()].find((r) => r.type.endsWith("/notesSlide"));
    if (notesRel && zip.file(notesRel.path)) {
      const nx = parseXml(await zip.file(notesRel.path).async("string"));
      for (const sp of all(nx, "p", "sp")) {
        if (placeholder(sp)?.getAttribute("type") === "body") {
          const body = kid(sp, "p", "txBody");
          notes = body ? drawingText(body).trim() : "";
          break;
        }
      }
    }

    let usedOcr = false;
    // Slides that are mostly pictures (e.g. scanned handouts) get OCR'd
    if (text.length < OCR_MIN_CHARS && pictures.length && options.ocr) {
      options.onStatus?.(`Reading slide ${loc} of ${slidePaths.length} with OCR`);
      const parts = [];
      for (const id of pictures) {
        const media = rels.get(id);
        const file = media && zip.file(media.path);
        if (!file) continue;
        const blob = new Blob([await file.async("uint8array")]);
        parts.push(await ocrImage(await imageSource(blob, media.path), options));
      }
      const ocrText = cleanText(parts.join("\n"));
      if (ocrText) {
        text = cleanText(`${text}\n${ocrText}`);
        usedOcr = true;
        result.ocr_count += 1;
      }
    }
    if (notes) text = cleanText(`${text}\n\nSpeaker notes: ${notes}`);
    result.segments.push({ location: loc, label: `Slide ${loc}`, text, title, ocr: usedOcr });
  }
  return result;
}

// ------------------------------------------------------------------ DOCX

function wordParagraphText(p) {
  let s = "";
  for (const node of p.getElementsByTagNameNS(NS.w, "*")) {
    if (node.localName === "t") s += node.textContent;
    else if (node.localName === "tab") s += "\t";
    else if ((node.localName === "br" && node.getAttributeNS(NS.w, "type") !== "page") || node.localName === "cr") {
      s += "\n";
    }
  }
  return s;
}

function pageBreaks(p) {
  let n = 0;
  for (const node of p.getElementsByTagNameNS(NS.w, "*")) {
    if (node.localName === "br" && node.getAttributeNS(NS.w, "type") === "page") n++;
    else if (node.localName === "lastRenderedPageBreak") n++;
  }
  return n;
}

async function extractDocx(bytes, options) {
  const zip = await openZip(bytes, "Word document");
  const docPath = "word/document.xml";
  if (!zip.file(docPath)) throw new ExtractionError("Could not open Word document: it has no document part.");
  const xml = parseXml(await zip.file(docPath).async("string"));
  const styleNames = new Map();
  if (zip.file("word/styles.xml")) {
    const styles = parseXml(await zip.file("word/styles.xml").async("string"));
    for (const st of all(styles, "w", "style")) {
      const name = kid(st, "w", "name")?.getAttributeNS(NS.w, "val");
      styleNames.set(st.getAttributeNS(NS.w, "styleId"), name ?? "");
    }
  }
  const body = all(xml, "w", "body")[0];
  if (!body) throw new ExtractionError("Could not open Word document: it has no body.");

  // Walk the body in order (paragraphs and tables interleaved): [text, isHeading, pageBreaksBefore]
  const blocks = [];
  for (const child of body.children) {
    if (child.localName === "p") {
      const styleId = all(child, "w", "pStyle")[0]?.getAttributeNS(NS.w, "val") ?? "";
      const style = (styleNames.get(styleId) ?? styleId).toLowerCase();
      blocks.push([wordParagraphText(child).trim(), /^(heading|title)/.test(style), pageBreaks(child)]);
    } else if (child.localName === "tbl") {
      const rows = [];
      for (const tr of kids(child, "w", "tr")) {
        const cells = [];
        for (const tc of kids(tr, "w", "tc")) {
          const ct = kids(tc, "w", "p")
            .map(wordParagraphText)
            .join("\n")
            .trim();
          if (ct && cells[cells.length - 1] !== ct) cells.push(ct);
        }
        if (cells.length) rows.push(cells.join(" | "));
      }
      blocks.push([rows.join("\n"), false, 0]);
    }
  }

  const hasPages = blocks.some((b) => b[2]);
  const result = { unit: hasPages ? "page" : "section", segments: [], ocr_count: 0 };
  let segments = [];
  let current = [];
  let currentTitle = null;
  let loc = 1;
  const flush = () => {
    const text = cleanText(current.join("\n"));
    if (text) {
      const n = hasPages ? loc : segments.length + 1;
      segments.push({ location: n, label: `${hasPages ? "Page" : "Section"} ${n}`, text, title: currentTitle, ocr: false });
    }
    current = [];
  };
  for (const [text, heading, breaks] of blocks) {
    if (hasPages && breaks) {
      flush();
      loc += breaks;
    }
    if (!hasPages && heading && current.length) flush();
    if (heading && text) currentTitle = text;
    if (text) current.push(text);
  }
  flush();

  // Scanned documents: Word files that are just pictures of pages
  const totalChars = segments.reduce((n, s) => n + s.text.length, 0);
  if (totalChars < OCR_MIN_CHARS && options.ocr) {
    const rels = await relationships(zip, docPath);
    const texts = [];
    const images = [...rels.values()].filter((r) => r.type.endsWith("/image"));
    for (const [i, r] of images.entries()) {
      const file = zip.file(r.path);
      if (!file) continue;
      options.onStatus?.(`Reading image ${i + 1} of ${images.length} with OCR`);
      const blob = new Blob([await file.async("uint8array")]);
      const t = cleanText(await ocrImage(await imageSource(blob, r.path), options));
      if (t) texts.push(t);
    }
    if (texts.length) {
      result.unit = "page";
      segments = texts.map((t, i) => ({
        location: i + 1,
        label: `Page ${i + 1}`,
        text: t,
        title: t.split("\n", 1)[0].slice(0, 120),
        ocr: true,
      }));
      result.ocr_count = texts.length;
    }
  }
  result.segments = segments;
  return result;
}

// ------------------------------------------------------------------ images

async function extractImage(blob, filename, options) {
  if (!options.ocr) throw new ExtractionError("Image files need OCR, which is switched off in Settings.");
  options.onStatus?.("Reading the image with OCR (the first time loads the OCR engine)");
  const text = cleanText(await ocrImage(await imageSource(blob, filename), { ...options, ocrRequired: true }));
  return {
    unit: "page",
    ocr_count: 1,
    segments: [{ location: 1, label: "Page 1", text, title: text.split("\n", 1)[0].slice(0, 120) || null, ocr: true }],
  };
}

// ------------------------------------------------------------------ dispatcher

/**
 * @param {Blob} blob   the uploaded file
 * @param {string} fileType  pdf | pptx | docx | txt | md | image
 * @param {{ ocr?: boolean, onStatus?: (s: string) => void, filename?: string }} options
 */
export async function extract(blob, fileType, options = {}) {
  const opts = { ocr: true, ...options };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let result;
  if (fileType === "pdf") result = await extractPdf(bytes, opts);
  else if (fileType === "pptx") result = await extractPptx(bytes, opts);
  else if (fileType === "docx") result = await extractDocx(bytes, opts);
  else if (fileType === "txt" || fileType === "md") result = extractPlainText(decodeText(bytes));
  else if (fileType === "image") result = await extractImage(blob, opts.filename ?? "", opts);
  else throw new ExtractionError(`Unsupported file type: ${fileType}`);
  return finishExtraction(result);
}

// ------------------------------------------------------------------ page previews

const previewCache = new Map();

/** A URL for an image of one page of a PDF (or the image itself), for the source panel. */
export async function pagePreviewUrl(cacheKey, blob, fileType, page) {
  const key = `${cacheKey}:${page}`;
  if (previewCache.has(key)) return previewCache.get(key);
  let url = null;
  if (fileType === "image") {
    url = URL.createObjectURL(blob);
  } else if (fileType === "pdf") {
    const doc = await openPdf(new Uint8Array(await blob.arrayBuffer()));
    try {
      if (page < 1 || page > doc.numPages) return null;
      const canvas = await renderPdfPageToCanvas(await doc.getPage(page), 1.6);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      url = png ? URL.createObjectURL(png) : null;
    } finally {
      doc.destroy();
    }
  }
  if (url) previewCache.set(key, url);
  return url;
}
