import { html, useEffect, useRef, useState } from "../../vendor/preact-htm.js";
import { useConfirm } from "../components/confirm.js";
import { ErrorNote, Note, Page, RequireAuth, Spinner } from "../components/ui.js";
import { DEFAULT_MODELS } from "../engine/llm.js";
import { exportBackup, importBackup, VERSION } from "../server/api.js";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { useTitle } from "../lib/hooks.js";
import { navigate } from "../lib/router.js";

const PROVIDERS = [
  { value: "offline", label: "Built-in generator", hint: "No key needed. Works offline." },
  { value: "anthropic", label: "Anthropic Claude", hint: "Uses your Anthropic API key." },
  { value: "openai", label: "OpenAI or compatible", hint: "OpenAI, or a local server such as Ollama." },
];

export function SettingsPage() {
  useTitle("Settings");
  return html`<${RequireAuth}><${SettingsInner} /><//>`;
}

function SettingsInner() {
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [test, setTest] = useState(null);

  useEffect(() => {
    api("/api/settings").then(setForm);
  }, []);
  if (!form) return html`<${Page} narrow><${Spinner} /><//>`;
  const set = (patch) => {
    setForm({ ...form, ...patch });
    setSaved(false);
    setTest(null);
  };

  async function save(e) {
    e?.preventDefault();
    setError(null);
    try {
      setForm(await api("/api/settings", { method: "PUT", json: form }));
      setSaved(true);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  async function runTest() {
    if (!(await save())) return;
    setTest({ busy: true });
    try {
      const out = await api("/api/settings/test", { method: "POST" });
      setTest({ ok: true, message: `Connected to ${out.model}. Questions will now be written by the model.` });
    } catch (err) {
      setTest({ ok: false, message: err.message });
    }
  }

  const ai = form.provider !== "offline";
  return html`<${Page} narrow>
    <h1 class="text-3xl sm:text-4xl">Settings</h1>
    <p class="mt-1 text-muted">These settings are saved in this browser.</p>

    <form onSubmit=${save} class="mt-8 space-y-10">
      <fieldset>
        <legend class="font-serif text-xl font-semibold">Who writes the questions</legend>
        <div class="mt-3 grid gap-2 sm:grid-cols-3">
          ${PROVIDERS.map(
            (p) => html`<label key=${p.value} class="choice cursor-pointer flex-col gap-0.5" data-state=${form.provider === p.value ? "selected" : undefined}>
              <input type="radio" name="provider" class="sr-only" checked=${form.provider === p.value} onChange=${() => set({ provider: p.value })} />
              <span class="font-semibold">${p.label}</span>
              <span class="text-sm text-muted">${p.hint}</span>
            </label>`,
          )}
        </div>

        ${ai &&
        html`<div class="mt-6 space-y-5">
          <div>
            <label class="label" for="key">API key ${form.provider === "openai" && html`<span class="font-normal text-muted">(not needed for a local server)</span>`}</label>
            <input
              id="key"
              type="password"
              class="field"
              autocomplete="off"
              placeholder=${form.provider === "anthropic" ? "sk-ant-…" : "sk-…"}
              value=${form.apiKey}
              onInput=${(e) => set({ apiKey: e.currentTarget.value })}
            />
            <p class="mt-1 text-sm text-muted">
              Kept in this browser's storage and sent only to ${form.provider === "anthropic" ? "Anthropic" : "the server below"}. Don't use
              a shared computer for this.
            </p>
          </div>
          <div class="grid gap-5 sm:grid-cols-2">
            <div>
              <label class="label" for="model">Model</label>
              <input
                id="model"
                class="field"
                placeholder=${DEFAULT_MODELS[form.provider]}
                value=${form.model}
                onInput=${(e) => set({ model: e.currentTarget.value })}
              />
            </div>
            <div>
              <label class="label" for="base">Server address <span class="font-normal text-muted">(optional)</span></label>
              <input
                id="base"
                class="field"
                placeholder=${form.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
                value=${form.baseUrl}
                onInput=${(e) => set({ baseUrl: e.currentTarget.value })}
              />
            </div>
          </div>
          ${form.provider === "openai" &&
          html`<${Note}>
            For Ollama use${" "}<code>http://localhost:11434/v1</code>${" "}and start it with${" "}
            <code>OLLAMA_ORIGINS=*</code>${" "}so the browser is allowed to call it.
          <//>`}
          <div>
            <label class="label" for="method">Structured output</label>
            <select id="method" class="field max-w-xs" value=${form.structuredMethod} onChange=${(e) => set({ structuredMethod: e.currentTarget.value })}>
              <option value="auto">Automatic</option>
              <option value="json_schema">JSON schema</option>
              <option value="function_calling">Tool calling</option>
            </select>
            <p class="mt-1 text-sm text-muted">Leave on Automatic unless your server only supports one of them.</p>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <button type="button" class="btn btn-secondary" onClick=${runTest} disabled=${test?.busy}>
              ${test?.busy ? "Testing…" : "Test connection"}
            </button>
            ${test && !test.busy && html`<span class=${`text-sm ${test.ok ? "text-check" : "text-pen"}`}>${test.message}</span>`}
          </div>
        </div>`}
      </fieldset>

      <fieldset>
        <legend class="font-serif text-xl font-semibold">Reading your files</legend>
        <div class="mt-3 space-y-3">
          <label class="flex items-start gap-3">
            <input
              type="checkbox"
              class="mt-1 h-4.5 w-4.5 accent-ink"
              checked=${form.embeddings === "minilm"}
              onChange=${(e) => set({ embeddings: e.currentTarget.checked ? "minilm" : "hashing" })}
            />
            <span>
              <span class="font-medium">Use the MiniLM embedding model</span>
              <span class="block text-sm text-muted">
                sentence-transformers/all-MiniLM-L6-v2 finds topics and relevant passages by meaning. Downloaded once
                (about 25 MB); without it, a faster word-matching method is used.
              </span>
            </span>
          </label>
          <label class="flex items-start gap-3">
            <input type="checkbox" class="mt-1 h-4.5 w-4.5 accent-ink" checked=${form.ocr} onChange=${(e) => set({ ocr: e.currentTarget.checked })} />
            <span>
              <span class="font-medium">Read scanned pages with OCR</span>
              <span class="block text-sm text-muted">Tesseract reads pages and slides that are pictures of text. Slower, but needed for scans.</span>
            </span>
          </label>
        </div>
      </fieldset>

      ${error && html`<${ErrorNote} message=${error} />`}
      <div class="flex items-center gap-4 border-t border-rule pt-6">
        <button class="btn btn-primary">Save settings</button>
        ${saved && html`<span class="text-sm text-check">Saved.</span>`}
      </div>
    </form>

    <${DataSection} />

    <p class="mt-12 text-sm text-muted">TestYourBrain ${VERSION}, made by Swayam Shakya.</p>
  <//>`;
}

function DataSection() {
  const { setUser } = useAuth();
  const input = useRef(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDialog, confirm] = useConfirm();

  async function download() {
    setBusy("export");
    setError(null);
    try {
      const data = await exportBackup();
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `testyourbrain-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function restore(file) {
    if (!file) return;
    const ok = await confirm({
      title: "Replace everything with this backup?",
      body: "All accounts, files and quizzes on this device are replaced by the ones in the backup.",
      confirmLabel: "Restore backup",
      danger: true,
    });
    if (input.current) input.current.value = "";
    if (!ok) return;
    setBusy("import");
    setError(null);
    try {
      await importBackup(JSON.parse(await file.text()));
      setUser(null);
      navigate("/login");
    } catch (e) {
      setError(e instanceof SyntaxError ? "That file isn't a backup." : e.message);
      setBusy(null);
    }
  }

  async function wipe() {
    const ok = await confirm({
      title: "Delete everything on this device?",
      body: "All accounts, uploaded files, quizzes and results are removed from this browser. This can't be undone.",
      confirmLabel: "Delete everything",
      danger: true,
    });
    if (!ok) return;
    await api("/api/data", { method: "DELETE" });
    setUser(null);
    navigate("/");
  }

  return html`<section class="mt-12 border-t border-rule pt-8" aria-labelledby="data-h">
    ${confirmDialog}
    <h2 id="data-h" class="font-serif text-xl font-semibold">Your data</h2>
    <p class="mt-1 text-muted">
      Files, quizzes and results are stored only in this browser. Download a backup to move them to another computer or
      browser.
    </p>
    ${error && html`<div class="mt-3"><${ErrorNote} message=${error} /></div>`}
    <div class="mt-4 flex flex-wrap gap-2">
      <button class="btn btn-secondary" onClick=${download} disabled=${!!busy}>${busy === "export" ? "Preparing…" : "Download backup"}</button>
      <button class="btn btn-secondary" onClick=${() => input.current?.click()} disabled=${!!busy}>
        ${busy === "import" ? "Restoring…" : "Restore a backup"}
      </button>
      <input ref=${input} type="file" accept=".json,application/json" class="sr-only" aria-label="Backup file" onChange=${(e) => restore(e.currentTarget.files[0])} />
      <button class="btn btn-danger" onClick=${wipe} disabled=${!!busy}>Delete everything</button>
    </div>
  </section>`;
}
