// Split a document's chunks into contiguous topics and give each topic a name.
//
// Boundaries are placed where the meaning changes most between neighbouring chunks
// (a TextTiling-style approach on embeddings), nudged towards changes of slide/page
// heading. Names come from the LLM when one is configured, otherwise from headings + TF-IDF keywords.

import { meanVector, norm, dot } from "./embeddings.js";
import { ENGLISH_STOP_WORDS } from "./stopwords.js";

const CONT = /\b(cont(inued|'d|\.)?|part \d+|\(\d+\)|\d+\/\d+)\b/gi;

function normTitle(t) {
  if (!t) return "";
  t = t.toLowerCase().replace(CONT, "");
  return t.replace(/[^a-z0-9 ]+/g, " ").trim();
}

export function targetTopicCount(nChunks) {
  if (nChunks <= 2) return 1;
  return Math.trunc(Math.max(2, Math.min(12, Math.round(nChunks ** 0.6))));
}

function headingGroups(titles) {
  const groups = [];
  let start = 0;
  for (let i = 1; i <= titles.length; i++) {
    if (i === titles.length || normTitle(titles[i]) !== normTitle(titles[start])) {
      groups.push([start, i]);
      start = i;
    }
  }
  return groups;
}

const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const pairwise = (arr) => arr.slice(1).map((b, i) => [arr[i], b]);

/** Returns [start, end) index pairs over the chunk list. */
export function segment(vectors, titles, locations, texts, unit = "page") {
  const n = vectors.length;
  if (n <= 2) return [[0, n]];
  const sizes = texts.map((t) => t.length);
  const totalChars = sum(sizes);
  const size = (a, b) => sum(sizes.slice(a, b));

  // 1) Notes/documents with real section headings: one topic per heading (merging tiny sections).
  //    Slides are excluded because every slide has its own title.
  if (unit !== "slide" && titles.filter(Boolean).length >= 0.8 * n) {
    const groups = headingGroups(titles);
    if (groups.length >= 2 && groups.length <= 12) {
      const merged = [];
      for (const [a, b] of groups) {
        if (merged.length && size(...merged[merged.length - 1]) < 150) merged[merged.length - 1][1] = b;
        else merged.push([a, b]);
      }
      if (merged.length > 1 && size(...merged[merged.length - 1]) < 150) {
        const last = merged.pop();
        merged[merged.length - 1][1] = last[1];
      }
      if (merged.length >= 2) return merged.map(([a, b]) => [a, b]);
    }
  }

  // 2) Otherwise: cut where neighbouring chunks are least similar (TextTiling on embeddings)
  const k = targetTopicCount(n);
  const vecs = vectors.map((v) => {
    const nv = norm(v) + 1e-9;
    return Float32Array.from(v, (x) => x / nv);
  });
  const w = n < 40 ? 2 : 3;
  const scores = [];
  for (let i = 1; i < n; i++) {
    const left = meanVector(vecs.slice(Math.max(0, i - w), i));
    const right = meanVector(vecs.slice(i, Math.min(n, i + w)));
    let sim = dot(left, right) / (norm(left) * norm(right) + 1e-9);
    const tPrev = normTitle(titles[i - 1]);
    const tNext = normTitle(titles[i]);
    if (tPrev && tNext && tPrev !== tNext) sim -= 0.1;
    else if (tPrev && tPrev === tNext) sim += 0.15;
    if (locations[i] === locations[i - 1]) sim += 0.25; // avoid cutting a single page/slide in half
    scores.push([sim, i]);
  }
  const minChars = Math.min(400, totalChars / (k * 2.5));
  const ok = (bounds) => pairwise(bounds).every(([a, b]) => size(a, b) >= minChars);

  const chosen = [];
  for (const [, i] of [...scores].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const trial = [0, ...[...chosen, i].sort((a, b) => a - b), n];
    if (ok(trial)) chosen.push(i);
    if (chosen.length >= k - 1) break;
  }
  return pairwise([0, ...chosen.sort((a, b) => a - b), n]);
}

// ---------------------------------------------------------------------- naming

const STOP_TITLES = new Set([
  "",
  "overview",
  "outline",
  "agenda",
  "contents",
  "table of contents",
  "summary",
  "questions",
  "introduction",
  "references",
  "thank you",
  "example",
  "examples",
  "recap",
  "review",
]);

const KEYWORD_STOP = new Set([
  ...ENGLISH_STOP_WORDS,
  ..."speaker notes slide slides page figure example examples remind students lecture chapter section using used use also called known include".split(
    " ",
  ),
]);

/** TF-IDF keywords per text, like scikit-learn's TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True). */
export function keywords(texts, top = 5) {
  const docs = texts.map((t) => {
    const words = (t.toLowerCase().match(/\b[a-z][a-z-]{2,}\b/g) ?? []).filter((w) => !KEYWORD_STOP.has(w));
    const grams = [...words];
    for (let i = 0; i + 1 < words.length; i++) grams.push(`${words[i]} ${words[i + 1]}`);
    const counts = new Map();
    for (const g of grams) counts.set(g, (counts.get(g) ?? 0) + 1);
    return counts;
  });
  const n = docs.length;
  const df = new Map();
  for (const d of docs) for (const g of d.keys()) df.set(g, (df.get(g) ?? 0) + 1);
  const maxDf = n > 2 ? 0.9 * n : n;
  return docs.map((counts) => {
    const weights = [];
    let sq = 0;
    for (const [g, tf] of counts) {
      const d = df.get(g);
      if (d > maxDf) continue;
      const wgt = (1 + Math.log(tf)) * (Math.log((1 + n) / (1 + d)) + 1);
      weights.push([g, wgt]);
      sq += wgt * wgt;
    }
    // Highest weight first; on a tie the single word wins over a two-word run ("program" over the
    // stop-word-stripped "process program"), then alphabetical order
    const words = (s) => s.split(" ").length;
    weights.sort((a, b) => b[1] - a[1] || words(a[0]) - words(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const out = [];
    for (const [term, wgt] of weights) {
      if (wgt <= 0 || out.length >= top) break;
      if (out.some((w) => term.includes(w) || w.includes(term))) continue;
      out.push(term);
    }
    return sq ? out : [];
  });
}

function firstSentences(text, maxChars = 220) {
  text = text.replace(/\s+/g, " ").trim();
  let out = "";
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (out.length + s.length > maxChars && out) break;
    out += s + " ";
  }
  return out.trim().slice(0, maxChars);
}

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Name topics without an LLM: the most common heading in the topic (the earliest wins a tie),
 *  or failing that its top TF-IDF keywords. Mutates and returns the spans. */
export function nameOffline(spans, texts, titles) {
  const topicTexts = spans.map((s) => texts.slice(s.start, s.end).join(" "));
  const kws = keywords(topicTexts);
  const used = new Map();
  spans.forEach((span, idx) => {
    const headings = titles
      .slice(span.start, span.end)
      .filter((t) => t && t.trim() && !STOP_TITLES.has(normTitle(t)) && t.length <= 80)
      .map((t) => t.replace(CONT, "").replace(/^[\s\-:–]+|[\s\-:–]+$/g, ""))
      .filter(Boolean);
    const counts = new Map();
    for (const h of headings) counts.set(h, (counts.get(h) ?? 0) + 1);
    let name = "";
    let best = -1;
    for (const [h, c] of counts) if (c > best) [name, best] = [h, c]; // Map keeps first-seen order: ties go to the earliest
    if (!name && kws[idx].length) name = kws[idx].slice(0, 3).map(titleCase).join(", ");
    name = name || "General";
    used.set(name, (used.get(name) ?? 0) + 1);
    if (used.get(name) > 1) name = `${name} (${used.get(name)})`;
    span.name = name.slice(0, 120);
    span.keywords = kws[idx];
    span.summary = firstSentences(topicTexts[idx]);
  });
  return spans;
}

// ---------------------------------------------------------------------- with an LLM

export const TOPIC_LABELS_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Index of the topic as given in the input" },
          name: { type: "string", description: "Short topic title, 2-6 words, title case" },
          summary: { type: "string", description: "One sentence describing what this part of the material covers" },
          keywords: { type: "array", items: { type: "string" }, description: "3-6 key terms from this part" },
        },
        required: ["index", "name", "summary", "keywords"],
        additionalProperties: false,
      },
    },
  },
  required: ["topics"],
  additionalProperties: false,
};

export const LLM_TOPICS_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          first_location: { type: "integer", description: "Number of the first page/slide/section of this topic" },
          name: { type: "string", description: "Short topic title, 2-6 words, title case" },
          summary: { type: "string", description: "One sentence describing what this topic covers" },
          keywords: { type: "array", items: { type: "string" }, description: "3-6 key terms" },
        },
        required: ["first_location", "name", "summary", "keywords"],
        additionalProperties: false,
      },
    },
  },
  required: ["topics"],
  additionalProperties: false,
};

async function nameWithLLM(llm, spans, texts, titles, filename) {
  const parts = spans.map((s, i) => {
    const heads = [...new Set(titles.slice(s.start, s.end).filter(Boolean))].slice(0, 6);
    const excerpt = texts.slice(s.start, s.end).join(" ").slice(0, 1500);
    return `<topic index="${i}">\nHeadings: ${heads.join("; ") || "(none)"}\nText: ${excerpt}\n</topic>`;
  });
  const prompt =
    `The study material '${filename}' has been split into ${spans.length} consecutive parts. ` +
    "Give each part a short, specific topic name (2-6 words, no numbering), a one-sentence summary, " +
    "and key terms. Names must be distinct and describe the actual content, not generic words like " +
    "'Introduction' unless that is genuinely the content.\n\n" +
    parts.join("\n\n");
  try {
    const out = await llm.structured({ name: "TopicLabels", schema: TOPIC_LABELS_SCHEMA, prompt });
    const byIdx = new Map((out.topics ?? []).map((t) => [t.index, t]));
    if (byIdx.size < spans.length * 0.5) return false;
    spans.forEach((s, i) => {
      const t = byIdx.get(i);
      if (t?.name?.trim()) {
        s.name = t.name.trim().slice(0, 120);
        s.summary = (t.summary ?? "").trim();
        s.keywords = (t.keywords ?? []).slice(0, 6);
      }
    });
    return true;
  } catch (err) {
    console.warn("LLM topic naming failed, using offline names:", err);
    return false;
  }
}

async function segmentWithLLM(llm, texts, titles, locations, filename, unit) {
  const locs = [...new Set(locations)];
  if (locs.length < 3 || locs.length > 400) return null;
  const per = locs.length <= 80 ? 320 : 160;
  const lines = locs.map((loc) => {
    const idx = locations.flatMap((other, i) => (other === loc ? [i] : []));
    const title = idx.map((i) => titles[i]).find(Boolean) ?? "";
    const body = idx
      .map((i) => texts[i])
      .join(" ")
      .replace(/\n/g, " ")
      .slice(0, per);
    return `[${unit} ${loc}] ${title ? `Title: ${title} | ` : ""}${body}`;
  });
  const maxTopics = Math.min(12, Math.max(2, Math.round(locs.length ** 0.6)));
  const prompt =
    `Below is an outline of the study material '${filename}', one line per ${unit}. Split it into ` +
    `between 2 and ${maxTopics} topics. Each topic must be a contiguous ` +
    `run of ${unit}s; give the number of its first ${unit}. Topics must be in order and the first topic must ` +
    `start at ${unit} ${locs[0]}. Fold title, agenda and reference ${unit}s into a neighbouring topic. ` +
    "Give each topic a specific name (2-6 words), a one-sentence summary and key terms.\n\n" +
    lines.join("\n");
  let out;
  try {
    out = await llm.structured({ name: "LLMTopics", schema: LLM_TOPICS_SCHEMA, prompt });
  } catch (err) {
    console.warn("LLM topic segmentation failed, using embedding segmentation:", err);
    return null;
  }
  const starts = new Map();
  for (const t of [...(out.topics ?? [])].sort((a, b) => a.first_location - b.first_location)) {
    if (locs.includes(t.first_location) && !starts.has(t.first_location)) starts.set(t.first_location, t);
  }
  if (!starts.size) return null;
  if (!starts.has(locs[0])) {
    // make sure the beginning is covered
    const first = Math.min(...starts.keys());
    starts.set(locs[0], starts.get(first));
    starts.delete(first);
  }
  const begins = [...starts.keys()].sort((a, b) => a - b);
  const spans = [];
  begins.forEach((loc, j) => {
    const endLoc = j + 1 < begins.length ? begins[j + 1] : null;
    const idx = locations.flatMap((other, i) => (other >= loc && (endLoc === null || other < endLoc) ? [i] : []));
    if (!idx.length) return;
    const t = starts.get(loc);
    spans.push({
      start: idx[0],
      end: idx[idx.length - 1] + 1,
      name: String(t.name ?? "")
        .trim()
        .slice(0, 120),
      summary: String(t.summary ?? "").trim(),
      keywords: (t.keywords ?? []).slice(0, 6),
    });
  });
  // spans must tile the chunk list exactly
  if (
    !spans.length ||
    spans[0].start !== 0 ||
    spans[spans.length - 1].end !== texts.length ||
    pairwise(spans).some(([a, b]) => a.end !== b.start) ||
    spans.some((s) => !s.name)
  ) {
    return null;
  }
  return spans;
}

/** Topic spans for a document: { start, end, name, summary, keywords }[] */
export async function buildTopics({ vectors, texts, titles, locations, filename, unit = "page", llm = null }) {
  if (llm) {
    const llmSpans = await segmentWithLLM(llm, texts, titles, locations, filename, unit);
    if (llmSpans) {
      // keep TF-IDF keywords and summaries as a fallback when the LLM returns none
      const offline = nameOffline(
        llmSpans.map((s) => ({ start: s.start, end: s.end })),
        texts,
        titles,
      );
      llmSpans.forEach((s, i) => {
        s.keywords = s.keywords.length ? s.keywords : offline[i].keywords;
        s.summary = s.summary || offline[i].summary;
      });
      return llmSpans;
    }
  }
  const spans = segment(vectors, titles, locations, texts, unit).map(([start, end]) => ({ start, end }));
  nameOffline(spans, texts, titles); // headings + TF-IDF keywords
  if (llm) await nameWithLLM(llm, spans, texts, titles, filename); // better names when an LLM is configured
  return spans;
}
