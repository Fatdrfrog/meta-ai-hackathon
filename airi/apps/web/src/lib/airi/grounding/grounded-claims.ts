const SENTENCE_SPLIT = /(?<=[.!?…])\s+/u;

function tokenizeForOverlap(text: string): Set<string> {
  const raw = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const parts = raw.split(/\s+/).filter(w => w.length > 2);
  return new Set(parts);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function sentenceLooksFactual(sentence: string): boolean {
  const t = sentence.trim();
  if (t.length < 24) return false;
  if (/\d/.test(t)) return true;
  if (/\b(is|are|was|were|costs?|price|fee|₸|\$|€|£)\b/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Heuristic claim check: factual-looking sentences should overlap retrieved citation text.
 */
export function postCheckClaims(params: {
  answer: string;
  citationTexts: string[];
}): { unsupportedClaims: string[]; confidence: number } {
  const corpus = params.citationTexts.join("\n").toLowerCase();
  const corpusTokens = tokenizeForOverlap(corpus);
  const sentences = params.answer
    .split(SENTENCE_SPLIT)
    .map(s => s.trim())
    .filter(Boolean);

  const unsupported: string[] = [];
  for (const s of sentences) {
    if (!sentenceLooksFactual(s)) continue;
    const st = tokenizeForOverlap(s);
    const overlap = jaccard(st, corpusTokens);
    if (overlap < 0.08) {
      unsupported.push(s);
    }
  }

  const penalty = Math.min(0.45, unsupported.length * 0.12);
  const confidence = Math.max(0, 1 - penalty);

  return { unsupportedClaims: unsupported, confidence };
}
