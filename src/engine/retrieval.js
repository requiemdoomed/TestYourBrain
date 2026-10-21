// The retrieval half of RAG: cosine similarity search over chunk vectors with MMR re-ranking,
// so the passages handed to the question writer cover different parts of the material.
// (The Python version keeps the vectors in ChromaDB; here they live in IndexedDB next to the chunks.)

import { cosine, dot, norm } from "./embeddings.js";

/**
 * @param {Float32Array} query
 * @param {{id: string, vector: Float32Array}[]} chunks  candidates (already filtered to a document/topic)
 * @returns the chosen chunks with a `score` (cosine similarity)
 */
export function search(query, chunks, { k = 6, fetchK = 20, lambda = 0.6, excludeIds = null } = {}) {
  let pool = chunks;
  if (excludeIds?.size) {
    const rest = chunks.filter((c) => !excludeIds.has(c.id));
    if (rest.length) pool = rest; // everything was excluded: allow reuse
  }
  const scored = pool
    .map((c) => ({ ...c, score: cosine(query, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(k, fetchK));
  return mmr(query, scored, k, lambda);
}

export function mmr(query, cands, k, lambda) {
  if (cands.length <= k) return cands;
  const unit = (v) => {
    const n = norm(v) + 1e-9;
    return Float32Array.from(v, (x) => x / n);
  };
  const mat = cands.map((c) => unit(c.vector));
  const q = unit(query);
  const rel = mat.map((v) => dot(v, q));
  const chosen = [];
  const remaining = cands.map((_, i) => i);
  while (remaining.length && chosen.length < k) {
    let best = remaining[0];
    let bestScore = -Infinity;
    for (const i of remaining) {
      const redundancy = chosen.length ? Math.max(...chosen.map((j) => dot(mat[i], mat[j]))) : 0;
      const s = chosen.length ? lambda * rel[i] - (1 - lambda) * redundancy : rel[i];
      if (s > bestScore) [best, bestScore] = [i, s];
    }
    chosen.push(best);
    remaining.splice(remaining.indexOf(best), 1);
  }
  return chosen.map((i) => cands[i]);
}
