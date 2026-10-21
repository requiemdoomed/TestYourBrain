import { html, useEffect, useState } from "../../vendor/preact-htm.js";
import { ErrorNote, Page, Spinner } from "../components/ui.js";
import { api, plural, TYPE_LABEL } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { useApi, useTitle } from "../lib/hooks.js";
import { Link, navigate } from "../lib/router.js";

/** #/s/<quiz in the link>: store the quiz on this device, then show it at #/shared/<token>. */
export function SharedOpenPage({ payload }) {
  const { ready } = useAuth();
  const [error, setError] = useState(null);
  useTitle("Shared quiz");
  useEffect(() => {
    if (!ready) return;
    api("/api/shared/open", { method: "POST", json: { payload } })
      .then((q) => navigate(`/shared/${q.share_token}`, { replace: true }))
      .catch((e) => setError(e.message));
  }, [payload, ready]);
  if (error) {
    return html`<${Page} narrow>
      <h1 class="text-3xl">This quiz isn't available</h1>
      <p class="mt-3 text-muted">${error}</p>
    <//>`;
  }
  return html`<${Page} narrow><${Spinner} label="Opening the shared quiz" /><//>`;
}

export function SharedPage({ token }) {
  const { user, ready } = useAuth();
  const quiz = useApi(ready ? `/api/shared/${token}` : null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  useTitle(quiz.data?.title ?? "Shared quiz");

  if (quiz.error) {
    return html`<${Page} narrow>
      <h1 class="text-3xl">This quiz isn't available</h1>
      <p class="mt-3 text-muted">${quiz.error} Ask the person who sent the link to share it again.</p>
    <//>`;
  }
  const q = quiz.data;
  if (!q || !ready) return html`<${Page} narrow><${Spinner} /><//>`;

  async function start(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const a = await api(`/api/shared/${token}/attempts`, {
        method: "POST",
        json: { guest_name: user ? null : name.trim() || null },
      });
      navigate(`/attempts/${a.id}`);
    } catch (err) {
      setError(err?.message ?? "Could not start the quiz.");
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const copy = await api(`/api/shared/${token}/save`, { method: "POST" });
      setSaved(copy.id);
    } catch (err) {
      setError(err?.message ?? "Could not save the quiz.");
    } finally {
      setBusy(false);
    }
  }

  const types = q.question_types.map((t) => TYPE_LABEL[t].toLowerCase()).join(", ");
  return html`<${Page} narrow>
    <p class="text-muted">${q.is_owner ? "You shared this quiz" : `${q.owner_name} shared a quiz with you`}</p>
    <h1 class="mt-1 text-3xl sm:text-4xl">${q.title}</h1>
    <p class="mt-3 text-muted">
      ${plural(q.question_count, "question")} (${types}), ${q.difficulty} difficulty. Written from
      ${" "}${q.documents.map((d) => d.filename).join(", ")}.
    </p>
    ${q.topics.length > 0 && html`<p class="mt-2 text-sm text-muted">Topics: ${q.topics.join(", ")}</p>`}

    <form onSubmit=${start} class="sheet mt-8 space-y-4 p-6">
      ${q.is_owner
        ? html`<p>This is your quiz. Classmates who open the link will see this page.</p>`
        : user
          ? html`<p>You'll take this quiz as <strong>${user.name}</strong>. Afterwards you can send your result to ${q.owner_name}.</p>`
          : html`<div>
              <label class="label" for="guest">Your name</label>
              <input
                id="guest"
                class="field max-w-sm"
                value=${name}
                onInput=${(e) => setName(e.currentTarget.value)}
                placeholder="Shown to the person who shared it"
                maxlength="120"
              />
              <p class="mt-2 text-sm text-muted">
                No account needed.${" "}
                <${Link} href=${`/login?next=${encodeURIComponent(`/shared/${token}`)}`} class="link">Sign in<//>${" "}
                to save this quiz to your own library.
              </p>
            </div>`}
      ${error && html`<${ErrorNote} message=${error} />`}
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-primary px-6" disabled=${busy}>Start quiz</button>
        ${user &&
        !q.is_owner &&
        !saved &&
        html`<button type="button" class="btn btn-secondary" onClick=${save} disabled=${busy}>Save to my library</button>`}
        ${saved && html`<${Link} href=${`/quizzes/${saved}`} class="btn btn-secondary">Saved. Open in library<//>`}
      </div>
    </form>

    ${q.leaderboard.length > 0 &&
    html`<section class="mt-10">
      <h2 class="text-xl">${q.is_owner ? "Classmates who took it" : "Taken on this device"}</h2>
      <ol class="sheet ruled mt-3">
        ${q.leaderboard.map(
          (row) => html`<li key=${row.id} class="flex items-baseline justify-between gap-3 px-4 py-2.5">
            <${Link} href=${`/attempts/${row.id}/results`} class="truncate hover:underline">${row.name}<//>
            <span class="font-serif font-semibold">${Math.round(row.percent ?? 0)}%</span>
          </li>`,
        )}
      </ol>
    </section>`}
  <//>`;
}

/** #/r/<result in the link>: a classmate's result, added to the owner's quiz. */
export function ResultImportPage({ payload }) {
  const { user, ready } = useAuth();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  useTitle("Classmate's result");
  useEffect(() => {
    if (!ready) return;
    if (!user) {
      navigate(`/login?next=${encodeURIComponent(`/r/${payload}`)}`, { replace: true });
      return;
    }
    api("/api/results/import", { method: "POST", json: { payload } })
      .then(setState)
      .catch((e) => setError(e.message));
  }, [payload, ready, user]);

  if (error) {
    return html`<${Page} narrow>
      <h1 class="text-3xl">Couldn't add this result</h1>
      <div class="mt-4"><${ErrorNote} message=${error} /></div>
    <//>`;
  }
  if (!state) return html`<${Page} narrow><${Spinner} label="Adding the result" /><//>`;
  return html`<${Page} narrow>
    <h1 class="text-3xl">${state.duplicate ? `${state.name}'s result is already here` : `Added ${state.name}'s result`}</h1>
    <p class="mt-3 text-muted">It's listed under Classmates on the quiz page.</p>
    <${Link} href=${`/quizzes/${state.quiz_id}`} class="btn btn-primary mt-6">Open the quiz<//>
  <//>`;
}
