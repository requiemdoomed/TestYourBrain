// A stand-in for a language model, used by the tests. It answers each kind of request the app makes the
// way a real model would, plus some bad answers the app has to catch: a made-up question that isn't in the
// material and a question that cites the wrong excerpt.

/** Answers like a model would: real questions quoted from the excerpts, plus one made up and one mis-cited. */
export function modelAnswer(schemaName, prompt) {
  if (schemaName === "QuestionBatch") {
    const excerpts = [...prompt.matchAll(/<excerpt id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/excerpt>/g)].map((m) => [m[1], m[2]]);
    const [sid, text] = excerpts[0];
    const sentence = text.split(/(?<=\.)\s+/).find((s) => s.split(" ").length > 6) ?? text.slice(0, 80);
    const last = excerpts[excerpts.length - 1];
    const topic = /on the topic "([^"]+)"/.exec(prompt)?.[1] ?? "this topic";
    return {
      questions: [
        {
          type: "mcq",
          question: `Which statement does the material on ${topic} make?`,
          options: [sentence, "The moon is made of cheese.", "Nothing at all.", "Only the opposite."],
          correct_answer: sentence,
          accepted_answers: [],
          explanation: "It is stated in the excerpt.",
          source_id: sid,
          supporting_quote: sentence,
          difficulty: "easy",
        },
        {
          type: "true_false",
          question: "The moon is made of green cheese according to the lecture.",
          options: null,
          correct_answer: "True",
          accepted_answers: [],
          explanation: "Made up.",
          source_id: sid,
          supporting_quote: "the moon is made of green cheese and astronauts eat it",
          difficulty: "easy",
        },
        {
          type: "short_answer",
          question: `In a few words, how does the material on ${topic} begin its last excerpt?`,
          options: null,
          correct_answer: last[1].split(" ").slice(0, 3).join(" "),
          accepted_answers: [],
          explanation: "From the last excerpt.",
          source_id: "S1",
          supporting_quote: last[1].split(" ").slice(0, 12).join(" "),
          difficulty: "medium",
        },
      ],
    };
  }
  if (schemaName === "LLMTopics") return { topics: [] }; // fall back to embedding segmentation
  if (schemaName === "TopicLabels") {
    const n = [...prompt.matchAll(/<topic index="(\d+)">/g)].length;
    return { topics: Array.from({ length: n }, (_, i) => ({ index: i, name: `Model Topic ${i + 1}`, summary: "A summary.", keywords: ["k"] })) };
  }
  if (schemaName === "Ping") return { ok: true, reply: "ready" };
  if (schemaName === "Verdict") return { verdict: "partially_correct", feedback: "Nearly there." };
  return {};
}

/** Which request this is: the tool / schema name, or for Claude's JSON mode, guessed from the prompt. */
export function schemaOf(body) {
  const named = body.tools?.[0]?.name ?? body.tools?.[0]?.function?.name ?? body.response_format?.json_schema?.name;
  if (named) return named;
  const prompt = body.messages.at(-1).content;
  if (prompt.includes("<excerpt")) return "QuestionBatch";
  if (prompt.includes("<topic index")) return "TopicLabels";
  if (prompt.includes("outline of the study material")) return "LLMTopics";
  if (prompt.includes("Reply with ok=true")) return "Ping";
  return "Verdict";
}
