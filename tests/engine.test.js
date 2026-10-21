// Tests for the quiz engine: question writing (rule-based and with a model), grading and results.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { hashingEmbed, HASHING } from "../src/engine/embeddings.js";
import { buildResults, grade } from "../src/engine/grading.js";
import { createLLM, structuredMethod } from "../src/engine/llm.js";
import { allocate, attribute, generateQuizQuestions } from "../src/engine/quiz-generator.js";
import { search } from "../src/engine/retrieval.js";
import { buildTopics } from "../src/engine/topics.js";
import { decodePayload, encodePayload } from "../src/server/share.js";
import { modelAnswer, schemaOf } from "./fake-model.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));

/** Turn a fixture document into the records the app stores: document, topics and chunks with vectors. */
async function library(llm = null) {
  const docs = [];
  const topics = [];
  const chunks = [];
  let topicId = 1;
  for (const [i, d] of fx.docs.entries()) {
    const docId = i + 1;
    docs.push({ id: docId, filename: d.file, embedding: HASHING, status: "ready" });
    const vectors = d.chunks.map((c) => hashingEmbed(c.title ? `${c.title}\n${c.text}` : c.text));
    const spans = await buildTopics({
      vectors,
      texts: d.chunks.map((c) => c.text),
      titles: d.chunks.map((c) => c.title),
      locations: d.chunks.map((c) => c.location),
      filename: d.file,
      unit: d.unit,
      llm,
    });
    spans.forEach((s, order) => {
      const id = topicId++;
      topics.push({ id, document_id: docId, order, name: s.name, summary: s.summary, keywords: s.keywords });
      for (let j = s.start; j < s.end; j++) {
        const c = d.chunks[j];
        const label = `${d.unit === "slide" ? "Slide" : d.unit === "section" ? "Section" : "Page"} ${c.location}`;
        chunks.push({
          id: `${docId}-${j}`,
          document_id: docId,
          order: j,
          topic_id: id,
          location: c.location,
          location_label: label,
          heading: c.title,
          text: c.text,
          vector: vectors[j],
        });
      }
    });
  }
  return { docs, topics, chunks };
}

const QUIZ = { id: 7, num_questions: 12, difficulty: "mixed", question_types: ["mcq", "true_false", "short_answer"] };

test("questions are spread over topics by size", () => {
  assert.deepEqual(allocate(10, [5, 3, 2]), [5, 3, 2]);
  assert.equal(allocate(7, [1, 1, 1, 1]).reduce((a, b) => a + b), 7);
  assert.deepEqual(allocate(2, [1, 9, 4]), [0, 1, 1]);
});

test("the built-in generator writes grounded questions from every file", async () => {
  const lib = await library();
  const { questions, usedLLM } = await generateQuizQuestions({ quiz: { ...QUIZ, num_questions: 20 }, ...lib });
  assert.equal(usedLLM, false);
  assert.equal(questions.length, 20);
  const chunkText = new Map(lib.chunks.map((c) => [c.id, c.text]));
  for (const q of questions) {
    assert.ok(["mcq", "true_false", "short_answer"].includes(q.qtype));
    assert.ok(q.source_label && q.source_filename, "every question points at its source");
    const flat = (t) => t.replace(/\s+/g, " ");
    assert.ok(flat(chunkText.get(q.source_chunk_id)).includes(flat(q.source_quote)), `quote not in source: ${q.source_quote}`);
    if (q.qtype === "mcq") {
      assert.equal(new Set(q.options.map((o) => o.toLowerCase())).size, q.options.length, "options are distinct");
      assert.ok(q.options.includes(q.answer));
    }
    if (q.qtype === "true_false") assert.ok(["True", "False"].includes(q.answer));
  }
  assert.ok(new Set(questions.map((q) => q.qtype)).size === 3, "all three question types");
  assert.ok(new Set(questions.map((q) => q.source_filename)).size >= 3, "questions come from several files");
});

test("distractors come from the question's own file", async () => {
  const lib = await library();
  const { questions } = await generateQuizQuestions({ quiz: { ...QUIZ, num_questions: 20, question_types: ["mcq"] }, ...lib });
  const textOf = (file) =>
    lib.chunks
      .filter((c) => lib.docs.find((d) => d.id === c.document_id).filename === file)
      .map((c) => c.text.toLowerCase())
      .join(" ");
  for (const q of questions) {
    const own = textOf(q.source_filename);
    for (const o of q.options) if (!/^\d/.test(o)) assert.ok(own.includes(o.toLowerCase()), `"${o}" isn't in ${q.source_filename}`);
  }
});

test("a practice quiz avoids the passages of the quiz it follows", async () => {
  const lib = await library();
  const first = await generateQuizQuestions({ quiz: { ...QUIZ, num_questions: 6, topic_filter: [lib.topics[0].id, lib.topics[1].id] }, ...lib });
  const practice = await generateQuizQuestions({
    quiz: { ...QUIZ, id: 8, num_questions: 6, topic_filter: [lib.topics[0].id, lib.topics[1].id] },
    ...lib,
    previous: first.questions,
  });
  const before = new Set(first.questions.map((q) => q.prompt));
  const repeats = practice.questions.filter((q) => before.has(q.prompt)).length;
  assert.ok(repeats <= 1, `${repeats} repeated questions`);
});

test("retrieval finds the passage about the query", () => {
  const lib = fx.docs[0].chunks.map((c, i) => ({ id: String(i), text: c.text, vector: hashingEmbed(c.text) }));
  const [best] = search(hashingEmbed("deadlock waiting for resources"), lib, { k: 3 });
  assert.match(best.text, /deadlock/i);
});

test("grading: multiple choice, true/false, spelling slips and partial answers", async () => {
  const mcq = { qtype: "mcq", answer: "Round Robin" };
  assert.equal((await grade(mcq, "round robin"))[0], 1);
  assert.equal((await grade(mcq, "FCFS"))[0], 0);
  const tf = { qtype: "true_false", answer: "False" };
  assert.equal((await grade(tf, "f"))[0], 1);
  const short = { qtype: "short_answer", answer: "process control block", accepted_answers: ["PCB"] };
  assert.equal((await grade(short, "the pcb"))[0], 1);
  assert.equal((await grade(short, "proces control blok"))[0], 1);
  assert.equal((await grade(short, "the control block"))[0], 1); // all its words are in the answer
  assert.equal((await grade(short, "process control unit"))[0], 0.5);
  assert.equal((await grade(short, "a thread"))[0], 0);
  assert.equal((await grade(short, ""))[0], 0);
});

test("results group by topic and list the pages to reread", () => {
  const questions = [
    { id: 1, topic_name: "Threads", topic_id: 1, qtype: "mcq", difficulty: "easy", source_filename: "os.pdf", source_location: 2, source_label: "Page 2" },
    { id: 2, topic_name: "Threads", topic_id: 1, qtype: "mcq", difficulty: "easy", source_filename: "os.pdf", source_location: 2, source_label: "Page 2" },
    { id: 3, topic_name: "Paging", topic_id: 2, qtype: "true_false", difficulty: "hard", source_filename: "os.pdf", source_location: 5, source_label: "Page 5" },
  ];
  const attempt = {
    id: 1,
    question_ids: [1, 2, 3],
    started_at: "2026-01-01T10:00:00Z",
    finished_at: "2026-01-01T10:03:05Z",
    responses: [
      { question_id: 1, score: 0, given_answer: "x" },
      { question_id: 2, score: 0, given_answer: "y" },
      { question_id: 3, score: 1, given_answer: "True", is_correct: true },
    ],
  };
  const r = buildResults(attempt, { id: 9, title: "OS" }, questions);
  assert.equal(r.percent, 33.3);
  assert.equal(r.duration_seconds, 185);
  assert.deepEqual(
    r.weak_topics.map((t) => t.topic),
    ["Threads"],
  );
  assert.deepEqual(
    r.weak_topics[0].revise.map((s) => s.label),
    ["Page 2"],
  );
});

test("share links round-trip and stay short", async () => {
  const payload = { token: "abc", questions: Array.from({ length: 15 }, (_, i) => ({ n: i, prompt: `Question ${i} about threads and processes` })) };
  const text = await encodePayload(payload);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.ok(text.length < 1000);
  assert.deepEqual(await decodePayload(text), payload);
  await assert.rejects(decodePayload("not-a-real-link"));
});

// ---------------------------------------------------------------- with a language model (fake API)

function fakeApi(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const out = handler(url, body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}

test("Claude: JSON-schema output, made-up questions dropped, mis-cited ones re-attributed", async () => {
  const calls = fakeApi((url, body) => {
    const name = schemaOf(body);
    return { content: [{ type: "text", text: JSON.stringify(modelAnswer(name, body.messages.at(-1).content)) }] };
  });
  const llm = createLLM({ provider: "anthropic", apiKey: "sk-ant-test" });
  const lib = await library(llm);
  assert.ok(lib.topics.some((t) => t.name.startsWith("Model Topic")), "topics named by the model");
  const { questions, usedLLM } = await generateQuizQuestions({ quiz: { ...QUIZ, num_questions: 9 }, ...lib, llm });
  assert.equal(usedLLM, true);
  assert.ok(!questions.some((q) => /moon/i.test(q.prompt)), "the made-up question is dropped");
  const chunkText = new Map(lib.chunks.map((c) => [c.id, c.text]));
  for (const q of questions) {
    const words = q.source_quote.toLowerCase().split(" ").slice(0, 4).join(" ");
    assert.ok(chunkText.get(q.source_chunk_id).toLowerCase().includes(words), "every quote is in its cited passage");
  }
  const req = calls.find((c) => c.body.messages.at(-1).content.includes("<excerpt"));
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(req.body.model, "claude-sonnet-5-5");
  assert.equal(req.body.output_config.format.type, "json_schema");
  assert.ok(req.body.system.includes("university teacher"));

  const [score, feedback] = await grade({ qtype: "short_answer", answer: "mutual exclusion", prompt: "?" }, "only one at once", "", llm);
  assert.deepEqual([score, feedback], [0.5, "Nearly there."]);
});

test("OpenAI-compatible servers get tool calls; OpenAI gets response_format", async () => {
  assert.equal(structuredMethod({ provider: "openai", baseUrl: "http://localhost:11434/v1" }), "function_calling");
  assert.equal(structuredMethod({ provider: "openai" }), "json_schema");
  assert.equal(structuredMethod({ provider: "anthropic", structuredMethod: "function_calling" }), "function_calling");

  const calls = fakeApi((url, body) => {
    const name = schemaOf(body);
    const answer = JSON.stringify(modelAnswer(name, body.messages.at(-1).content));
    return body.tools
      ? { choices: [{ message: { tool_calls: [{ function: { name, arguments: answer } }] } }] }
      : { choices: [{ message: { content: answer } }] };
  });
  const lib = await library();
  for (const settings of [
    { provider: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
    { provider: "openai", apiKey: "sk-test" },
  ]) {
    const llm = createLLM(settings);
    const { questions, usedLLM } = await generateQuizQuestions({ quiz: { ...QUIZ, num_questions: 5 }, ...lib, llm });
    assert.equal(usedLLM, true);
    assert.equal(questions.length, 5);
  }
  const local = calls.find((c) => c.url.startsWith("http://localhost:11434"));
  assert.equal(local.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(local.body.tool_choice.function.name, "QuestionBatch");
  const hosted = calls.find((c) => c.url.startsWith("https://api.openai.com"));
  assert.equal(hosted.headers.authorization, "Bearer sk-test");
  assert.equal(hosted.body.response_format.json_schema.strict, true);
});

test("a failing model falls back to the built-in generator", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
  const lib = await library();
  const llm = createLLM({ provider: "anthropic", apiKey: "bad" });
  const { questions, usedLLM, llmError } = await generateQuizQuestions({ quiz: { ...QUIZ, num_questions: 6 }, ...lib, llm });
  assert.equal(usedLLM, false);
  assert.equal(questions.length, 6);
  assert.match(llmError, /invalid x-api-key/);
});

test("attribution trusts a quote only when it is really in the passage", () => {
  const excerpts = new Map([
    ["S1", { id: "a", text: "A semaphore is an integer variable used to control access to a shared resource." }],
    ["S2", { id: "b", text: "Paging divides memory into fixed-size frames." }],
  ]);
  assert.equal(attribute({ source_id: "S2", supporting_quote: "an integer variable used to control access", question: "q", correct_answer: "a" }, excerpts).id, "a");
  assert.equal(attribute({ source_id: "S1", supporting_quote: "bananas are yellow and grow on trees in the tropics", question: "What colour are bananas in the tropics?", correct_answer: "yellow" }, excerpts), null);
});
