// Client for the TestYourBrain API. In this web version the "server" runs in the same page
// (src/server/api.js), so requests never leave the browser, but the calls look exactly like the
// fetch calls of the full-stack version.

import { handle, uploadDocuments } from "../server/api.js";
import { navigate } from "./router.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** api("/api/quizzes", { method: "POST", json: {...} }) */
export async function api(path, init = {}) {
  try {
    return await handle(init.method ?? "GET", path, init.json ?? null);
  } catch (err) {
    const status = err?.status ?? 500;
    if (status === 401 && !path.startsWith("/api/auth/")) {
      // Signed out (or the account was removed): come back here after signing in again
      const here = window.location.hash.slice(1) || "/library";
      navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
    }
    throw new ApiError(status, err?.message || "Something went wrong.");
  }
}

/** Save files to this browser's storage and start reading them; reports progress as a fraction. */
export async function uploadFiles(files, onProgress) {
  try {
    return await uploadDocuments(files, onProgress);
  } catch (err) {
    throw new ApiError(err?.status ?? 500, err?.message || "Upload failed.");
  }
}

export const TYPE_LABEL = {
  mcq: "Multiple choice",
  true_false: "True / false",
  short_answer: "Short answer",
};

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function unitWord(unit, n) {
  const w = unit === "slide" ? "slide" : unit === "section" ? "section" : "page";
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The full URL of an in-app path, e.g. for share links. */
export function absoluteUrl(hashPath) {
  const base = window.location.href.split("#")[0];
  return `${base}${hashPath.startsWith("#") ? hashPath : `#${hashPath}`}`;
}
