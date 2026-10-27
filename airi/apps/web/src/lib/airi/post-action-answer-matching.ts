import type {
  ScenarioAnswerMatchMode,
  ScenarioAnswerMatchRule,
} from "@icecore/scenario-contracts";
import { chatCompletionWithFallback, getLightTextModel } from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import { normalizeAnswerMatchRules } from "@icecore/scenario-contracts";

export const DEFAULT_POST_ACTION_INTENT_MATCH_THRESHOLD = 0.82;

export type PostActionAnswerMatchResult = {
  ruleId: string;
  mode: ScenarioAnswerMatchMode;
  confidence: number;
};

const inFlightIntentMatches = new Map<
  string,
  Promise<PostActionAnswerMatchResult | null>
>();

function normalizeMessageText(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function tokenizeExactText(value: unknown): string[] {
  const normalized = normalizeMessageText(value).toLocaleLowerCase();
  if (!normalized) return [];
  return normalized
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function phraseTokensMatch(messageTokens: string[], ruleTokens: string[]) {
  if (ruleTokens.length === 0 || ruleTokens.length > messageTokens.length) {
    return false;
  }

  for (
    let startIndex = 0;
    startIndex <= messageTokens.length - ruleTokens.length;
    startIndex += 1
  ) {
    let matched = true;
    for (let offset = 0; offset < ruleTokens.length; offset += 1) {
      if (messageTokens[startIndex + offset] !== ruleTokens[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }

  return false;
}

function normalizeConfiguredRules(rules: unknown): ScenarioAnswerMatchRule[] {
  return normalizeAnswerMatchRules(rules).filter(rule => rule.text.trim());
}

export function matchPostActionAnswerExact(params: {
  messageText?: string | null;
  rules?: ScenarioAnswerMatchRule[] | null;
}): PostActionAnswerMatchResult | null {
  const messageTokens = tokenizeExactText(params.messageText);
  if (messageTokens.length === 0) return null;

  for (const rule of normalizeConfiguredRules(params.rules).filter(
    candidate => candidate.mode === "exact"
  )) {
    const ruleTokens = tokenizeExactText(rule.text);
    if (phraseTokensMatch(messageTokens, ruleTokens)) {
      return {
        ruleId: rule.id,
        mode: "exact",
        confidence: 1,
      };
    }
  }

  return null;
}

function buildIntentCacheKey(params: {
  messageText: string;
  rules: ScenarioAnswerMatchRule[];
  language?: string | null;
  threshold: number;
}): string {
  return JSON.stringify({
    messageText: normalizeMessageText(params.messageText).toLocaleLowerCase(),
    language: normalizeMessageText(params.language).toLocaleLowerCase(),
    threshold: params.threshold,
    rules: params.rules.map(rule => ({
      id: rule.id,
      text: rule.text,
    })),
  });
}

function parseIntentMatchResponse(params: {
  content: string;
  rules: ScenarioAnswerMatchRule[];
  threshold: number;
}): PostActionAnswerMatchResult | null {
  if (!params.content.trim()) return null;

  try {
    // Tolerates fenced or wrapped JSON (no response schema is sent here).
    const parsed = extractJsonObject(params.content) as { matches?: unknown };
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const ruleById = new Map(
      params.rules.map((rule, index) => [rule.id, index])
    );

    const candidates = matches
      .flatMap(match => {
        if (!match || typeof match !== "object") return [];
        const record = match as { id?: unknown; confidence?: unknown };
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const ruleIndex = ruleById.get(id);
        const confidence =
          typeof record.confidence === "number" &&
          Number.isFinite(record.confidence)
            ? record.confidence
            : Number.NaN;
        if (ruleIndex === undefined || confidence < params.threshold) {
          return [];
        }
        return [{ id, confidence, ruleIndex }];
      })
      .sort((left, right) => {
        if (right.confidence !== left.confidence) {
          return right.confidence - left.confidence;
        }
        return left.ruleIndex - right.ruleIndex;
      });

    const best = candidates[0];
    return best
      ? {
          ruleId: best.id,
          mode: "intent",
          confidence: best.confidence,
        }
      : null;
  } catch {
    return null;
  }
}

async function resolvePostActionAnswerIntentMatch(params: {
  messageText: string;
  rules: ScenarioAnswerMatchRule[];
  language?: string | null;
  threshold: number;
}): Promise<PostActionAnswerMatchResult | null> {
  const cacheKey = buildIntentCacheKey(params);
  const existing = inFlightIntentMatches.get(cacheKey);
  if (existing) return existing;

  const matchPromise = (async () => {
    try {
      const result = await chatCompletionWithFallback({
        model: getLightTextModel(),
        temperature: 0,
        responseFormat: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You classify whether the latest customer message matches one of the configured answer intents for a no-reply wait.",
              'Return JSON only in the shape {"matches":[{"id":"rule id","confidence":0.0}]} with confidence from 0 to 1.',
              "Use only the provided rule IDs. Do not generate customer-facing text. Return an empty matches array when none are clearly matched.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              params.language ? `Language hint: ${params.language}` : "",
              "Answer intent rules:",
              ...params.rules.map(rule => `- ${rule.id}: ${rule.text}`),
              "",
              `Latest customer message: ${params.messageText}`,
            ]
              .filter(line => line !== "")
              .join("\n"),
          },
        ],
      });

      return parseIntentMatchResponse({
        content: result.content,
        rules: params.rules,
        threshold: params.threshold,
      });
    } catch {
      return null;
    } finally {
      inFlightIntentMatches.delete(cacheKey);
    }
  })();

  inFlightIntentMatches.set(cacheKey, matchPromise);
  return matchPromise;
}

export async function resolvePostActionAnswerMatch(params: {
  messageText?: string | null;
  rules?: ScenarioAnswerMatchRule[] | null;
  language?: string | null;
  threshold?: number;
}): Promise<PostActionAnswerMatchResult | null> {
  const messageText = normalizeMessageText(params.messageText);
  const rules = normalizeConfiguredRules(params.rules);
  if (!messageText || rules.length === 0) return null;

  const exactMatch = matchPostActionAnswerExact({ messageText, rules });
  if (exactMatch) return exactMatch;

  const intentRules = rules.filter(rule => rule.mode === "intent");
  if (intentRules.length === 0) return null;

  const threshold =
    typeof params.threshold === "number" && Number.isFinite(params.threshold)
      ? params.threshold
      : DEFAULT_POST_ACTION_INTENT_MATCH_THRESHOLD;

  return resolvePostActionAnswerIntentMatch({
    messageText,
    rules: intentRules,
    language: params.language,
    threshold,
  });
}
