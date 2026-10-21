import { html, useEffect, useState } from "../../vendor/preact-htm.js";
import { useConfirm } from "../components/confirm.js";
import { SourcePanel } from "../components/source.js";
import { ErrorNote, Note, Page, ProgressBar, RequireAuth, Spinner } from "../components/ui.js";
import { absoluteUrl, api, formatDate, TYPE_LABEL } from "../lib/api.js";
import { useApi, useTitle } from "../lib/hooks.js";
import { Link, navigate } from "../lib/router.js";

export function QuizPage({ id }) {
  return html`<${RequireAuth}><${QuizInner} id=${id} /><//>`;
}

function generatorLabel(g) {
  if (!g) return "";
  if (g.startsWith("offline")) return "Written by the built-in generator";
  const [provider, model] = g.split(":");
  return `Written by ${model || provider}`;
}

function QuizInner({ id }) {
  const quiz = useApi(`/api/quizzes/${id}?answers=true`, { poll: 800, shouldPoll: (q) => q.status === "generating" });
  const [starting, setStarting] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [showAnswers, setShowAnswers] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDialog, confirm] = useConfirm();
  useTitle(quiz.data?.title ?? "Quiz");

  if (quiz.error) return html`<${Page}><${ErrorNote} message=${quiz.error} onRetry=${quiz.reload} /><//>`;
  const q = quiz.data;
  if (!q) return html`<${Page}><${Spinner} /><//>`;

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const a = await api(`/api/quizzes/${q.id}/attempts`, { method: "POST", json: { shuffle } });
      navigate(`/attempts/${a.id}`);
    } catch (e) {
      setError(e?.message ?? "Could not start the quiz.");
      setStarting(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete "${q.title}"?`,
      body: "The questions and everyone's results will be deleted from this device.",
      confirmLabel: "Delete quiz",
      danger: true,
    });
    if (!ok) return;
    await api(`/api/quizzes/${q.id}`, { method: "DELETE" });
    navigate("/library");
  }

  const ownAttempts = q.attempts.filter((a) => a.is_owner);
  const classmateAttempts = q.attempts.filter((a) => !a.is_owner);
  const fromText = q.documents.map((d) => d.filename).join(", ") || "a classmate's material";

  return html`<${Page}>
    ${confirmDialog}
    <${Link} href="/library" class="link text-sm">Back to library<//>

    <div class="mt-3 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        ${renaming
          ? html`<${RenameForm}
              title=${q.title}
              onDone=${async (t) => {
                if (t && t !== q.title) {
                  await api(`/api/quizzes/${q.id}`, { method: "PATCH", json: { title: t } });
                  await quiz.reload();
                }
                setRenaming(false);
              }}
            />`
          : html`<div class="flex flex-wrap items-baseline gap-x-3">
              <h1 class="text-3xl break-words sm:text-4xl">${q.title}</h1>
              <button class="link text-sm" onClick=${() => setRenaming(true)}>Rename</button>
            </div>`}
        <p class="mt-2 text-muted">
          From ${fromText}${q.copied_from && ` (shared by ${q.copied_from})`}
          ${q.practice_of_id &&
          html`. Practice on the weak topics of${" "}<${Link} href=${`/quizzes/${q.practice_of_id}`} class="link">an earlier quiz<//>`}
        </p>

        ${q.status === "generating" &&
        html`<div class="sheet mt-8 space-y-3 p-6">
          <p class="font-serif text-lg font-semibold">Writing ${q.num_questions} questions from your material</p>
          <${ProgressBar} value=${q.progress} label="Generating questions" />
          <p class="text-sm text-muted">
            Each topic is searched for the most relevant passages, then questions are written from them and checked
            against the source text.
          </p>
        </div>`}

        ${q.status === "failed" &&
        html`<div class="mt-8 space-y-4">
          <${ErrorNote} message=${q.error ?? "Generation failed."} />
          <${Link} href="/quizzes/new" class="btn btn-secondary">Try different settings<//>
        </div>`}

        ${q.status === "ready" &&
        html`
          <dl class="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 border-y border-rule py-5 sm:grid-cols-4">
            <${Fact} label="Questions" value=${String(q.question_count)} />
            <${Fact} label="Difficulty" value=${q.difficulty[0].toUpperCase() + q.difficulty.slice(1)} />
            <${Fact} label="Topics" value=${String(q.topics.length)} />
            <${Fact} label="Best score" value=${q.best_percent === null ? "Not taken" : `${Math.round(q.best_percent)}%`} />
          </dl>
          <p class="mt-3 text-sm text-muted">
            ${q.question_types.map((t) => TYPE_LABEL[t]).join(", ")}. ${generatorLabel(q.generator)}.
          </p>
          ${q.generator_note &&
          html`<div class="mt-3">
            <${Note}>The AI model couldn't be used (${q.generator_note}), so the built-in generator wrote these questions.<//>
          </div>`}

          ${error && html`<div class="mt-4"><${ErrorNote} message=${error} /></div>`}
          <div class="mt-6 flex flex-wrap items-center gap-4">
            <button class="btn btn-primary px-6 text-base" onClick=${start} disabled=${starting}>
              ${starting ? "Starting…" : q.attempt_count ? "Retake quiz" : "Start quiz"}
            </button>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" class="accent-ink" checked=${shuffle} onChange=${(e) => setShuffle(e.currentTarget.checked)} />
              Shuffle question order
            </label>
            <${Link} href=${`/quizzes/${q.id}/print`} class="btn btn-ghost ml-auto">Print worksheet<//>
          </div>

          <section class="mt-12">
            <button class="btn btn-ghost -ml-3" aria-expanded=${showAnswers} onClick=${() => setShowAnswers((s) => !s)}>
              ${showAnswers ? "Hide questions and answers" : "Review questions and answers"}
            </button>
            ${showAnswers && html`<${AnswerKey} questions=${q.questions} quizId=${q.id} onChange=${quiz.reload} />`}
          </section>
        `}
      </div>

      ${q.status === "ready" &&
      html`<aside class="space-y-10">
        <${SharePanel}
          quizId=${q.id}
          token=${q.share_token}
          stamp=${q.questions.map((x) => `${x.id}:${x.prompt}:${x.answer}:${x.options}`).join("|")}
          onChange=${quiz.reload}
        />
        <section>
          <h2 class="text-xl">Your attempts</h2>
          ${ownAttempts.length === 0
            ? html`<p class="mt-2 text-sm text-muted">Results appear here after you finish the quiz.</p>`
            : html`<ul class="mt-3 space-y-2">
                ${ownAttempts.map(
                  (a) => html`<li key=${a.id} class="flex items-baseline justify-between gap-3 text-sm">
                    <${Link} href=${`/attempts/${a.id}/results`} class="hover:underline">${formatDate(a.finished_at)}, ${a.total} questions<//>
                    <span class="font-serif text-base font-semibold">${Math.round(a.percent ?? 0)}%</span>
                  </li>`,
                )}
              </ul>`}
        </section>
        ${classmateAttempts.length > 0 &&
        html`<section>
          <h2 class="text-xl">Classmates</h2>
          <ul class="mt-3 space-y-2">
            ${classmateAttempts.map(
              (a) => html`<li key=${a.id} class="flex items-baseline justify-between gap-3 text-sm">
                <${Link} href=${`/attempts/${a.id}/results`} class="truncate hover:underline">${a.name}<//>
                <span class="font-serif text-base font-semibold">${Math.round(a.percent ?? 0)}%</span>
              </li>`,
            )}
          </ul>
        </section>`}
        <button class="btn btn-danger" onClick=${remove}>Delete quiz</button>
      </aside>`}
    </div>
  <//>`;
}

function Fact({ label, value }) {
  return html`<div>
    <dt class="text-sm text-muted">${label}</dt>
    <dd class="font-serif text-xl font-semibold">${value}</dd>
  </div>`;
}

function RenameForm({ title, onDone }) {
  const [value, setValue] = useState(title);
  return html`<form
    class="flex flex-wrap gap-2"
    onSubmit=${(e) => {
      e.preventDefault();
      onDone(value.trim());
    }}
  >
    <label for="rename" class="sr-only">Quiz name</label>
    <input id="rename" class="field max-w-md text-lg" value=${value} onInput=${(e) => setValue(e.currentTarget.value)} autofocus maxlength="200" />
    <button class="btn btn-primary">Save name</button>
    <button type="button" class="btn btn-ghost" onClick=${() => onDone(title)}>Cancel</button>
  </form>`;
}

function SharePanel({ quizId, token, stamp, onChange }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState(null);

  // The link carries the questions, so it is rebuilt whenever they change
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setUrl("");
      return undefined;
    }
    api(`/api/quizzes/${quizId}/share-link`)
      .then(({ path }) => !cancelled && setUrl(absoluteUrl(path)))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [quizId, token, stamp]);

  async function set(enabled) {
    setBusy(true);
    setError(null);
    await api(`/api/quizzes/${quizId}/share?enabled=${enabled}`, { method: "POST" });
    await onChange();
    setBusy(false);
  }

  return html`<section>
    <h2 class="text-xl">Share with classmates</h2>
    ${token
      ? html`
          <p class="mt-2 text-sm text-muted">
            Anyone with this link can take the quiz. They don't need an account. The questions travel inside the link,
            so it works on any device.
          </p>
          <div class="mt-3 flex gap-2">
            <input class="field text-sm" readonly value=${url} aria-label="Share link" onFocus=${(e) => e.currentTarget.select()} />
            <button
              class="btn btn-secondary"
              disabled=${!url}
              onClick=${async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  /* clipboard blocked: the field is selectable */
                }
              }}
            >
              ${copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p class="mt-2 text-sm text-muted">
            Classmates get a link to send their result back to you. Open it here to see it under Classmates.
          </p>
          ${error && html`<p class="mt-2 text-sm text-pen">${error}</p>`}
          <button class="link mt-3 text-sm" onClick=${() => set(false)} disabled=${busy}>Stop sharing</button>
        `
      : html`
          <p class="mt-2 text-sm text-muted">Create a link so classmates can take this quiz and see their own results.</p>
          <button class="btn btn-secondary mt-3" onClick=${() => set(true)} disabled=${busy}>Create share link</button>
        `}
  </section>`;
}

function AnswerKey({ questions, quizId, onChange }) {
  const [source, setSource] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirmDialog, confirm] = useConfirm();

  async function removeQuestion(qid) {
    const ok = await confirm({
      title: "Remove this question?",
      body: "It disappears from the quiz. Past results keep their score.",
      confirmLabel: "Remove question",
      danger: true,
    });
    if (!ok) return;
    await api(`/api/quizzes/${quizId}/questions/${qid}`, { method: "DELETE" });
    onChange();
  }

  return html`
    ${confirmDialog}
    <ol class="sheet ruled mt-3">
      ${questions.map(
        (q, i) => html`<li key=${q.id} class="px-5 py-4">
          <div class="flex gap-3">
            <span class="font-serif font-semibold text-muted">${i + 1}.</span>
            <div class="min-w-0 flex-1">
              <p class="text-sm text-muted">${TYPE_LABEL[q.qtype]}, ${q.difficulty}, ${q.topic_name}</p>
              ${editing === q.id
                ? html`<${QuestionEditor}
                    question=${q}
                    quizId=${quizId}
                    onDone=${async (saved) => {
                      setEditing(null);
                      if (saved) await onChange();
                    }}
                  />`
                : html`
                    <p class="mt-1 font-serif text-[1.05rem]">${q.prompt}</p>
                    ${q.options &&
                    q.qtype === "mcq" &&
                    html`<ul class="mt-2 space-y-0.5 text-sm">
                      ${q.options.map(
                        (o, j) => html`<li key=${j} class=${o === q.answer ? "font-semibold text-check" : "text-muted"}>
                          ${"ABCDEF"[j]}. ${o}
                        </li>`,
                      )}
                    </ul>`}
                    ${q.qtype !== "mcq" &&
                    html`<p class="mt-2 text-sm">
                      <span class="font-semibold text-check">Answer: ${q.answer}</span>
                      ${q.accepted_answers.length > 0 &&
                      html`<span class="text-muted"> (also accepted: ${q.accepted_answers.join(", ")})</span>`}
                    </p>`}
                    ${q.explanation && html`<p class="mt-2 text-sm text-muted">${q.explanation}</p>`}
                    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      <button class="link" onClick=${() => setSource(q.id)}>${q.source_label} of ${q.source_filename}</button>
                      <button class="text-muted hover:text-ink" onClick=${() => setEditing(q.id)}>Edit</button>
                      <button class="text-muted hover:text-pen" onClick=${() => removeQuestion(q.id)}>Remove</button>
                    </div>
                  `}
            </div>
          </div>
        </li>`,
      )}
    </ol>
    ${source !== null && html`<${SourcePanel} questionId=${source} onClose=${() => setSource(null)} />`}
  `;
}

function QuestionEditor({ question, quizId, onDone }) {
  const [prompt, setPrompt] = useState(question.prompt);
  const [options, setOptions] = useState(question.options ?? []);
  const [answer, setAnswer] = useState(question.answer);
  const [accepted, setAccepted] = useState(question.accepted_answers.join(", "));
  const [explanation, setExplanation] = useState(question.explanation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const id = `edit-${question.id}`;

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/quizzes/${quizId}/questions/${question.id}`, {
        method: "PATCH",
        json: {
          prompt,
          answer,
          explanation,
          ...(question.qtype === "mcq" ? { options } : {}),
          ...(question.qtype === "short_answer"
            ? {
                accepted_answers: accepted
                  .split(",")
                  .map((a) => a.trim())
                  .filter(Boolean),
              }
            : {}),
        },
      });
      onDone(true);
    } catch (err) {
      setError(err?.message ?? "Could not save the question.");
      setBusy(false);
    }
  }

  return html`<form onSubmit=${save} class="mt-2 space-y-4">
    <div>
      <label class="label" for=${`${id}-prompt`}>Question</label>
      <textarea id=${`${id}-prompt`} class="field min-h-20 font-serif" value=${prompt} onInput=${(e) => setPrompt(e.currentTarget.value)} required></textarea>
    </div>

    ${question.qtype === "mcq" &&
    html`<fieldset>
      <legend class="label">Options (pick the correct one)</legend>
      <div class="space-y-2">
        ${options.map(
          (o, j) => html`<div key=${j} class="flex items-center gap-2">
            <input
              type="radio"
              name=${`${id}-answer`}
              class="h-4 w-4 accent-ink"
              checked=${answer === o}
              onChange=${() => setAnswer(o)}
              aria-label=${`Option ${"ABCDEF"[j]} is correct`}
            />
            <input
              class="field"
              value=${o}
              aria-label=${`Option ${"ABCDEF"[j]}`}
              onInput=${(e) => {
                const next = [...options];
                next[j] = e.currentTarget.value;
                if (answer === o) setAnswer(e.currentTarget.value);
                setOptions(next);
              }}
              required
            />
          </div>`,
        )}
      </div>
    </fieldset>`}

    ${question.qtype === "true_false" &&
    html`<fieldset>
      <legend class="label">Answer</legend>
      <div class="flex gap-4">
        ${["True", "False"].map(
          (v) => html`<label key=${v} class="flex items-center gap-2">
            <input type="radio" name=${`${id}-tf`} class="accent-ink" checked=${answer === v} onChange=${() => setAnswer(v)} />
            ${v}
          </label>`,
        )}
      </div>
    </fieldset>`}

    ${question.qtype === "short_answer" &&
    html`
      <div>
        <label class="label" for=${`${id}-answer`}>Answer</label>
        <input id=${`${id}-answer`} class="field" value=${answer} onInput=${(e) => setAnswer(e.currentTarget.value)} required />
      </div>
      <div>
        <label class="label" for=${`${id}-accepted`}>Also accept <span class="font-normal text-muted">(comma separated)</span></label>
        <input id=${`${id}-accepted`} class="field" value=${accepted} onInput=${(e) => setAccepted(e.currentTarget.value)} />
      </div>
    `}

    <div>
      <label class="label" for=${`${id}-explanation`}>Explanation</label>
      <textarea id=${`${id}-explanation`} class="field min-h-16" value=${explanation} onInput=${(e) => setExplanation(e.currentTarget.value)}></textarea>
    </div>

    ${error && html`<${ErrorNote} message=${error} />`}
    <div class="flex gap-2">
      <button class="btn btn-primary" disabled=${busy}>${busy ? "Saving…" : "Save question"}</button>
      <button type="button" class="btn btn-ghost" onClick=${() => onDone(false)}>Cancel</button>
    </div>
  </form>`;
}
