// Small text helpers shared by extraction, question writing and grading.

const ARTICLES = new Set(["a", "an", "the"]);

const BULLET = /^\s*(?:[•●▪◦–—*\->]+|\(?\d{1,2}[.)]|[a-z][.)])\s+/;
const SENT_SPLIT = /(?<=[.!?])["'”’)]?\s+(?=["'“(]?[A-Z0-9])/;
const TERMINAL = /[.!?:;]["'”’)]?$/;

export const isUpper = (ch) => !!ch && ch !== ch.toLowerCase() && ch === ch.toUpperCase();
export const isLower = (ch) => !!ch && ch !== ch.toUpperCase() && ch === ch.toLowerCase();
export const isDigit = (ch) => !!ch && /\d/.test(ch);

/** Lowercase, drop punctuation (but keep decimal points, % and -) and articles. Used to compare answers. */
export function normalizeAnswer(s) {
  s = String(s ?? "")
    .toLowerCase()
    .trim();
  s = s.replace(/[^\p{L}\p{N}_\s.%-]/gu, " ");
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, " ");
  return s
    .split(/\s+/)
    .filter((w) => w && !ARTICLES.has(w))
    .join(" ");
}

/** Tidy text from PDFs, slides and OCR: one space between words, at most one blank line. */
export function cleanText(text) {
  text = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "");
  text = text.replace(/(\w)-\n(\w)/g, "$1$2"); // words hyphenated across a line break
  const lines = text.split("\n").map((ln) => ln.replace(/[ \t ]+/g, " ").trim());
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Re-join lines that were hard-wrapped by PDF/OCR layout, keeping bullets and headings separate. */
export function paragraphs(text) {
  const out = [];
  let buf = "";
  for (const raw of String(text).split("\n")) {
    let line = raw.trim();
    if (!line) {
      if (buf) out.push(buf);
      buf = "";
      continue;
    }
    if (line.toLowerCase().startsWith("speaker notes:")) {
      line = line.slice(line.indexOf(":") + 1).trim();
      if (buf) out.push(buf);
      buf = "";
    }
    const bullet = BULLET.test(line);
    line = line.replace(BULLET, "");
    const first = line.slice(0, 1);
    if (buf && !bullet && !TERMINAL.test(buf) && (isLower(first) || isDigit(first) || buf.length >= 55)) {
      buf = `${buf} ${line}`;
    } else {
      if (buf) out.push(buf);
      buf = line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Split text into sentences. With completeOnly, drop fragments cut off at chunk edges. */
export function sentences(text, completeOnly = false) {
  const out = [];
  const paras = paragraphs(text);
  paras.forEach((para, pi) => {
    const parts = para
      .split(SENT_SPLIT)
      .map((p) => p.trim())
      .filter(Boolean);
    parts.forEach((s, si) => {
      if (completeOnly) {
        const c = s.slice(0, 1);
        if (!(isUpper(c) || isDigit(c) || `"'“(`.includes(c))) return; // starts mid-sentence (chunk overlap)
        const isLast = pi === paras.length - 1 && si === parts.length - 1;
        if (isLast && !TERMINAL.test(s)) return; // may be cut off at the end of the chunk
      }
      out.push(s);
    });
  });
  return out;
}

export function truncateWords(s, n) {
  const words = s.split(/\s+/);
  return words.length <= n ? s : words.slice(0, n).join(" ") + "…";
}

export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
