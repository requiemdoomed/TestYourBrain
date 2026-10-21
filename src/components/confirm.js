import { html, useCallback, useEffect, useRef, useState } from "../../vendor/preact-htm.js";

/**
 * A promise-based replacement for window.confirm, using the native <dialog> element
 * (so focus trapping and Escape-to-close come for free).
 *
 *   const [confirmDialog, confirm] = useConfirm();
 *   if (await confirm({ title: "Delete this quiz?", confirmLabel: "Delete quiz", danger: true })) ...
 *   return html`${confirmDialog} ...`
 */
export function useConfirm() {
  const [request, setRequest] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (request && ref.current && !ref.current.open) ref.current.showModal();
  }, [request]);

  const ask = useCallback((opts) => new Promise((resolve) => setRequest({ ...opts, resolve })), []);

  function close(ok) {
    request?.resolve(ok);
    ref.current?.close();
    setRequest(null);
  }

  const dialog = request
    ? html`<dialog
        ref=${ref}
        aria-labelledby="confirm-title"
        onCancel=${(e) => {
          e.preventDefault();
          close(false);
        }}
        onClick=${(e) => e.target === ref.current && close(false)}
        class="m-auto w-[min(92vw,26rem)] rounded border border-rule bg-sheet p-0 text-ink shadow-2xl backdrop:bg-ink/40"
      >
        <div class="p-6">
          <h2 id="confirm-title" class="text-xl">${request.title}</h2>
          ${request.body && html`<p class="mt-2 text-muted">${request.body}</p>`}
          <div class="mt-6 flex flex-wrap justify-end gap-2">
            <button class="btn btn-secondary" onClick=${() => close(false)} autofocus>Cancel</button>
            <button class=${`btn ${request.danger ? "btn-danger-solid" : "btn-primary"}`} onClick=${() => close(true)}>
              ${request.confirmLabel}
            </button>
          </div>
        </div>
      </dialog>`
    : null;

  return [dialog, ask];
}
