// Plain text / Markdown reading and the clean-up rules shared by every file type.
// (No browser APIs here, so the Node tests can use it directly.)

import { cleanText } from "./text.js";

export const SUPPORTED_EXTENSIONS = {
  ".pdf": "pdf",
  ".pptx": "pptx",
  ".docx": "docx",
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".tif": "image",
  ".tiff": "image",
  ".webp": "image",
};

export class ExtractionError extends Error {}

export function detectFileType(filename) {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? null : (SUPPORTED_EXTENSIONS[filename.slice(dot).toLowerCase()] ?? null);
}

/** Decode bytes as UTF-8 (with or without BOM), UTF-16 (with BOM) or, failing that, Windows-1252. */
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** One segment per Markdown heading; very long heading-less stretches are cut on blank lines. */
export function extractPlainText(content) {
  content = content.replace(/\r\n/g, "\n");
  const sections = [[null, []]];
  for (const line of content.split("\n")) {
    const m = MD_HEADING.exec(line);
    if (m) sections.push([m[2].trim(), [line.replace(/^#+/, "").trim()]]);
    else sections[sections.length - 1][1].push(line);
  }
  const final = [];
  for (const [title, lines] of sections) {
    const text = cleanText(lines.join("\n"));
    if (!text) continue;
    if (text.length <= 3500) {
      final.push([title, text]);
      continue;
    }
    let buf = "";
    for (const para of text.split(/\n\s*\n/)) {
      if (buf && buf.length + para.length > 2500) {
        final.push([title, buf.trim()]);
        buf = "";
      }
      buf += para + "\n\n";
    }
    if (buf.trim()) final.push([title, buf.trim()]);
  }
  return {
    unit: "section",
    ocr_count: 0,
    segments: final.map(([title, text], i) => ({ location: i + 1, label: `Section ${i + 1}`, text, title, ocr: false })),
  };
}

/** Drop empty segments and fold heading-only sections (e.g. a document title) into the next one. */
export function finishExtraction(result) {
  result.segments = result.segments.filter((sg) => sg.text.trim());
  if (result.unit === "section") {
    const merged = [];
    let carry = "";
    for (const sg of result.segments) {
      if (sg.text.length < 60 && !sg.text.includes("\n")) {
        carry = `${carry}\n${sg.text}`.trim();
        continue;
      }
      if (carry) {
        sg.text = `${carry}\n${sg.text}`;
        carry = "";
      }
      merged.push(sg);
    }
    if (carry) {
      if (merged.length) merged[merged.length - 1].text += `\n${carry}`;
      else merged.push({ location: 1, label: "Section 1", text: carry, title: null, ocr: false });
    }
    merged.forEach((sg, i) => {
      sg.location = i + 1;
      sg.label = `Section ${i + 1}`;
    });
    result.segments = merged;
  }
  if (!result.segments.length) {
    throw new ExtractionError(
      "No readable text was found in this file. If it is a scan, make sure OCR is switched on in Settings.",
    );
  }
  return result;
}
