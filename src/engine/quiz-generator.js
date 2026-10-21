// Quiz generation with retrieval-augmented generation (RAG).
//
// For each topic chosen for the quiz:
//   1. retrieve the most relevant (and diverse, via MMR) chunks for that topic,
//   2. ask the language model to write questions *only* from those excerpts, citing the excerpt each
//      question is based on plus a verbatim supporting quote,
//   3. verify the citation against the chunk text (re-attribute or drop questions that don't check out).
//
// Without a model (or if a call fails) the rule-based generator is used, so every question is still
// tied to a real slide or page.

import { embedQuery, hashingEmbed, HASHING } from "./embeddings.js";
import { partialRatio, ratio, tokenSetRatio } from "./fuzzy.js";
import { generate as offlineGenerate, TermBank } from "./offline-generator.js";
import { search } from "./retrieval.js";
import { Random } from "./rng.js";
import { normalizeAnswer } from "./text.js";

export const QTYPES = ["mcq", "true_false", "short_answer"];
const TYPE_LABELS = { mcq: "multiple-choice", true_false: "true/false", short_answer: "short-answer" };

const DIFFICULTY_GUIDE = {
  easy: "Easy: test recall of definitions, names and facts that are stated directly in the excerpts.",
  medium:
    "Medium: test understanding - relationships between ideas, cause and effect, comparisons, " +
    "and applying a concept to a simple, concrete case.",
  hard:
    "Hard: test application and analysis - short scenarios, multi-step reasoning, combining two " +
    "ideas from the excerpts, and subtle but clearly wrong distractors. Still answerable from the excerpts.",
};

export const QUESTION_BATCH_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: QTYPES },
          question: { type: "string", description: "The question text (for true_false: a statement to judge)" },
          options: {
            anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
            description: "mcq: exactly 4 distinct options. true_false/short_answer: null",
          },
          correct_answer: {
            type: "string",
            description:
              "mcq: the correct option copied exactly; true_false: 'True' or 'False'; " +
              "short_answer: a concise model answer (a few words or one sentence)",
          },
          accepted_answers: {
            type: "array",
            items: { type: "string" },
            description: "short_answer only: other acceptable phrasings/synonyms (otherwise empty)",
          },
          explanation: {
            type: "string",
            description: "1-2 sentences explaining why the answer is correct, using the material",
          },
          source_id: { type: "string", description: "Id of the excerpt the question is based on, e.g. 'S3'" },
          supporting_quote: {
            type: "string",
            description: "A short verbatim quote (max ~25 words) from that excerpt",
          },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
        },
        required: [
          "type",
          "question",
          "options",
          "correct_answer",
          "accepted_answers",
          "explanation",
          "source_id",
          "supporting_quote",
          "difficulty",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  "You are an experienced university teacher who writes fair, unambiguous exam questions. " +
  "You write questions strictly from the course material excerpts you are given and never " +
  "rely on outside knowledge for the answer.";

function buildPrompt(topic, excerpts, counts, difficulties, avoid) {
  const ctx = excerpts
    .map(
      ([sid, c, fname]) => `<excerpt id="${sid}" location="${c.location_label}" file="${fname}">\n${c.text}\n</excerpt>`,
    )
    .join("\n\n");
  const wanted = Object.entries(counts)
    .filter(([, n]) => n)
    .map(([t, n]) => `${n} ${TYPE_LABELS[t]}`)
    .join(", ");
  const diffCounts = ["easy", "medium", "hard"]
    .map((d) => [d, difficulties.filter((x) => x === d).length])
    .filter(([, n]) => n);
  const diffText = diffCounts.map(([d, n]) => `${n} ${d}`).join(", ");
  const guides = diffCounts.map(([d]) => `- ${DIFFICULTY_GUIDE[d]}`).join("\n");
  const avoidText =
    avoid
      .slice(-25)
      .map((a) => `- ${a}`)
      .join("\n") || "- (none yet)";
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return `Course material on the topic "${topic}":

${ctx}

Write exactly ${total} questions: ${wanted}.
Difficulty mix: ${diffText}.
${guides}

Rules:
- Every question must be answerable using only the excerpts above. Set source_id to the id of the single
  excerpt it is based on, and supporting_quote to a short passage copied word-for-word from that excerpt.
- Spread the questions over different excerpts and different ideas; do not test the same fact twice.
- Multiple-choice: exactly 4 distinct options, exactly one correct; distractors must be plausible and from the
  same domain; correct_answer must be copied exactly from the options. No "all/none of the above".
- True/false: a single clear statement; make roughly half of them false by changing one key detail.
- Short-answer: answerable in a few words or one sentence; give a concise correct_answer and list common
  alternative phrasings in accepted_answers.
- explanation: 1-2 sentences on why the answer is right, grounded in the excerpt.
- Ask about the concepts, never about slide numbers, file names, or the layout of the material.
- Do not repeat or closely paraphrase these existing questions:
${avoidText}`;
}

// ------------------------------------------------------------------ helpers

/** Spread n questions over topics proportionally to their size (largest remainder). */
export function allocate(n, weights) {
  if (!weights.length) return [];
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  if (n < weights.length) {
    // fewer questions than topics: one each for the n largest topics
    const order = weights
      .map((w, i) => [w, i])
      .sort((a, b) => b[0] - a[0] || a[1] - b[1])
      .slice(0, n)
      .map(([, i]) => i);
    return weights.map((_, i) => (order.includes(i) ? 1 : 0));
  }
  const raw = weights.map((w) => Math.max(1, (n * w) / total));
  const base = raw.map(Math.trunc);
  const sum = () => base.reduce((a, b) => a + b, 0);
  while (sum() > n) base[base.indexOf(Math.max(...base))] -= 1;
  const rema = raw
    .map((r, i) => [r - Math.trunc(r), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map(([, i]) => i);
  for (let k = 0; sum() < n; k++) base[rema[k % rema.length]] += 1;
  return base;
}

export function splitTypes(n, types, rng) {
  const seq = rng.shuffle(Array.from({ length: n }, (_, i) => types[i % types.length]));
  return Object.fromEntries(types.map((t) => [t, seq.filter((x) => x === t).length]));
}

export function difficultyList(n, difficulty) {
  if (difficulty === "mixed") return Array.from({ length: n }, (_, i) => ["easy", "medium", "hard"][i % 3]);
  return Array(n).fill(difficulty);
}

function matchOption(answer, options) {
  const na = normalizeAnswer(answer);
  const exact = options.find((o) => normalizeAnswer(o) === na);
  if (exact) return exact;
  // "B" / "B) foo" style answers
  const letters = "abcdefgh";
  if (na.length === 1 && letters.slice(0, options.length).includes(na)) return options[letters.indexOf(na)];
  const best = options.reduce((a, b) => (ratio(normalizeAnswer(b), na) > ratio(normalizeAnswer(a), na) ? b : a));
  return ratio(normalizeAnswer(best), na) >= 85 ? best : null;
}

const argmax = (items, score) => items.reduce((a, b) => (score(b) > score(a) ? b : a));

/**
 * Find the excerpt a question really comes from. Trust the cited excerpt if the supporting quote is in
 * it; otherwise look for the quote in the other excerpts (models sometimes cite the wrong id), and as a
 * last resort match the question and answer wording. Returns null when it can't be tied to the material.
 */
export function attribute(q, excerpts) {
  const quote = String(q.supporting_quote ?? "")
    .trim()
    .toLowerCase();
  const probe = `${q.question} ${q.correct_answer}`.toLowerCase();
  const cited = excerpts.get(
    String(q.source_id ?? "")
      .trim()
      .replace(/^\[|\]$/g, "")
      .toUpperCase(),
  );
  const all = [...excerpts.values()];

  if (quote && cited && partialRatio(quote, cited.text.toLowerCase()) >= 75) return cited;
  if (quote) {
    const best = argmax(all, (c) => partialRatio(quote, c.text.toLowerCase()));
    if (partialRatio(quote, best.text.toLowerCase()) >= 75) return best;
  }
  if (cited && tokenSetRatio(probe, cited.text.toLowerCase()) >= 50) return cited;
  const best = argmax(all, (c) => tokenSetRatio(probe, c.text.toLowerCase()));
  return tokenSetRatio(probe, best.text.toLowerCase()) >= 55 ? best : null;
}

export function cleanModelQuestion(q, rng) {
  const text = String(q.question ?? "").trim();
  if (text.length < 8) return null;
  if (q.type === "mcq") {
    const opts = [];
    for (let o of q.options ?? []) {
      o = String(o).trim();
      if (o && !opts.some((x) => normalizeAnswer(x) === normalizeAnswer(o))) opts.push(o);
    }
    if (opts.length < 3) return null;
    const correct = matchOption(String(q.correct_answer ?? ""), opts);
    if (correct === null) return null;
    rng.shuffle(opts); // models like putting the right answer first
    return { type: "mcq", question: text, options: opts.slice(0, 5), correct_answer: correct, accepted_answers: [] };
  }
  if (q.type === "true_false") {
    const a = normalizeAnswer(q.correct_answer);
    if (!["true", "false", "t", "f"].includes(a)) return null;
    return {
      type: "true_false",
      question: text,
      options: ["True", "False"],
      correct_answer: a.startsWith("t") ? "True" : "False",
      accepted_answers: [],
    };
  }
  if (q.type !== "short_answer" || !String(q.correct_answer ?? "").trim()) return null;
  return {
    type: "short_answer",
    question: text,
    options: null,
    correct_answer: String(q.correct_answer).trim(),
    accepted_answers: (q.accepted_answers ?? [])
      .map((a) => String(a).trim())
      .filter(Boolean)
      .slice(0, 8),
  };
}

/** Run async jobs with at most `limit` in flight, keeping results in order. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// ------------------------------------------------------------------ retrieval for one topic

async function retrieve(plan, allChunks, docs, k, usedChunks) {
  const topic = plan.topic;
  const doc = docs.get(topic.document_id);
  const query = `${topic.name}. ${topic.summary ?? ""} ${(topic.keywords ?? []).join(" ")}`;
  let candidates = allChunks.filter((c) => c.topic_id === topic.id);
  if (!candidates.length) candidates = allChunks.filter((c) => c.document_id === topic.document_id);

  let qvec = doc?.embedding === HASHING ? hashingEmbed(query) : await embedQuery(query, doc?.embedding);
  if (!qvec || candidates.some((c) => !c.vector || c.vector.length !== qvec.length)) {
    // The model these chunks were embedded with isn't available: compare word hashes instead
    qvec = hashingEmbed(query);
    candidates = candidates.map((c) => ({ ...c, vector: hashingEmbed(c.heading ? `${c.heading}\n${c.text}` : c.text) }));
  }
  return search(qvec, candidates, { k, fetchK: Math.max(24, k * 3), excludeIds: usedChunks });
}

// ------------------------------------------------------------------ per-topic generation

async function generateForTopic(plan, ctx, seed) {
  const { types, difficulty, keywords, avoid, avoidSents, usedChunks, llm, allChunks, docs } = ctx;
  const rng = new Random(seed);
  const topic = plan.topic;
  const bank = ctx.bankFor(topic.document_id);
  const k = Math.max(6, Math.min(12, plan.count + 3));
  const retrieved = await retrieve(plan, allChunks, docs, k, usedChunks);
  // Present excerpts in reading order
  const chunks = [...new Map(retrieved.map((r) => [r.id, r])).values()]
    .sort((a, b) => a.location - b.location || a.order - b.order)
    .map((r) => ({ id: r.id, text: r.text, location_label: r.location_label, topic_name: topic.name, heading: r.heading }));
  if (!chunks.length) return [[], false];

  const counts = splitTypes(plan.count, types, rng);
  const diffs = rng.shuffle(difficultyList(plan.count, difficulty));
  const results = [];
  let usedLLM = false;

  if (llm) {
    const excerpts = new Map(chunks.map((c, i) => [`S${i + 1}`, c]));
    const prompt = buildPrompt(
      topic.name,
      [...excerpts].map(([sid, c]) => [sid, c, plan.filename]),
      counts,
      diffs,
      avoid,
    );
    try {
      const batch = await llm.structured({ name: "QuestionBatch", schema: QUESTION_BATCH_SCHEMA, system: SYSTEM_PROMPT, prompt });
      usedLLM = true;
      for (const gq of batch?.questions ?? []) {
        if (!types.includes(gq.type)) continue;
        const cleaned = cleanModelQuestion(gq, rng);
        const src = cleaned ? attribute(gq, excerpts) : null;
        if (!cleaned || !src) continue;
        results.push({
          ...cleaned,
          chunk_id: src.id,
          explanation: String(gq.explanation ?? "").trim(),
          supporting_quote: String(gq.supporting_quote ?? "")
            .trim()
            .slice(0, 500),
          difficulty: difficulty === "mixed" ? gq.difficulty || "medium" : difficulty,
        });
      }
    } catch (err) {
      console.warn(`Model generation failed for topic "${topic.name}", using the built-in generator:`, err);
      ctx.llmError = err.message;
      usedLLM = false;
    }
  }

  const missing = plan.count - results.length;
  if (missing > 0) {
    const have = Object.fromEntries(types.map((t) => [t, results.filter((r) => r.type === t).length]));
    const need = Object.fromEntries(types.map((t) => [t, Math.max(0, (counts[t] ?? 0) - have[t])]));
    const needed = Object.values(need).reduce((a, b) => a + b, 0);
    if (needed < missing) need[types[0]] += missing - needed;
    const extra = offlineGenerate(
      chunks,
      need,
      diffs.slice(0, missing).length ? diffs.slice(0, missing) : [difficulty],
      bank,
      [...(topic.keywords ?? []), ...keywords],
      rng,
      avoidSents,
    );
    results.push(...extra.slice(0, missing));
  }
  for (const r of results) usedChunks.add(r.chunk_id);
  return [results.slice(0, plan.count), usedLLM];
}

// ------------------------------------------------------------------ entry point

/**
 * Write the questions for a quiz.
 * @param quiz      { id, num_questions, difficulty, question_types, topic_filter }
 * @param docs      ready documents the quiz is made from
 * @param topics    all topics of those documents
 * @param chunks    all chunks of those documents (with `vector`)
 * @param previous  questions of the quiz this one follows up on (practice quizzes avoid repeating them)
 * @returns {{ questions: object[], usedLLM: boolean, llmError?: string }}
 */
export async function generateQuizQuestions({ quiz, docs, topics, chunks, llm = null, previous = [], onProgress }) {
  const docMap = new Map(docs.map((d) => [d.id, d]));
  let chosen = quiz.topic_filter?.length ? topics.filter((t) => quiz.topic_filter.includes(t.id)) : topics;
  chosen = [...chosen].sort((a, b) => a.document_id - b.document_id || a.order - b.order);
  if (!chosen.length) throw new Error("No topics found in the selected material.");
  const sizes = new Map(chosen.map((t) => [t.id, chunks.filter((c) => c.topic_id === t.id).length]));
  const nonEmpty = chosen.filter((t) => sizes.get(t.id) > 0);
  if (nonEmpty.length) chosen = nonEmpty;
  const counts = allocate(
    quiz.num_questions,
    chosen.map((t) => Math.max(1, sizes.get(t.id))),
  );
  const plans = chosen
    .map((t, i) => ({ topic: t, filename: docMap.get(t.document_id)?.filename ?? "", count: counts[i], weight: sizes.get(t.id) }))
    .filter((p) => p.count);

  const allKeywords = topics.flatMap((t) => t.keywords ?? []);
  const ctx = {
    types: (quiz.question_types ?? []).filter((t) => QTYPES.includes(t)),
    difficulty: quiz.difficulty,
    // Distractors come from the question's own file, so an operating-systems question never offers
    // "photosynthesis" as an option when a biology deck is in the same quiz
    bankFor(docId) {
      if (!this.banks.has(docId)) {
        const own = chunks.filter((c) => c.document_id === docId).map((c) => c.text);
        const ownKeywords = topics.filter((t) => t.document_id === docId).flatMap((t) => t.keywords ?? []);
        this.banks.set(docId, TermBank.build(own, ownKeywords));
      }
      return this.banks.get(docId);
    },
    banks: new Map(),
    keywords: allKeywords,
    // A practice quiz should ask new questions, not repeat the quiz it follows up on
    avoid: previous.map((q) => q.prompt),
    avoidSents: new Set(previous.map((q) => q.source_quote).filter(Boolean)),
    usedChunks: new Set(),
    llm,
    allChunks: chunks,
    docs: docMap,
    llmError: null,
  };
  if (!ctx.types.length) ctx.types = [...QTYPES];

  const generated = [];
  let usedLLM = false;
  let done = 0;
  const outputs = await pool(plans, llm ? 4 : 1, async (plan, i) => {
    const out = await generateForTopic(plan, ctx, quiz.id * 1000 + i);
    done += 1;
    onProgress?.(Math.round((90 * done) / plans.length));
    return out;
  });
  outputs.forEach(([questions, used], i) => {
    usedLLM ||= used;
    for (const q of questions) generated.push([plans[i], q]);
  });

  // Keep a question unless it nearly repeats one already kept (or one of the quiz this follows up on)
  const final = [];
  const keep = (plan, q, allowRepeats = false) => {
    const text = q.question.toLowerCase();
    if (final.some(([, f]) => ratio(text, f.question.toLowerCase()) > 90)) return;
    if (!allowRepeats && ctx.avoid.some((a) => ratio(text, a.toLowerCase()) > 95)) return;
    final.push([plan, q]);
  };
  for (const [plan, q] of generated) keep(plan, q);

  // Fill any shortfall (topics with little text, repeated or rejected model questions) with rule-based
  // questions from the largest topics first
  const topUp = (avoidSents, allowRepeats = false) => {
    const rng = new Random(quiz.id);
    for (const plan of [...plans].sort((a, b) => b.weight - a.weight)) {
      const shortfall = quiz.num_questions - final.length;
      if (shortfall <= 0) return;
      const topicChunks = chunks
        .filter((c) => c.topic_id === plan.topic.id)
        .map((c) => ({ id: c.id, text: c.text, location_label: c.location_label, topic_name: plan.topic.name, heading: c.heading }));
      const extra = offlineGenerate(
        topicChunks,
        splitTypes(shortfall, ctx.types, rng),
        difficultyList(shortfall, quiz.difficulty),
        ctx.bankFor(plan.topic.document_id),
        plan.topic.keywords ?? [],
        rng,
        avoidSents,
      );
      for (const q of extra) keep(plan, q, allowRepeats);
    }
  };
  topUp(ctx.avoidSents);
  // Small material: reuse passages the earlier quiz used (new wording first, then repeats as a last resort)
  if (final.length < quiz.num_questions && ctx.avoidSents.size) topUp(new Set());
  if (final.length < quiz.num_questions && ctx.avoid.length) topUp(new Set(), true);
  if (!final.length) throw new Error("Could not write any questions from this material. Try adding more text.");

  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const questions = final.slice(0, quiz.num_questions).map(([plan, q], order) => {
    const chunk = chunkById.get(q.chunk_id);
    const doc = chunk ? docMap.get(chunk.document_id) : null;
    // File the question under the topic its source passage belongs to,
    // so the results page points at the right thing to revise
    const topic = (chunk?.topic_id && topicById.get(chunk.topic_id)) || plan.topic;
    return {
      order,
      qtype: q.type,
      difficulty: q.difficulty ?? (quiz.difficulty !== "mixed" ? quiz.difficulty : "medium"),
      prompt: q.question,
      options: q.options ?? null,
      answer: q.correct_answer,
      accepted_answers: q.accepted_answers ?? [],
      explanation: q.explanation ?? "",
      topic_name: topic.name,
      topic_id: topic.id,
      source_chunk_id: chunk?.id ?? null,
      source_document_id: doc?.id ?? null,
      source_filename: doc?.filename ?? "",
      source_location: chunk?.location ?? 1,
      source_label: chunk?.location_label ?? "",
      source_quote: String(q.supporting_quote ?? "").slice(0, 500),
    };
  });
  return { questions, usedLLM, llmError: usedLLM ? null : ctx.llmError };
}
