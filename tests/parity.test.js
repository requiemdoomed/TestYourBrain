// Checks the JavaScript engine against output recorded from the original Python backend
// (tests/fixtures/parity.json, made by scripts/make_parity_fixtures.py).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { splitText } from "../src/engine/chunk.js";
import { hashingEmbed } from "../src/engine/embeddings.js";
import { partialRatio, ratio, tokenSetRatio } from "../src/engine/fuzzy.js";
import { swapTerm, TermBank } from "../src/engine/offline-generator.js";
import { nameOffline, segment } from "../src/engine/topics.js";
import { normalizeAnswer, paragraphs, sentences } from "../src/engine/text.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));

test("answers are normalised the same way", () => {
  for (const [input, expected] of Object.entries(fx.normalize)) assert.equal(normalizeAnswer(input), expected, input);
});

test("paragraphs and sentences match", () => {
  for (const doc of fx.docs) {
    doc.chunks.forEach((c, i) => {
      assert.deepEqual(paragraphs(c.text), doc.paragraphs[i], `${doc.file} chunk ${i} paragraphs`);
      assert.deepEqual(sentences(c.text), doc.sentences[i], `${doc.file} chunk ${i} sentences`);
      assert.deepEqual(sentences(c.text, true), doc.complete_sentences[i], `${doc.file} chunk ${i} complete`);
    });
  }
});

test("chunking matches LangChain's recursive splitter", () => {
  fx.docs.forEach((doc, i) => {
    assert.deepEqual(splitText(doc.segments[0].text.repeat(3)), fx.split[i], doc.file);
  });
  for (const doc of fx.docs) {
    const mine = doc.segments.flatMap((s) =>
      splitText(s.text)
        .map((p) => p.trim())
        .filter((p) => p.length >= 15),
    );
    assert.deepEqual(
      mine,
      doc.chunks.map((c) => c.text),
      doc.file,
    );
  }
});

test("hashing vectors are identical to scikit-learn's HashingVectorizer", () => {
  for (const doc of fx.docs) {
    doc.hash_nonzero.forEach((idx, i) => {
      const c = doc.chunks[i];
      const v = hashingEmbed(c.title ? `${c.title}\n${c.text}` : c.text);
      const nz = [...v.keys()].filter((k) => v[k] !== 0);
      assert.deepEqual(nz, idx, `${doc.file} chunk ${i} indexes`);
      nz.forEach((k, j) => assert.ok(Math.abs(v[k] - doc.hash_values[i][j]) < 1e-5));
    });
  }
});

test("topic boundaries and names match", () => {
  for (const doc of fx.docs) {
    const texts = doc.chunks.map((c) => c.text);
    const titles = doc.chunks.map((c) => c.title);
    const vectors = doc.chunks.map((c) => hashingEmbed(c.title ? `${c.title}\n${c.text}` : c.text));
    const bounds = segment(
      vectors,
      titles,
      doc.chunks.map((c) => c.location),
      texts,
      doc.unit,
    );
    assert.deepEqual(bounds, doc.segment_bounds, `${doc.file} boundaries`);
    const spans = nameOffline(
      bounds.map(([start, end]) => ({ start, end })),
      texts,
      titles,
    );
    assert.deepEqual(
      spans.map((s) => s.name),
      doc.topic_names,
      `${doc.file} names`,
    );
    // Keywords with exactly equal TF-IDF weights come out in numpy's (unstable) sort order,
    // and the substring rule then hides different near-duplicates, so only the strongest keyword
    // has to be among Python's top three
    spans.forEach((s, i) => {
      const py = doc.topic_keywords[i];
      const top = s.keywords[0];
      assert.ok(
        py.slice(0, 3).some((k) => k === top || k.includes(top) || top.includes(k)),
        `${doc.file} keywords ${i}: ${s.keywords} vs ${py}`,
      );
    });
  }
});

test("key terms and definitions match", () => {
  for (const doc of fx.docs) {
    const bank = TermBank.build(
      doc.chunks.map((c) => c.text),
      doc.topic_keywords.flat(),
    );
    assert.deepEqual(Object.fromEntries(bank.kinds), doc.terms, `${doc.file} terms`);
    assert.deepEqual(Object.fromEntries(bank.definitions), doc.definitions, `${doc.file} definitions`);
  }
});

test("term swaps keep the grammar", () => {
  for (const [s, o, n, expected] of fx.swaps) assert.equal(swapTerm(s, o, n), expected);
});

test("fuzzy scores are close to RapidFuzz", () => {
  for (const p of fx.fuzz) {
    assert.ok(Math.abs(ratio(p.a, p.b) - p.ratio) < 0.01, `ratio ${p.a} | ${p.b}`);
    assert.ok(Math.abs(tokenSetRatio(p.a, p.b) - p.token_set) < 0.01, `token_set ${p.a} | ${p.b}: ${tokenSetRatio(p.a, p.b)} vs ${p.token_set}`);
    assert.ok(Math.abs(partialRatio(p.a, p.b) - p.partial) <= 6, `partial ${p.a} | ${p.b}: ${partialRatio(p.a, p.b)} vs ${p.partial}`);
  }
});
