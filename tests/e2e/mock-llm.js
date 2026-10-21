// A local fake of the Anthropic and OpenAI APIs for the end-to-end test, so the AI path can be checked in a
// real browser without an API key. It allows cross-origin requests like the real APIs do.

import { createServer } from "node:http";
import { modelAnswer, schemaOf } from "../fake-model.js";

export function startMockModel(port) {
  const requests = [];
  const server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "POST, OPTIONS",
    };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const name = schemaOf(body);
      requests.push({ path: req.url, name, body });
      const answer = JSON.stringify(modelAnswer(name, body.messages.at(-1).content));
      let out;
      if (req.url.endsWith("/v1/messages")) out = { content: [{ type: "text", text: answer }] };
      else if (body.tools) out = { choices: [{ message: { tool_calls: [{ function: { name, arguments: answer } }] } }] };
      else out = { choices: [{ message: { content: answer } }] };
      res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  server.listen(port);
  return { requests, close: () => server.close() };
}
