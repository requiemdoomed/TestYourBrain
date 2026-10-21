import { html, useEffect, useMemo, useState } from "../../vendor/preact-htm.js";
import { EmptyState, ErrorNote, Page, RequireAuth, Spinner } from "../components/ui.js";
import { api, TYPE_LABEL } from "../lib/api.js";
import { useApi, useTitle } from "../lib/hooks.js";
import { Link, navigate, useRoute } from "../lib/router.js";

const DIFFICULTIES = [
  { value: "easy", label: "Easy", hint: "Definitions and facts" },
  { value: "medium", label: "Medium", hint: "How ideas connect" },
  { value: "hard", label: "Hard", hint: "Apply and analyse" },
  { value: "mixed", label: "Mixed", hint: "A bit of each" },
];

export function BuilderPage() {
  useTitle("Make a quiz");
  return html`<${RequireAuth}><${BuilderInner} /><//>`;
}

const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function BuilderInner() {
  const { query } = useRoute();
  const docParam = query.get("doc");
  const topicParam = query.get("topic");
  const docs = useApi("/api/documents");
  const ready = useMemo(() => docs.data?.filter((d) => d.status === "ready") ?? [], [docs.data]);

  const [chosen, setSelected] = useState(docParam ? [Number(docParam)] : null);
  // Until the user picks, preselect the only file if there is just one
  const selected = useMemo(() => chosen ?? (ready.length === 1 ? [ready[0].id] : []), [chosen, ready]);
  const [details, setDetails] = useState({});
  const [topics, setTopics] = useState(topicParam ? [Number(topicParam)] : []);
  const [types, setTypes] = useState(["mcq", "true_false", "short_answer"]);
  const [difficulty, setDifficulty] = useState("medium");
  const [count, setCount] = useState(10);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Load topics for the selected files
  useEffect(() => {
    selected.forEach((id) => {
      if (details[id]) return;
      api(`/api/documents/${id}`)
        .then((d) => setDetails((prev) => ({ ...prev, [id]: d })))
        .catch(() => undefined);
    });
  }, [selected, details]);

  const visibleTopicIds = selected.flatMap((id) => details[id]?.topics.map((t) => t.id) ?? []);
  const chosenTopics = topics.filter((t) => visibleTopicIds.includes(t));

  async function submit(e) {
    e.preventDefault();
    if (!selected.length) return setError("Choose at least one file.");
    if (!types.length) return setError("Choose at least one question type.");
    setBusy(true);
    setError(null);
    try {
      const quiz = await api("/api/quizzes", {
        method: "POST",
        json: {
          title: title.trim() || null,
          document_ids: selected,
          topic_ids: chosenTopics,
          num_questions: count,
          difficulty,
          question_types: types,
        },
      });
      navigate(`/quizzes/${quiz.id}`);
    } catch (err) {
      setError(err?.message ?? "Could not start the quiz.");
      setBusy(false);
    }
  }

  if (docs.error) return html`<${Page}><${ErrorNote} message=${docs.error} onRetry=${docs.reload} /><//>`;
  if (!docs.data) return html`<${Page}><${Spinner} /><//>`;

  if (ready.length === 0) {
    return html`<${Page} narrow>
      <h1 class="text-3xl">Make a quiz</h1>
      <div class="mt-8">
        <${EmptyState} title="Nothing to quiz on yet" action=${html`<${Link} href="/library" class="btn btn-primary">Upload material<//>`}>
          Upload lecture slides, a PDF, a Word document or notes first. Once a file is read, you can build quizzes from it
          here.
        <//>
      </div>
    <//>`;
  }

  return html`<${Page} narrow>
    <${Link} href="/library" class="link text-sm">Back to library<//>
    <h1 class="mt-3 text-3xl sm:text-4xl">Make a quiz</h1>
    <p class="mt-1 text-muted">Questions are written only from the files and topics you pick.</p>

    <form onSubmit=${submit} class="mt-8 space-y-10">
      <fieldset>
        <legend class="font-serif text-xl font-semibold">Material</legend>
        <div class="sheet ruled mt-3">
          ${ready.map(
            (d) => html`<label key=${d.id} class="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-paper">
              <input
                type="checkbox"
                class="h-4.5 w-4.5 accent-ink"
                checked=${selected.includes(d.id)}
                onChange=${() => setSelected(toggle(selected, d.id))}
              />
              <span class="min-w-0 flex-1 truncate font-medium">${d.filename}</span>
              <span class="text-sm text-muted">${d.topic_count} topics</span>
            </label>`,
          )}
        </div>
      </fieldset>

      ${selected.length > 0 &&
      html`<fieldset>
        <legend class="font-serif text-xl font-semibold">Topics</legend>
        <p class="mt-1 text-sm text-muted">
          ${chosenTopics.length === 0
            ? "All topics are included. Tick some to focus the quiz."
            : `${chosenTopics.length} ${chosenTopics.length === 1 ? "topic" : "topics"} chosen.`}
          ${chosenTopics.length > 0 &&
          html`<button type="button" class="link ml-2" onClick=${() => setTopics([])}>Use all topics</button>`}
        </p>
        <div class="mt-3 space-y-4">
          ${selected.map((id) => {
            const d = details[id];
            if (!d) return html`<${Spinner} key=${id} label="Loading topics" />`;
            return html`<div key=${id}>
              ${selected.length > 1 && html`<p class="mb-2 text-sm font-semibold">${d.filename}</p>`}
              <div class="flex flex-wrap gap-2">
                ${d.topics.map((t) => {
                  const on = topics.includes(t.id);
                  return html`<button
                    key=${t.id}
                    type="button"
                    aria-pressed=${on}
                    onClick=${() => setTopics((s) => toggle(s, t.id))}
                    class=${`rounded-full border-[1.5px] px-3.5 py-1.5 text-sm transition-colors ${
                      on ? "border-ink bg-ink text-white" : "border-rule-strong bg-sheet hover:border-ink"
                    }`}
                  >
                    ${t.name}
                  </button>`;
                })}
              </div>
            </div>`;
          })}
        </div>
      </fieldset>`}

      <fieldset>
        <legend class="font-serif text-xl font-semibold">Question types</legend>
        <div class="mt-3 grid gap-2 sm:grid-cols-3">
          ${Object.keys(TYPE_LABEL).map(
            (t) => html`<label
              key=${t}
              class=${`choice cursor-pointer items-center ${types.includes(t) ? "" : "opacity-70"}`}
              data-state=${types.includes(t) ? "selected" : undefined}
            >
              <input type="checkbox" class="h-4.5 w-4.5 accent-ink" checked=${types.includes(t)} onChange=${() => setTypes((s) => toggle(s, t))} />
              <span class="font-medium">${TYPE_LABEL[t]}</span>
            </label>`,
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend class="font-serif text-xl font-semibold">Difficulty</legend>
        <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          ${DIFFICULTIES.map(
            (d) => html`<label key=${d.value} class="choice cursor-pointer flex-col gap-0.5" data-state=${difficulty === d.value ? "selected" : undefined}>
              <input
                type="radio"
                name="difficulty"
                class="sr-only"
                checked=${difficulty === d.value}
                onChange=${() => setDifficulty(d.value)}
              />
              <span class="font-semibold">${d.label}</span>
              <span class="text-sm text-muted">${d.hint}</span>
            </label>`,
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend class="font-serif text-xl font-semibold">Length</legend>
        <div class="mt-3 flex flex-wrap items-center gap-4">
          <input
            type="range"
            min="3"
            max="50"
            value=${count}
            onInput=${(e) => setCount(Number(e.currentTarget.value))}
            class="w-full max-w-sm accent-ink"
            aria-label="Number of questions"
          />
          <span class="font-serif text-2xl font-semibold">${count}</span>
          <span class="text-muted">questions</span>
        </div>
      </fieldset>

      <div>
        <label class="label" for="title">Quiz name <span class="font-normal text-muted">(optional)</span></label>
        <input
          id="title"
          class="field max-w-md"
          placeholder="Named after the file if left empty"
          value=${title}
          onInput=${(e) => setTitle(e.currentTarget.value)}
          maxlength="200"
        />
      </div>

      ${error && html`<${ErrorNote} message=${error} />`}
      <div class="flex flex-wrap items-center gap-4 border-t border-rule pt-6">
        <button class="btn btn-primary" disabled=${busy || !selected.length || !types.length}>
          ${busy ? "Starting…" : `Generate ${count} questions`}
        </button>
        <span class="text-sm text-muted">Usually takes a few seconds, or under a minute with an AI model.</span>
      </div>
    </form>
  <//>`;
}
