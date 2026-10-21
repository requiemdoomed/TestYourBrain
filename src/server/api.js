// The TestYourBrain "backend", running inside the browser.
//
// It answers the same requests as the FastAPI server of the full-stack version (same paths, same JSON),
// but reads and writes IndexedDB instead of PostgreSQL. The pages call it through `api()` in
// src/lib/api.js exactly as they would call a real server.

import { HASHING, EMBEDDING_LABELS, MINILM } from "../engine/embeddings.js";
import { detectFileType, SUPPORTED_EXTENSIONS, pagePreviewUrl } from "../engine/extract.js";
import { buildResults, grade, WEAK_THRESHOLD } from "../engine/grading.js";
import { getDB, STORE_NAMES } from "./db.js";
import { generateQuiz, queueDocument } from "./jobs.js";
import { currentLLM, currentLLMLabel, getSettings, saveSettings } from "./settings.js";
import { decodePayload, digest, encodePayload, quizPayload, randomToken } from "./share.js";

export const VERSION = "2.0.0";
const MAX_UPLOAD_MB = 50;
const SESSION_KEY = "tyb.session";

export class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}
const notFound = (what = "Not found") => new HttpError(404, what);
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ accounts (stored in this browser)

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 150000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

function sessionUserId() {
  try {
    return Number(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return memorySession;
  }
}
let memorySession = null;
function setSession(id) {
  memorySession = id;
  try {
    if (id) localStorage.setItem(SESSION_KEY, String(id));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: session lasts until the tab closes */
  }
}

async function currentUser(db) {
  const id = sessionUserId();
  return id ? await db.get("users", id) : null;
}

async function requireUser(db) {
  const user = await currentUser(db);
  if (!user) throw new HttpError(401, "Please sign in first.");
  return user;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function register(db, { name, email, password }) {
  name = String(name ?? "").trim();
  email = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!name) throw new HttpError(422, "name: Field required");
  if (!validEmail(email)) throw new HttpError(422, "email: Enter a valid email address.");
  if (String(password ?? "").length < 8) throw new HttpError(422, "password: Use at least 8 characters.");
  if ((await db.where("users", "email", email)).length) {
    throw new HttpError(409, "An account with this email already exists on this device.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const user = await db.add("users", {
    name: name.slice(0, 120),
    email,
    salt: [...salt],
    password_hash: await hashPassword(password, salt),
    created_at: now(),
  });
  setSession(user.id);
  return { access_token: String(user.id), token_type: "local", user: publicUser(user) };
}

async function login(db, { email, password }) {
  email = String(email ?? "")
    .trim()
    .toLowerCase();
  const [user] = await db.where("users", "email", email);
  if (!user || (await hashPassword(String(password ?? ""), new Uint8Array(user.salt))) !== user.password_hash) {
    throw new HttpError(401, "Incorrect email or password.");
  }
  setSession(user.id);
  return { access_token: String(user.id), token_type: "local", user: publicUser(user) };
}

// ------------------------------------------------------------------ documents

async function ownedDocument(db, user, id) {
  const doc = await db.get("documents", id);
  if (!doc || doc.owner_id !== user.id) throw notFound("Document not found");
  return doc;
}

async function documentOut(db, doc) {
  const topics = await db.where("topics", "document_id", doc.id);
  return {
    id: doc.id,
    filename: doc.filename,
    file_type: doc.file_type,
    size_bytes: doc.size_bytes,
    status: doc.status,
    status_note: doc.status_note ?? null,
    error: doc.error ?? null,
    unit: doc.unit,
    page_count: doc.page_count ?? 0,
    ocr_pages: doc.ocr_pages ?? 0,
    word_count: doc.word_count ?? 0,
    created_at: doc.created_at,
    topic_count: topics.length,
    has_preview: doc.file_type === "pdf" || doc.file_type === "image",
    embedding: doc.embedding ? EMBEDDING_LABELS[doc.embedding] : null,
  };
}

/** Save uploaded files and start reading them. `onProgress(fraction)` reports saving progress. */
export async function uploadDocuments(files, onProgress = () => {}) {
  const db = await getDB();
  const user = await requireUser(db);
  for (const f of files) {
    if (!detectFileType(f.name)) {
      const allowed = Object.keys(SUPPORTED_EXTENSIONS).sort().join(", ");
      throw new HttpError(415, `'${f.name}' is not a supported file type. Supported: ${allowed}`);
    }
    if (f.size > MAX_UPLOAD_MB * 1024 * 1024) throw new HttpError(413, `'${f.name}' is larger than ${MAX_UPLOAD_MB} MB.`);
  }
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  let saved = 0;
  const created = [];
  for (const f of files) {
    const type = detectFileType(f.name);
    const doc = await db.add("documents", {
      owner_id: user.id,
      filename: f.name.slice(0, 255),
      file_type: type,
      mime: f.type,
      size_bytes: f.size,
      status: "processing",
      status_note: "Waiting to be read",
      error: null,
      unit: type === "pptx" ? "slide" : "page",
      page_count: 0,
      ocr_pages: 0,
      word_count: 0,
      created_at: now(),
    });
    // Copy into memory first: a File from <input> can't always be stored once the input is reset
    const blob = new Blob([await f.arrayBuffer()], { type: f.type });
    await db.put("files", { id: doc.id, blob });
    saved += f.size;
    onProgress(saved / total);
    created.push(doc);
    queueDocument(doc.id);
  }
  return Promise.all(created.map((d) => documentOut(db, d)));
}

async function listDocuments(db, user) {
  const docs = (await db.where("documents", "owner_id", user.id)).sort((a, b) => b.id - a.id);
  return Promise.all(docs.map((d) => documentOut(db, d)));
}

async function getDocument(db, user, id) {
  const doc = await ownedDocument(db, user, id);
  const topics = (await db.where("topics", "document_id", id)).sort((a, b) => a.order - b.order);
  const chunks = (await db.where("chunks", "document_id", id)).sort((a, b) => a.order - b.order);
  const counts = new Map();
  for (const c of chunks) counts.set(c.topic_id, (counts.get(c.topic_id) ?? 0) + 1);
  return {
    ...(await documentOut(db, doc)),
    topics: topics.map((t) => ({ ...t, chunk_count: counts.get(t.id) ?? 0 })),
    chunks: chunks.map(({ vector, ...c }) => c), // eslint-disable-line no-unused-vars
  };
}

async function deleteDocument(db, user, id) {
  await ownedDocument(db, user, id);
  await db.deleteWhere("chunks", "document_id", id);
  await db.deleteWhere("topics", "document_id", id);
  await db.delete("files", id);
  await db.delete("documents", id);
}

async function fileUrl(db, doc) {
  const file = await db.get("files", doc.id);
  if (!file?.blob) throw notFound("The original file is no longer available.");
  return URL.createObjectURL(file.blob);
}

// ------------------------------------------------------------------ quizzes

const percentOf = (a) => {
  if (!a.finished_at) return null;
  const total = a.question_ids?.length || a.total;
  return total ? Math.round((1000 * a.score) / total) / 10 : 0;
};

async function quizSummary(db, quiz, viewerIsOwner = true) {
  const questions = (await db.where("questions", "quiz_id", quiz.id)).sort((a, b) => a.order - b.order);
  const attempts = await db.where("attempts", "quiz_id", quiz.id);
  const mine = attempts
    .filter((a) => a.user_id && a.user_id === quiz.owner_id && a.finished_at)
    .sort((a, b) => (a.finished_at < b.finished_at ? -1 : 1));
  const pcts = mine.map(percentOf).filter((p) => p !== null);
  const documents = viewerIsOwner
    ? (await Promise.all((quiz.document_ids ?? []).map((id) => db.get("documents", id))))
        .filter(Boolean)
        .map((d) => ({ id: d.id, filename: d.filename, file_type: d.file_type }))
    : [];
  const filenames = [...new Set(questions.map((q) => q.source_filename).filter(Boolean))];
  return {
    id: quiz.id,
    title: quiz.title,
    status: quiz.status,
    error: quiz.error ?? null,
    progress: quiz.progress ?? 0,
    difficulty: quiz.difficulty,
    question_types: quiz.question_types ?? [],
    num_questions: quiz.num_questions,
    question_count: questions.length,
    generator: quiz.generator ?? "",
    generator_note: quiz.generator_note ?? null,
    shared: !!quiz.share_token && !quiz.received,
    share_token: viewerIsOwner && !quiz.received ? (quiz.share_token ?? null) : null,
    created_at: quiz.created_at,
    documents: documents.length ? documents : filenames.map((filename) => ({ filename })),
    topics: [...new Set(questions.map((q) => q.topic_name))],
    attempt_count: mine.length,
    best_percent: pcts.length ? Math.max(...pcts) : null,
    last_percent: pcts.length ? pcts[pcts.length - 1] : null,
    practice_of_id: quiz.practice_of_id ?? null,
    copied_from: quiz.copied_from_owner ?? null,
  };
}

const publicQuestion = (q) => ({
  id: q.id,
  order: q.order,
  qtype: q.qtype,
  difficulty: q.difficulty,
  prompt: q.prompt,
  options: q.options,
  topic_name: q.topic_name,
  source_label: q.source_label,
  source_filename: q.source_filename,
});

const fullQuestion = (q) => ({
  ...publicQuestion(q),
  answer: q.answer,
  accepted_answers: q.accepted_answers ?? [],
  explanation: q.explanation ?? "",
  source_quote: q.source_quote ?? "",
  source_document_id: q.source_document_id ?? null,
  source_location: q.source_location,
});

async function ownedQuiz(db, user, id) {
  const quiz = await db.get("quizzes", id);
  if (!quiz || quiz.owner_id !== user.id) throw notFound("Quiz not found");
  return quiz;
}

async function attemptRows(db, quiz) {
  const attempts = (await db.where("attempts", "quiz_id", quiz.id))
    .filter((a) => a.finished_at)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return Promise.all(
    attempts.map(async (a) => {
      const u = a.user_id ? await db.get("users", a.user_id) : null;
      const isOwner = !!a.user_id && a.user_id === quiz.owner_id;
      return {
        id: a.id,
        name: u ? u.name : a.guest_name || "Guest",
        is_owner: isOwner,
        via_share: !!a.via_share,
        percent: percentOf(a),
        score: a.score,
        total: a.question_ids?.length ?? 0,
        finished_at: a.finished_at,
        access_key: isOwner ? a.access_key : null,
        imported: !!a.import_id,
      };
    }),
  );
}

function stemTitle(filename) {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
  return stem.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase());
}

async function createQuiz(db, user, body) {
  const ids = [...new Set((body.document_ids ?? []).map(Number))];
  if (!ids.length) throw new HttpError(422, "document_ids: choose at least one file");
  const docs = await Promise.all(ids.map((id) => db.get("documents", id)));
  if (docs.some((d) => !d || d.owner_id !== user.id)) throw notFound("One or more documents were not found.");
  const notReady = docs.filter((d) => d.status !== "ready").map((d) => d.filename);
  if (notReady.length) throw new HttpError(409, `Still processing or failed: ${notReady.join(", ")}`);
  let topicIds = [];
  if (body.topic_ids?.length) {
    const topics = (await Promise.all(ids.map((id) => db.where("topics", "document_id", id)))).flat();
    topicIds = topics.filter((t) => body.topic_ids.includes(t.id)).map((t) => t.id);
    if (!topicIds.length) throw new HttpError(400, "None of the chosen topics belong to the selected documents.");
  }
  const n = Number(body.num_questions ?? 10);
  if (!(n >= 1 && n <= 60)) throw new HttpError(422, "num_questions: between 1 and 60");
  const types = [...new Set(body.question_types ?? ["mcq", "true_false", "short_answer"])];
  if (!types.length) throw new HttpError(422, "question_types: choose at least one");
  let title = String(body.title ?? "").trim();
  if (!title) {
    const stems = docs.map((d) => stemTitle(d.filename));
    title = `${stems.length === 1 ? stems[0] : `${stems[0]} + ${stems.length - 1} More`} Quiz`;
  }
  const quiz = await db.add("quizzes", {
    owner_id: user.id,
    title: title.slice(0, 200),
    difficulty: body.difficulty ?? "medium",
    question_types: types,
    num_questions: n,
    topic_filter: topicIds,
    document_ids: ids,
    status: "generating",
    progress: 0,
    generator: "",
    share_token: null,
    created_at: now(),
    practice_of_id: body.practice_of_id ?? null,
  });
  generateQuiz(quiz.id);
  return quizSummary(db, quiz);
}

async function getQuiz(db, user, id, answers) {
  const quiz = await ownedQuiz(db, user, id);
  const questions = (await db.where("questions", "quiz_id", id)).sort((a, b) => a.order - b.order);
  return {
    ...(await quizSummary(db, quiz)),
    questions: questions.map(answers ? fullQuestion : publicQuestion),
    attempts: await attemptRows(db, quiz),
  };
}

async function editQuestion(db, user, quizId, questionId, body) {
  await ownedQuiz(db, user, quizId);
  const q = await db.get("questions", questionId);
  if (!q || q.quiz_id !== quizId) throw notFound("Question not found");
  const prompt = body.prompt != null ? String(body.prompt).trim() : q.prompt;
  if (prompt.length < 3) throw new HttpError(422, "prompt: write at least 3 characters");
  let options = q.options;
  let answer = body.answer != null ? String(body.answer).trim() : q.answer;
  if (!answer) throw new HttpError(422, "answer: Field required");
  if (q.qtype === "mcq") {
    if (body.options != null) {
      options = body.options.map((o) => String(o).trim()).filter(Boolean);
      if (options.length < 2 || new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
        throw new HttpError(400, "Give at least two different options.");
      }
    }
    if (!(options ?? []).includes(answer)) throw new HttpError(400, "The answer must be one of the options.");
  } else if (q.qtype === "true_false") {
    if (!["true", "false"].includes(answer.toLowerCase())) throw new HttpError(400, "The answer must be True or False.");
    answer = answer[0].toUpperCase() + answer.slice(1).toLowerCase();
  }
  const updated = {
    ...q,
    prompt,
    options,
    answer,
    accepted_answers:
      body.accepted_answers != null ? body.accepted_answers.map((a) => String(a).trim()).filter(Boolean) : q.accepted_answers,
    explanation: body.explanation != null ? String(body.explanation).trim() : q.explanation,
  };
  await db.put("questions", updated);
  return fullQuestion(updated);
}

async function lastFinishedAttempt(db, quiz, user) {
  return (await db.where("attempts", "quiz_id", quiz.id))
    .filter((a) => a.user_id === user.id && a.finished_at)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
}

async function resultsFor(db, attempt) {
  const quiz = await db.get("quizzes", attempt.quiz_id);
  const questions = await db.where("questions", "quiz_id", attempt.quiz_id);
  return { quiz, results: buildResults(attempt, quiz, questions) };
}

async function practiceQuiz(db, user, quizId, body) {
  const quiz = await ownedQuiz(db, user, quizId);
  const docs = (await Promise.all((quiz.document_ids ?? []).map((id) => db.get("documents", id)))).filter(
    (d) => d && d.owner_id === user.id && d.status === "ready",
  );
  if (!docs.length) throw new HttpError(409, "The material this quiz was made from isn't in your library any more.");
  let topicIds = [...(body.topic_ids ?? [])];
  if (!topicIds.length) {
    const last = await lastFinishedAttempt(db, quiz, user);
    if (last) topicIds = (await resultsFor(db, last)).results.weak_topics.map((t) => t.topic_id).filter(Boolean);
  }
  if (!topicIds.length) {
    topicIds = [...new Set((await db.where("questions", "quiz_id", quiz.id)).map((q) => q.topic_id).filter(Boolean))];
  }
  const allTopics = (await Promise.all(docs.map((d) => db.where("topics", "document_id", d.id)))).flat();
  const topics = allTopics.filter((t) => topicIds.includes(t.id));
  if (!topics.length) throw new HttpError(400, "Those topics aren't part of this quiz's material.");
  const names = topics.map((t) => t.name);
  const title = `Practice: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` + ${names.length - 2} more` : ""}`;
  return createQuiz(db, user, {
    title,
    document_ids: docs.map((d) => d.id),
    topic_ids: topics.map((t) => t.id),
    num_questions: body.num_questions || Math.max(5, Math.min(15, 4 * topics.length)),
    difficulty: quiz.difficulty,
    question_types: quiz.question_types,
    practice_of_id: quiz.id,
  });
}

async function setSharing(db, user, quizId, enabled) {
  const quiz = await ownedQuiz(db, user, quizId);
  if (quiz.status !== "ready") throw new HttpError(409, "Only finished quizzes can be shared.");
  if (enabled && !quiz.share_token) quiz.share_token = randomToken();
  else if (!enabled) quiz.share_token = null;
  await db.put("quizzes", quiz);
  return { shared: !!quiz.share_token, share_token: quiz.share_token };
}

/** The link classmates open: the whole quiz, compressed into the URL fragment. */
async function shareLink(db, user, quizId) {
  const quiz = await ownedQuiz(db, user, quizId);
  if (!quiz.share_token) throw new HttpError(409, "Create a share link first.");
  const questions = (await db.where("questions", "quiz_id", quizId)).sort((a, b) => a.order - b.order);
  return { path: `#/s/${await encodePayload(quizPayload(quiz, questions, user.name))}` };
}

// ------------------------------------------------------------------ taking a quiz

async function startAttempt(db, quiz, body, user, viaShare) {
  const questions = (await db.where("questions", "quiz_id", quiz.id)).sort((a, b) => a.order - b.order);
  if (quiz.status !== "ready" || !questions.length) throw new HttpError(409, "This quiz is not ready yet.");
  let ids = questions.map((q) => q.id);
  if (body.question_ids?.length) {
    ids = ids.filter((id) => body.question_ids.includes(id));
    if (!ids.length) throw new HttpError(400, "None of those questions are in this quiz.");
  }
  if (body.shuffle) {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
  }
  const guest = String(body.guest_name ?? "").trim() || null;
  const attempt = await db.add("attempts", {
    quiz_id: quiz.id,
    user_id: user?.id ?? null,
    guest_name: user ? null : (guest ?? "Guest"),
    via_share: viaShare,
    question_ids: ids,
    total: ids.length,
    score: 0,
    started_at: now(),
    finished_at: null,
    access_key: randomToken(16),
    responses: [],
  });
  return attemptOut(db, attempt, user);
}

function feedbackOut(q, r) {
  return {
    question_id: q.id,
    given_answer: r.given_answer,
    score: r.score,
    is_correct: r.is_correct,
    feedback: r.feedback,
    correct_answer: q.answer,
    accepted_answers: q.accepted_answers ?? [],
    explanation: q.explanation ?? "",
    source_label: q.source_label,
    source_filename: q.source_filename,
    source_quote: q.source_quote ?? "",
  };
}

async function attemptOut(db, attempt, user) {
  const quiz = await db.get("quizzes", attempt.quiz_id);
  const qmap = new Map((await db.where("questions", "quiz_id", attempt.quiz_id)).map((q) => [q.id, q]));
  const ids = attempt.question_ids.filter((id) => qmap.has(id));
  return {
    id: attempt.id,
    quiz_id: quiz.id,
    quiz_title: quiz.title,
    access_key: attempt.access_key,
    guest_name: attempt.guest_name,
    started_at: attempt.started_at,
    finished_at: attempt.finished_at,
    questions: ids.map((id) => publicQuestion(qmap.get(id))),
    responses: attempt.responses.filter((r) => qmap.has(r.question_id)).map((r) => feedbackOut(qmap.get(r.question_id), r)),
    share_token: attempt.via_share ? quiz.share_token : null,
    is_owner: !!(user && user.id === quiz.owner_id),
  };
}

async function getAttempt(db, id) {
  const attempt = await db.get("attempts", id);
  if (!attempt) throw notFound("Attempt not found");
  return attempt;
}

async function answer(db, attemptId, body) {
  const attempt = await getAttempt(db, attemptId);
  if (attempt.finished_at) throw new HttpError(409, "This attempt is already finished.");
  const qid = Number(body.question_id);
  if (!attempt.question_ids.includes(qid)) throw new HttpError(400, "That question is not part of this attempt.");
  const q = await db.get("questions", qid);
  if (!q) throw notFound("Question not found");
  const existing = attempt.responses.find((r) => r.question_id === qid);
  if (existing) return feedbackOut(q, existing); // answers are final once feedback was shown
  const chunk = q.source_chunk_id ? await db.get("chunks", q.source_chunk_id) : null;
  const [score, feedback] = await grade(q, body.answer, chunk?.text ?? "", currentLLM());
  const r = {
    question_id: qid,
    given_answer: String(body.answer ?? "").trim(),
    score,
    is_correct: score >= 1,
    feedback,
  };
  // Re-read before saving: answers to two questions can be checked at the same time
  const fresh = await getAttempt(db, attemptId);
  if (!fresh.responses.some((x) => x.question_id === qid)) fresh.responses.push(r);
  await db.put("attempts", fresh);
  return feedbackOut(q, r);
}

async function finish(db, attemptId) {
  const attempt = await getAttempt(db, attemptId);
  if (!attempt.finished_at) {
    attempt.finished_at = now();
    attempt.score = attempt.responses.reduce((s, r) => s + r.score, 0);
    attempt.total = attempt.question_ids.length;
    await db.put("attempts", attempt);
  }
  return (await resultsFor(db, attempt)).results;
}

async function results(db, user, attemptId) {
  const attempt = await getAttempt(db, attemptId);
  const { quiz, results: out } = await resultsFor(db, attempt);
  return {
    ...out,
    is_owner: !!(user && user.id === quiz.owner_id),
    share_token: attempt.via_share ? quiz.share_token : null,
    access_key: attempt.access_key,
    guest_name: attempt.guest_name,
    owner_name: quiz.owner_name ?? null,
    received: !!quiz.received,
    imported: !!attempt.import_id,
  };
}

// ------------------------------------------------------------------ sharing with classmates

/**
 * Open a share link. The quiz in the link is stored on this device (once) so the classmate can take it,
 * retake it and keep their results. If it's your own quiz, you get your own copy back.
 */
async function openShared(db, user, payloadText) {
  const p = await decodePayload(payloadText);
  if (!p?.token || !Array.isArray(p.questions)) throw new Error("This link doesn't contain a quiz.");
  const matches = await db.where("quizzes", "share_token", p.token);
  const own = matches.find((q) => !q.received && user && q.owner_id === user.id);
  let quiz = own ?? matches.find((q) => q.received);
  const fingerprint = await digest(payloadText);
  if (!quiz || (quiz.received && quiz.fingerprint !== fingerprint)) {
    // First visit, or the owner has edited the quiz since: store this version
    if (quiz) await db.deleteWhere("questions", "quiz_id", quiz.id);
    const record = {
      ...(quiz ?? {}),
      owner_id: null,
      received: true,
      fingerprint,
      owner_name: p.owner || "A classmate",
      title: String(p.title ?? "Shared quiz").slice(0, 200),
      difficulty: p.difficulty ?? "medium",
      question_types: p.types ?? [],
      num_questions: p.questions.length,
      topic_filter: [],
      document_ids: [],
      status: "ready",
      progress: 100,
      generator: p.generator ?? "",
      share_token: p.token,
      created_at: quiz?.created_at ?? now(),
    };
    quiz = quiz ? await db.put("quizzes", record) : await db.add("quizzes", record);
    await db.putMany(
      "questions",
      p.questions.map((q, i) => ({
        quiz_id: quiz.id,
        order: q.n ?? i,
        qtype: q.qtype,
        difficulty: q.difficulty,
        prompt: q.prompt,
        options: q.options ?? null,
        answer: q.answer,
        accepted_answers: q.accepted ?? [],
        explanation: q.explanation ?? "",
        topic_name: q.topic ?? "General",
        topic_id: null,
        source_chunk_id: null,
        source_document_id: null,
        source_filename: q.file ?? "",
        source_location: q.location ?? 1,
        source_label: q.label ?? "",
        source_quote: q.quote ?? "",
      })),
    );
  }
  return sharedOut(db, user, quiz);
}

async function sharedQuizByToken(db, user, token) {
  const matches = await db.where("quizzes", "share_token", token);
  const quiz =
    matches.find((q) => !q.received && user && q.owner_id === user.id) ??
    matches.find((q) => q.received) ??
    matches.find((q) => !q.received);
  if (!quiz) throw notFound("This quiz is no longer shared.");
  return quiz;
}

async function sharedOut(db, user, quiz) {
  const isOwner = !!(user && !quiz.received && quiz.owner_id === user.id);
  const owner = quiz.received ? null : await db.get("users", quiz.owner_id);
  const leaderboard = (await attemptRows(db, quiz))
    .filter((r) => r.via_share)
    .slice(0, 20)
    .map(({ access_key, ...r }) => r); // eslint-disable-line no-unused-vars
  return {
    ...(await quizSummary(db, quiz, isOwner)),
    share_token: quiz.share_token,
    owner_name: quiz.received ? quiz.owner_name : (owner?.name ?? ""),
    is_owner: isOwner,
    received: !!quiz.received,
    leaderboard,
  };
}

async function saveShared(db, user, token) {
  const quiz = await sharedQuizByToken(db, user, token);
  if (!quiz.received && quiz.owner_id === user.id) throw new HttpError(400, "This quiz is already in your library.");
  const existing = (await db.where("quizzes", "owner_id", user.id)).find((q) => q.copied_from_token === token);
  if (existing) return quizSummary(db, existing);
  const copy = await db.add("quizzes", {
    owner_id: user.id,
    title: quiz.title,
    status: "ready",
    difficulty: quiz.difficulty,
    question_types: quiz.question_types,
    num_questions: quiz.num_questions,
    topic_filter: [],
    document_ids: [],
    generator: quiz.generator,
    progress: 100,
    share_token: null,
    copied_from_token: token,
    copied_from_owner: quiz.owner_name ?? null,
    created_at: now(),
  });
  const questions = await db.where("questions", "quiz_id", quiz.id);
  await db.putMany(
    "questions",
    questions.map(({ id, ...q }) => ({ ...q, quiz_id: copy.id })), // eslint-disable-line no-unused-vars
  );
  return quizSummary(db, copy);
}

/** A link a classmate sends back so their result shows up on the quiz owner's device. */
async function resultLink(db, attemptId) {
  const attempt = await getAttempt(db, attemptId);
  const quiz = await db.get("quizzes", attempt.quiz_id);
  if (!attempt.via_share || !quiz.share_token) throw new HttpError(400, "Only results of shared quizzes can be sent.");
  if (!attempt.finished_at) throw new HttpError(409, "Finish the quiz first.");
  const qmap = new Map((await db.where("questions", "quiz_id", quiz.id)).map((q) => [q.id, q]));
  const user = attempt.user_id ? await db.get("users", attempt.user_id) : null;
  const payload = {
    v: 1,
    token: quiz.share_token,
    name: user?.name ?? attempt.guest_name ?? "Guest",
    started: attempt.started_at,
    finished: attempt.finished_at,
    asked: attempt.question_ids.filter((id) => qmap.has(id)).map((id) => qmap.get(id).order),
    answers: attempt.responses
      .filter((r) => qmap.has(r.question_id))
      .map((r) => ({ n: qmap.get(r.question_id).order, given: r.given_answer, score: r.score, feedback: r.feedback })),
  };
  return { path: `#/r/${await encodePayload(payload)}`, owner_name: quiz.owner_name ?? null };
}

async function importResult(db, user, payloadText) {
  const p = await decodePayload(payloadText);
  if (!p?.token || !Array.isArray(p.answers)) throw new Error("This link doesn't contain a quiz result.");
  const quiz = (await db.where("quizzes", "share_token", p.token)).find((q) => !q.received);
  if (!quiz) throw notFound("This result is for a quiz that isn't on this device.");
  if (!user || quiz.owner_id !== user.id) {
    throw new HttpError(403, "This result belongs to someone else's quiz. Sign in as the person who shared it.");
  }
  const importId = await digest(payloadText);
  const questions = await db.where("questions", "quiz_id", quiz.id);
  const byOrder = new Map(questions.map((q) => [q.order, q]));
  const already = (await db.where("attempts", "quiz_id", quiz.id)).find((a) => a.import_id === importId);
  if (already) return { quiz_id: quiz.id, name: p.name, duplicate: true };
  const asked = (p.asked ?? p.answers.map((a) => a.n)).map((n) => byOrder.get(n)?.id).filter(Boolean);
  const responses = p.answers
    .filter((a) => byOrder.has(a.n))
    .map((a) => ({
      question_id: byOrder.get(a.n).id,
      given_answer: String(a.given ?? ""),
      score: Number(a.score) || 0,
      is_correct: Number(a.score) >= 1,
      feedback: String(a.feedback ?? ""),
    }));
  await db.add("attempts", {
    quiz_id: quiz.id,
    user_id: null,
    guest_name: String(p.name ?? "Guest").slice(0, 120),
    via_share: true,
    question_ids: asked,
    total: asked.length,
    score: responses.reduce((s, r) => s + r.score, 0),
    started_at: p.started ?? now(),
    finished_at: p.finished ?? now(),
    access_key: randomToken(16),
    responses,
    import_id: importId,
  });
  return { quiz_id: quiz.id, name: p.name, duplicate: false };
}

// ------------------------------------------------------------------ sources

function mergeOverlapping(texts) {
  let out = texts[0];
  for (const t of texts.slice(1)) {
    // chunks overlap by up to 120 characters; drop the repeated prefix
    let overlap = 0;
    for (let size = Math.min(out.length, t.length, 300); size > 20; size--) {
      if (out.endsWith(t.slice(0, size))) {
        overlap = size;
        break;
      }
    }
    out = out + (overlap ? "" : "\n") + t.slice(overlap);
  }
  return out;
}

/** The slide/page a question came from: the passage, the whole page's text and a page image. */
async function questionSource(db, user, questionId) {
  const q = await db.get("questions", questionId);
  if (!q) throw notFound("Question not found");
  const doc = q.source_document_id ? await db.get("documents", q.source_document_id) : null;
  const canSeeFile = doc && user && doc.owner_id === user.id;
  let text = q.source_quote;
  if (canSeeFile) {
    const pageChunks = (await db.where("chunks", "document_id", doc.id))
      .filter((c) => c.location === q.source_location)
      .sort((a, b) => a.order - b.order);
    if (pageChunks.length) text = mergeOverlapping(pageChunks.map((c) => c.text));
  }
  let pageImage = null;
  let file = null;
  if (canSeeFile) {
    const stored = await db.get("files", doc.id);
    if (stored?.blob) {
      try {
        pageImage = await pagePreviewUrl(`doc${doc.id}`, stored.blob, doc.file_type, q.source_location);
      } catch (err) {
        console.warn("Page preview failed", err);
      }
      file = URL.createObjectURL(stored.blob) + (doc.file_type === "pdf" ? `#page=${q.source_location}` : "");
    }
  }
  return {
    question_id: q.id,
    document_id: canSeeFile ? doc.id : null,
    filename: q.source_filename,
    file_type: doc?.file_type ?? null,
    location: q.source_location,
    label: q.source_label,
    quote: q.source_quote,
    text,
    page_image_url: pageImage,
    file_url: file,
    unit: doc?.unit ?? null,
    full_page_available: !!canSeeFile,
  };
}

// ------------------------------------------------------------------ dashboard stats

async function stats(db, user) {
  const attempts = (await db.where("attempts", "user_id", user.id))
    .filter((a) => a.finished_at)
    .sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1))
    .slice(0, 30);
  const topicAcc = new Map();
  const recent = [];
  const percents = [];
  for (const a of attempts) {
    const quiz = await db.get("quizzes", a.quiz_id);
    if (!quiz) continue;
    const { results: res } = await resultsFor(db, a);
    if (recent.length < 5) {
      recent.push({
        attempt_id: a.id,
        quiz_id: a.quiz_id,
        quiz_title: quiz.title,
        access_key: a.access_key,
        finished_at: a.finished_at,
        percent: res.percent,
      });
    }
    if (a.question_ids.length) percents.push((100 * a.score) / a.question_ids.length);
    for (const t of res.topics) {
      if (!topicAcc.has(t.topic)) {
        topicAcc.set(t.topic, { topic: t.topic, score: 0, total: 0, quizzes: new Set(), topic_ids: new Set(), revise: new Map() });
      }
      const d = topicAcc.get(t.topic);
      if (t.topic_id && quiz.owner_id === user.id) d.topic_ids.add(t.topic_id);
      d.score += t.score;
      d.total += t.total;
      if (quiz.owner_id === user.id) d.quizzes.add(a.quiz_id);
      for (const src of t.revise) d.revise.set(`${src.document_id}:${src.location}`, src);
    }
  }
  const weak = [];
  for (const d of topicAcc.values()) {
    const acc = d.total ? d.score / d.total : 0;
    if (acc < WEAK_THRESHOLD) {
      weak.push({
        topic: d.topic,
        accuracy: Math.round(acc * 1000) / 1000,
        questions: d.total,
        quiz_ids: [...d.quizzes].sort((a, b) => a - b),
        topic_ids: [...d.topic_ids].sort((a, b) => a - b),
        revise: [...d.revise.values()].slice(0, 6),
      });
    }
  }
  weak.sort((a, b) => a.accuracy - b.accuracy || b.questions - a.questions);
  return {
    documents: (await db.where("documents", "owner_id", user.id)).length,
    quizzes: (await db.where("quizzes", "owner_id", user.id)).length,
    attempts: attempts.length,
    average_percent: percents.length ? Math.round((10 * percents.reduce((a, b) => a + b, 0)) / percents.length) / 10 : null,
    weak_topics: weak.slice(0, 8),
    recent,
  };
}

// ------------------------------------------------------------------ settings, backup

function settingsOut() {
  const s = getSettings();
  return { ...s, apiKey: s.apiKey ? "•".repeat(8) + s.apiKey.slice(-4) : "", has_key: !!s.apiKey };
}

function updateSettings(body) {
  const patch = {};
  for (const k of ["provider", "model", "baseUrl", "structuredMethod", "embeddings"]) {
    if (body[k] !== undefined) patch[k] = String(body[k]).trim();
  }
  if (body.ocr !== undefined) patch.ocr = !!body.ocr;
  if (body.apiKey !== undefined && !String(body.apiKey).startsWith("•")) patch.apiKey = String(body.apiKey).trim();
  if (patch.provider && !["offline", "anthropic", "openai"].includes(patch.provider)) {
    throw new HttpError(422, "provider: offline, anthropic or openai");
  }
  saveSettings(patch);
  return settingsOut();
}

async function testModel() {
  const llm = currentLLM();
  if (!llm) throw new HttpError(400, "Choose a provider and add an API key first.");
  const out = await llm.structured({
    name: "Ping",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" }, reply: { type: "string" } },
      required: ["ok", "reply"],
      additionalProperties: false,
    },
    prompt: 'Reply with ok=true and reply="ready" to confirm you can return structured JSON.',
  });
  return { ok: true, model: llm.label, reply: out?.reply ?? "" };
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Everything stored by the app on this device, as one JSON object (files included). */
export async function exportBackup() {
  const db = await getDB();
  const out = { app: "TestYourBrain", version: VERSION, exported_at: now(), stores: {} };
  for (const name of STORE_NAMES) {
    const rows = await db.all(name);
    out.stores[name] = await Promise.all(
      rows.map(async (r) => {
        if (name === "files") return { id: r.id, type: r.blob?.type ?? "", data: r.blob ? await blobToDataUrl(r.blob) : null };
        if (name === "chunks") return { ...r, vector: r.vector ? Array.from(r.vector) : null };
        return r;
      }),
    );
  }
  return out;
}

export async function importBackup(data) {
  if (data?.app !== "TestYourBrain" || !data.stores) throw new HttpError(400, "That isn't a TestYourBrain backup file.");
  const db = await getDB();
  await db.clearAll();
  for (const name of STORE_NAMES) {
    const rows = await Promise.all(
      (data.stores[name] ?? []).map(async (r) => {
        if (name === "files") return { id: r.id, blob: r.data ? await (await fetch(r.data)).blob() : null };
        if (name === "chunks") return { ...r, vector: r.vector ? Float32Array.from(r.vector) : null };
        return r;
      }),
    );
    await db.putMany(name, rows);
  }
  setSession(null);
}

async function health(db) {
  const s = getSettings();
  return {
    status: "ok",
    version: VERSION,
    llm: currentLLMLabel(),
    embeddings: s.embeddings === MINILM ? EMBEDDING_LABELS[MINILM] : EMBEDDING_LABELS[HASHING],
    ocr: s.ocr,
    storage: db.persistent ? "indexeddb" : "memory",
  };
}

// ------------------------------------------------------------------ routing

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(
    "^" +
      pattern.replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, re, keys, handler });
};

route("GET", "/api/health", ({ db }) => health(db));
route("POST", "/api/auth/register", ({ db, body }) => register(db, body));
route("POST", "/api/auth/login", ({ db, body }) => login(db, body));
route("POST", "/api/auth/logout", () => setSession(null));
route("GET", "/api/auth/me", async ({ db }) => publicUser(await requireUser(db)));

route("GET", "/api/documents", async ({ db }) => listDocuments(db, await requireUser(db)));
route("GET", "/api/documents/:id", async ({ db, p }) => getDocument(db, await requireUser(db), p.id));
route("POST", "/api/documents/:id/reprocess", async ({ db, p }) => {
  const doc = await ownedDocument(db, await requireUser(db), p.id);
  await db.put("documents", { ...doc, status: "processing", error: null, status_note: "Waiting to be read" });
  queueDocument(doc.id);
  return documentOut(db, { ...doc, status: "processing" });
});
route("DELETE", "/api/documents/:id", async ({ db, p }) => deleteDocument(db, await requireUser(db), p.id));
route("GET", "/api/documents/:id/file", async ({ db, p }) => ({
  url: await fileUrl(db, await ownedDocument(db, await requireUser(db), p.id)),
}));
route("GET", "/api/documents/:id/pages/:page", async ({ db, p }) => {
  const doc = await ownedDocument(db, await requireUser(db), p.id);
  const file = await db.get("files", doc.id);
  const url = file?.blob ? await pagePreviewUrl(`doc${doc.id}`, file.blob, doc.file_type, p.page) : null;
  if (!url) throw notFound("No page preview is available for this file.");
  return { url };
});

route("POST", "/api/quizzes", async ({ db, body }) => createQuiz(db, await requireUser(db), body));
route("GET", "/api/quizzes", async ({ db }) => {
  const user = await requireUser(db);
  const quizzes = (await db.where("quizzes", "owner_id", user.id)).sort((a, b) => b.id - a.id);
  return Promise.all(quizzes.map((q) => quizSummary(db, q)));
});
route("GET", "/api/quizzes/:id", async ({ db, p, query }) =>
  getQuiz(db, await requireUser(db), p.id, query.get("answers") === "true"),
);
route("PATCH", "/api/quizzes/:id", async ({ db, p, body }) => {
  const quiz = await ownedQuiz(db, await requireUser(db), p.id);
  const title = String(body.title ?? "").trim();
  if (!title) throw new HttpError(422, "title: Field required");
  await db.put("quizzes", { ...quiz, title: title.slice(0, 200) });
  return quizSummary(db, { ...quiz, title });
});
route("DELETE", "/api/quizzes/:id", async ({ db, p }) => {
  const quiz = await ownedQuiz(db, await requireUser(db), p.id);
  await db.deleteWhere("questions", "quiz_id", quiz.id);
  await db.deleteWhere("attempts", "quiz_id", quiz.id);
  await db.delete("quizzes", quiz.id);
});
route("DELETE", "/api/quizzes/:id/questions/:qid", async ({ db, p }) => {
  await ownedQuiz(db, await requireUser(db), p.id);
  const q = await db.get("questions", p.qid);
  if (!q || q.quiz_id !== p.id) throw notFound("Question not found");
  await db.delete("questions", q.id);
});
route("PATCH", "/api/quizzes/:id/questions/:qid", async ({ db, p, body }) =>
  editQuestion(db, await requireUser(db), p.id, p.qid, body),
);
route("POST", "/api/quizzes/:id/practice", async ({ db, p, body }) => practiceQuiz(db, await requireUser(db), p.id, body));
route("POST", "/api/quizzes/:id/share", async ({ db, p, query }) =>
  setSharing(db, await requireUser(db), p.id, query.get("enabled") !== "false"),
);
route("GET", "/api/quizzes/:id/share-link", async ({ db, p }) => shareLink(db, await requireUser(db), p.id));
route("POST", "/api/quizzes/:id/attempts", async ({ db, p, body }) => {
  const user = await requireUser(db);
  return startAttempt(db, await ownedQuiz(db, user, p.id), body, user, false);
});

route("POST", "/api/shared/open", async ({ db, body }) => openShared(db, await currentUser(db), body.payload));
route("GET", "/api/shared/:token", async ({ db, p }) => {
  const user = await currentUser(db);
  return sharedOut(db, user, await sharedQuizByToken(db, user, p.token));
});
route("POST", "/api/shared/:token/attempts", async ({ db, p, body }) => {
  const user = await currentUser(db);
  return startAttempt(db, await sharedQuizByToken(db, user, p.token), body, user, true);
});
route("POST", "/api/shared/:token/save", async ({ db, p }) => saveShared(db, await requireUser(db), p.token));
route("POST", "/api/results/import", async ({ db, body }) => importResult(db, await currentUser(db), body.payload));

route("GET", "/api/attempts/:id", async ({ db, p }) => attemptOut(db, await getAttempt(db, p.id), await currentUser(db)));
route("POST", "/api/attempts/:id/answers", ({ db, p, body }) => answer(db, p.id, body));
route("POST", "/api/attempts/:id/finish", ({ db, p }) => finish(db, p.id));
route("GET", "/api/attempts/:id/results", async ({ db, p }) => results(db, await currentUser(db), p.id));
route("GET", "/api/attempts/:id/result-link", ({ db, p }) => resultLink(db, p.id));
route("GET", "/api/questions/:id/source", async ({ db, p }) => questionSource(db, await currentUser(db), p.id));
route("GET", "/api/stats", async ({ db }) => stats(db, await requireUser(db)));

route("GET", "/api/settings", () => settingsOut());
route("PUT", "/api/settings", ({ body }) => updateSettings(body));
route("POST", "/api/settings/test", () => testModel());
route("DELETE", "/api/data", async ({ db }) => {
  await db.clearAll();
  setSession(null);
});

/** Handle one request: returns the response body or throws HttpError. */
export async function handle(method, path, body = null) {
  const url = new URL(path, "http://local");
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const p = Object.fromEntries(r.keys.map((k, i) => [k, /^\d+$/.test(m[i + 1]) ? Number(m[i + 1]) : decodeURIComponent(m[i + 1])]));
    const db = await getDB();
    try {
      return await r.handler({ db, p, query: url.searchParams, body: body ?? {} });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.error(`${method} ${path} failed`, err);
      throw new HttpError(500, err?.message || "Something went wrong.");
    }
  }
  throw new HttpError(404, `No route for ${method} ${url.pathname}`);
}
