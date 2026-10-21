import { html } from "../../vendor/preact-htm.js";
import { useAuth } from "../lib/auth.js";
import { useTitle } from "../lib/hooks.js";
import { Link } from "../lib/router.js";

function HomeActions() {
  const { user } = useAuth();
  return html`<div class="mt-8 flex flex-wrap gap-3">
    ${user
      ? html`
          <${Link} href="/library" class="btn btn-primary">Open your library<//>
          <${Link} href="/quizzes/new" class="btn btn-secondary">Make a new quiz<//>
        `
      : html`
          <${Link} href="/register" class="btn btn-primary">Create an account<//>
          <${Link} href="/login" class="btn btn-secondary">Sign in<//>
        `}
  </div>`;
}

const STEPS = [
  ["Upload", "Drop in this week's slides or a whole folder of notes. Text is extracted page by page."],
  ["Pick topics", "The material is split into topics. Quiz yourself on everything or only what's on Friday's exam."],
  ["Answer", "Multiple-choice, true/false and short answers, checked the moment you answer, with an explanation."],
  ["Revise", "Your results list your weakest topics and the exact slides to reread before you try again."],
];

export function HomePage() {
  useTitle("");
  return html`<main class="flex-1">
    <section
      class="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-12 pb-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-20"
    >
      <div>
        <h1 class="max-w-[16ch] text-[2.6rem] leading-[1.08] sm:text-[3.4rem]">Turn your own lecture slides into a quiz.</h1>
        <p class="mt-6 max-w-[52ch] text-lg text-muted">
          Upload slides, PDFs, Word documents or notes. TestYourBrain splits them into topics and writes questions from
          what is actually in them, so every answer points back to the slide or page it came from.
        </p>
        <${HomeActions} />
        <p class="mt-6 text-sm text-muted">
          Reads PDF, PowerPoint, Word, Markdown and text files. Scanned pages are read with OCR. Runs entirely in your
          browser: your files are never uploaded to a server.
        </p>
      </div>
      <${TraceDemo} />
    </section>

    <section class="border-t border-rule bg-sheet">
      <div class="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 class="text-2xl">From notes to revision plan in four steps</h2>
        <ol class="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          ${STEPS.map(
            ([title, text], i) => html`<li key=${title} class="border-t-2 border-ink pt-4">
              <span class="font-serif text-3xl font-semibold text-rule-strong">${i + 1}</span>
              <h3 class="mt-2 font-sans text-base font-bold">${title}</h3>
              <p class="mt-1 text-muted">${text}</p>
            </li>`,
          )}
        </ol>
        <p class="mt-12 max-w-[70ch] text-muted">
          Save quizzes to retake later, retake only the questions you missed, or share a link so classmates can take the
          same quiz without making an account.${" "}
          <${Link} href="/register" class="link">Create a free account<//> to start.
        </p>
      </div>
    </section>
  </main>`;
}

function TraceDemo() {
  return html`<figure aria-label="Example: a question generated from a highlighted sentence on a slide" class="relative">
    <div
      class="sheet relative rotate-[-1.2deg] px-6 pt-5 pb-7 shadow-[0_1px_0_#d5dff0,0_14px_30px_-18px_rgb(22_33_62/0.35)]"
    >
      <div class="flex items-baseline justify-between text-sm text-muted">
        <span>biology-week-3.pptx</span>
        <span>Slide 5</span>
      </div>
      <h3 class="mt-3 text-xl">The Calvin Cycle</h3>
      <ul class="mt-3 space-y-2 font-serif text-[1.02rem] leading-relaxed">
        <li>Fixes carbon dioxide into organic molecules in the stroma.</li>
        <li><span class="marker">The enzyme RuBisCO catalyses the first step of carbon fixation.</span></li>
        <li>Three turns of the cycle produce one molecule of G3P.</li>
      </ul>
    </div>

    <div
      class="sheet relative z-10 -mt-4 ml-6 rotate-[0.8deg] px-6 py-5 shadow-[0_18px_40px_-20px_rgb(22_33_62/0.45)] sm:ml-16"
    >
      <p class="text-sm text-muted">Question 4 of 12, multiple choice</p>
      <p class="mt-2 font-serif text-lg leading-snug">Which enzyme catalyses the first step of carbon fixation?</p>
      <div class="mt-4 grid gap-2 text-[0.95rem]">
        ${["ATP synthase", "RuBisCO", "Chlorophyll a", "NADPH oxidase"].map(
          (o, i) => html`<div key=${o} class="choice" data-state=${i === 1 ? "correct" : undefined}>
            <span class="choice-key">${"ABCD"[i]}</span>
            <span class="pt-0.5">${o}</span>
          </div>`,
        )}
      </div>
      <p class="mt-4 text-sm">
        <span class="font-semibold text-check">Correct.</span>${" "}
        <span class="text-muted">Source: Slide 5, highlighted above.</span>
      </p>
    </div>
  </figure>`;
}
