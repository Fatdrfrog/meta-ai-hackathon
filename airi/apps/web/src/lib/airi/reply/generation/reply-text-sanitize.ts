/**
 * Removes a trailing fragment that often appears when the model (or a JSON
 * merge) concatenates a second copy of the opening lines after a stray quote,
 * e.g. "...find that information."Understood.\n\nTo help you with..."
 */
export function stripLlmJsonGlueDuplicateSuffix(raw: string): string {
  const t = raw.trim();
  if (t.length < 50) return t;

  const normalizeForCompare = (s: string) =>
    s
      .replace(/^["'\u201c\u201d\u00ab\u00bb\s]+/u, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const splitIndices: number[] = [];
  for (let i = 8; i < t.length - 2; i += 1) {
    const ch = t[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
    let j = i + 1;
    while (j < t.length && /\s/.test(t[j])) j += 1;
    if (j < t.length && (t[j] === '"' || t[j] === "\u201c")) {
      splitIndices.push(i);
    }
  }

  for (let s = splitIndices.length - 1; s >= 0; s -= 1) {
    const i = splitIndices[s];
    let j = i + 1;
    while (j < t.length && /\s/.test(t[j])) j += 1;
    if (j >= t.length) continue;

    const main = t.slice(0, i + 1).trimEnd();
    const tail = t.slice(j + 1).trim();
    if (tail.length < 12 || main.length < 24) continue;

    const mainOpening = normalizeForCompare(main).slice(0, 96);
    const tailOpening = normalizeForCompare(tail).slice(0, 96);
    const compareLen = Math.min(28, mainOpening.length, tailOpening.length);
    if (compareLen < 10) continue;

    if (mainOpening.slice(0, compareLen) === tailOpening.slice(0, compareLen)) {
      return main;
    }
  }

  return t;
}

export function stripInternalCitationMarkers(raw: string): string {
  return String(raw || "")
    .replace(/(?<!\])\s*\[(?:\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

export function normalizeReplyText(raw: string, maxChars: number): string {
  const preparedReply =
    stripInternalCitationMarkers(
      stripLlmJsonGlueDuplicateSuffix(String(raw || "").trim())
    ) || "";
  if (preparedReply.length <= maxChars) {
    return preparedReply;
  }

  const truncated = preparedReply.slice(0, maxChars);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf(".\n"),
    truncated.lastIndexOf("!\n"),
    truncated.lastIndexOf("?\n")
  );

  return lastSentenceEnd > maxChars * 0.5
    ? truncated.slice(0, lastSentenceEnd + 1).trim()
    : `${truncated.trim()}...`;
}
