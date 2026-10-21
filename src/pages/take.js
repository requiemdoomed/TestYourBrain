import { html, useCallback, useEffect, useMemo, useRef, useState } from "../../vendor/preact-htm.js";
import { useConfirm } from "../components/confirm.js";
import { HighlightedText, SourcePanel } from "../components/source.js";
import { ErrorNote, Page, ProgressBar, Spinner } from "../components/ui.js";
import { api, TYPE_LABEL } from "../lib/api.js";
import { useApi, useTitle } from "../lib/hooks.js";
import { Link, navigate } from "../lib/router.js";

export function TakePage({ id }) {
  const attempt = useApi(`/api/attempts/${id}`);
  const finished = attempt.data?.finished_at;
  useTitle(attempt.data?.quiz_title ?? "Quiz");

  useEffect(() => {
    if (finished) navigate(`/attempts/${id}/results`, { replace: true });
  }, [finished, id]);

  if (attempt.error) return html`<${Page} narrow><${ErrorNote} message=${attempt.error} onRetry=${attempt.reload} /><//>`;
  if (!attempt.data || finished) return html`<${Page} narrow><${Spinner} label="Loading the quiz" /><//>`;
  return html`<${Taker} key=${attempt.data.id} a=${attempt.data} />`;
}

function Taker({ a }) {
  // Restore progress when resuming an attempt
  const [feedback, setFeedback] = useState(() => Object.fromEntries(a.responses.map((r) => [r.question_id, r])));
  const [index, setIndex] = useState(() => {
    const answeredIds = new Set(a.responses.map((r) => r.question_id));
    const firstOpen = a.questions.findIndex((q) => !answeredIds.has(q.id));
    return firstOpen === -1 ? a.questions.length - 1 : firstOpen;
  });
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDialog, confirm] = useConfirm();

  const finish = useCallback(async () => {
    setFinishing(true);
    try {
      await api(`/api/attempts/${a.id}/finish`, { method: "POST" });
      navigate(`/attempts/${a.id}/results`);
    } catch (e) {
      setError(e?.message ?? "Could not finish the quiz.");
      setFinishing(false);
    }
  }, [a.id]);

  const total = a.questions.length;
  const answered = Object.keys(feedback).length;
  const score = Object.values(feedback).reduce((s, f) => s + f.score, 0);
  const q = a.questions[index];

  return html`<${Page} narrow>
    ${confirmDialog}
    <div class="flex flex-wrap items-baseline justify-between gap-3">
      <p class="font-serif text-lg font-semibold">${a.quiz_title}</p>
      <p class="text-sm text-muted">
        ${answered} of ${total} answered${answered > 0 && `, ${score % 1 ? score.toFixed(1) : score} right so far`}
        <span aria-hidden="true">, </span>
        <${Elapsed} since=${a.started_at} />
      </p>
    </div>
    <div class="mt-3"><${ProgressBar} value=${(answered / total) * 100} label="Quiz progress" /></div>

    <nav aria-label="Questions" class="mt-4 flex flex-wrap gap-1.5">
      ${a.questions.map((qq, i) => {
        const f = feedback[qq.id];
        const state = !f ? "open" : f.score >= 1 ? "right" : f.score > 0 ? "half" : "wrong";
        const spoken = f ? (state === "right" ? ", correct" : state === "half" ? ", partly correct" : ", wrong") : "";
        return html`<button
          key=${qq.id}
          onClick=${() => setIndex(i)}
          aria-current=${i === index ? "step" : undefined}
          aria-label=${`Question ${i + 1}${spoken}`}
          class=${`h-8 w-8 rounded text-sm font-semibold transition-colors ${i === index ? "ring-2 ring-ink ring-offset-1" : ""} ${
            state === "right"
              ? "bg-check-soft text-check"
              : state === "wrong"
                ? "bg-pen-soft text-pen"
                : state === "half"
                  ? "bg-marker-soft text-ink"
                  : "border border-rule bg-sheet text-muted"
          }`}
        >
          ${i + 1}
        </button>`;
      })}
    </nav>

    ${error && html`<div class="mt-4"><${ErrorNote} message=${error} /></div>`}

    ${q &&
    html`<${QuestionSheet}
      key=${q.id}
      attempt=${a}
      question=${q}
      number=${index + 1}
      total=${total}
      feedback=${feedback[q.id]}
      onAnswered=${(f) => setFeedback((prev) => ({ ...prev, [q.id]: f }))}
      onNext=${() => {
        const nextOpen = a.questions.findIndex((qq, i) => i > index && !feedback[qq.id]);
        const anyOpen = a.questions.findIndex((qq) => !feedback[qq.id] && qq.id !== q.id);
        if (nextOpen !== -1) setIndex(nextOpen);
        else if (anyOpen !== -1) setIndex(anyOpen);
        else finish();
      }}
      isLastOpen=${answered >= total - (feedback[q.id] ? 0 : 1)}
      finishing=${finishing}
    />`}

    <div class="mt-10 flex items-center justify-between border-t border-rule pt-5 text-sm">
      ${a.is_owner
        ? html`<${Link} href=${`/quizzes/${a.quiz_id}`} class="link">Leave quiz<//>`
        : a.share_token
          ? html`<${Link} href=${`/shared/${a.share_token}`} class="link">Leave quiz<//>`
          : html`<span></span>`}
      ${answered < total &&
      answered > 0 &&
      html`<button
        class="link"
        onClick=${async () => {
          const open = total - answered;
          const ok = await confirm({
            title: "Finish the quiz now?",
            body: `${open} unanswered ${open === 1 ? "question counts" : "questions count"} as wrong.`,
            confirmLabel: "Finish and see results",
          });
          if (ok) finish();
        }}
        disabled=${finishing}
      >
        Finish now
      </button>`}
    </div>
  <//>`;
}

/** Time spent on this attempt, updated every second. */
function Elapsed({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return html`<span aria-label=${`Time spent: ${m} minutes ${s} seconds`}>${`${m}:${s}`}</span>`;
}

function QuestionSheet({ attempt, question, number, total, feedback, onAnswered, onNext, isLastOpen, finishing }) {
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showSource, setShowSource] = useState(false);
  const nextRef = useRef(null);
  const options = useMemo(() => (question.qtype === "true_false" ? ["True", "False"] : (question.options ?? [])), [question]);

  const submit = useCallback(
    async (value) => {
      const answer = String(value ?? choice).trim();
      if (!answer || feedback || busy) return;
      setBusy(true);
      setError(null);
      try {
        const f = await api(`/api/attempts/${attempt.id}/answers`, {
          method: "POST",
          json: { question_id: question.id, answer },
        });
        onAnswered(f);
      } catch (e) {
        setError(e?.message ?? "Could not check your answer.");
      } finally {
        setBusy(false);
      }
    },
    [choice, feedback, busy, attempt.id, question.id, onAnswered],
  );

  useEffect(() => {
    if (feedback) nextRef.current?.focus();
  }, [feedback]);

  // Keyboard: A-D / 1-4 pick an option, Enter checks
  useEffect(() => {
    function onKey(e) {
      if (feedback || showSource || question.qtype === "short_answer") return;
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      let idx = "abcde".indexOf(k);
      if (idx === -1) idx = "12345".indexOf(k);
      if (question.qtype === "true_false") idx = k === "t" ? 0 : k === "f" ? 1 : idx;
      if (idx >= 0 && idx < options.length) setChoice(options[idx]);
      if (e.key === "Enter" && choice) {
        e.preventDefault();
        submit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [feedback, showSource, question.qtype, options, choice, submit]);

  const given = feedback?.given_answer;
  function stateOf(o) {
    if (!feedback) return choice === o ? "selected" : undefined;
    if (o.toLowerCase() === feedback.correct_answer.toLowerCase()) return "correct";
    if (o === given) return "wrong";
    return undefined;
  }
  const verdict = feedback ? (feedback.score >= 1 ? "Correct." : feedback.score > 0 ? "Partly right." : "Not quite.") : "";

  return html`<article class="sheet mt-6 px-5 py-6 sm:px-8 sm:py-8" aria-labelledby=${`q-${question.id}`}>
    <p class="text-sm text-muted">
      Question ${number} of ${total}, ${TYPE_LABEL[question.qtype].toLowerCase()}, on ${question.topic_name}
    </p>
    <h1 id=${`q-${question.id}`} class="mt-3 font-serif text-[1.35rem] leading-snug font-medium sm:text-[1.55rem]">
      ${question.qtype === "true_false"
        ? html`<span class="mb-1 block text-base font-semibold text-muted">True or false?</span>${question.prompt}`
        : question.prompt}
    </h1>

    <div class="mt-6">
      ${question.qtype === "short_answer"
        ? html`<form
            onSubmit=${(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label for=${`a-${question.id}`} class="label">Your answer</label>
            <textarea
              id=${`a-${question.id}`}
              class="field min-h-24 font-serif text-[1.05rem]"
              value=${feedback ? given : choice}
              onInput=${(e) => setChoice(e.currentTarget.value)}
              disabled=${!!feedback}
              autofocus
              onKeyDown=${(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            ></textarea>
            ${!feedback &&
            html`<button class="btn btn-primary mt-4" disabled=${!choice.trim() || busy}>${busy ? "Checking…" : "Check answer"}</button>`}
          </form>`
        : html`
            <div class=${`grid gap-2.5 ${question.qtype === "true_false" ? "sm:grid-cols-2" : ""}`} role="radiogroup" aria-label="Answer options">
              ${options.map(
                (o, i) => html`<button
                  key=${o}
                  role="radio"
                  aria-checked=${choice === o || given === o}
                  class="choice"
                  data-state=${stateOf(o)}
                  disabled=${!!feedback || busy}
                  onClick=${() => setChoice(o)}
                >
                  <span class="choice-key">${question.qtype === "true_false" ? o[0] : "ABCDE"[i]}</span>
                  <span class="pt-0.5 text-[1.02rem]">${o}</span>
                </button>`,
              )}
            </div>
            ${!feedback &&
            html`<div class="mt-5 flex items-center gap-4">
              <button class="btn btn-primary" disabled=${!choice || busy} onClick=${() => submit()}>${busy ? "Checking…" : "Check answer"}</button>
              <span class="hidden text-sm text-muted sm:inline">
                Keys ${question.qtype === "true_false" ? "T / F" : `A–${"ABCDE"[options.length - 1]}`} then Enter
              </span>
            </div>`}
          `}
    </div>

    ${error && html`<div class="mt-4"><${ErrorNote} message=${error} /></div>`}

    ${feedback &&
    html`<div class="mt-7 border-t border-rule pt-6" aria-live="polite">
      <p class=${`font-serif text-xl font-semibold ${feedback.score >= 1 ? "text-check" : feedback.score > 0 ? "text-ink" : "text-pen"}`}>
        ${verdict}
      </p>
      ${feedback.score < 1 &&
      html`<p class="mt-1">
        The answer is <strong>${feedback.correct_answer}</strong>
        ${feedback.accepted_answers.length > 0 &&
        html`<span class="text-muted"> (also accepted: ${feedback.accepted_answers.join(", ")})</span>`}.
      </p>`}
      ${feedback.feedback &&
      feedback.feedback !== "Correct!" &&
      !feedback.feedback.startsWith("Not quite") &&
      html`<p class="mt-1 text-muted">${feedback.feedback}</p>`}
      ${feedback.explanation && html`<p class="mt-3 max-w-[68ch]">${feedback.explanation}</p>`}

      ${feedback.source_quote &&
      html`<figure class="mt-5 rounded border border-rule bg-paper px-4 py-3">
        <blockquote class="font-serif leading-relaxed">
          <${HighlightedText} text=${feedback.source_quote} quote=${feedback.source_quote} animate />
        </blockquote>
        <figcaption class="mt-2 text-sm text-muted">
          ${feedback.source_label} of ${feedback.source_filename}${" "}
          <button class="link ml-1" onClick=${() => setShowSource(true)}>Open ${feedback.source_label.toLowerCase()}</button>
        </figcaption>
      </figure>`}

      <button ref=${nextRef} class="btn btn-primary mt-6" onClick=${onNext} disabled=${finishing}>
        ${isLastOpen ? (finishing ? "Scoring…" : "See results") : "Next question"}
      </button>
    </div>`}

    ${showSource && html`<${SourcePanel} questionId=${question.id} onClose=${() => setShowSource(false)} />`}
  </article>`;
}
