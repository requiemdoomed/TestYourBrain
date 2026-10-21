import { html, useEffect } from "../../vendor/preact-htm.js";
import { useAuth } from "../lib/auth.js";
import { Link, navigate } from "../lib/router.js";

export function Page({ children, narrow = false }) {
  return html`<main class=${`mx-auto w-full ${narrow ? "max-w-3xl" : "max-w-6xl"} flex-1 px-4 py-8 sm:px-6 sm:py-10`}>
    ${children}
  </main>`;
}

export function Spinner({ label = "Loading" }) {
  return html`<div role="status" class="flex items-center gap-3 py-10 text-muted">
    <span class="h-4 w-4 animate-spin rounded-full border-2 border-rule-strong border-t-ink"></span>
    <span>${label}…</span>
  </div>`;
}

export function ErrorNote({ message, onRetry }) {
  return html`<div
    role="alert"
    class="flex flex-wrap items-center gap-3 rounded border border-[#e9b6b2] bg-pen-soft px-4 py-3 text-pen"
  >
    <span class="flex-1">${message}</span>
    ${onRetry && html`<button class="btn btn-secondary" onClick=${onRetry}>Try again</button>`}
  </div>`;
}

export function ProgressBar({ value, indeterminate = false, label }) {
  return html`<div
    role="progressbar"
    aria-label=${label}
    aria-valuenow=${indeterminate ? undefined : Math.round(value ?? 0)}
    aria-valuemin="0"
    aria-valuemax="100"
    class="relative h-2 w-full overflow-hidden rounded-full bg-rule"
  >
    ${indeterminate
      ? html`<span
          class="absolute inset-y-0 left-0 w-2/5 rounded-full bg-ink"
          style="animation: indeterminate 1.4s ease-in-out infinite"
        ></span>`
      : html`<span
          class="absolute inset-y-0 left-0 rounded-full bg-ink transition-[width] duration-500"
          style=${{ width: `${Math.max(3, value ?? 0)}%` }}
        ></span>`}
  </div>`;
}

const BADGES = {
  processing: ["Reading file", "bg-[#e8eef9] text-blue"],
  generating: ["Writing questions", "bg-[#e8eef9] text-blue"],
  ready: ["Ready", "bg-check-soft text-check"],
  failed: ["Failed", "bg-pen-soft text-pen"],
};

export function StatusBadge({ status }) {
  const [text, cls] = BADGES[status] ?? [status, "bg-rule text-ink"];
  return html`<span class=${`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${cls}`}>${text}</span>`;
}

export function ScoreRing({ percent, size = 120 }) {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const color = percent >= 70 ? "var(--color-check)" : percent >= 50 ? "#b7791f" : "var(--color-pen)";
  return html`<svg width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`} role="img" aria-label=${`${percent}% score`}>
    <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--color-rule)" stroke-width="9" />
    <circle
      cx=${size / 2}
      cy=${size / 2}
      r=${r}
      fill="none"
      stroke=${color}
      stroke-width="9"
      stroke-linecap="round"
      stroke-dasharray=${`${(c * percent) / 100} ${c}`}
      transform=${`rotate(-90 ${size / 2} ${size / 2})`}
    />
    <text
      x="50%"
      y="50%"
      dominant-baseline="central"
      text-anchor="middle"
      font-family="var(--font-serif)"
      font-weight="650"
      font-size=${size / 4.4}
      fill="var(--color-ink)"
    >
      ${Math.round(percent)}%
    </text>
  </svg>`;
}

/** Sends signed-out visitors to the sign-in page. Renders children only for signed-in users. */
export function RequireAuth({ children }) {
  const { user, ready } = useAuth();
  useEffect(() => {
    if (ready && !user) {
      const next = window.location.hash.slice(1) || "/library";
      navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
    }
  }, [ready, user]);
  if (!ready || !user) return html`<${Page}><${Spinner} /><//>`;
  return children;
}

export function TopBar() {
  const { user, ready, logout } = useAuth();
  return html`<header class="border-b border-rule bg-sheet print:hidden">
    <div class="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
      <${Link} href=${user ? "/library" : "/"} class="flex min-w-0 items-center gap-2.5" aria-label="TestYourBrain home">
        <${Logo} />
        <span class="font-serif text-[1.2rem] font-semibold tracking-tight">TestYourBrain</span>
      <//>
      <nav class="ml-auto flex items-center gap-1 sm:gap-2">
        ${ready &&
        user &&
        html`
          <${Link} href="/library" class="btn btn-ghost hidden sm:inline-flex">Library<//>
          <${Link} href="/quizzes/new" class="btn btn-ghost hidden sm:inline-flex">New quiz<//>
          <${Link} href="/settings" class="btn btn-ghost hidden sm:inline-flex">Settings<//>
          <span class="mx-2 hidden h-6 w-px bg-rule md:block"></span>
          <span class="hidden text-sm text-muted md:inline">${user.name}</span>
          <button
            class="btn btn-ghost"
            onClick=${async () => {
              await logout();
              navigate("/");
            }}
          >
            Sign out
          </button>
        `}
        ${ready &&
        !user &&
        html`
          <${Link} href="/login" class="btn btn-ghost">Sign in<//>
          <${Link} href="/register" class="btn btn-primary hidden sm:inline-flex">Create account<//>
        `}
      </nav>
    </div>
  </header>`;
}

export function Logo({ size = 30 }) {
  // An answer bubble with a highlighter stroke through it
  return html`<svg width=${size} height=${size} viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="12" width="26" height="9" rx="2" fill="#FFE45C" transform="rotate(-4 16 16)" />
    <circle cx="16" cy="16" r="10" fill="none" stroke="#16213E" stroke-width="2.5" />
    <path
      d="M11.5 16.2l3.2 3.2 6-6.4"
      fill="none"
      stroke="#16213E"
      stroke-width="2.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>`;
}

export function Footer() {
  return html`<footer class="border-t border-rule print:hidden">
    <div
      class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-muted sm:px-6"
    >
      <span>TestYourBrain — made by Swayam Shakya</span>
      <span>Questions come only from the material you upload. Everything stays in your browser.</span>
    </div>
  </footer>`;
}

export function EmptyState({ title, children, action }) {
  return html`<div class="rounded border border-dashed border-rule-strong px-6 py-10 text-center">
    <p class="font-serif text-lg font-semibold">${title}</p>
    ${children && html`<div class="mx-auto mt-2 max-w-md text-muted">${children}</div>`}
    ${action && html`<div class="mt-5">${action}</div>`}
  </div>`;
}

/** A quiet information box. */
export function Note({ children }) {
  return html`<p class="rounded border border-rule bg-sheet px-4 py-3 text-sm text-muted">${children}</p>`;
}
