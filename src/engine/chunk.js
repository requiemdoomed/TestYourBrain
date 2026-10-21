// Splits page/slide text into overlapping chunks for retrieval.
// A faithful port of LangChain's RecursiveCharacterTextSplitter (keep_separator="start").

import { escapeRegExp } from "./text.js";

export const DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", "; ", ", ", " ", ""];

function splitWithSeparator(text, separator) {
  if (!separator) return [...text].filter((s) => s !== "");
  const parts = text.split(new RegExp(`(${escapeRegExp(separator)})`));
  const pieces = [];
  for (let i = 1; i < parts.length; i += 2) pieces.push(parts[i] + (parts[i + 1] ?? ""));
  // String.split with a capture group always gives an odd number of parts, so the tail is already in
  return [parts[0], ...pieces].filter((s) => s !== "");
}

function joinDocs(docs, separator) {
  const text = docs.join(separator).trim();
  return text === "" ? null : text;
}

function mergeSplits(splits, separator, chunkSize, overlap) {
  const sepLen = separator.length;
  const docs = [];
  let current = [];
  let total = 0;
  for (const d of splits) {
    const len = d.length;
    if (total + len + (current.length ? sepLen : 0) > chunkSize) {
      if (current.length) {
        const doc = joinDocs(current, separator);
        if (doc !== null) docs.push(doc);
        while (total > overlap || (total + len + (current.length ? sepLen : 0) > chunkSize && total > 0)) {
          total -= current[0].length + (current.length > 1 ? sepLen : 0);
          current = current.slice(1);
        }
      }
    }
    current.push(d);
    total += len + (current.length > 1 ? sepLen : 0);
  }
  const doc = joinDocs(current, separator);
  if (doc !== null) docs.push(doc);
  return docs;
}

function splitRecursive(text, separators, chunkSize, overlap) {
  const out = [];
  let separator = separators[separators.length - 1];
  let rest = [];
  for (let i = 0; i < separators.length; i++) {
    const s = separators[i];
    if (s === "") {
      separator = s;
      break;
    }
    if (text.includes(s)) {
      separator = s;
      rest = separators.slice(i + 1);
      break;
    }
  }
  const splits = splitWithSeparator(text, separator);
  let good = [];
  for (const s of splits) {
    if (s.length < chunkSize) {
      good.push(s);
      continue;
    }
    if (good.length) {
      out.push(...mergeSplits(good, "", chunkSize, overlap));
      good = [];
    }
    if (!rest.length) out.push(s);
    else out.push(...splitRecursive(s, rest, chunkSize, overlap));
  }
  if (good.length) out.push(...mergeSplits(good, "", chunkSize, overlap));
  return out;
}

export function splitText(text, { chunkSize = 900, chunkOverlap = 120, separators = DEFAULT_SEPARATORS } = {}) {
  return splitRecursive(text, separators, chunkSize, chunkOverlap);
}
