// App settings (AI model, embeddings, OCR), kept in this browser's localStorage.
// The Python version reads the same choices from backend/.env.

import { createLLM, llmLabel } from "../engine/llm.js";

const KEY = "tyb.settings";

export const DEFAULT_SETTINGS = {
  provider: "offline", // offline | anthropic | openai
  apiKey: "",
  model: "",
  baseUrl: "",
  structuredMethod: "auto", // auto | json_schema | function_calling
  embeddings: "minilm", // minilm (falls back to hashing) | hashing
  ocr: true,
};

let cache = null;

export function getSettings() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    stored = {};
  }
  cache = { ...DEFAULT_SETTINGS, ...stored };
  return cache;
}

export function saveSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable: keep the settings for this visit only */
  }
  return cache;
}

/** The configured model, or null in offline mode. */
export function currentLLM() {
  return createLLM(getSettings());
}

export function currentLLMLabel() {
  return currentLLM() ? llmLabel(getSettings()) : "offline";
}
