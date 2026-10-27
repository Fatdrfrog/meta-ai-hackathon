import { extractPlainText } from "@/lib/kb/content-utils";
import { tokenizeKBQuery } from "./kb-query";

const DEFAULT_KB_EXCERPT_MAX_CHARS = 1500;
const SERVICE_OVERVIEW_EXCERPT_MAX_CHARS = 2400;

type KBSection = {
  heading: string;
  blocks: string[];
};

function trimExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text.trim();
  return text.slice(0, maxChars).trim();
}

function isHeadingLike(block: string): boolean {
  return block.length <= 220 && !/[.!?]\s*$/u.test(block);
}

function splitKBBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean);
}

function buildKBSections(blocks: string[]): KBSection[] {
  const sections: KBSection[] = [];
  let current: KBSection | null = null;

  for (const block of blocks) {
    if (isHeadingLike(block)) {
      if (current) {
        sections.push(current);
      }
      current = {
        heading: block,
        blocks: [],
      };
      continue;
    }

    if (!current) {
      current = {
        heading: "",
        blocks: [block],
      };
      continue;
    }

    current.blocks.push(block);
  }

  if (current) {
    sections.push(current);
  }

  return sections;
}

function buildSectionPreview(section: KBSection, maxChars: number): string {
  const parts: string[] = [];
  if (section.heading) {
    parts.push(section.heading);
  }

  for (const block of section.blocks) {
    parts.push(block);
    if (parts.join("\n\n").length >= maxChars * 0.85) {
      break;
    }
  }

  return trimExcerpt(parts.join("\n\n").trim(), maxChars);
}

function buildServiceOverviewIndexes(sectionCount: number): number[] {
  if (sectionCount <= 0) return [];

  const rawIndexes = [
    0,
    1,
    Math.floor(sectionCount * 0.35),
    Math.floor(sectionCount * 0.55),
    Math.floor(sectionCount * 0.75),
    sectionCount - 2,
    sectionCount - 1,
  ];

  return Array.from(
    new Set(rawIndexes.filter(index => index >= 0 && index < sectionCount))
  );
}

function buildServiceOverviewExcerpt(
  cleaned: string,
  maxChars: number
): string {
  const blocks = splitKBBlocks(cleaned);
  const sections = buildKBSections(blocks);
  if (sections.length <= 1) {
    return trimExcerpt(cleaned, maxChars);
  }

  const introSection = sections[0]?.heading ? null : sections[0];
  const serviceSections = introSection ? sections.slice(1) : sections;
  const targetIndexes = buildServiceOverviewIndexes(serviceSections.length);
  if (targetIndexes.length === 0) {
    return trimExcerpt(cleaned, maxChars);
  }

  const selectedParts: string[] = [];
  let totalChars = 0;

  if (introSection) {
    const introPreview = buildSectionPreview(
      introSection,
      Math.min(320, Math.max(220, Math.floor(maxChars * 0.18)))
    );
    if (introPreview) {
      selectedParts.push(introPreview);
      totalChars += introPreview.length;
    }
  }

  const perSectionChars = Math.max(
    180,
    Math.min(
      340,
      Math.floor((maxChars - totalChars) / Math.max(1, targetIndexes.length))
    )
  );

  for (const index of targetIndexes) {
    const preview = buildSectionPreview(
      serviceSections[index],
      perSectionChars
    );
    if (!preview) continue;

    const projectedChars =
      totalChars + preview.length + (selectedParts.length > 0 ? 2 : 0);
    if (projectedChars > maxChars && selectedParts.length > 0) {
      continue;
    }

    selectedParts.push(preview);
    totalChars = projectedChars;
  }

  return trimExcerpt(selectedParts.join("\n\n").trim() || cleaned, maxChars);
}

export function extractKBPlainText(content: string): string {
  return extractPlainText(content, { preserveLineBreaks: true }).trim();
}

export function buildKBContentExcerpt(params: {
  content: string;
  query?: string;
  maxChars?: number;
  preferBroadOverview?: boolean;
}): string {
  const cleaned = extractKBPlainText(params.content || "");
  const maxChars = Math.max(
    200,
    params.maxChars ||
      (params.preferBroadOverview
        ? SERVICE_OVERVIEW_EXCERPT_MAX_CHARS
        : DEFAULT_KB_EXCERPT_MAX_CHARS)
  );

  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;
  if (params.preferBroadOverview) {
    return buildServiceOverviewExcerpt(cleaned, maxChars);
  }

  const queryTokens = tokenizeKBQuery(params.query || "");
  if (queryTokens.length === 0) {
    return trimExcerpt(cleaned, maxChars);
  }

  const blocks = splitKBBlocks(cleaned);
  if (blocks.length === 0) {
    return trimExcerpt(cleaned, maxChars);
  }

  const scoredBlocks = blocks
    .map((block, index) => {
      const normalized = block.toLowerCase();
      const matches = new Set(
        queryTokens.filter(token => normalized.includes(token.toLowerCase()))
      );
      const headingBonus = isHeadingLike(block) ? 0.5 : 0;
      const score =
        matches.size * 3 +
        matches.size / Math.max(1, queryTokens.length) +
        headingBonus;

      return {
        index,
        block,
        score,
      };
    })
    .filter(item => item.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.index - right.index
    );

  if (scoredBlocks.length === 0) {
    return trimExcerpt(cleaned, maxChars);
  }

  const selectedIndexes = new Set<number>();
  let totalChars = 0;

  for (const item of scoredBlocks.slice(0, 4)) {
    const candidateIndexes = [item.index];

    if (blocks[item.index - 1] && isHeadingLike(blocks[item.index - 1])) {
      candidateIndexes.unshift(item.index - 1);
    }
    if (blocks[item.index + 1] && item.block.length < 300) {
      candidateIndexes.push(item.index + 1);
    }

    for (const index of candidateIndexes) {
      if (selectedIndexes.has(index)) continue;

      const block = blocks[index];
      const projectedChars =
        totalChars + block.length + (totalChars > 0 ? 2 : 0);
      if (projectedChars > maxChars && selectedIndexes.size > 0) {
        continue;
      }

      selectedIndexes.add(index);
      totalChars = projectedChars;
    }

    if (totalChars >= maxChars) {
      break;
    }
  }

  const excerpt = Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map(index => blocks[index])
    .join("\n\n")
    .trim();

  return trimExcerpt(excerpt || cleaned, maxChars);
}
