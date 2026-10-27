import {
  estimateTokenCount,
  estimateTokenCountFromCharBudget,
  REPLY_OUTPUT_TOKEN_LIMITS,
  REPLY_PROMPT_INPUT_CHAR_LIMITS,
  REPLY_PROMPT_INPUT_TOKEN_LIMITS,
  truncateToCharBudget,
  truncateToTokenBudget,
  truncateTranscriptToCharBudget,
  truncateTranscriptToTokenBudget,
} from "@/lib/airi/shared/token-budget";
import type { ResponseStyle } from "@/lib/airi/workspace-bot-contract";
import type {
  ReplyOutputProfile,
  ReplyPromptBudgetProvider,
} from "@/lib/airi/reply/generation/prompt-envelope-types";
import {
  normalizePromptComparableText,
  renderUserPrompt,
  TRIM_PRIORITY_DESC,
  type ReplyPromptSection,
} from "@/lib/airi/reply/generation/prompt-envelope-sections";

type ReplyPromptBudget = {
  inputCharLimit: number;
  inputTokenLimit: number;
};

type ReplyPromptMeasurement = {
  userPrompt: string;
  totalChars: number;
  totalTokens: number;
};

type ReplyPromptOverflow = {
  charOverflow: number;
  tokenOverflow: number;
};

const RESPONSE_STYLE_TOKEN_MULTIPLIER: Record<ResponseStyle, number> = {
  concise: 0.6,
  balanced: 1.0,
  detailed: 1.4,
};

export function resolveOutputMaxTokens(
  outputProfile: ReplyOutputProfile,
  responseStyle?: ResponseStyle
): number {
  const base = REPLY_OUTPUT_TOKEN_LIMITS[outputProfile];
  const multiplier =
    RESPONSE_STYLE_TOKEN_MULTIPLIER[responseStyle || "balanced"];
  return Math.round(base * multiplier);
}

export function resolveInputBudget(
  providerBudget: ReplyPromptBudgetProvider,
  compactMode: boolean
): ReplyPromptBudget {
  const inputCharLimit = REPLY_PROMPT_INPUT_CHAR_LIMITS[providerBudget];
  const configuredInputTokenLimit =
    REPLY_PROMPT_INPUT_TOKEN_LIMITS[providerBudget];
  const fallbackInputTokenLimit =
    estimateTokenCountFromCharBudget(inputCharLimit);
  const inputTokenLimit = Math.min(
    configuredInputTokenLimit,
    fallbackInputTokenLimit
  );

  if (!compactMode) {
    return {
      inputCharLimit,
      inputTokenLimit,
    };
  }

  return {
    inputCharLimit: Math.floor(inputCharLimit * 0.8),
    inputTokenLimit: Math.floor(inputTokenLimit * 0.8),
  };
}

export function measureAssembledReplyPrompt(
  systemPrompt: string,
  sections: ReplyPromptSection[]
): ReplyPromptMeasurement {
  const userPrompt = renderUserPrompt(sections);
  const combinedPrompt = userPrompt
    ? `${systemPrompt}\n\n${userPrompt}`
    : systemPrompt;

  return {
    userPrompt,
    totalChars: systemPrompt.length + userPrompt.length,
    totalTokens: estimateTokenCount(combinedPrompt),
  };
}

function getPromptOverflow(
  measurement: ReplyPromptMeasurement,
  budget: ReplyPromptBudget
): ReplyPromptOverflow {
  return {
    charOverflow: Math.max(0, measurement.totalChars - budget.inputCharLimit),
    tokenOverflow: Math.max(
      0,
      measurement.totalTokens - budget.inputTokenLimit
    ),
  };
}

function measureOverflow(
  systemPrompt: string,
  sections: ReplyPromptSection[],
  budget: ReplyPromptBudget
): { measurement: ReplyPromptMeasurement; overflow: ReplyPromptOverflow } {
  const measurement = measureAssembledReplyPrompt(systemPrompt, sections);
  return {
    measurement,
    overflow: getPromptOverflow(measurement, budget),
  };
}

function trimSectionContentToBudget(
  section: ReplyPromptSection,
  overflow: ReplyPromptOverflow
): string {
  let content = section.finalContent;
  if (!content.trim()) return content;

  const minTokenChars = Math.max(section.minChars, 1);
  const minTokenBudget = estimateTokenCountFromCharBudget(minTokenChars);

  if (
    overflow.tokenOverflow > 0 &&
    estimateTokenCount(content) > minTokenBudget
  ) {
    const targetTokens = Math.max(
      minTokenBudget,
      estimateTokenCount(content) - overflow.tokenOverflow
    );
    content = section.keepLatestLines
      ? truncateTranscriptToTokenBudget(content, targetTokens)
      : truncateToTokenBudget(content, targetTokens);
  }

  if (overflow.charOverflow > 0 && content.length > section.minChars) {
    const targetChars = Math.max(
      section.minChars,
      content.length - overflow.charOverflow
    );
    content = section.keepLatestLines
      ? truncateTranscriptToCharBudget(content, targetChars)
      : truncateToCharBudget(content, targetChars);
  }

  return content;
}

export function trimSectionsToBudget(
  sections: ReplyPromptSection[],
  systemPrompt: string,
  budget: ReplyPromptBudget
): { sections: ReplyPromptSection[]; wasOverBudget: boolean } {
  const cloned = sections.map(section => ({ ...section }));
  const { measurement: initialMeasurement } = measureOverflow(
    systemPrompt,
    cloned,
    budget
  );
  const wasOverBudget =
    initialMeasurement.totalChars > budget.inputCharLimit ||
    initialMeasurement.totalTokens > budget.inputTokenLimit;
  if (!wasOverBudget) {
    return { sections: cloned, wasOverBudget: false };
  }

  for (const sectionName of TRIM_PRIORITY_DESC) {
    const section = cloned.find(candidate => candidate.name === sectionName);
    if (!section || !section.finalContent.trim()) continue;

    let { overflow } = measureOverflow(systemPrompt, cloned, budget);

    if (
      (overflow.charOverflow > 0 || overflow.tokenOverflow > 0) &&
      section.finalContent.length > section.minChars
    ) {
      const trimmedContent = trimSectionContentToBudget(section, overflow);
      if (trimmedContent.length < section.finalContent.length) {
        section.finalContent = trimmedContent;
        section.trimmed = true;
      }

      ({ overflow } = measureOverflow(systemPrompt, cloned, budget));
    }

    if (
      (overflow.charOverflow > 0 || overflow.tokenOverflow > 0) &&
      !section.required &&
      section.finalContent.trim()
    ) {
      section.finalContent = "";
      section.trimmed = true;
      section.dropped = true;
    }

    ({ overflow } = measureOverflow(systemPrompt, cloned, budget));
    if (overflow.charOverflow === 0 && overflow.tokenOverflow === 0) {
      break;
    }
  }

  return { sections: cloned, wasOverBudget };
}

export function dropExactDuplicateLowerPrioritySections(
  sections: ReplyPromptSection[]
): ReplyPromptSection[] {
  const cloned = sections.map(section => ({ ...section }));
  const seen = new Set<string>();

  for (const section of cloned) {
    const normalized = normalizePromptComparableText(section.finalContent);
    if (!normalized) continue;

    if (!section.required && seen.has(normalized)) {
      section.finalContent = "";
      section.trimmed = true;
      section.dropped = true;
      continue;
    }

    seen.add(normalized);
  }

  return cloned;
}
