// Talking to a language model straight from the browser.
//
// The rest of the code only sees a "structured" model: give it a JSON schema and a prompt, get back an
// object matching the schema. Anthropic (Claude), OpenAI and OpenAI-compatible servers (Ollama, LM Studio,
// Groq, ...) are supported. With no key the app stays in offline mode and the rule-based generator is used.
//
// Keys are kept in this browser's localStorage and sent only to the provider you choose.

export const DEFAULT_MODELS = { anthropic: "claude-sonnet-5-5", openai: "gpt-4o-mini" };

export class LLMError extends Error {}

/** "json_schema" (native structured output) or "function_calling" (forced tool call). */
export function structuredMethod(settings) {
  if (settings.structuredMethod && settings.structuredMethod !== "auto") return settings.structuredMethod;
  // Many OpenAI-compatible servers only understand tool calling
  if (settings.provider === "openai" && settings.baseUrl) return "function_calling";
  return "json_schema";
}

export function llmLabel(settings) {
  if (!settings || settings.provider === "offline" || !settings.provider) return "offline";
  return `${settings.provider}:${settings.model || DEFAULT_MODELS[settings.provider] || ""}`;
}

function friendly(status, body) {
  const detail = body?.error?.message || body?.message || "";
  if (status === 401 || status === 403) {
    return detail ? `The provider rejected the request: ${detail}` : "The API key was rejected.";
  }
  if (status === 404) return `Model or endpoint not found${detail ? ": " + detail : ""}.`;
  if (status === 429) return "The provider's rate limit was hit. Wait a moment and try again.";
  return detail || `The model request failed (${status}).`;
}

/** POST JSON, retrying network errors, rate limits and server errors (but not bad requests). */
async function postJSON(url, headers, body, { timeoutMs = 120000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (err) {
      lastError = new LLMError(
        err?.name === "AbortError"
          ? "The model took too long to answer."
          : "Couldn't reach the model. Check the server address, your connection, and that the server allows requests from this site (CORS).",
      );
      continue;
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (res.ok) return json;
    lastError = new LLMError(friendly(res.status, json));
    if (res.status !== 429 && res.status < 500) break;
  }
  throw lastError;
}

function parseJSON(text) {
  if (typeof text !== "string") throw new LLMError("The model returned no text.");
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new LLMError("The model's answer wasn't valid JSON.");
  }
}

function anthropicClient(settings) {
  const base = (settings.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const model = settings.model || DEFAULT_MODELS.anthropic;
  const method = structuredMethod(settings);
  const headers = {
    "x-api-key": settings.apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  return async ({ name, schema, system, prompt }) => {
    const body = { model, max_tokens: 8000, messages: [{ role: "user", content: prompt }] };
    if (system) body.system = system;
    if (method === "function_calling") {
      body.tools = [{ name, description: `Return the ${name} result.`, input_schema: schema }];
      body.tool_choice = { type: "tool", name };
    } else {
      body.output_config = { format: { type: "json_schema", schema } };
    }
    const out = await postJSON(`${base}/v1/messages`, headers, body);
    const content = out?.content ?? [];
    if (method === "function_calling") {
      const call = content.find((c) => c.type === "tool_use");
      if (!call) throw new LLMError("The model didn't return structured output.");
      return call.input;
    }
    return parseJSON(
      content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(""),
    );
  };
}

function openaiClient(settings) {
  const base = (settings.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = settings.model || DEFAULT_MODELS.openai;
  const method = structuredMethod(settings);
  const headers = settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {};
  return async ({ name, schema, system, prompt }) => {
    const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }];
    const body = { model, messages };
    if (method === "function_calling") {
      body.tools = [{ type: "function", function: { name, description: `Return the ${name} result.`, parameters: schema } }];
      body.tool_choice = { type: "function", function: { name } };
    } else {
      body.response_format = { type: "json_schema", json_schema: { name, schema, strict: true } };
    }
    const out = await postJSON(`${base}/chat/completions`, headers, body);
    const msg = out?.choices?.[0]?.message ?? {};
    if (method === "function_calling") {
      const call = msg.tool_calls?.[0]?.function;
      if (!call) {
        if (msg.content) return parseJSON(msg.content);
        throw new LLMError("The model didn't return structured output.");
      }
      return typeof call.arguments === "string" ? parseJSON(call.arguments) : call.arguments;
    }
    if (msg.refusal) throw new LLMError(`The model declined: ${msg.refusal}`);
    return parseJSON(msg.content);
  };
}

/** A structured model for these settings, or null in offline mode. */
export function createLLM(settings) {
  if (!settings || !settings.provider || settings.provider === "offline") return null;
  if (settings.provider === "anthropic" && !settings.apiKey) return null;
  if (settings.provider === "openai" && !settings.apiKey && !settings.baseUrl) return null;
  const call = settings.provider === "anthropic" ? anthropicClient(settings) : openaiClient(settings);
  return { label: llmLabel(settings), structured: call };
}
