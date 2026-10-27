export type HyDEArtifactSource = "snippet" | "kb";

export interface HyDEArtifact {
  source: HyDEArtifactSource;
  query: string;
  hypotheticalAnswer: string;
}

export interface HyDELeakageMatch extends HyDEArtifact {
  reason: "exact_normalized_match" | "substring_match" | "high_ngram_overlap";
  tokenOverlap: number;
  bigramOverlap: number;
}

const CUSTOMER_ROLE_TAG = "[CUSTOMER]";
const MIN_TOKEN_LENGTH = 3;
const MIN_SUBSTRING_CHARS = 80;
const MIN_TOKEN_OVERLAP = 0.78;
const MIN_BIGRAM_OVERLAP = 0.66;

function normalizeHyDEText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeHyDEText(normalized: string): string[] {
  return normalized
    .split(" ")
    .map(token => token.trim())
    .filter(token => token.length >= MIN_TOKEN_LENGTH);
}

function dedupeNormalizedTexts(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeHyDEText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value.trim());
  }

  return result;
}

function buildNgrams(tokens: string[], size: number): string[] {
  if (tokens.length < size) return [];
  const ngrams: string[] = [];
  for (let index = 0; index <= tokens.length - size; index += 1) {
    ngrams.push(tokens.slice(index, index + size).join(" "));
  }
  return ngrams;
}

function overlapBySmallerSet(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;

  leftSet.forEach(item => {
    if (rightSet.has(item)) intersection += 1;
  });

  return intersection / Math.max(1, Math.min(leftSet.size, rightSet.size));
}

export function extractCustomerOnlyConversationContextForHyDE(
  conversationContext?: string,
  maxChars: number = 500
): string {
  const lines = String(conversationContext || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const customerMessages = lines.flatMap(line => {
    const tagIndex = line.indexOf(CUSTOMER_ROLE_TAG);
    if (tagIndex === -1) return [];
    const message = line.slice(tagIndex + CUSTOMER_ROLE_TAG.length).trim();
    return message ? [message] : [];
  });

  const dedupedMessages = dedupeNormalizedTexts(customerMessages);
  if (dedupedMessages.length === 0) return "";

  const joined = dedupedMessages.join("\n");
  return joined.length <= maxChars ? joined : joined.slice(-maxChars).trim();
}

function detectHyDELeakageAgainstArtifact(
  candidateText: string,
  artifact: HyDEArtifact
): HyDELeakageMatch | null {
  const candidateNormalized = normalizeHyDEText(candidateText);
  const hypotheticalNormalized = normalizeHyDEText(artifact.hypotheticalAnswer);

  if (!candidateNormalized || !hypotheticalNormalized) {
    return null;
  }

  const candidateTokens = tokenizeHyDEText(candidateNormalized);
  const hypotheticalTokens = tokenizeHyDEText(hypotheticalNormalized);
  const tokenOverlap = overlapBySmallerSet(candidateTokens, hypotheticalTokens);
  const bigramOverlap = overlapBySmallerSet(
    buildNgrams(candidateTokens, 2),
    buildNgrams(hypotheticalTokens, 2)
  );

  if (candidateNormalized === hypotheticalNormalized) {
    return {
      ...artifact,
      reason: "exact_normalized_match",
      tokenOverlap,
      bigramOverlap,
    };
  }

  const hasLongEnoughTexts =
    candidateNormalized.length >= MIN_SUBSTRING_CHARS &&
    hypotheticalNormalized.length >= MIN_SUBSTRING_CHARS;

  if (
    hasLongEnoughTexts &&
    (candidateNormalized.includes(hypotheticalNormalized) ||
      hypotheticalNormalized.includes(candidateNormalized))
  ) {
    return {
      ...artifact,
      reason: "substring_match",
      tokenOverlap,
      bigramOverlap,
    };
  }

  if (
    tokenOverlap >= MIN_TOKEN_OVERLAP &&
    bigramOverlap >= MIN_BIGRAM_OVERLAP
  ) {
    return {
      ...artifact,
      reason: "high_ngram_overlap",
      tokenOverlap,
      bigramOverlap,
    };
  }

  return null;
}

export function findHyDELeakageMatch(
  candidateText: string,
  artifacts: HyDEArtifact[] | undefined
): HyDELeakageMatch | null {
  if (!artifacts || artifacts.length === 0) return null;

  let bestMatch: HyDELeakageMatch | null = null;
  for (const artifact of artifacts) {
    const match = detectHyDELeakageAgainstArtifact(candidateText, artifact);
    if (!match) continue;

    const score = match.tokenOverlap + match.bigramOverlap;
    const bestScore = bestMatch
      ? bestMatch.tokenOverlap + bestMatch.bigramOverlap
      : Number.NEGATIVE_INFINITY;

    if (!bestMatch || score > bestScore) {
      bestMatch = match;
    }
  }

  return bestMatch;
}
