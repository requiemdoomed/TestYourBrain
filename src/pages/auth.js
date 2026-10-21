import { html, useState } from "../../vendor/preact-htm.js";
import { ErrorNote, Page } from "../components/ui.js";
import { useAuth } from "../lib/auth.js";
import { useTitle } from "../lib/hooks.js";
import { Link, navigate, useRoute } from "../lib/router.js";

export function AuthPage({ mode }) {
  const { login, register } = useAuth();
  const { query } = useRoute();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isLogin = mode === "login";
  useTitle(isLogin ? "Sign in" : "Create account");

  const next = query.get("next");
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isLogin) await login(email, password);
      else await register(name, email, password);
      navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/library", { replace: true });
    } catch (err) {
      setError(err?.message ?? "Something went wrong.");
      setBusy(false);
    }
  }

  return html`<${Page} narrow>
    <div class="mx-auto max-w-md">
      <h1 class="text-3xl">${isLogin ? "Sign in" : "Create your account"}</h1>
      <p class="mt-2 text-muted">
        ${isLogin
          ? "Pick up where you left off with your quizzes."
          : "Your uploads and quizzes are private to your account, and stay in this browser."}
      </p>
      <form onSubmit=${submit} class="sheet mt-8 space-y-5 p-6">
        ${!isLogin &&
        html`<div>
          <label class="label" for="name">Name</label>
          <input id="name" class="field" autocomplete="name" required value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
        </div>`}
        <div>
          <label class="label" for="email">Email</label>
          <input
            id="email"
            type="email"
            class="field"
            autocomplete="email"
            required
            value=${email}
            onInput=${(e) => setEmail(e.currentTarget.value)}
          />
        </div>
        <div>
          <label class="label" for="password">Password</label>
          <input
            id="password"
            type="password"
            class="field"
            autocomplete=${isLogin ? "current-password" : "new-password"}
            minlength=${isLogin ? undefined : 8}
            required
            value=${password}
            onInput=${(e) => setPassword(e.currentTarget.value)}
          />
          ${!isLogin && html`<p class="mt-1 text-sm text-muted">At least 8 characters.</p>`}
        </div>
        ${error && html`<${ErrorNote} message=${error} />`}
        <button class="btn btn-primary w-full" disabled=${busy}>
          ${busy ? (isLogin ? "Signing in…" : "Creating account…") : isLogin ? "Sign in" : "Create account"}
        </button>
      </form>
      <p class="mt-5 text-center text-muted">
        ${isLogin
          ? html`New here?${" "}<${Link} class="link" href=${`/register${nextQuery}`}>Create an account<//>`
          : html`Already have an account?${" "}<${Link} class="link" href=${`/login${nextQuery}`}>Sign in<//>`}
      </p>
      <p class="mt-3 text-center text-sm text-muted">
        Accounts live in this browser only, so several people can share a computer without seeing each other's files.
      </p>
    </div>
  <//>`;
}
