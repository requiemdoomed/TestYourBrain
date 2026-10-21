// Background work: reading uploaded files and writing quizzes.
// Runs in the page; if the page is closed halfway, the work starts again next time the app opens.

import { splitText } from "../engine/chunk.js";
import { embedTexts, HASHING } from "../engine/embeddings.js";
import { extract, ExtractionError } from "../engine/extract.js";
import { generateQuizQuestions } from "../engine/quiz-generator.js";
import { buildTopics } from "../engine/topics.js";
import { getDB } from "./db.js";
import { currentLLM, currentLLMLabel, getSettings } from "./settings.js";

const uuid = () => crypto.randomUUID();

let queue = Promise.resolve();
const queued = new Set();

/** Read a file in the background (one file at a time, so OCR and the embedding model aren't overloaded). */
export function queueDocument(id) {
  if (queued.has(id)) return;
  queued.add(id);
  queue = queue.then(() => processDocument(id).finally(() => queued.delete(id)));
}

async function setNote(db, id, note) {
  const doc = await db.get("documents", id);
  if (doc && doc.status === "processing") await db.put("documents", { ...doc, status_note: note });
}

export async function processDocument(id) {
  const db = await getDB();
  const settings = getSettings();
  let doc = await db.get("documents", id);
  if (!doc) return;
  // Progress notes are written one after another, and always before the final status
  let notes = Promise.resolve();
  const note = (s) => (notes = notes.then(() => setNote(db, id, s)).catch(() => {}));
  const fail = async (message) => {
    await notes;
    const current = await db.get("documents", id);
    if (current) await db.put("documents", { ...current, status: "failed", error: message, status_note: null });
  };
  try {
    const file = await db.get("files", id);
    if (!file?.blob) return fail("The uploaded file is missing. Delete it and upload it again.");
    let result;
    try {
      result = await extract(file.blob, doc.file_type, {
        ocr: settings.ocr,
        filename: doc.filename,
        onStatus: note,
      });
    } catch (err) {
      if (err instanceof ExtractionError) return fail(err.message);
      throw err;
    }

    const chunks = [];
    for (const seg of result.segments) {
      for (let piece of splitText(seg.text)) {
        piece = piece.trim();
        if (piece.length < 15) continue;
        chunks.push({
          id: uuid(),
          document_id: id,
          order: chunks.length,
          location: seg.location,
          location_label: seg.label,
          heading: seg.title ? seg.title.slice(0, 300) : null,
          text: piece,
          ocr: !!seg.ocr,
          topic_id: null,
        });
      }
    }
    if (!chunks.length) return fail("Not enough text to build a quiz from this file.");

    note("Finding topics");
    // Prefix the heading so embeddings know the context of short slide bullets
    const { backend, vectors } = await embedTexts(
      chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)),
      settings.embeddings,
      note,
    );
    const llm = currentLLM();
    if (llm) note("Naming topics with the AI model");
    const spans = await buildTopics({
      vectors,
      texts: chunks.map((c) => c.text),
      titles: chunks.map((c) => c.heading),
      locations: chunks.map((c) => c.location),
      filename: doc.filename,
      unit: result.unit,
      llm,
    });

    if (!(await db.get("documents", id))) return; // deleted while it was being read
    // Replace any previous processing output (re-processing is idempotent)
    await db.deleteWhere("chunks", "document_id", id);
    await db.deleteWhere("topics", "document_id", id);
    const topics = await db.putMany(
      "topics",
      spans.map((span, order) => ({
        document_id: id,
        order,
        name: span.name,
        summary: span.summary ?? "",
        keywords: span.keywords ?? [],
        start_location: chunks[span.start].location,
        end_location: chunks[span.end - 1].location,
      })),
    );
    spans.forEach((span, i) => {
      for (let j = span.start; j < span.end; j++) chunks[j].topic_id = topics[i].id;
    });
    chunks.forEach((c, i) => (c.vector = vectors[i]));
    await db.putMany("chunks", chunks);

    await notes;
    doc = await db.get("documents", id);
    if (!doc) return; // deleted while it was being read
    await db.put("documents", {
      ...doc,
      unit: result.unit,
      page_count: Math.max(0, ...result.segments.map((s) => s.location)),
      ocr_pages: result.ocr_count,
      word_count: result.segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0),
      embedding: backend,
      status: "ready",
      error: null,
      status_note: null,
    });
  } catch (err) {
    console.error("Processing failed", err);
    await fail(`Unexpected error while reading the file: ${err?.message ?? err}`);
  }
}

const running = new Set();

/** Write the questions for a quiz that was just created. */
export async function generateQuiz(quizId) {
  if (running.has(quizId)) return;
  running.add(quizId);
  const db = await getDB();
  try {
    const quiz = await db.get("quizzes", quizId);
    if (!quiz) return;
    const docs = (await Promise.all(quiz.document_ids.map((id) => db.get("documents", id)))).filter(
      (d) => d && d.status === "ready",
    );
    if (!docs.length) throw new Error("None of the selected documents are ready.");
    const topics = (await Promise.all(docs.map((d) => db.where("topics", "document_id", d.id)))).flat();
    const chunks = (await Promise.all(docs.map((d) => db.where("chunks", "document_id", d.id)))).flat();
    for (const d of docs) if (!d.embedding) d.embedding = HASHING;
    const previous = quiz.practice_of_id ? await db.where("questions", "quiz_id", quiz.practice_of_id) : [];
    const llm = currentLLM();

    const { questions, usedLLM, llmError } = await generateQuizQuestions({
      quiz,
      docs,
      topics,
      chunks,
      llm,
      previous,
      onProgress: async (p) => {
        const q = await db.get("quizzes", quizId);
        if (q) await db.put("quizzes", { ...q, progress: p });
      },
    });
    const current = await db.get("quizzes", quizId);
    if (!current) return; // deleted while generating
    await db.deleteWhere("questions", "quiz_id", quizId);
    await db.putMany(
      "questions",
      questions.map((q) => ({ ...q, quiz_id: quizId })),
    );
    await db.put("quizzes", {
      ...current,
      generator: usedLLM ? currentLLMLabel() : "offline (rule-based)",
      generator_note: llm && !usedLLM ? llmError : null,
      status: "ready",
      progress: 100,
      error: null,
    });
  } catch (err) {
    console.error("Generating the quiz failed", err);
    const q = await db.get("quizzes", quizId);
    if (q) await db.put("quizzes", { ...q, status: "failed", error: err?.message ?? String(err) });
  } finally {
    running.delete(quizId);
  }
}

/** Pick up work interrupted by closing or reloading the page. */
export async function resumeInterruptedWork() {
  const db = await getDB();
  for (const d of await db.all("documents")) if (d.status === "processing") queueDocument(d.id);
  for (const q of await db.all("quizzes")) if (q.status === "generating") generateQuiz(q.id);
}
