import { html, useEffect, useState } from "../../vendor/preact-htm.js";
import { SourcePanel } from "../components/source.js";
import { ErrorNote, Page, ScoreRing, Spinner } from "../components/ui.js";
import { absoluteUrl, api, TYPE_LABEL } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { useApi, useTitle } from "../lib/hooks.js";
import { Link, navigate } from "../lib/router.js";

function duration(s) {
  if (s === null || s === undefined) return null;
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

export function ResultsPage({ id }) {
  const { user } = useAuth();
  const res = useApi(`/api/attempts/${id}/results`);
  const [source, setSource] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  useTitle(res.data ? `Results: ${res.data.quiz_title}` : "Results");

  if (res.error) return html`<${Page}><${ErrorNote} message=${res.error} onRetry=${res.reload} /><//>`;
  const r = res.data;
  if (!r) return html`<${Page}><${Spinner} label="Scoring" /><//>`;

  const missed = r.questions.filter((q) => q.score < 1).map((q) => q.question_id);
  const correct = r.questions.filter((q) => q.score >= 1).length;

  async function retake(only) {
    setBusy(true);
    setError(null);
    try {
      const body = { question_ids: only ?? null };
      const url = r.is_owner ? `/api/quizzes/${r.quiz_id}/attempts` : `/api/shared/${r.share_token}/attempts`;
      const a = await api(url, { method: "POST", json: { ...body, guest_name: r.guest_name } });
      navigate(`/attempts/${a.id}`);
    } catch (e) {
      setError(e?.message ?? "Could not start a new attempt.");
      setBusy(false);
    }
  }

  async function practise() {
    setBusy(true);
    setError(null);
    try {
      const topicIds = r.weak_topics.map((t) => t.topic_id).filter((t) => t !== null);
      const quiz = await api(`/api/quizzes/${r.quiz_id}/practice`, { method: "POST", json: { topic_ids: topicIds } });
      navigate(`/quizzes/${quiz.id}`);
    } catch (e) {
      setError(e?.message ?? "Could not start a practice quiz.");
      setBusy(false);
    }
  }

  async function saveToLibrary() {
    setBusy(true);
    try {
      const q = await api(`/api/shared/${r.share_token}/save`, { method: "POST" });
      setSaved(q.id);
    } catch (e) {
      setError(e?.message ?? "Could not save the quiz.");
    } finally {
      setBusy(false);
    }
  }

  const canRetake = r.is_owner || !!r.share_token;

  return html`<${Page}>
    <div class="grid items-center gap-8 sm:grid-cols-[auto_minmax(0,1fr)]">
      <${ScoreRing} percent=${r.percent} size=${140} />
      <div>
        <p class="text-muted">${r.quiz_title}${r.imported && r.guest_name ? `, ${r.guest_name}'s result` : ""}</p>
        <h1 class="mt-1 text-3xl sm:text-4xl">${correct} of ${r.total} correct</h1>
        <p class="mt-2 text-muted">
          ${r.weak_topics.length === 0
            ? "You did well on every topic in this quiz."
            : `${r.weak_topics.length} ${r.weak_topics.length === 1 ? "topic needs" : "topics need"} another look before you retake it.`}
          ${duration(r.duration_seconds) && ` Time taken: ${duration(r.duration_seconds)}.`}
        </p>
        ${error && html`<div class="mt-3"><${ErrorNote} message=${error} /></div>`}
        <div class="mt-5 flex flex-wrap gap-2">
          ${canRetake &&
          !r.imported &&
          missed.length > 0 &&
          html`<button class="btn btn-primary" disabled=${busy} onClick=${() => retake(missed)}>Retake the ${missed.length} you missed</button>`}
          ${canRetake &&
          !r.imported &&
          html`<button class=${`btn ${missed.length ? "btn-secondary" : "btn-primary"}`} disabled=${busy} onClick=${() => retake()}>
            Retake whole quiz
          </button>`}
          ${r.is_owner &&
          !r.imported &&
          r.weak_topics.some((t) => t.topic_id) &&
          html`<button class="btn btn-secondary" disabled=${busy} onClick=${practise}>New questions on weak topics</button>`}
          ${r.is_owner && html`<${Link} href=${`/quizzes/${r.quiz_id}`} class="btn btn-ghost">Quiz overview<//>`}
          ${!r.is_owner &&
          r.share_token &&
          user &&
          !saved &&
          html`<button class="btn btn-ghost" disabled=${busy} onClick=${saveToLibrary}>Save to my library</button>`}
          ${saved && html`<${Link} href=${`/quizzes/${saved}`} class="btn btn-ghost">Saved. Open in library<//>`}
        </div>
      </div>
    </div>

    ${r.received && r.share_token && html`<${SendResult} attemptId=${r.attempt_id} ownerName=${r.owner_name} />`}

    <div class="mt-12 grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section aria-labelledby="revise-h">
        <h2 id="revise-h" class="text-2xl">What to revise</h2>
        ${r.weak_topics.length === 0
          ? html`<p class="mt-3 text-muted">No weak topics this time. Try a harder quiz or a new set of slides.</p>`
          : html`<ol class="mt-4 space-y-5">
              ${r.weak_topics.map(
                (t) => html`<li key=${t.topic} class="border-l-[3px] border-pen pl-4">
                  <h3 class="text-lg">${t.topic}</h3>
                  <p class="text-sm text-muted">${t.score % 1 ? t.score.toFixed(1) : t.score} of ${t.total} right</p>
                  ${t.revise.length > 0 &&
                  html`<p class="mt-2">
                    Reread${" "}
                    ${t.revise.map(
                      (s, i) => html`<span key=${`${s.document_id}-${s.location}`}>
                        ${i > 0 && (i === t.revise.length - 1 ? " and " : ", ")}
                        <button class="link" onClick=${() => setSource(s.question_id)}>${s.label}</button>
                      </span>`,
                    )}${" "}
                    <span class="text-muted">of ${t.revise[0].filename}</span>
                  </p>`}
                </li>`,
              )}
            </ol>`}
      </section>

      <section aria-labelledby="topics-h">
        <h2 id="topics-h" class="text-2xl">Score by topic</h2>
        <ul class="mt-4 space-y-4">
          ${r.topics.map((t) => {
            const pct = Math.round(t.accuracy * 100);
            return html`<li key=${t.topic}>
              <div class="flex items-baseline justify-between gap-3">
                <span class="font-medium">${t.topic}</span>
                <span class="font-serif font-semibold">${pct}%</span>
              </div>
              <div class="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-rule" aria-hidden="true">
                <div class=${`h-full rounded-full ${t.weak ? "bg-pen" : "bg-check"}`} style=${{ width: `${Math.max(2, pct)}%` }}></div>
              </div>
            </li>`;
          })}
        </ul>
      </section>
    </div>

    <section class="mt-14" aria-labelledby="review-h">
      <h2 id="review-h" class="text-2xl">${r.imported ? "Their answers" : "Your answers"}</h2>
      <ol class="sheet ruled mt-4">
        ${r.questions.map(
          (q, i) => html`<li key=${q.question_id} class="flex gap-4 px-5 py-4">
            <span
              class=${`mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-full text-sm font-bold ${
                q.score >= 1 ? "bg-check-soft text-check" : q.score > 0 ? "bg-marker-soft" : "bg-pen-soft text-pen"
              }`}
              aria-label=${q.score >= 1 ? "Correct" : q.score > 0 ? "Partly correct" : "Wrong"}
            >
              ${i + 1}
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-sm text-muted">${TYPE_LABEL[q.qtype]}, ${q.topic}</p>
              <p class="mt-0.5 font-serif text-[1.05rem]">${q.prompt}</p>
              <p class="mt-2 text-sm">
                ${q.answered
                  ? html`Answer given:${" "}
                      <span class=${q.score >= 1 ? "font-semibold text-check" : "font-semibold text-pen"}>${q.given_answer}</span>`
                  : html`<span class="text-pen">Not answered</span>`}
                ${q.score < 1 && html`. Correct answer: <strong>${q.correct_answer}</strong>`}
              </p>
              ${q.score < 1 && q.explanation && html`<p class="mt-1 text-sm text-muted">${q.explanation}</p>`}
              <button class="link mt-1 text-sm" onClick=${() => setSource(q.question_id)}>${q.source_label} of ${q.source_filename}</button>
            </div>
          </li>`,
        )}
      </ol>
    </section>

    ${source !== null && html`<${SourcePanel} questionId=${source} onClose=${() => setSource(null)} />`}
  <//>`;
}

/** For classmates: a link that adds this result to the quiz owner's list. */
function SendResult({ attemptId, ownerName }) {
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    api(`/api/attempts/${attemptId}/result-link`)
      .then(({ path }) => setUrl(absoluteUrl(path)))
      .catch((e) => setError(e.message));
  }, [attemptId]);
  const who = ownerName || "the person who shared the quiz";
  return html`<section class="sheet mt-10 p-5" aria-labelledby="send-h">
    <h2 id="send-h" class="text-xl">Send your result to ${who}</h2>
    <p class="mt-1 text-sm text-muted">
      Everything stays on your device, so ${who} only sees your score if you send this link. Opening it adds your result
      to their quiz.
    </p>
    ${error && html`<p class="mt-2 text-sm text-pen">${error}</p>`}
    <div class="mt-3 flex gap-2">
      <input class="field text-sm" readonly value=${url} aria-label="Result link" onFocus=${(e) => e.currentTarget.select()} />
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
  </section>`;
}
