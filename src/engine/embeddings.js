// Text embeddings for retrieval and topic splitting.
//
// "minilm": the sentence-transformers model all-MiniLM-L6-v2, run in the browser with Transformers.js
//           (downloaded once, about 25 MB, then cached by the browser).
// "hashing": bag-of-words hashing vectors, identical to scikit-learn's HashingVectorizer as used by the
//           Python version. No download; used when the model can't be loaded (offline, blocked CDN).

import { ENGLISH_STOP_WORDS } from "./stopwords.js";

export const HASHING = "hashing";
export const MINILM = "minilm";
export const MINILM_MODEL = "Xenova/all-MiniLM-L6-v2";
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js";
const N_FEATURES = 1024;

export const EMBEDDING_LABELS = {
  [MINILM]: "sentence-transformers/all-MiniLM-L6-v2",
  [HASHING]: "hashing (offline fallback)",
};

// ------------------------------------------------------------------ hashing vectors

/** MurmurHash3 (x86, 32-bit) of the UTF-8 bytes of `key`, as a signed integer. */
export function murmur3(key, seed = 0) {
  const data = new TextEncoder().encode(key);
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const blocks = data.length >> 2;
  for (let i = 0; i < blocks; i++) {
    let k = data[i * 4] | (data[i * 4 + 1] << 8) | (data[i * 4 + 2] << 16) | (data[i * 4 + 3] << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const tail = blocks * 4;
  switch (data.length & 3) {
    case 3:
      k ^= data[tail + 2] << 16;
    // falls through
    case 2:
      k ^= data[tail + 1] << 8;
    // falls through
    case 1:
      k ^= data[tail];
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

function hashingFeatures(text) {
  const words = (String(text).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter(
    (w) => !ENGLISH_STOP_WORDS.has(w),
  );
  const grams = [...words];
  for (let i = 0; i + 1 < words.length; i++) grams.push(`${words[i]} ${words[i + 1]}`);
  return grams;
}

export function hashingEmbed(text) {
  const vec = new Float32Array(N_FEATURES);
  for (const g of hashingFeatures(text)) vec[Math.abs(murmur3(g)) % N_FEATURES] += 1;
  let norm = 0;
  for (const v of vec) norm += v * v;
  if (norm === 0) {
    vec[0] = 1; // never return an all-zero vector
    return vec;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

// ------------------------------------------------------------------ MiniLM in the browser

let minilm = null; // Promise of the feature-extraction pipeline
let minilmFailed = null;

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function loadMiniLM(onStatus) {
  if (minilmFailed) throw minilmFailed;
  if (!minilm) {
    onStatus?.("Loading the embedding model (first time only, about 25 MB)");
    minilm = withTimeout(
      import(/* @vite-ignore */ TRANSFORMERS_URL).then(({ pipeline, env }) => {
        env.allowLocalModels = false;
        return pipeline("feature-extraction", MINILM_MODEL, { dtype: "q8" });
      }),
      120000,
      "The embedding model took too long to download.",
    ).catch((err) => {
      minilm = null;
      minilmFailed = err;
      throw err;
    });
  }
  return minilm;
}

/** Is the MiniLM model usable right now? Loads it if needed. */
export async function miniLMAvailable(onStatus) {
  if (typeof window === "undefined") return false;
  try {
    await loadMiniLM(onStatus);
    return true;
  } catch {
    return false;
  }
}

/**
 * Embed texts with the requested backend. Returns { backend, vectors } where backend is the one
 * actually used: asking for MiniLM falls back to hashing when the model can't be loaded.
 */
export async function embedTexts(texts, backend = MINILM, onStatus) {
  if (backend === MINILM && (await miniLMAvailable(onStatus))) {
    const extractor = await loadMiniLM();
    const vectors = [];
    for (let i = 0; i < texts.length; i += 16) {
      onStatus?.(`Embedding passages ${i + 1}–${Math.min(i + 16, texts.length)} of ${texts.length}`);
      const out = await extractor(texts.slice(i, i + 16), { pooling: "mean", normalize: true });
      const dim = out.dims[out.dims.length - 1];
      for (let r = 0; r < out.dims[0]; r++) vectors.push(Float32Array.from(out.data.slice(r * dim, (r + 1) * dim)));
    }
    return { backend: MINILM, vectors };
  }
  return { backend: HASHING, vectors: texts.map(hashingEmbed) };
}

export async function embedQuery(text, backend) {
  if (backend === MINILM) {
    const { backend: used, vectors } = await embedTexts([text], MINILM);
    if (used === MINILM) return vectors[0];
    return null; // the document was embedded with MiniLM, but the model isn't available now
  }
  return hashingEmbed(text);
}

// ------------------------------------------------------------------ vector maths

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function norm(a) {
  return Math.sqrt(dot(a, a));
}

export function cosine(a, b) {
  return dot(a, b) / (norm(a) * norm(b) + 1e-9);
}

export function meanVector(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i];
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length;
  return out;
}
