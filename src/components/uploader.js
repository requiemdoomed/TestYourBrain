import { html, useRef, useState } from "../../vendor/preact-htm.js";
import { uploadFiles } from "../lib/api.js";
import { ErrorNote, ProgressBar } from "./ui.js";

const EXTENSIONS = [".pdf", ".pptx", ".docx", ".txt", ".md", ".markdown", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"];
const ACCEPT = EXTENSIONS.join(",");
const MAX_MB = 50;

/** Catch the obvious problems before saving anything. */
function checkFiles(files) {
  for (const f of files) {
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!EXTENSIONS.includes(ext)) {
      return ext === ".ppt" || ext === ".doc"
        ? `${f.name} is an old Office format. Save it as ${ext}x and upload that instead.`
        : `${f.name} isn't a supported file. Use PDF, PowerPoint, Word, text, Markdown or an image.`;
    }
    if (f.size > MAX_MB * 1024 * 1024) return `${f.name} is larger than ${MAX_MB} MB.`;
    if (f.size === 0) return `${f.name} is empty.`;
  }
  return null;
}

export function Uploader({ onUploaded, compact = false }) {
  const input = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);

  async function upload(files) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const problem = checkFiles(list);
    if (problem) {
      setError(problem);
      if (input.current) input.current.value = "";
      return;
    }
    setError(null);
    setProgress(0);
    setBusy(list.length === 1 ? list[0].name : `${list.length} files`);
    try {
      onUploaded(await uploadFiles(list, setProgress));
    } catch (e) {
      setError(e?.message ?? "Upload failed.");
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }

  return html`<div>
    <div
      onDragOver=${(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave=${() => setDragging(false)}
      onDrop=${(e) => {
        e.preventDefault();
        setDragging(false);
        upload(e.dataTransfer.files);
      }}
      class=${`rounded border-2 border-dashed text-center transition-colors ${
        dragging ? "border-ink bg-marker-soft" : "border-rule-strong bg-sheet"
      } ${compact ? "px-4 py-6" : "px-6 py-10"}`}
    >
      ${busy
        ? html`<div class="mx-auto max-w-sm space-y-3">
            <p>${progress < 1 ? `Saving ${busy}… ${Math.round(progress * 100)}%` : `Saving ${busy}…`}</p>
            <${ProgressBar} value=${progress * 100} indeterminate=${progress >= 1} label="Saving files" />
          </div>`
        : html`
            <p class="font-serif text-lg font-semibold">Drop lecture slides, PDFs, Word files or notes here</p>
            <p class="mt-1 text-sm text-muted">PDF, PPTX, DOCX, TXT, Markdown or scanned images, up to 50 MB each</p>
            <button type="button" class="btn btn-primary mt-5" onClick=${() => input.current?.click()}>Choose files</button>
          `}
      <input
        ref=${input}
        type="file"
        multiple
        accept=${ACCEPT}
        class="sr-only"
        aria-label="Choose files to upload"
        onChange=${(e) => upload(e.currentTarget.files)}
      />
    </div>
    ${error && html`<div class="mt-3"><${ErrorNote} message=${error} /></div>`}
  </div>`;
}
