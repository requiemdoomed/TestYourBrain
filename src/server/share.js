// Share links without a server: the quiz itself travels inside the link (compressed JSON in the URL
// fragment, which browsers never send to any server). A classmate's result comes back the same way.

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodePayload(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  return toBase64Url(await pipe(json, new CompressionStream("deflate-raw")));
}

export async function decodePayload(text) {
  try {
    const bytes = await pipe(fromBase64Url(text), new DecompressionStream("deflate-raw"));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("This link is incomplete or damaged. Ask for it to be sent again.");
  }
}

/** A short, stable id for a piece of text (used to spot results that were already imported). */
export async function digest(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toBase64Url(new Uint8Array(hash)).slice(0, 16);
}

export function randomToken(n = 12) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
}

/** The quiz as it travels in a share link (answers included: the classmate's browser checks them). */
export function quizPayload(quiz, questions, ownerName) {
  return {
    v: 1,
    token: quiz.share_token,
    owner: ownerName,
    title: quiz.title,
    difficulty: quiz.difficulty,
    types: quiz.question_types,
    generator: quiz.generator,
    files: [...new Set(questions.map((q) => q.source_filename).filter(Boolean))],
    questions: questions.map((q) => ({
      n: q.order,
      qtype: q.qtype,
      difficulty: q.difficulty,
      prompt: q.prompt,
      options: q.options,
      answer: q.answer,
      accepted: q.accepted_answers,
      explanation: q.explanation,
      topic: q.topic_name,
      label: q.source_label,
      file: q.source_filename,
      location: q.source_location,
      quote: q.source_quote,
    })),
  };
}
