import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type { EvidenceChunk } from "@/lib/airi/rag/evidence/evidence-types";
import { isFaqHeading } from "@/lib/airi/rag/knowledge/faq-heading-patterns";

const CODE_FENCE = /```[\s\S]*?```/g;
const SENTENCE_SPLIT_RE = /(?<=[.!?…。！？])\s+/u;
const HTML_HEADING_RE = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
const MD_HEADING_RE = /^(#{1,3})\s+(.+)$/;
const HTML_DETECTION_RE = /<\/?[a-z][\s\S]*>/i;

function stripCodeFences(text: string): string {
  return text.replace(CODE_FENCE, "\n");
}

/** Strip simple HTML tags for heading labels (chunk titles). */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rewrite `<a href="…">TEXT</a>` as plain text that keeps the http(s) URL
 * visible, so:
 *   1. downstream `extractHttpUrlsFromKbSource` (regex-based) can still pick
 *      the URL out of the *stored chunk body* when building the reply URL
 *      allowlist (see `kb-retrieval.ts`), and
 *   2. the LLM actually sees which URL goes with which label.
 *
 * Shape rules:
 *   - `<a href="https://x">click</a>`         → `click (https://x)`
 *   - `<a href="https://x">https://x</a>`     → `https://x` (no duplication)
 *   - `<a href="https://x"></a>`              → `https://x`
 *   - non-http schemes (mailto:, tel:, …)     → just the inner text
 *     (those should never enter the HTTP allowlist anyway)
 */
const ANCHOR_TAG_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_ATTR_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function rewriteAnchorTagsAsPlainText(html: string): string {
  return html.replace(ANCHOR_TAG_RE, (_full, attrs: string, inner: string) => {
    const hrefMatch = HREF_ATTR_RE.exec(attrs || "");
    const href = (
      hrefMatch?.[1] ??
      hrefMatch?.[2] ??
      hrefMatch?.[3] ??
      ""
    ).trim();
    const innerText = stripHtmlTags(inner);

    if (!href) return innerText ? ` ${innerText} ` : " ";
    if (!/^https?:\/\//i.test(href)) return innerText ? ` ${innerText} ` : " ";
    if (!innerText) return ` ${href} `;
    if (innerText === href || innerText.includes(href)) return ` ${innerText} `;
    return ` ${innerText} (${href}) `;
  });
}

/**
 * Convert HTML / light markdown into clean plain text with preserved paragraph
 * breaks. Kept self-contained so the chunker does not depend on `marked` at
 * runtime (important for jest transform boundaries).
 */
function htmlOrMarkdownToPlainText(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";

  const hasHtml = HTML_DETECTION_RE.test(raw);
  let text = raw;

  if (hasHtml) {
    text = rewriteAnchorTagsAsPlainText(text);
    text = text
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/td>/gi, " | ")
      .replace(/<[^>]+>/g, " ");
  } else {
    text = text
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s{0,3}[-*+]\s+/gm, "• ")
      .replace(/^\s{0,3}\d+\.\s+/gm, "");
  }

  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toPlainText(htmlOrMarkdown: string): string {
  return htmlOrMarkdownToPlainText(htmlOrMarkdown);
}

type RawSection = {
  /** Full breadcrumb from the root down to this section's heading. */
  headingPath: string[];
  /** Raw section body (still HTML/markdown at this stage). */
  rawText: string;
};

export type ChunkedSection = {
  /** Full breadcrumb. */
  headingPath: string[];
  /** Last element of `headingPath`, kept for backward-compat with tests/callers. */
  heading: string;
  /** Plain-text content of the chunk (HTML stripped, overlap already applied). */
  text: string;
};

/**
 * Extract logical sections from KB HTML while preserving the full heading hierarchy.
 * Sections inherit ancestors from lower-numbered h-tags (h1 > h2 > h3).
 */
function extractRawSectionsFromHtml(
  body: string,
  articleTitle: string
): RawSection[] {
  const matches: {
    index: number;
    end: number;
    level: number;
    inner: string;
  }[] = [];
  let m: RegExpExecArray | null;
  HTML_HEADING_RE.lastIndex = 0;
  while ((m = HTML_HEADING_RE.exec(body)) !== null) {
    matches.push({
      index: m.index,
      end: m.index + m[0].length,
      level: Number(m[1]),
      inner: m[2],
    });
  }

  if (matches.length === 0) {
    return [];
  }

  const sections: RawSection[] = [];

  const intro = body.slice(0, matches[0].index).trim();
  if (intro) {
    sections.push({
      headingPath: articleTitle ? [articleTitle] : ["Article"],
      rawText: intro,
    });
  }

  const stack: { level: number; heading: string }[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const label = stripHtmlTags(match.inner) || `Section ${i + 1}`;

    while (stack.length > 0 && stack[stack.length - 1].level >= match.level) {
      stack.pop();
    }
    stack.push({ level: match.level, heading: label });

    const bodyStart = match.end;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const rawText = body.slice(bodyStart, bodyEnd).trim() || label;

    const headingPath = stack.map(entry => entry.heading);
    sections.push({ headingPath, rawText });
  }

  return sections;
}

/**
 * Extract sections from markdown headings (# / ## / ###) with a heading stack so
 * sub-sections inherit their ancestors' labels.
 */
function extractRawSectionsFromMarkdown(
  body: string,
  articleTitle: string
): RawSection[] | null {
  const lines = body.split(/\r?\n/);
  let sawMdHeading = false;
  for (const line of lines) {
    if (MD_HEADING_RE.exec(line)) {
      sawMdHeading = true;
      break;
    }
  }
  if (!sawMdHeading) {
    return null;
  }

  const sections: RawSection[] = [];
  const stack: { level: number; heading: string }[] = [];
  let currentPath: string[] = articleTitle ? [articleTitle] : ["Article"];
  const buf: string[] = [];

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length > 0) {
      sections.push({ headingPath: currentPath.slice(), rawText: text });
    }
    buf.length = 0;
  };

  for (const line of lines) {
    const md = MD_HEADING_RE.exec(line);
    if (md) {
      flush();
      const level = md[1].length;
      const heading = md[2].trim();
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack.push({ level, heading });
      currentPath = stack.map(entry => entry.heading);
      continue;
    }
    buf.push(line);
  }
  flush();

  if (sections.length === 0 && body.trim().length > 0) {
    return [
      {
        headingPath: articleTitle ? [articleTitle] : ["Article"],
        rawText: body.trim(),
      },
    ];
  }

  return sections;
}

function extractRawSections(
  bodyText: string,
  articleTitle: string
): RawSection[] {
  const body = stripCodeFences(bodyText || "").trim();
  if (!body) return [];

  if (/<h[1-3][\s>]/i.test(body)) {
    const htmlSections = extractRawSectionsFromHtml(body, articleTitle);
    if (htmlSections.length > 0) return htmlSections;
  }

  const mdSections = extractRawSectionsFromMarkdown(body, articleTitle);
  if (mdSections && mdSections.length > 0) return mdSections;

  return [
    {
      headingPath: articleTitle ? [articleTitle] : ["Article"],
      rawText: body,
    },
  ];
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function takeTailForOverlap(text: string): string {
  const { tailSentences, maxChars } = RAG_CONFIG.chunking.overlap;
  if (tailSentences <= 0 || maxChars <= 0) return "";

  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) return "";

  const tail = sentences.slice(-Math.max(1, tailSentences)).join(" ").trim();
  if (!tail) return "";

  if (tail.length <= maxChars) return tail;
  const truncated = tail.slice(tail.length - maxChars).trim();
  const firstSpace = truncated.indexOf(" ");
  return firstSpace > 0 ? truncated.slice(firstSpace + 1) : truncated;
}

/**
 * Recursively split oversized plain-text bodies into <= maxChunkChars pieces,
 * preferring paragraph → sentence boundaries. Preserves word boundaries.
 */
function splitOversizedText(text: string): string[] {
  const { maxChunkChars, targetChunkChars } = RAG_CONFIG.chunking;
  if (text.length <= maxChunkChars) return [text];

  const paragraphs = text
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  let current = "";

  const flushCurrent = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChunkChars) {
      flushCurrent();
      const sentences = splitIntoSentences(paragraph);
      let sentenceBuf = "";
      for (const sentence of sentences) {
        if (sentence.length > maxChunkChars) {
          if (sentenceBuf.trim()) pieces.push(sentenceBuf.trim());
          sentenceBuf = "";
          for (
            let start = 0;
            start < sentence.length;
            start += targetChunkChars
          ) {
            pieces.push(sentence.slice(start, start + targetChunkChars).trim());
          }
          continue;
        }

        const joined = sentenceBuf ? `${sentenceBuf} ${sentence}` : sentence;
        if (joined.length > targetChunkChars && sentenceBuf) {
          pieces.push(sentenceBuf.trim());
          sentenceBuf = sentence;
        } else {
          sentenceBuf = joined;
        }
      }
      if (sentenceBuf.trim()) pieces.push(sentenceBuf.trim());
      continue;
    }

    const joined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (joined.length > targetChunkChars && current) {
      flushCurrent();
      current = paragraph;
    } else {
      current = joined;
    }
  }

  flushCurrent();
  return pieces.filter(Boolean);
}

/**
 * Language-agnostic "this heading looks like a FAQ question" test.
 * Used for structural FAQ detection (see `detectFaqClusters`).
 *
 * Deliberately restrictive — the presence of a trailing "?" (Latin or
 * fullwidth) is required. Numbered how-to headings like "1. Install
 * dependencies" *do not* qualify; numbered FAQ entries like "1. Что такое X?"
 * do, because they keep the question mark.
 */
function isQuestionLikeHeading(heading: string): boolean {
  const trimmed = (heading || "").trim();
  if (!trimmed) return false;
  return /[?？]\s*$/u.test(trimmed);
}

/**
 * Returns true iff the section's body is effectively empty, i.e. either blank
 * after HTML stripping, or the body just repeats the heading label
 * (a quirk of `extractRawSectionsFromHtml` when the parent heading has no
 * content before its first sub-heading).
 */
function isEmptyOrLabelOnly(plainText: string, headingPath: string[]): boolean {
  const body = (plainText || "").trim();
  if (!body) return true;
  const leaf = (headingPath[headingPath.length - 1] || "").trim();
  return leaf !== "" && body === leaf;
}

/**
 * Direct children of a parent section in document order.
 *
 * A section `s` is a direct child of `parent` iff:
 *  - it appears after `parent` in the flat document order,
 *  - its `headingPath` starts with `parent.headingPath`,
 *  - its `headingPath.length === parent.headingPath.length + 1`.
 *
 * Iteration stops as soon as we step outside parent's subtree.
 */
function findDirectChildrenIndices(
  sections: RawSection[],
  parentIdx: number
): number[] {
  const parent = sections[parentIdx];
  const parentDepth = parent.headingPath.length;
  const children: number[] = [];
  for (let i = parentIdx + 1; i < sections.length; i++) {
    const s = sections[i];
    if (s.headingPath.length <= parentDepth) break;
    let prefixMatches = true;
    for (let k = 0; k < parentDepth; k++) {
      if (s.headingPath[k] !== parent.headingPath[k]) {
        prefixMatches = false;
        break;
      }
    }
    if (!prefixMatches) break;
    if (s.headingPath.length === parentDepth + 1) {
      children.push(i);
    }
  }
  return children;
}

type FaqCluster = {
  /** Index of the parent section in the flat list. */
  parentIdx: number;
  /** Indices of direct-child sections that should be emitted as Q/A chunks. */
  childIdxs: number[];
};

/**
 * Structural FAQ detection.
 *
 * Rather than matching the parent heading against a locale-specific regex,
 * we look at the section *tree*: a parent whose direct children are
 * predominantly question-like headings (e.g. an H1 with a run of H3
 * "1. …?", "2. …?", "3. …?") is almost certainly a FAQ block, regardless of
 * whether its own heading literally says "FAQ" / "Часто задаваемые вопросы".
 *
 * `isFaqHeading` is kept as a *hint* that lowers the confirmation threshold,
 * not as a hard requirement.
 */
function detectFaqClusters(sections: RawSection[]): Map<number, FaqCluster> {
  const clusters = new Map<number, FaqCluster>();
  for (let i = 0; i < sections.length; i++) {
    const parent = sections[i];
    const parentLeaf = parent.headingPath[parent.headingPath.length - 1] || "";
    const parentLooksFaq = isFaqHeading(parentLeaf);

    const childIdxs = findDirectChildrenIndices(sections, i);
    if (childIdxs.length === 0) continue;

    const questionLike = childIdxs.filter(idx => {
      const leaf =
        sections[idx].headingPath[sections[idx].headingPath.length - 1] || "";
      return isQuestionLikeHeading(leaf);
    });

    // With a confirming parent heading, 2 question-like children are enough.
    // Without that hint, require 3 and a clear question-majority to avoid
    // false positives on numbered guides ("1. Prepare", "2. Configure").
    const minChildren = parentLooksFaq ? 2 : 3;
    const majorityThreshold = parentLooksFaq ? 0.5 : 0.75;
    const fraction = questionLike.length / childIdxs.length;

    if (questionLike.length >= minChildren && fraction >= majorityThreshold) {
      clusters.set(i, { parentIdx: i, childIdxs: questionLike });
    }
  }
  return clusters;
}

/**
 * Split a FAQ section body into one chunk per Q/A pair.
 * Heuristics:
 *  - "Q: ..." / "В: ..." / "Вопрос: ..." / "Question: ..." markers
 *  - A standalone paragraph ending in "?" is the question; the following
 *    paragraph(s) up to the next question are the answer.
 */
function splitFaqBody(
  plainText: string
): { question: string; answer: string }[] {
  const paragraphs = plainText
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const prefixRe =
    /^(?:q|question|в|вопрос|a|answer|о|ответ|q\d+|в\d+)\s*[:.\-]\s*/iu;

  const stripPrefix = (
    value: string
  ): { kind: "q" | "a" | "auto"; text: string } => {
    const match = value.match(prefixRe);
    if (!match) return { kind: "auto", text: value };
    const head = match[0].toLowerCase();
    const rest = value.slice(match[0].length).trim();
    if (/^(q|question|в|вопрос|q\d+|в\d+)/iu.test(head)) {
      return { kind: "q", text: rest };
    }
    return { kind: "a", text: rest };
  };

  const pairs: { question: string; answer: string }[] = [];
  let pending: { question: string; answers: string[] } | null = null;

  const commitPending = () => {
    if (!pending) return;
    const question = pending.question.trim();
    const answer = pending.answers.join("\n\n").trim();
    if (question && answer) pairs.push({ question, answer });
    pending = null;
  };

  for (const paragraph of paragraphs) {
    const stripped = stripPrefix(paragraph);

    if (stripped.kind === "q") {
      commitPending();
      pending = { question: stripped.text, answers: [] };
      continue;
    }
    if (stripped.kind === "a") {
      if (pending) pending.answers.push(stripped.text);
      continue;
    }

    if (/\?\s*$/u.test(paragraph)) {
      commitPending();
      pending = { question: paragraph, answers: [] };
      continue;
    }

    if (pending) {
      pending.answers.push(paragraph);
    }
  }

  commitPending();
  return pairs;
}

/**
 * Second-pass chunker: takes raw sections and produces plain-text chunks with
 * - HTML stripped
 * - full heading path preserved
 * - FAQ sections sub-split by Q/A (body-level *and* structural: parent with
 *   question-like children, independent of heading regex)
 * - oversized sections recursively split
 * - min-size filter applied
 * - sentence-level overlap between adjacent chunks of the same section, but
 *   never between sibling Q/A atoms (they are semantically independent)
 */
export function buildChunkedSections(
  bodyText: string,
  articleTitle: string
): ChunkedSection[] {
  const rawSections = extractRawSections(bodyText, articleTitle);
  if (rawSections.length === 0) return [];

  const { minChunkChars, faq } = RAG_CONFIG.chunking;
  const candidates: ChunkedSection[] = [];

  // Pre-pass: figure out which parents behave as FAQ clusters (structural),
  // and which child sections are therefore consumed as Q/A atoms.
  const faqClusters = faq.enabled
    ? detectFaqClusters(rawSections)
    : new Map<number, FaqCluster>();
  const consumedByCluster = new Set<number>();
  for (const cluster of faqClusters.values()) {
    for (const idx of cluster.childIdxs) consumedByCluster.add(idx);
  }

  let previousTail = "";

  const push = (headingPath: string[], text: string, resetTail: boolean) => {
    const finalText = previousTail ? `${previousTail}\n\n${text}` : text;
    const trimmed = finalText.trim();
    if (!trimmed) return;
    candidates.push({
      headingPath:
        headingPath.length > 0 ? headingPath : [articleTitle || "Article"],
      heading: headingPath[headingPath.length - 1] || articleTitle || "Article",
      text: trimmed,
    });
    previousTail = resetTail ? "" : takeTailForOverlap(text);
  };

  const emitQAChildren = (parent: RawSection, cluster: FaqCluster) => {
    // Each Q/A atom is semantically independent — reset overlap around them
    // so a prior section's tail doesn't bleed into Q1, and Q1's tail doesn't
    // bleed into Q2.
    previousTail = "";
    for (const idx of cluster.childIdxs) {
      const child = rawSections[idx];
      const childPlain = toPlainText(child.rawText);
      if (!childPlain) continue;
      const question = child.headingPath[child.headingPath.length - 1] || "";
      // Keep the parent's heading path as the breadcrumb and append the
      // question as the leaf, so citations look like
      //   "FAQ > 1. Что вообще такое грант БесТірек?"
      const qaPath = [
        ...parent.headingPath,
        question.slice(0, 200) || "Question",
      ];
      const qaText = `Q: ${question}\nA: ${childPlain}`;
      push(qaPath, qaText, /* resetTail */ true);
    }
    previousTail = "";
  };

  for (let i = 0; i < rawSections.length; i++) {
    if (consumedByCluster.has(i)) continue;

    const raw = rawSections[i];
    const plainText = toPlainText(raw.rawText);
    const cluster = faqClusters.get(i);

    if (cluster) {
      // Structural FAQ parent. Emit an intro only if the parent has a real
      // body that is *not* just the heading label; otherwise skip it (avoids
      // emitting a 24-char chunk that just repeats the section title).
      if (plainText && !isEmptyOrLabelOnly(plainText, raw.headingPath)) {
        // A real intro paragraph above the question block — keep it but
        // reset overlap afterwards because the next chunks are Q/A atoms.
        const pieces = splitOversizedText(plainText);
        for (const piece of pieces) {
          push(raw.headingPath, piece, /* resetTail */ true);
        }
      }
      emitQAChildren(raw, cluster);
      continue;
    }

    if (!plainText) continue;

    const leafHeading =
      raw.headingPath[raw.headingPath.length - 1] || articleTitle;

    // Body-level Q/A detection: a single section whose body itself is a run
    // of Q/A paragraphs (no child sub-headings). Triggered either by a FAQ
    // heading hint or by the body structure itself.
    const bodyPairs = faq.enabled ? splitFaqBody(plainText) : [];
    const shouldSplitByBody =
      faq.enabled &&
      (isFaqHeading(leafHeading)
        ? bodyPairs.length >= 1
        : bodyPairs.length >= 2);

    if (shouldSplitByBody) {
      previousTail = "";
      if (faq.emitSectionIntro) {
        const firstPairIndex = plainText.indexOf(bodyPairs[0].question);
        const intro =
          firstPairIndex > 0 ? plainText.slice(0, firstPairIndex).trim() : "";
        if (intro) push(raw.headingPath, intro, /* resetTail */ true);
      }
      for (const pair of bodyPairs) {
        const qaPath = [...raw.headingPath, pair.question.slice(0, 200)];
        const qaText = `Q: ${pair.question}\nA: ${pair.answer}`;
        push(qaPath, qaText, /* resetTail */ true);
      }
      previousTail = "";
      continue;
    }

    // Regular section: recursively split oversized bodies and carry the tail
    // across adjacent pieces and across sibling sections.
    const pieces = splitOversizedText(plainText);
    for (const piece of pieces) {
      push(raw.headingPath, piece, /* resetTail */ false);
    }
  }

  if (candidates.length === 0) return [];

  // Two-pass min-size filter: drop tiny chunks, but guarantee at least one chunk
  // survives so documents with only short sections aren't silently dropped.
  const large = candidates.filter(
    section => section.text.trim().length >= minChunkChars
  );
  return large.length > 0 ? large : [candidates[0]];
}

// ---------------------------------------------------------------------------
// Back-compat surface
// ---------------------------------------------------------------------------

/**
 * @deprecated Prefer {@link buildChunkedSections}. Kept for tests and callers
 * that only need a flat `{heading, text}` list of raw (non-split) sections.
 */
export function extractKbArticleSectionsFromHtml(
  body: string,
  articleTitle: string
): { heading: string; text: string }[] {
  return extractRawSectionsFromHtml(body, articleTitle).map(section => ({
    heading:
      section.headingPath[section.headingPath.length - 1] ||
      articleTitle ||
      "Article",
    text: section.rawText,
  }));
}

/**
 * @deprecated Prefer {@link buildChunkedSections}. Kept as a flat section extractor
 * (raw HTML/markdown slices, heading-only labels).
 */
export function extractKbArticleSections(
  bodyText: string,
  articleTitle: string
): { heading: string; text: string }[] {
  return extractRawSections(bodyText, articleTitle).map(section => ({
    heading:
      section.headingPath[section.headingPath.length - 1] ||
      articleTitle ||
      "Article",
    text: section.rawText,
  }));
}

function buildEvidenceChunkMetadata(
  documentKey: string,
  chunkIndex: number,
  headingPath: string[],
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    documentKey,
    chunkIndex,
    headingPath,
    ...(extra || {}),
  };
}

/** Split KB article body into evidence chunks (HTML h1–h3 or markdown headings). */
export function chunkKbArticleByHeadings(params: {
  articleId: string;
  title: string;
  bodyText: string;
  locale?: string;
  url?: string;
}): EvidenceChunk[] {
  const sections = buildChunkedSections(params.bodyText, params.title);

  return sections.map((sec, idx) => ({
    id: `knowledge_chunk:kb_article:${params.articleId}:${idx}`,
    sourceKind: "knowledge_chunk" as const,
    locale: params.locale,
    title: sec.heading,
    text: sec.text,
    url: params.url,
    authorityScore: RAG_CONFIG.thresholds.kbAdmissionCeiling,
    metadata: buildEvidenceChunkMetadata(
      `kb_article:${params.articleId}`,
      idx,
      sec.headingPath
    ),
  }));
}

/** Split page text on blank-line blocks and pseudo-headings (lines ending with :). */
export function chunkIndexedUrlByBlocks(params: {
  pageId: string;
  title: string;
  bodyText: string;
  locale?: string;
  url?: string;
}): EvidenceChunk[] {
  const plain = toPlainText(stripCodeFences(params.bodyText || "")).trim();
  if (!plain) return [];

  const blocks = plain
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean);
  const { minChunkChars, overlap } = RAG_CONFIG.chunking;
  const chunks: EvidenceChunk[] = [];
  let idx = 0;
  let previousTail = "";

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const first = lines[0] || "";
    const isHeading =
      lines.length > 1 && /^.+\S:$/.test(first.trim()) && first.length < 120;

    const headingPath: string[] = [params.title || "Page"];
    let bodyPart: string;
    if (isHeading) {
      headingPath.push(first.replace(/:$/, "").trim());
      bodyPart = lines.slice(1).join("\n").trim();
    } else {
      bodyPart = block;
    }
    if (bodyPart.length < minChunkChars) continue;

    const pieces = splitOversizedText(bodyPart);
    for (const piece of pieces) {
      const withOverlap = previousTail ? `${previousTail}\n\n${piece}` : piece;
      chunks.push({
        id: `knowledge_chunk:indexed_url:${params.pageId}:${idx}`,
        sourceKind: "knowledge_chunk",
        locale: params.locale,
        title: headingPath[headingPath.length - 1],
        text: withOverlap,
        url: params.url,
        authorityScore: RAG_CONFIG.authority.indexedUrlChunk,
        metadata: buildEvidenceChunkMetadata(
          `indexed_url:${params.pageId}`,
          idx,
          headingPath
        ),
      });
      idx += 1;
      previousTail = overlap.tailSentences > 0 ? takeTailForOverlap(piece) : "";
    }
  }

  return chunks;
}

export function chunkCuratedSnippet(params: {
  snippetId: string;
  question: string;
  answer: string;
  locale?: string;
}): EvidenceChunk[] {
  const question = (params.question || "").trim();
  const answer = (params.answer || "").trim();
  if (!question && !answer) return [];

  const fullText = `Q: ${question}\nA: ${answer}`;
  const headingPath = [question.slice(0, 200) || "Snippet"];
  const title = question.slice(0, 200) || "Snippet";

  const { maxChunkChars, overlap } = RAG_CONFIG.chunking;
  if (fullText.length <= maxChunkChars) {
    return [
      {
        id: `knowledge_chunk:snippet:${params.snippetId}:0`,
        sourceKind: "knowledge_chunk",
        locale: params.locale,
        title,
        text: fullText,
        authorityScore: RAG_CONFIG.authority.curatedSnippetChunk,
        metadata: buildEvidenceChunkMetadata(
          `curated_snippet:${params.snippetId}`,
          0,
          headingPath
        ),
      },
    ];
  }

  const pieces = splitOversizedText(answer);
  const chunks: EvidenceChunk[] = [];
  let previousTail = "";
  pieces.forEach((piece, idx) => {
    const withOverlap = previousTail ? `${previousTail}\n\n${piece}` : piece;
    chunks.push({
      id: `knowledge_chunk:snippet:${params.snippetId}:${idx}`,
      sourceKind: "knowledge_chunk",
      locale: params.locale,
      title,
      text: idx === 0 ? `Q: ${question}\nA: ${withOverlap}` : withOverlap,
      authorityScore: RAG_CONFIG.authority.curatedSnippetChunk,
      metadata: buildEvidenceChunkMetadata(
        `curated_snippet:${params.snippetId}`,
        idx,
        headingPath,
        { partOf: "curated_snippet", partIndex: idx, partCount: pieces.length }
      ),
    });
    previousTail = overlap.tailSentences > 0 ? takeTailForOverlap(piece) : "";
  });
  return chunks;
}

/**
 * Build the text that gets embedded for a chunk. Prepends the document title
 * and full heading path so short sub-sections gain parent context.
 * Mirrors `buildKBArticleEmbeddingText` used for whole-article embeddings.
 */
export function buildChunkEmbeddingText(params: {
  documentTitle: string | null | undefined;
  headingPath: string[] | null | undefined;
  text: string;
}): string {
  const documentTitle = (params.documentTitle || "").trim();
  const headingPath = (params.headingPath || [])
    .map(heading => (heading || "").trim())
    .filter(Boolean);
  const body = (params.text || "").trim();

  const breadcrumb: string[] = [];
  if (documentTitle) breadcrumb.push(documentTitle);
  for (const heading of headingPath) {
    if (
      breadcrumb.length === 0 ||
      breadcrumb[breadcrumb.length - 1] !== heading
    ) {
      breadcrumb.push(heading);
    }
  }

  const prefix = breadcrumb.length > 0 ? breadcrumb.join(" > ") : "";
  return prefix ? `${prefix}\n\n${body}` : body;
}
