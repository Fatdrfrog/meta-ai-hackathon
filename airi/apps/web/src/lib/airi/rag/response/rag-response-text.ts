import { normalizeHttpUrlForRag } from "@/lib/airi/rag/http-url-normalize";
import { stripLlmJsonGlueDuplicateSuffix } from "@/lib/airi/reply/generation/reply-text-sanitize";

export function structureReplyForReadability(reply: string): string {
  const trimmed = (reply || "").trim();
  if (!trimmed) return trimmed;

  const hasLineBreaks = /\r?\n/.test(trimmed);
  if (hasLineBreaks) {
    return trimmed
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  if (/https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\s+/g, " ").trim();
  }

  let normalized = trimmed.replace(/\s+/g, " ").trim();
  normalized = normalized.replace(/\s(?=\d+\.\s)/g, "\n");

  if (/\n/.test(normalized)) {
    return normalized
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const sentences = normalized
    .split(/(?<=[.!?…])\s+/u)
    .map(s => s.trim())
    .filter(Boolean);

  const averageSentenceLength =
    sentences.length > 0
      ? sentences.reduce((sum, s) => sum + s.length, 0) / sentences.length
      : 0;

  const shouldSplitIntoParagraphs =
    (sentences.length >= 3 && averageSentenceLength >= 24) ||
    (sentences.length >= 2 &&
      normalized.length > 160 &&
      averageSentenceLength >= 20);

  if (shouldSplitIntoParagraphs) {
    const blocks: string[] = [];
    for (let i = 0; i < sentences.length; i += 2) {
      blocks.push(sentences.slice(i, i + 2).join(" "));
    }
    return blocks.join("\n\n").trim();
  }

  return normalized;
}

function sanitizeResponseUrls(
  reply: string,
  allowedUrls: Set<string> = new Set()
): string {
  let cleaned = reply;

  cleaned = cleaned.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi,
    (match, label: string, rawUrl: string) => {
      const normalized = normalizeHttpUrlForRag(rawUrl);
      return allowedUrls.has(normalized) ? match : label;
    }
  );

  cleaned = cleaned.replace(/https?:\/\/[^\s<>\])]+/gi, rawUrl => {
    const normalized = normalizeHttpUrlForRag(rawUrl);
    return allowedUrls.has(normalized) ? rawUrl : "";
  });

  return cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeGeneratedReply(
  reply: string,
  allowedUrls: Set<string> = new Set()
): string {
  return stripLlmJsonGlueDuplicateSuffix(
    sanitizeResponseUrls(reply, allowedUrls)
  );
}
