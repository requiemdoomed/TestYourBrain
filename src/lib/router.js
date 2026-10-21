// A tiny hash router: #/library, #/quizzes/12?answers=true ...
// Hash URLs work on any static host (GitHub Pages included) without server-side rewrites.

import { html, useEffect, useState } from "../../vendor/preact-htm.js";

export function currentRoute() {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [path, search = ""] = raw.split("?");
  return { path: path || "/", query: new URLSearchParams(search), raw };
}

export function navigate(to, { replace = false } = {}) {
  const target = `#${to.startsWith("/") ? to : `/${to}`}`;
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  if (replace) {
    history.replaceState(null, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

export function useRoute() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** Match "/quizzes/:id" against a path; returns params or null. Numeric params become numbers. */
export function matchPath(pattern, path) {
  const keys = [];
  const re = new RegExp(
    "^" +
      pattern.replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "/?$",
  );
  const m = re.exec(path);
  if (!m) return null;
  return Object.fromEntries(keys.map((k, i) => [k, /^\d+$/.test(m[i + 1]) ? Number(m[i + 1]) : m[i + 1]]));
}

/** <${Link} href="/library" class="btn">Library<//> */
export function Link({ href, children, ...props }) {
  return html`<a href=${`#${href}`} ...${props}>${children}</a>`;
}
