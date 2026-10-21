import { html, useEffect, useRef, useState } from "../../vendor/preact-htm.js";
import { api } from "../lib/api.js";
import { ErrorNote, Spinner } from "./ui.js";

/** Finds `quote` in `text`, ignoring case, spacing and quote marks. Returns [start, end] or null. */
export function findQuote(text, quote) {
  const q = quote
    .trim()
    .replace(/[“”"…]/g, "")
    .trim();
  if (!q) return null;
  // Map normalised (lowercase, single-spaced) positions back to the original text
  const map = [];
  let norm = "";
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        norm += " ";
        map.push(i);
      }
      prevSpace = true;
    } else {
      norm += ch.toLowerCase();
      map.push(i);
      prevSpace = false;
    }
  }
  const nq = q.toLowerCase().replace(/\s+/g, " ");
  let idx = norm.indexOf(nq);
  let len = nq.length;
  if (idx < 0) {
    // fall back to the longest matching prefix of at least 6 words
    const words = nq.split(" ");
    for (let n = words.length - 1; n >= 6 && idx < 0; n--) {
      const part = words.slice(0, n).join(" ");
      idx = norm.indexOf(part);
      len = part.length;
    }
  }
  if (idx < 0) return null;
  return [map[idx], map[Math.min(idx + len - 1, map.length - 1)] + 1];
}

/** Shows `text` with the passage matching `quote` highlighted. */
export function HighlightedText({ text, quote, animate = false }) {
  const range = findQuote(text, quote);
  const cls = `marker ${animate ? "marker-animate" : ""}`;
  if (!range) {
    return html`<div class="whitespace-pre-line">
      ${quote && html`<p class="mb-3"><span class=${cls}>${quote}</span></p>`}
      ${text !== quote ? text : null}
    </div>`;
  }
  const [a, b] = range;
  return html`<div class="whitespace-pre-line">
    ${text.slice(0, a)}<mark class=${`${cls} bg-transparent text-inherit`}>${text.slice(a, b)}</mark>${text.slice(b)}
  </div>`;
}

/** Side panel with the slide/page a question came from. */
export function SourcePanel({ questionId, onClose }) {
  const [source, setSource] = useState(null);
  const [error, setError] = useState(null);
  const [imgFailed, setImgFailed] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api(`/api/questions/${questionId}/source`)
      .then((s) => !cancelled && setSource(s))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [questionId]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return html`<div class="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="source-title">
    <button class="absolute inset-0 bg-ink/30" aria-label="Close source" onClick=${onClose} tabindex="-1"></button>
    <aside class="relative flex h-full w-full max-w-xl flex-col bg-sheet shadow-2xl">
      <div class="flex items-start gap-3 border-b border-rule px-5 py-4">
        <div class="min-w-0 flex-1">
          <h2 id="source-title" class="text-xl">${source ? source.label : "Source"}</h2>
          ${source && html`<p class="truncate text-sm text-muted">${source.filename}</p>`}
        </div>
        <button ref=${closeRef} class="btn btn-ghost" onClick=${onClose}>Close</button>
      </div>
      <div class="flex-1 overflow-y-auto px-5 py-5">
        ${error && html`<${ErrorNote} message=${error} />`}
        ${!source && !error && html`<${Spinner} label="Opening the source" />`}
        ${source &&
        html`<div class="space-y-5">
          ${source.page_image_url &&
          !imgFailed &&
          html`<img
            src=${source.page_image_url}
            alt=${`${source.label} of ${source.filename}`}
            class="w-full rounded border border-rule"
            onError=${() => setImgFailed(true)}
          />`}
          <div>
            <h3 class="mb-2 font-sans text-sm font-semibold text-muted">
              ${source.full_page_available
                ? `Text on this ${source.unit ?? "page"}, with the passage the question uses`
                : "The passage the question uses"}
            </h3>
            <div class="font-serif text-[1.02rem] leading-relaxed">
              <${HighlightedText} text=${source.text} quote=${source.quote} animate />
            </div>
            ${!source.full_page_available &&
            html`<p class="mt-3 text-sm text-muted">
              The rest of ${source.filename || "the file"} stays on the device of the person who shared the quiz.
            </p>`}
          </div>
          ${source.file_url &&
          html`<a class="btn btn-secondary" href=${source.file_url} target="_blank" rel="noreferrer">
            Open ${source.filename}${source.file_type === "pdf" ? ` at ${source.label.toLowerCase()}` : ""}
          </a>`}
        </div>`}
      </div>
    </aside>
  </div>`;
}
