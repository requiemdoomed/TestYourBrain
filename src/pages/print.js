import { html, useState } from "../../vendor/preact-htm.js";
import { ErrorNote, Page, RequireAuth, Spinner } from "../components/ui.js";
import { useApi, useTitle } from "../lib/hooks.js";
import { Link } from "../lib/router.js";

/** A paper version of a quiz: questions first, answer key on its own page. */
export function PrintPage({ id }) {
  return html`<${RequireAuth}><${Worksheet} id=${id} /><//>`;
}

function Worksheet({ id }) {
  const quiz = useApi(`/api/quizzes/${id}?answers=true`);
  const [withKey, setWithKey] = useState(true);
  useTitle(quiz.data ? `${quiz.data.title} (worksheet)` : "Worksheet");

  if (quiz.error) return html`<${Page} narrow><${ErrorNote} message=${quiz.error} onRetry=${quiz.reload} /><//>`;
  const q = quiz.data;
  if (!q) return html`<${Page} narrow><${Spinner} /><//>`;
  const questions = q.questions;

  return html`<${Page} narrow>
    <div class="mb-8 flex flex-wrap items-center gap-4 print:hidden">
      <${Link} href=${`/quizzes/${q.id}`} class="link text-sm">Back to quiz<//>
      <label class="ml-auto flex items-center gap-2 text-sm">
        <input type="checkbox" class="accent-ink" checked=${withKey} onChange=${(e) => setWithKey(e.currentTarget.checked)} />
        Include answer key
      </label>
      <button class="btn btn-primary" onClick=${() => window.print()}>Print</button>
    </div>

    <article class="sheet px-8 py-10 print:border-0 print:p-0">
      <header class="border-b-2 border-ink pb-4">
        <h1 class="text-3xl">${q.title}</h1>
        <p class="mt-1 text-sm text-muted">${questions.length} questions, from ${q.documents.map((d) => d.filename).join(", ")}</p>
        <div class="mt-6 grid grid-cols-[auto_1fr_auto_10rem] items-end gap-x-3 text-sm">
          <span>Name</span>
          <span class="border-b border-ink"></span>
          <span>Date</span>
          <span class="border-b border-ink"></span>
        </div>
      </header>

      <ol class="mt-8 space-y-7">
        ${questions.map(
          (question, i) => html`<li key=${question.id} class="break-inside-avoid">
            <p class="font-serif text-[1.05rem] leading-snug">
              <span class="mr-2 font-semibold">${i + 1}.</span>
              ${question.qtype === "true_false" && html`<span class="text-muted">True or false: </span>`}
              ${question.prompt}
            </p>
            ${question.qtype === "mcq" &&
            question.options &&
            html`<ul class="mt-2 grid gap-1.5 pl-6 sm:grid-cols-2">
              ${question.options.map(
                (o, j) => html`<li key=${j} class="flex items-start gap-2">
                  <span
                    class="mt-0.5 inline-grid h-5 w-5 flex-none place-items-center rounded-full border border-ink text-xs font-semibold"
                    >${"ABCDEF"[j]}</span
                  >
                  <span>${o}</span>
                </li>`,
              )}
            </ul>`}
            ${question.qtype === "true_false" &&
            html`<p class="mt-2 pl-6 text-sm"><span class="mr-6">◯ True</span><span>◯ False</span></p>`}
            ${question.qtype === "short_answer" &&
            html`<div class="mt-4 space-y-5 pl-6">
              <div class="border-b border-rule-strong"></div>
              <div class="border-b border-rule-strong"></div>
            </div>`}
          </li>`,
        )}
      </ol>

      ${withKey &&
      html`<section class="mt-12 border-t-2 border-ink pt-6 print:mt-0 print:break-before-page print:border-t-0 print:pt-0">
        <h2 class="text-2xl">Answer key</h2>
        <ol class="mt-4 space-y-2.5 text-sm">
          ${questions.map(
            (question, i) => html`<li key=${question.id} class="break-inside-avoid">
              <span class="font-semibold">${i + 1}. </span>
              ${question.qtype === "mcq" && question.options
                ? `${"ABCDEF"[question.options.indexOf(question.answer)] ?? "?"}. ${question.answer}`
                : question.answer}
              <span class="text-muted">, ${question.source_label} of ${question.source_filename}</span>
            </li>`,
          )}
        </ol>
      </section>`}
    </article>
  <//>`;
}
