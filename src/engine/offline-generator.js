// Rule-based question generator, used when no AI model is configured (or a model call fails).
//
// It works from complete sentences in the retrieved chunks:
//   * definitions ("A semaphore is an integer variable ...") become "which term" questions,
//   * other factual sentences become fill-in-the-blank, true/false (with one detail swapped)
//     and short-answer questions,
//   * distractors are other key terms of the same kind from the material
//     (other defined terms, names, acronyms, numbers).
// Every question carries the chunk it came from, exactly like model-written ones.

import { capitalize, escapeRegExp, isLower, isUpper, normalizeAnswer, sentences } from "./text.js";

const W = "[\\p{L}\\p{N}_]"; // Python's \w
const TERM = `^(?:An?\\s+|The\\s+)?(?<term>[A-Za-z0-9][\\p{L}\\p{N}_\\s\\-'’()/]{0,60}?)\\s+`;
const DEF_IS = new RegExp(
  TERM +
    "(?<verb>is|are)\\s+" +
    "(?<rest>(?:a|an|the|one of|used to|used for|responsible for|known as)\\s.{8,})$",
  "u",
);
const DEF_REF = new RegExp(TERM + "(?<verb>refers to|means|describes)\\s+(?<rest>.{10,})$", "u");

export function matchDef(sentence) {
  return DEF_IS.exec(sentence) ?? DEF_REF.exec(sentence);
}

const NUMBER = new RegExp(`(?<![\\p{L}\\p{N}_.])\\d+(?:\\.\\d+)?(?![\\p{L}\\p{N}_.]*${W})`, "gu");
const WORD = /[A-Za-z][A-Za-z0-9'’-]*/g;
const COMMON = new Set(
  `a an the and or of to in on for with by from as at is are was were be been being this that these
  those it its their there which who whom whose what when where why how not no can could may might
  must shall should will would each every all any some most more less many much such than then also
  only very just into onto over under between about after before during while because so if do does
  did done has have had having one two three four five six seven eight nine ten first second third new
  use used using uses make made way part set level type types example examples overview introduction
  summary chapter section slide page figure table notes speaker remind students however therefore thus
  often typically usually called known include includes including different same other`.split(/\s+/),
);
const GERUND_START = /^\w+ing\b/i;
const PRONOUN_START = new Set(
  "it this that they there which what these those he she we you its their each both all".split(" "),
);

const words = (s) => s.match(WORD) ?? [];
const hasDigit = (w) => /\d/.test(w);

export function isAcronym(w) {
  return [...w].filter(isUpper).length >= 2 && w.length >= 2;
}

const findCache = new Map();
/** Case-insensitive whole-term search (terms may contain spaces and hyphens). */
function find(sentence, term) {
  let re = findCache.get(term);
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(term)}(?![\\p{L}\\p{N}_-])`, "iu");
    if (findCache.size > 5000) findCache.clear();
    findCache.set(term, re);
  }
  return re.exec(sentence);
}

const KIND_SCORE = { def: 3.0, name: 2.6, acronym: 2.5, phrase: 2.0, keyword: 1.2 };
const COMPAT = {
  def: ["def", "phrase"],
  phrase: ["phrase", "def"],
  name: ["name"],
  acronym: ["acronym"],
  keyword: ["keyword", "phrase", "def"],
};

function goodTerm(term) {
  const ws = term.trim().split(/\s+/);
  if (!(ws.length >= 1 && ws.length <= 5)) return false;
  if (PRONOUN_START.has(ws[0].toLowerCase()) || GERUND_START.test(term)) return false;
  return !ws.every((w) => COMMON.has(w.toLowerCase()));
}

function defTermCase(term, names) {
  const ws = term.split(/\s+/);
  if (ws.length === 1 && isUpper(term[0]) && !isAcronym(term) && !names.has(term.toLowerCase())) {
    return term.toLowerCase();
  }
  return term;
}

function initials(t) {
  const ws = t.split(/[\s-]+/).filter((w) => w && !["of", "and", "the", "a", "an"].includes(w.toLowerCase()));
  return ws.length > 1 ? ws.map((w) => w[0]).join("").toLowerCase() : "~";
}

/** Make distractors look like the answer (so capitalisation doesn't give it away). */
function matchCase(t, answer) {
  if (isAcronym(t) || t.split(/\s+/).slice(1).some((w) => isUpper(w[0]))) return t;
  if (isLower(answer[0])) return t[0].toLowerCase() + t.slice(1);
  if (isUpper(answer[0])) return t[0].toUpperCase() + t.slice(1);
  return t;
}

const stripChars = (s, chars) => {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
};

/** Key terms of the whole material, grouped by kind, used for answers and distractors. */
export class TermBank {
  constructor() {
    this.kinds = new Map(); // term -> def | name | acronym | phrase | keyword
    this.definitions = new Map();
  }

  add(term, kind) {
    term = stripChars(term.trim(), ` .,:;()"'“”`);
    if (!(term.length >= 2 && term.length <= 60)) return;
    const ws = term.toLowerCase().split(/\s+/);
    if (ws.every((w) => COMMON.has(w)) || PRONOUN_START.has(ws[0])) return;
    const lower = term.toLowerCase();
    const existing = [...this.kinds.keys()].find((t) => t.toLowerCase() === lower);
    if (existing === undefined) this.kinds.set(term, kind);
    else if (KIND_SCORE[kind] > KIND_SCORE[this.kinds.get(existing)]) this.kinds.set(existing, kind);
  }

  static build(texts, keywordList = []) {
    const bank = new TermBank();
    const names = new Set();
    for (const txt of texts) {
      for (const s of sentences(txt)) {
        const ws = words(s);
        const caps = ws.filter((w) => isUpper(w[0])).length;
        if (ws.length && (caps / ws.length > 0.6 || ws.length < 4)) continue; // a heading line, not prose
        // Capitalised runs: names, places, named methods and algorithms
        let run = [];
        const padded = [...ws, "x"];
        for (let i = 0; i < padded.length; i++) {
          const w = padded[i];
          const digit = hasDigit(w);
          if (digit && isAcronym(w) && w.length >= 3 && !run.length) bank.add(w, "acronym");
          const cap = isUpper(w[0]) && !digit;
          const startsOk = i > 0 || isAcronym(w) || (i + 1 < ws.length && isUpper(ws[i + 1][0]));
          if (cap && (run.length || (!COMMON.has(w.toLowerCase()) && startsOk))) {
            run.push(w);
            continue;
          }
          if (run.length) {
            while (run.length && COMMON.has(run[run.length - 1].toLowerCase())) run.pop();
            const phrase = run.join(" ").replace(/['’]s$/, "");
            if (run.every((r) => isAcronym(r.split("-")[0]))) {
              for (const r of run) bank.add(r, "acronym");
            } else if (run.length) {
              bank.add(phrase, "name");
              names.add(phrase.toLowerCase());
            }
            run = [];
          }
        }
        const m = matchDef(s);
        if (m && goodTerm(m.groups.term)) {
          const term = defTermCase(m.groups.term.trim(), names);
          if (!bank.definitions.has(term)) bank.definitions.set(term, m.groups.rest.replace(/[. ]+$/, ""));
          bank.add(term, "def");
        }
      }
    }
    const corpus = texts.join(" ").toLowerCase();
    for (let k of keywordList) {
      k = k.trim();
      if (k.includes(" ")) {
        if (corpus.split(k.toLowerCase()).length - 1 >= 2) bank.add(k, "phrase");
      } else if (k.length >= 6) {
        bank.add(k, "keyword");
      }
    }
    return bank;
  }

  score(term) {
    const kind = this.kinds.get(term);
    if (kind === undefined) return 0;
    return KIND_SCORE[kind] + 0.1 * Math.min(term.split(/\s+/).length, 3);
  }

  kindOf(term) {
    const ws = term.split(/\s+/);
    if (isAcronym(ws[0]) && ws.length === 1) return "acronym";
    if (this.kinds.has(term)) return this.kinds.get(term);
    const lower = term.toLowerCase();
    for (const [t, k] of this.kinds) if (t.toLowerCase() === lower) return k;
    return "keyword";
  }

  distractors(answer, context, n, rng, topicTerms = null, sameKindOnly = false) {
    const ans = normalizeAnswer(answer);
    const ctx = context.toLowerCase();
    const kind = this.kindOf(answer);
    const allowed = sameKindOnly ? COMPAT[kind].slice(0, 1) : COMPAT[kind];
    const ansWords = new Set(ans.split(" "));
    const tiers = new Map();
    for (const t of this.kinds.keys()) {
      const k = this.kindOf(t);
      if (!allowed.includes(k)) continue;
      const nt = normalizeAnswer(t);
      if (!nt || nt === ans || nt.includes(ans) || ans.includes(nt) || ctx.includes(t.toLowerCase())) continue;
      if (initials(t) === ans.replace(/ /g, "") || initials(answer) === nt.replace(/ /g, "")) continue; // "DNS" vs "Domain Name System"
      if (nt.slice(0, 5) === ans.slice(0, 5) && Math.min(nt.length, ans.length) >= 5) continue; // same stem ("Britain" / "British")
      if (nt.split(" ").some((w) => ansWords.has(w) && !COMMON.has(w))) continue; // shares a content word: ambiguous or a giveaway
      let tier = allowed.indexOf(k);
      if (topicTerms && !topicTerms.has(t.toLowerCase())) tier += 0.5; // for hard questions, prefer terms from the same topic
      if (!tiers.has(tier)) tiers.set(tier, []);
      tiers.get(tier).push(t);
    }
    const out = [];
    for (const tier of [...tiers.keys()].sort((a, b) => a - b)) out.push(...rng.shuffle(tiers.get(tier)));
    const seen = new Set();
    const uniq = [];
    for (const t of out.map((x) => matchCase(x, answer))) {
      if (!seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        uniq.push(t);
      }
    }
    return uniq.slice(0, n);
  }
}

function numberVariants(num, rng, n = 3) {
  const v = Number(num);
  if (!Number.isFinite(v)) return [];
  const isInt = !num.includes(".");
  let cands;
  if (isInt && v >= 1000 && v <= 2100) {
    // a year: nearby years
    cands = rng.shuffle([-30, -15, -10, -5, 5, 10, 20, 40]).map((o) => String(v + o));
  } else {
    cands = rng.shuffle([0.5, 2, 1.5, 0.75, 3, 1.25, 4, 0.25]).map((f) => {
      const nv = v * f;
      return isInt ? String(Math.max(1, Math.round(nv))) : nv.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    });
  }
  const out = [];
  for (const s of cands) {
    if (s !== num && !out.includes(s)) out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

/** Most specific known term in the sentence, returned with the sentence's own spelling. */
function bestTerm(sentence, bank) {
  let best = null;
  let bestScore = 0;
  for (const t of bank.kinds.keys()) {
    const m = find(sentence, t);
    if (!m) continue;
    const sc = bank.score(t);
    if (sc > bestScore || (sc === bestScore && best && t.length > best.length)) [best, bestScore] = [m[0], sc];
  }
  if (best === null || bestScore < 1.2) return null;
  const names = new Set([...bank.kinds].filter(([, k]) => k === "name").map(([t]) => t.toLowerCase()));
  if (isUpper(best[0]) && sentence.startsWith(best) && !isAcronym(best.split(/\s+/)[0]) && !names.has(best.toLowerCase())) {
    best = bank.kinds.get(best) !== "name" ? best[0].toLowerCase() + best.slice(1) : best;
  }
  return best;
}

function looksPlural(term) {
  const head = term
    .trim()
    .split(/\s+(?:of|for|in|on)\s+/)[0]
    .split(/\s+/)
    .pop();
  if (isAcronym(head)) return false;
  const low = head.toLowerCase();
  return low.endsWith("s") && !["ss", "us", "is", "sis"].some((e) => low.endsWith(e));
}

/** Replace one term with another, keeping "a/an" and "is/are" around it grammatical. */
export function swapTerm(sentence, old, replacement) {
  const match = find(sentence, old);
  if (!match) return sentence;
  let before = sentence.slice(0, match.index);
  let after = sentence.slice(match.index + match[0].length);

  const verb = /^\s+(is|are)\b/.exec(after);
  if (verb && looksPlural(old) !== looksPlural(replacement)) {
    const at = verb[0].length - verb[1].length;
    after = after.slice(0, at) + (looksPlural(replacement) ? "are" : "is") + after.slice(verb[0].length);
  }
  const article = /\b(an?|An?)\s+$/.exec(before);
  if (article) {
    const word = article[1];
    let art;
    if (looksPlural(replacement)) art = isUpper(word[0]) ? "The" : "the";
    else {
      art = "aeiou".includes(replacement[0].toLowerCase()) ? "an" : "a";
      if (isUpper(word[0])) art = capitalize(art);
    }
    before = before.slice(0, article.index) + art + before.slice(article.index + word.length);
  }
  return before + replacement + after;
}

function termScore(bank, term) {
  const lower = term.toLowerCase();
  const key = [...bank.kinds.keys()].find((t) => t.toLowerCase() === lower) ?? term;
  return bank.score(key);
}

function blank(sentence, term) {
  return sentence.replace(
    new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(term)}(?![\\p{L}\\p{N}_-])`, "iu"),
    "_____",
  );
}

function defQuestion(lead, verb, rest) {
  if (["refers to", "means", "describes"].includes(verb)) return `${lead} ${verb} “${rest}”?`;
  return `${lead} matches this description: “${capitalize(rest)}”?`;
}

function make(qtype, chunk, sent, bank, rng, difficulty, topicTerms) {
  const base = { chunk_id: chunk.id, supporting_quote: sent, accepted_answers: [] };
  const m = matchDef(sent);
  const isDef = !!(m && goodTerm(m.groups.term));
  const defTerm = isDef ? defTermCase(m.groups.term.trim(), new Set()) : null;
  const nums = (sent.match(NUMBER) ?? []).filter((n) => !(n.length === 1 && "0123".includes(n)));
  const term = bestTerm(sent, bank);
  const useNumber = nums.length > 0 && (difficulty === "hard" || term === null);
  const topics = difficulty === "hard" ? topicTerms : null;

  if (qtype === "mcq") {
    if (isDef && !useNumber) {
      const rest = m.groups.rest.replace(/[. ]+$/, "");
      const ds = bank.distractors(defTerm, sent, 3, rng, topics);
      if (ds.length >= 3) {
        return {
          ...base,
          type: "mcq",
          question: defQuestion("Which term", m.groups.verb, rest),
          options: rng.shuffle([defTerm, ...ds]),
          correct_answer: defTerm,
          explanation: `${capitalize(defTerm)} ${m.groups.verb} ${rest}.`,
        };
      }
    }
    let answer;
    let ds;
    if (useNumber) [answer, ds] = [nums[0], numberVariants(nums[0], rng)];
    else if (term && termScore(bank, term) >= 2.0) [answer, ds] = [term, bank.distractors(term, sent, 3, rng, topics)];
    else return null;
    if (ds.length < 3) return null;
    return {
      ...base,
      type: "mcq",
      question: `Fill in the blank: ${blank(sent, answer)}`,
      options: rng.shuffle([answer, ...ds.slice(0, 3)]),
      correct_answer: answer,
      explanation: `“${answer}” completes the statement on ${chunk.location_label}.`,
    };
  }

  if (qtype === "true_false") {
    if (!(term || nums.length || isDef)) return null;
    const makeFalse = rng.random() < 0.5;
    let statement = sent;
    let answer = "True";
    let changed = "";
    if (makeFalse) {
      let swapped = null;
      if (nums.length && (useNumber || rng.random() < 0.4)) {
        const vs = numberVariants(nums[0], rng, 1);
        if (vs.length) {
          swapped = sent.replace(new RegExp(`(?<![\\p{L}\\p{N}_.])${escapeRegExp(nums[0])}(?![\\p{L}\\p{N}_.]*${W})`, "u"), vs[0]);
          changed = `${vs[0]} should be ${nums[0]}`;
        }
      }
      if (swapped === null) {
        const target = isDef ? defTerm : term;
        const ds = target ? bank.distractors(target, sent, 1, rng, topics, true) : [];
        if (ds.length) {
          swapped = swapTerm(sent, target, ds[0]);
          changed = `it is ${target}, not ${ds[0]}`;
        }
      }
      if (swapped && swapped !== sent) [statement, answer] = [capitalize(swapped), "False"];
    }
    return {
      ...base,
      type: "true_false",
      question: statement,
      options: ["True", "False"],
      correct_answer: answer,
      explanation:
        answer === "True"
          ? `True: this is stated on ${chunk.location_label}.`
          : `False: ${changed}, as stated on ${chunk.location_label}.`,
    };
  }

  // short answer
  if (isDef && !useNumber) {
    const rest = m.groups.rest.replace(/[. ]+$/, "");
    return {
      ...base,
      type: "short_answer",
      question: defQuestion("What term", m.groups.verb, rest),
      options: null,
      correct_answer: defTerm,
      explanation: `${capitalize(defTerm)} ${m.groups.verb} ${rest}.`,
    };
  }
  const answer = useNumber ? nums[0] : term;
  if (!answer || (!useNumber && termScore(bank, answer) < 2.0)) return null; // generic words make unfair short answers
  return {
    ...base,
    type: "short_answer",
    question: `Complete the statement: ${blank(sent, answer)}`,
    options: null,
    correct_answer: answer,
    explanation: `“${answer}” completes the statement on ${chunk.location_label}.`,
  };
}

/**
 * @param {{id, text, location_label, topic_name, heading}[]} chunks
 * @param {Record<string, number>} counts  questions wanted per type
 * @returns question objects: type, question, options, correct_answer, accepted_answers, explanation,
 *          chunk_id, supporting_quote, difficulty
 */
export function generate(chunks, counts, difficulties, bank, keywordList, rng, avoid = new Set()) {
  const topicTerms = new Set(
    [...bank.kinds.keys()].filter((t) => chunks.some((c) => find(c.text, t))).map((t) => t.toLowerCase()),
  );
  let cands = [];
  for (const c of chunks) {
    const heading = (c.heading ?? "").trim().toLowerCase();
    for (const s of sentences(c.text, true)) {
      const wc = s.split(/\s+/).length;
      const ws = words(s);
      const titleLike = ws.length > 0 && ws.filter((w) => isUpper(w[0])).length / ws.length > 0.6;
      if (s.trim().toLowerCase() === heading || titleLike) continue;
      if (wc >= 6 && wc <= 45 && !s.trimEnd().endsWith("?") && !avoid.has(s)) cands.push([c, s]);
    }
  }
  rng.shuffle(cands);
  // Definitions first: they make the clearest questions
  cands.sort((a, b) => (matchDef(a[1]) ? 0 : 1) - (matchDef(b[1]) ? 0 : 1));

  const wanted = [];
  for (const [t, n] of Object.entries(counts)) for (let i = 0; i < n; i++) wanted.push(t);
  rng.shuffle(wanted);
  const out = [];
  const diffs = difficulties.length ? difficulties : ["medium"];
  wanted.forEach((qtype, i) => {
    const difficulty = diffs[i % diffs.length];
    let q = null;
    const tried = [];
    while (cands.length && q === null) {
      const [chunk, sent] = cands.shift();
      q = make(qtype, chunk, sent, bank, rng, difficulty, topicTerms);
      if (q) avoid.add(sent);
      else tried.push([chunk, sent]);
    }
    cands = [...tried, ...cands]; // unused sentences may still suit another question type
    if (q === null) return;
    q.difficulty = difficulty;
    out.push(q);
  });
  return out;
}
