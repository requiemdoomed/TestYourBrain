// Fuzzy string matching in the spirit of RapidFuzz: ratio, partialRatio and tokenSetRatio, all 0-100.
// Used to check that a question's quote really is in its source passage, and to accept answers
// with small spelling mistakes.

/** Length of the longest common subsequence (two-row dynamic programming). */
function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  if (a.length < b.length) [a, b] = [b, a];
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = ca === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : cur[j - 1] > prev[j] ? cur[j - 1] : prev[j];
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Normalised Indel similarity: 100 means identical. */
export function ratio(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  const total = a.length + b.length;
  if (!total) return 100;
  return (200 * lcsLength(a, b)) / total;
}

/**
 * Best ratio of the shorter string against any equally long window of the longer one (including
 * shorter windows that hang off either end, as RapidFuzz does). Short strings are checked exhaustively;
 * for long ones, windows are only tried where the strings share a 3-character anchor, which keeps it
 * fast on whole pages of text while finding the same best window in practice.
 */
export function partialRatio(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (!a.length || !b.length) return a.length === b.length ? 100 : 0;
  const [needle, hay] = a.length <= b.length ? [a, b] : [b, a];
  if (hay.includes(needle)) return 100;
  const n = needle.length;
  if (n === hay.length) return Math.max(ratio(needle, hay), ratio(hay, needle));

  if ((hay.length + n) * n * n <= 4_000_000) {
    let best = 0;
    for (let i = 1; i < n; i++) best = Math.max(best, ratio(needle, hay.slice(0, i)));
    for (let i = 0; i + n <= hay.length; i++) best = Math.max(best, ratio(needle, hay.slice(i, i + n)));
    for (let i = hay.length - n + 1; i < hay.length; i++) best = Math.max(best, ratio(needle, hay.slice(i)));
    return best;
  }

  const gram = Math.min(3, n);
  const index = new Map();
  for (let j = 0; j + gram <= n; j++) {
    const g = needle.slice(j, j + gram);
    if (!index.has(g)) index.set(g, []);
    index.get(g).push(j);
  }
  const votes = new Map();
  for (let i = 0; i + gram <= hay.length; i++) {
    const offsets = index.get(hay.slice(i, i + gram));
    if (!offsets) continue;
    for (const j of offsets) {
      const start = Math.max(-n + 1, Math.min(hay.length - 1, i - j));
      votes.set(start, (votes.get(start) ?? 0) + 1);
    }
  }
  if (!votes.size) return ratio(needle, hay.slice(0, n));
  const starts = [...votes.entries()].sort((x, y) => y[1] - x[1]).slice(0, 300);
  let best = 0;
  for (const [start] of starts) {
    const window = hay.slice(Math.max(0, start), Math.max(0, start) + n);
    if (!window) continue;
    const r = ratio(needle, window);
    if (r > best) best = r;
    if (best === 100) break;
  }
  return best;
}

const tokens = (s) =>
  String(s ?? "")
    .split(/\s+/)
    .filter(Boolean);

/** Compares the sets of words, ignoring order and repeats; 100 when one set contains the other. */
export function tokenSetRatio(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).sort();
  const diffAB = [...ta].filter((t) => !tb.has(t)).sort();
  const diffBA = [...tb].filter((t) => !ta.has(t)).sort();
  if (inter.length && (!diffAB.length || !diffBA.length)) return 100;
  const sect = inter.join(" ");
  const ab = diffAB.join(" ");
  const ba = diffBA.join(" ");
  const t1 = sect ? `${sect} ${ab}` : ab;
  const t2 = sect ? `${sect} ${ba}` : ba;
  const scores = [ratio(t1, t2)];
  if (sect) scores.push(ratio(sect, t1), ratio(sect, t2));
  return Math.max(...scores);
}
