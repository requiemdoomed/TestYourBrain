// Answer checking and results analysis.

import { ratio, tokenSetRatio } from "./fuzzy.js";
import { normalizeAnswer } from "./text.js";

const STOP = new Set(
  "a an the of to in on and or is are be by for with it that this as at from its into which".split(" "),
);

export const WEAK_THRESHOLD = 0.7;

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["correct", "partially_correct", "incorrect"] },
    feedback: { type: "string", description: "One or two sentences of feedback addressed to the student" },
  },
  required: ["verdict", "feedback"],
  additionalProperties: false,
};

const contentWords = (s) => new Set(normalizeAnswer(s).split(" ").filter((w) => !STOP.has(w) && w.length > 1));

/** Returns [score in {0, 0.5, 1}, feedback]. */
export async function grade(question, given, sourceText = "", llm = null) {
  given = String(given ?? "").trim();
  if (!given) return [0, "No answer given."];
  const ng = normalizeAnswer(given);

  if (question.qtype === "mcq") {
    return ng === normalizeAnswer(question.answer)
      ? [1, "Correct!"]
      : [0, `Not quite. The correct answer is: ${question.answer}`];
  }

  if (question.qtype === "true_false") {
    const val = ["true", "t", "yes"].includes(ng) ? "true" : ["false", "f", "no"].includes(ng) ? "false" : ng;
    return val === normalizeAnswer(question.answer)
      ? [1, "Correct!"]
      : [0, `Not quite. The statement is ${question.answer.toLowerCase()}.`];
  }

  // --- short answer -----------------------------------------------------------
  const normCands = [question.answer, ...(question.accepted_answers ?? [])].filter(Boolean).map(normalizeAnswer);
  if (normCands.includes(ng)) return [1, "Correct!"];
  const best = Math.max(0, ...normCands.map((c) => ratio(ng, c)));
  if (best >= 88) return [1, "Correct! (Small spelling differences are accepted.)"];
  // Short key-term answers contained in a longer response
  for (const c of normCands) {
    if (c && c.split(" ").length <= 4 && ` ${ng} `.includes(` ${c} `)) return [1, "Correct!"];
  }

  if (llm) {
    try {
      const v = await llm.structured({
        name: "Verdict",
        schema: VERDICT_SCHEMA,
        prompt:
          "Grade a student's short answer against the model answer and source material. Be fair: accept " +
          "answers that are correct in meaning even if worded differently; mark partially_correct if the " +
          "core idea is present but incomplete.\n\n" +
          `Question: ${question.prompt}\nModel answer: ${question.answer}\n` +
          `Also acceptable: ${(question.accepted_answers ?? []).join(", ") || "-"}\n` +
          `Source material: ${sourceText.slice(0, 1500) || question.source_quote}\n` +
          `Student answer: ${given}`,
      });
      const score = { correct: 1, partially_correct: 0.5, incorrect: 0 }[v.verdict];
      if (score !== undefined) return [score, String(v.feedback ?? "")];
    } catch (err) {
      console.warn("LLM grading failed, using keyword overlap:", err);
    }
  }

  // Offline: keyword overlap with the model answer
  const want = contentWords(question.answer);
  const have = contentWords(given);
  if (want.size) {
    const recall = [...want].filter((w) => have.has(w)).length / want.size;
    const fuzzy = tokenSetRatio(ng, normalizeAnswer(question.answer)) / 100;
    if (recall >= 0.8 || fuzzy >= 0.9) return [1, "Correct!"];
    if (recall >= 0.5 || fuzzy >= 0.75) return [0.5, `Partially correct. A complete answer: ${question.answer}`];
  }
  return [0, `Not quite. Expected: ${question.answer}`];
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/** Score, per-topic breakdown, weak topics and the pages to reread, for one attempt. */
export function buildResults(attempt, quiz, questions) {
  const qmap = new Map(questions.map((q) => [q.id, q]));
  const order = (attempt.question_ids?.length ? attempt.question_ids : questions.map((q) => q.id)).filter((id) =>
    qmap.has(id),
  );
  const responses = new Map((attempt.responses ?? []).map((r) => [r.question_id, r]));

  const perTopic = new Map();
  const byType = {};
  const byDifficulty = {};
  const items = [];
  let score = 0;
  for (const qid of order) {
    const q = qmap.get(qid);
    const r = responses.get(qid);
    const s = r ? r.score : 0;
    score += s;
    if (!perTopic.has(q.topic_name)) {
      perTopic.set(q.topic_name, {
        topic: q.topic_name,
        topic_id: q.topic_id ?? null,
        total: 0,
        score: 0,
        missed: [],
        sources: new Map(),
      });
    }
    const t = perTopic.get(q.topic_name);
    t.total += 1;
    t.score += s;
    if (s < 1) {
      t.missed.push(qid);
      const key = `${q.source_document_id}:${q.source_location}`;
      if (!t.sources.has(key)) {
        t.sources.set(key, {
          question_id: q.id,
          document_id: q.source_document_id ?? null,
          filename: q.source_filename,
          location: q.source_location,
          label: q.source_label,
        });
      }
    }
    for (const [bucket, key] of [
      [byType, q.qtype],
      [byDifficulty, q.difficulty],
    ]) {
      bucket[key] ??= { total: 0, score: 0 };
      bucket[key].total += 1;
      bucket[key].score += s;
    }
    items.push({
      question_id: q.id,
      prompt: q.prompt,
      qtype: q.qtype,
      topic: q.topic_name,
      options: q.options,
      given_answer: r ? r.given_answer : null,
      correct_answer: q.answer,
      score: s,
      is_correct: !!(r && r.is_correct),
      answered: !!r,
      feedback: r ? r.feedback : "Not answered.",
      explanation: q.explanation,
      source_label: q.source_label,
      source_filename: q.source_filename,
      source_document_id: q.source_document_id ?? null,
      source_location: q.source_location,
    });
  }

  const topics = [...perTopic.values()].map((t) => {
    const acc = t.total ? t.score / t.total : 0;
    return {
      topic: t.topic,
      topic_id: t.topic_id,
      total: t.total,
      score: round(t.score, 2),
      accuracy: round(acc, 3),
      weak: acc < WEAK_THRESHOLD,
      missed_question_ids: t.missed,
      revise: [...t.sources.values()].sort((a, b) =>
        a.filename === b.filename ? a.location - b.location : a.filename < b.filename ? -1 : 1,
      ),
    };
  });
  topics.sort((a, b) => a.accuracy - b.accuracy || b.total - a.total);
  const total = order.length;
  const duration =
    attempt.finished_at && attempt.started_at
      ? Math.max(0, Math.floor((new Date(attempt.finished_at) - new Date(attempt.started_at)) / 1000))
      : null;
  const pct = (b) =>
    Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { total: v.total, accuracy: round(v.score / v.total, 3) }]));

  return {
    attempt_id: attempt.id,
    quiz_id: quiz.id,
    quiz_title: quiz.title,
    score: round(score, 2),
    total,
    percent: total ? round((100 * score) / total, 1) : 0,
    answered: order.filter((id) => responses.has(id)).length,
    duration_seconds: duration,
    finished: !!attempt.finished_at,
    topics,
    weak_topics: topics.filter((t) => t.weak),
    by_type: pct(byType),
    by_difficulty: pct(byDifficulty),
    questions: items,
  };
}
