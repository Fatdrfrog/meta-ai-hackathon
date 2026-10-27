import { getLanguageName } from "@/lib/airi/language-detector";

export const COACH_TIP_TYPES = [
  "tone",
  "clarity",
  "policy",
  "empathy",
  "urgency",
  "other",
] as const;

export const COACH_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: ["tips", "suggestedEdit"],
  properties: {
    tips: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["title", "suggestion", "type", "confidence", "reasoning"],
        properties: {
          title: { type: "STRING" },
          suggestion: { type: "STRING" },
          type: {
            type: "STRING",
            format: "enum",
            enum: [...COACH_TIP_TYPES],
          },
          confidence: { type: "NUMBER" },
          reasoning: { type: "STRING" },
        },
        propertyOrdering: [
          "title",
          "suggestion",
          "type",
          "confidence",
          "reasoning",
        ],
      },
    },
    suggestedEdit: { type: "STRING" },
  },
  propertyOrdering: ["tips", "suggestedEdit"],
} as const;

export type CoachConversationContextInfo = {
  stage?: string;
  priority?: string;
  customerSentiment?: string;
  riskLevel?: number;
};

export type BuildCoachSystemPromptParams = {
  tipsLanguage: string;
  customerLanguage: string;
  conversationContext?: CoachConversationContextInfo;
  alreadyGreeted: boolean;
};

export type BuildCoachUserPromptParams = {
  knowledgeBlock?: string;
  conversationWindow?: string;
  agentDraft: string;
};

function languageLine(code: string): string {
  const name = getLanguageName(code);
  return `${name} (ISO ${code})`;
}

function formatContextBlock(
  context?: CoachConversationContextInfo
): string | undefined {
  if (!context) return undefined;

  const parts = [
    context.stage ? `stage=${context.stage}` : null,
    context.priority ? `priority=${context.priority}` : null,
    context.customerSentiment
      ? `customerSentiment=${context.customerSentiment}`
      : null,
    typeof context.riskLevel === "number" && context.riskLevel > 0
      ? `riskLevel=${context.riskLevel}/3`
      : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * System prompt for live coach tips + suggested reply edit.
 */
export function buildCoachSystemPrompt(
  params: BuildCoachSystemPromptParams
): string {
  const tipsLang = languageLine(params.tipsLanguage);
  const customerLang = languageLine(params.customerLanguage);
  const dualLanguage = params.tipsLanguage !== params.customerLanguage;
  const contextLine = formatContextBlock(params.conversationContext);

  const languageBlock = dualLanguage
    ? [
        "LANGUAGE (strict):",
        `- tips.title, tips.suggestion, tips.reasoning: write in ${tipsLang} for the manager.`,
        `- suggestedEdit: write the full customer-ready reply in ${customerLang}.`,
        "- Do not mix languages across those fields.",
      ].join("\n")
    : [
        "LANGUAGE (strict):",
        `- Write tips.title, tips.suggestion, tips.reasoning, and suggestedEdit in ${tipsLang}.`,
        "- Do not switch languages mid-field.",
      ].join("\n");

  const riskBlock =
    typeof params.conversationContext?.riskLevel === "number" &&
    params.conversationContext.riskLevel >= 2
      ? [
          "ESCALATION RISK:",
          "- Customer shows elevated risk. Prioritize de-escalation, empathy, and a calm concrete next step.",
          "- Avoid defensive, dismissive, or overly casual tone in suggestedEdit.",
        ].join("\n")
      : null;

  const greetingBlock = params.alreadyGreeted
    ? [
        "GREETING POLICY:",
        "- A greeting was already sent today. Do not add hello/hi/good morning (or equivalents) in suggestedEdit.",
      ].join("\n")
    : null;

  return [
    "You are Airi Coach, a live coaching assistant for support managers composing customer replies.",
    "",
    "Goal: improve THIS draft for THIS conversation. Prefer fewer high-impact tips over generic advice.",
    "",
    languageBlock,
    "",
    contextLine ? `CONVERSATION SIGNALS: ${contextLine}` : null,
    contextLine ? "" : null,
    "WHEN TO COACH:",
    "- Tip only when the draft has a clear issue or missed opportunity (tone, clarity, empathy, policy accuracy vs provided knowledge, urgency, missing next step, wrong/missing fact).",
    "- Skip vague praise, restating the draft, or generic slogans like \"be more professional\".",
    "- Return 0-3 tips, highest impact first. Empty tips array is valid when the draft is already good.",
    "",
    "TIP QUALITY:",
    "- title: short label (2-5 words).",
    "- suggestion: one concrete action for THIS draft + why it matters now (1-2 sentences).",
    "- type: one of tone | clarity | policy | empathy | urgency | other.",
    "- confidence: honest 0.0-1.0.",
    "- reasoning: why this tip is relevant to the current customer turn (1 sentence).",
    "",
    "SUGGESTED EDIT:",
    "- Provide a full improved reply ready to send, grounded only in the draft + conversation + reference context.",
    "- Use KB / Q&A / quick replies ONLY when relevant and accurate. Never invent policies, prices, SLAs, or commitments.",
    "- Preserve correct facts and channel-appropriate brevity.",
    "- If the draft needs no meaningful change, set suggestedEdit to an empty string.",
    "- Never return the manager draft verbatim as suggestedEdit.",
    "",
    riskBlock,
    riskBlock ? "" : null,
    greetingBlock,
    greetingBlock ? "" : null,
    "OUTPUT:",
    "- Return JSON only.",
    '- Shape: {"tips":[{"title":"...","suggestion":"...","type":"tone|clarity|policy|empathy|urgency|other","confidence":0.0,"reasoning":"..."}],"suggestedEdit":"..."}',
  ]
    .filter(line => line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * User prompt with evidence sections + draft to analyze.
 */
export function buildCoachUserPrompt(
  params: BuildCoachUserPromptParams
): string {
  const sections: string[] = [];

  if (params.knowledgeBlock?.trim()) {
    sections.push(
      `REFERENCE CONTEXT (use only if relevant and accurate):\n${params.knowledgeBlock.trim()}`
    );
  }

  if (params.conversationWindow?.trim()) {
    sections.push(
      `RECENT CONVERSATION (oldest → newest):\n${params.conversationWindow.trim()}`
    );
  }

  sections.push(
    `MANAGER DRAFT TO ANALYZE:\n${params.agentDraft.trim() || "(empty)"}`
  );

  sections.push(
    [
      "Task:",
      "1) Coach the manager on the draft above for this conversation.",
      "2) Return up to 3 high-quality tips (or none if the draft is already strong).",
      "3) Return suggestedEdit as an improved send-ready reply, or \"\" if no meaningful improvement.",
      "JSON only.",
    ].join("\n")
  );

  return sections.join("\n\n");
}
