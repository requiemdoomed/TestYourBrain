import { html, useMemo, useState } from "../../vendor/preact-htm.js";
import { ErrorNote, Page, RequireAuth, Spinner } from "../components/ui.js";
import { api, formatBytes, unitWord } from "../lib/api.js";
import { useApi, useTitle } from "../lib/hooks.js";
import { Link } from "../lib/router.js";

export function DocumentPage({ id }) {
  return html`<${RequireAuth}><${DocumentInner} id=${id} /><//>`;
}

function rangeLabel(unit, t) {
  const word = unit === "slide" ? "Slide" : unit === "section" ? "Section" : "Page";
  return t.start_location === t.end_location ? `${word} ${t.start_location}` : `${word}s ${t.start_location}–${t.end_location}`;
}

function DocumentInner({ id }) {
  const { data: doc, error, reload } = useApi(`/api/documents/${id}`, {
    poll: 1000,
    shouldPoll: (d) => d.status === "processing",
  });
  const [showText, setShowText] = useState(false);
  const [preview, setPreview] = useState(null);
  useTitle(doc?.filename ?? "Document");

  const pages = useMemo(() => {
    const map = new Map();
    for (const c of doc?.chunks ?? []) {
      const p = map.get(c.location) ?? { label: c.location_label, text: [], ocr: c.ocr };
      p.text.push(c.text);
      map.set(c.location, p);
    }
    return [...map.entries()];
  }, [doc]);

  async function openPreview(page) {
    setPreview({ page, url: null, error: null });
    try {
      const { url } = await api(`/api/documents/${id}/pages/${page}`);
      setPreview({ page, url, error: null });
    } catch (e) {
      setPreview({ page, url: null, error: e.message });
    }
  }

  async function openOriginal() {
    const { url } = await api(`/api/documents/${id}/file`);
    const a = document.createElement("a");
    a.href = url;
    // Browsers can show PDFs, images and text; Office files are downloaded
    if (["pdf", "image", "txt", "md"].includes(doc.file_type)) a.target = "_blank";
    else a.download = doc.filename;
    a.rel = "noopener";
    a.click();
  }

  if (error) return html`<${Page}><${ErrorNote} message=${error} onRetry=${reload} /><//>`;
  if (!doc) return html`<${Page}><${Spinner} /><//>`;

  return html`<${Page}>
    <${Link} href="/library" class="link text-sm">Back to library<//>
    <div class="mt-3 flex flex-wrap items-end justify-between gap-4">
      <div class="min-w-0">
        <h1 class="text-3xl break-words">${doc.filename}</h1>
        <p class="mt-1 text-muted">
          ${unitWord(doc.unit, doc.page_count)}, ${doc.word_count.toLocaleString()} words, ${formatBytes(doc.size_bytes)}
          ${doc.ocr_pages > 0 && `, ${doc.ocr_pages} ${doc.unit}${doc.ocr_pages === 1 ? "" : "s"} read with OCR`}
        </p>
        ${doc.embedding && html`<p class="mt-1 text-sm text-muted">Embeddings: ${doc.embedding}</p>`}
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-ghost" onClick=${openOriginal}>Open original</button>
        ${doc.status === "ready" &&
        html`<${Link} href=${`/quizzes/new?doc=${doc.id}`} class="btn btn-primary">Make a quiz from this file<//>`}
      </div>
    </div>

    ${doc.status === "processing" &&
    html`<p class="mt-6 text-muted">${doc.status_note || "Still reading this file"}… Topics will appear in a moment.</p>`}
    ${doc.status === "failed" && html`<div class="mt-6"><${ErrorNote} message=${doc.error ?? "Processing failed."} /></div>`}

    ${doc.topics.length > 0 &&
    html`<section class="mt-10" aria-labelledby="topics-h">
      <h2 id="topics-h" class="text-2xl">Topics found in this file</h2>
      <p class="mt-1 text-muted">Quiz yourself on one topic, or on the whole file.</p>
      <ol class="sheet ruled mt-5">
        ${doc.topics.map(
          (t, i) => html`<li key=${t.id} class="grid gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]">
            <span class="font-serif text-2xl font-semibold text-rule-strong">${i + 1}</span>
            <div class="min-w-0">
              <h3 class="text-lg">${t.name}</h3>
              <p class="text-sm text-muted">
                ${doc.has_preview
                  ? html`<button class="link" onClick=${() => openPreview(t.start_location)}>${rangeLabel(doc.unit, t)}</button>`
                  : rangeLabel(doc.unit, t)}
              </p>
              ${t.summary && html`<p class="mt-1.5 max-w-[68ch]">${t.summary}</p>`}
              ${t.keywords.length > 0 && html`<p class="mt-2 text-sm text-muted">Key terms: ${t.keywords.join(", ")}</p>`}
            </div>
            <div class="sm:self-center">
              <${Link} href=${`/quizzes/new?doc=${doc.id}&topic=${t.id}`} class="btn btn-secondary">Quiz this topic<//>
            </div>
          </li>`,
        )}
      </ol>
    </section>`}

    ${pages.length > 0 &&
    html`<section class="mt-10">
      <button class="btn btn-ghost -ml-3" aria-expanded=${showText} onClick=${() => setShowText((s) => !s)}>
        ${showText ? "Hide extracted text" : `Show extracted text (${pages.length} ${doc.unit}s)`}
      </button>
      ${showText &&
      html`<div class="sheet ruled mt-3">
        ${pages.map(
          ([loc, p]) => html`<div key=${loc} class="px-5 py-4">
            <p class="mb-1 text-sm font-semibold text-muted">${p.label}${p.ocr && ", read with OCR"}</p>
            <p class="max-w-[75ch] font-serif whitespace-pre-line">${p.text.join("\n")}</p>
          </div>`,
        )}
      </div>`}
    </section>`}

    ${preview &&
    html`<div
      class="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Page preview"
      onClick=${() => setPreview(null)}
    >
      <div class="max-h-full max-w-3xl overflow-auto rounded bg-sheet p-3" onClick=${(e) => e.stopPropagation()}>
        <div class="mb-2 flex items-center justify-between">
          <span class="font-semibold">${doc.unit === "slide" ? "Slide" : "Page"} ${preview.page}</span>
          <button class="btn btn-ghost" onClick=${() => setPreview(null)} autofocus>Close</button>
        </div>
        ${preview.error && html`<${ErrorNote} message=${preview.error} />`}
        ${!preview.url && !preview.error && html`<${Spinner} label="Rendering the page" />`}
        ${preview.url &&
        html`<img src=${preview.url} alt=${`${doc.unit} ${preview.page}`} class="w-full rounded border border-rule" />`}
      </div>
    </div>`}
  <//>`;
}
