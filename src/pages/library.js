import { html, useState } from "../../vendor/preact-htm.js";
import { useConfirm } from "../components/confirm.js";
import { Uploader } from "../components/uploader.js";
import { EmptyState, ErrorNote, Note, Page, ProgressBar, RequireAuth, Spinner, StatusBadge } from "../components/ui.js";
import { api, formatDate, plural, unitWord, uploadFiles } from "../lib/api.js";
import { useApi, useTitle } from "../lib/hooks.js";
import { Link, navigate } from "../lib/router.js";

const TYPE_NAME = { pdf: "PDF", pptx: "Slides", docx: "Word", txt: "Text", md: "Markdown", image: "Image" };

export const SAMPLE_FILES = [
  "operating-systems-notes.pdf",
  "biology-energy-in-cells.pptx",
  "industrial-revolution.docx",
  "networking-basics.md",
  "scanned-memory-management.pdf",
];

export function LibraryPage() {
  useTitle("Library");
  return html`<${RequireAuth}><${Library} /><//>`;
}

function Library() {
  const docs = useApi("/api/documents", { poll: 1000, shouldPoll: (d) => d.some((x) => x.status === "processing") });
  const quizzes = useApi("/api/quizzes", { poll: 1000, shouldPoll: (q) => q.some((x) => x.status === "generating") });
  const stats = useApi("/api/stats");
  const health = useApi("/api/health");
  const readyDocs = docs.data?.filter((d) => d.status === "ready") ?? [];

  return html`<${Page}>
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-3xl sm:text-4xl">Your library</h1>
        <p class="mt-1 text-muted">Upload material, then make quizzes from any mix of files and topics.</p>
      </div>
      ${readyDocs.length > 0 && html`<${Link} href="/quizzes/new" class="btn btn-primary">Make a quiz<//>`}
    </div>

    <div class="mt-6 space-y-3">
      ${health.data?.storage === "memory" &&
      html`<${ErrorNote}
        message="This browser isn't letting the app save data (a private window, perhaps), so everything is lost when you close the tab."
      />`}
      ${health.data?.llm === "offline" &&
      html`<${Note}>
        No AI model is connected, so questions are written by the built-in rule-based generator. Add an Anthropic or
        OpenAI API key in${" "}<${Link} href="/settings" class="link">Settings<//>${" "}for AI-written questions.
      <//>`}
    </div>

    <div class="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div class="space-y-12">
        <section aria-labelledby="material-h">
          <h2 id="material-h" class="mb-4 text-2xl">Study material</h2>
          <${Uploader} compact=${(docs.data?.length ?? 0) > 0} onUploaded=${() => docs.reload()} />
          <div class="mt-6">
            ${docs.error && html`<${ErrorNote} message=${docs.error} onRetry=${docs.reload} />`}
            ${docs.loading && html`<${Spinner} />`}
            ${docs.data?.length === 0 && html`<${SampleLoader} onLoaded=${() => docs.reload()} />`}
            ${docs.data?.length > 0 &&
            html`<ul class="sheet ruled">
              ${docs.data.map((d) => html`<${DocRow} key=${d.id} doc=${d} onChange=${() => docs.reload()} />`)}
            </ul>`}
          </div>
        </section>

        <section aria-labelledby="quizzes-h">
          <h2 id="quizzes-h" class="mb-4 text-2xl">Quizzes</h2>
          ${quizzes.error && html`<${ErrorNote} message=${quizzes.error} onRetry=${quizzes.reload} />`}
          ${quizzes.loading && html`<${Spinner} />`}
          ${quizzes.data?.length === 0 &&
          html`<${EmptyState}
            title="No quizzes yet"
            action=${readyDocs.length > 0 ? html`<${Link} href="/quizzes/new" class="btn btn-primary">Make your first quiz<//>` : null}
          >
            ${readyDocs.length > 0
              ? "Choose a file and how many questions you want."
              : "Upload some material first. Your quizzes will appear here."}
          <//>`}
          ${quizzes.data?.length > 0 &&
          html`<ul class="sheet ruled">
            ${quizzes.data.map((q) => html`<${QuizRow} key=${q.id} quiz=${q} />`)}
          </ul>`}
        </section>
      </div>

      <aside class="space-y-8">
        <${RevisePanel} stats=${stats.data} />
      </aside>
    </div>
  <//>`;
}

/** First visit: offer the sample lecture files so the app can be tried straight away. */
function SampleLoader({ onLoaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function load() {
    setBusy(true);
    setError(null);
    try {
      const files = await Promise.all(
        SAMPLE_FILES.map(async (name) => {
          const res = await fetch(new URL(`samples/${name}`, document.baseURI));
          if (!res.ok) throw new Error(`Couldn't load the sample ${name}.`);
          return new File([await res.blob()], name, { type: res.headers.get("content-type") ?? "" });
        }),
      );
      await uploadFiles(files, () => {});
      onLoaded();
    } catch (e) {
      setError(e?.message ?? "Couldn't load the sample files.");
      setBusy(false);
    }
  }
  return html`<div class="rounded border border-rule bg-sheet px-5 py-4">
    <p class="font-semibold">No files yet?</p>
    <p class="mt-1 text-sm text-muted">
      Try it with five sample lecture files: an operating-systems PDF, a biology slide deck, a history Word document,
      networking notes in Markdown and a scanned PDF that needs OCR.
    </p>
    <button class="btn btn-secondary mt-3" onClick=${load} disabled=${busy}>
      ${busy ? "Loading the samples…" : "Load sample material"}
    </button>
    ${error && html`<div class="mt-3"><${ErrorNote} message=${error} /></div>`}
  </div>`;
}

function DocRow({ doc, onChange }) {
  const [confirmDialog, confirm] = useConfirm();
  async function remove() {
    const ok = await confirm({
      title: `Delete ${doc.filename}?`,
      body: "Quizzes you made from it keep their questions, but you won't be able to make new ones.",
      confirmLabel: "Delete file",
      danger: true,
    });
    if (!ok) return;
    await api(`/api/documents/${doc.id}`, { method: "DELETE" });
    onChange();
  }
  async function retry() {
    await api(`/api/documents/${doc.id}/reprocess`, { method: "POST" });
    onChange();
  }
  return html`<li class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
    ${confirmDialog}
    <span class="w-16 flex-none rounded bg-paper px-1.5 py-0.5 text-center text-xs font-semibold text-muted">
      ${TYPE_NAME[doc.file_type] ?? doc.file_type}
    </span>
    <div class="min-w-0 flex-1">
      ${doc.status === "ready"
        ? html`<${Link} href=${`/documents/${doc.id}`} class="block truncate font-semibold hover:underline">${doc.filename}<//>`
        : html`<span class="block truncate font-semibold">${doc.filename}</span>`}
      <p class="text-sm text-muted">
        ${doc.status === "ready" &&
        `${unitWord(doc.unit, doc.page_count)}, ${plural(doc.topic_count, "topic")}${
          doc.ocr_pages > 0 ? `, ${doc.ocr_pages} read with OCR` : ""
        }`}
        ${doc.status === "processing" && `${doc.status_note || "Extracting text and finding topics"}…`}
        ${doc.status === "failed" && html`<span class="text-pen">${doc.error}</span>`}
      </p>
    </div>
    ${doc.status !== "ready" && html`<${StatusBadge} status=${doc.status} />`}
    <div class="flex gap-1">
      ${doc.status === "ready" && html`<${Link} href=${`/quizzes/new?doc=${doc.id}`} class="btn btn-secondary">Quiz me<//>`}
      ${doc.status === "failed" && html`<button class="btn btn-secondary" onClick=${retry}>Try again</button>`}
      <button class="btn btn-ghost text-muted" onClick=${remove} aria-label=${`Delete ${doc.filename}`}>Delete</button>
    </div>
  </li>`;
}

function QuizRow({ quiz }) {
  return html`<li class="px-4 py-3.5">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div class="min-w-0 flex-1">
        <${Link} href=${`/quizzes/${quiz.id}`} class="block truncate font-semibold hover:underline">${quiz.title}<//>
        <p class="text-sm text-muted">
          ${quiz.status === "ready" ? `${plural(quiz.question_count, "question")}, ${quiz.difficulty}` : null}
          ${quiz.status === "generating" && "Writing questions from your material…"}
          ${quiz.status === "failed" && html`<span class="text-pen">${quiz.error}</span>`}
          ${quiz.shared && quiz.status === "ready" && ", shared"}
          <span class="hidden sm:inline">${`, made ${formatDate(quiz.created_at)}`}</span>
        </p>
      </div>
      ${quiz.best_percent !== null &&
      html`<span class="text-sm">Best <strong class="font-serif text-base">${Math.round(quiz.best_percent)}%</strong></span>`}
      ${quiz.status === "ready"
        ? html`<${Link} href=${`/quizzes/${quiz.id}`} class="btn btn-secondary">${quiz.attempt_count ? "Retake" : "Start"}<//>`
        : html`<${StatusBadge} status=${quiz.status} />`}
    </div>
    ${quiz.status === "generating" &&
    html`<div class="mt-3"><${ProgressBar} value=${quiz.progress} label=${`Generating ${quiz.title}`} /></div>`}
  </li>`;
}

function RevisePanel({ stats }) {
  const [starting, setStarting] = useState(null);
  const [error, setError] = useState(null);
  if (!stats) return null;

  async function practise(topic) {
    setStarting(topic.topic);
    setError(null);
    try {
      const quizId = topic.quiz_ids[topic.quiz_ids.length - 1];
      const quiz = await api(`/api/quizzes/${quizId}/practice`, { method: "POST", json: { topic_ids: topic.topic_ids } });
      navigate(`/quizzes/${quiz.id}`);
    } catch (e) {
      setError(e?.message ?? "Could not start a practice quiz.");
      setStarting(null);
    }
  }

  return html`
    <section aria-labelledby="revise-h">
      <h2 id="revise-h" class="text-xl">Revise next</h2>
      ${error && html`<p role="alert" class="mt-2 text-sm text-pen">${error}</p>`}
      ${stats.weak_topics.length === 0
        ? html`<p class="mt-2 text-sm text-muted">
            ${stats.attempts === 0
              ? "Finish a quiz and the topics you found hardest will show up here."
              : "No weak topics in your recent quizzes. Nice work."}
          </p>`
        : html`<ul class="mt-3 space-y-4">
            ${stats.weak_topics.map(
              (t) => html`<li key=${t.topic} class="border-l-[3px] border-pen pl-3">
                <p class="leading-snug font-semibold">${t.topic}</p>
                <p class="text-sm text-muted">${Math.round(t.accuracy * 100)}% right over ${plural(t.questions, "question")}</p>
                ${t.revise.length > 0 &&
                html`<p class="mt-1 text-sm">
                  Reread ${t.revise
                    .slice(0, 3)
                    .map((r) => r.label)
                    .join(", ")}
                  ${t.revise[0] && html`<span class="text-muted"> in ${t.revise[0].filename}</span>`}
                </p>`}
                ${t.topic_ids.length > 0 &&
                t.quiz_ids.length > 0 &&
                html`<button class="link mt-1 text-sm" onClick=${() => practise(t)} disabled=${starting !== null}>
                  ${starting === t.topic ? "Starting a practice quiz…" : "Practise this topic"}
                </button>`}
              </li>`,
            )}
          </ul>`}
    </section>

    ${stats.recent.length > 0 &&
    html`<section aria-labelledby="recent-h">
      <h2 id="recent-h" class="text-xl">Recent results</h2>
      <ul class="mt-3 space-y-2">
        ${stats.recent.map(
          (r) => html`<li key=${r.attempt_id} class="flex items-baseline justify-between gap-3">
            <${Link} href=${`/attempts/${r.attempt_id}/results`} class="truncate text-sm hover:underline">${r.quiz_title}<//>
            <span class="font-serif font-semibold">${Math.round(r.percent)}%</span>
          </li>`,
        )}
      </ul>
      ${stats.average_percent !== null &&
      html`<p class="mt-3 text-sm text-muted">
        Average over ${plural(stats.attempts, "quiz", "quizzes")}: ${Math.round(stats.average_percent)}%
      </p>`}
    </section>`}
  `;
}
