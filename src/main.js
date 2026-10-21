// TestYourBrain, web edition: entry point. index.html loads this module, and it loads everything else.

import { html, render } from "../vendor/preact-htm.js";
import { Footer, Page, TopBar } from "./components/ui.js";
import { AuthProvider } from "./lib/auth.js";
import { Link, matchPath, useRoute } from "./lib/router.js";
import { AuthPage } from "./pages/auth.js";
import { BuilderPage } from "./pages/builder.js";
import { DocumentPage } from "./pages/document.js";
import { HomePage } from "./pages/home.js";
import { LibraryPage } from "./pages/library.js";
import { PrintPage } from "./pages/print.js";
import { QuizPage } from "./pages/quiz.js";
import { ResultsPage } from "./pages/results.js";
import { SettingsPage } from "./pages/settings.js";
import { ResultImportPage, SharedOpenPage, SharedPage } from "./pages/shared.js";
import { TakePage } from "./pages/take.js";
import { resumeInterruptedWork } from "./server/jobs.js";

const ROUTES = [
  ["/", () => html`<${HomePage} />`],
  ["/login", () => html`<${AuthPage} mode="login" />`],
  ["/register", () => html`<${AuthPage} mode="register" />`],
  ["/library", () => html`<${LibraryPage} />`],
  ["/settings", () => html`<${SettingsPage} />`],
  ["/documents/:id", (p) => html`<${DocumentPage} key=${p.id} id=${p.id} />`],
  ["/quizzes/new", () => html`<${BuilderPage} />`],
  ["/quizzes/:id/print", (p) => html`<${PrintPage} key=${p.id} id=${p.id} />`],
  ["/quizzes/:id", (p) => html`<${QuizPage} key=${p.id} id=${p.id} />`],
  ["/attempts/:id/results", (p) => html`<${ResultsPage} key=${p.id} id=${p.id} />`],
  ["/attempts/:id", (p) => html`<${TakePage} key=${p.id} id=${p.id} />`],
  ["/shared/:token", (p) => html`<${SharedPage} key=${p.token} token=${p.token} />`],
  ["/s/:payload", (p) => html`<${SharedOpenPage} key=${p.payload} payload=${p.payload} />`],
  ["/r/:payload", (p) => html`<${ResultImportPage} key=${p.payload} payload=${p.payload} />`],
];

function NotFound() {
  return html`<${Page} narrow>
    <h1 class="text-3xl">Page not found</h1>
    <p class="mt-3 text-muted">That link doesn't lead anywhere in TestYourBrain.</p>
    <${Link} href="/" class="btn btn-primary mt-6">Go to the start page<//>
  <//>`;
}

function App() {
  const { path } = useRoute();
  let page = null;
  for (const [pattern, view] of ROUTES) {
    const params = matchPath(pattern, path);
    if (params) {
      page = view(params);
      break;
    }
  }
  return html`<${AuthProvider}>
    <${TopBar} />
    ${page ?? html`<${NotFound} />`}
    <${Footer} />
  <//>`;
}

// Scroll to the top when moving to another page
let lastPath = null;
window.addEventListener("hashchange", () => {
  const path = window.location.hash.split("?")[0];
  if (path !== lastPath) window.scrollTo(0, 0);
  lastPath = path;
});

const root = document.getElementById("app");
root.textContent = "";
render(html`<${App} />`, root);

// Ask the browser not to clear the library when disk space runs low, then resume interrupted work
navigator.storage?.persist?.().catch(() => {});
resumeInterruptedWork().catch((err) => console.warn("Couldn't resume interrupted work", err));
