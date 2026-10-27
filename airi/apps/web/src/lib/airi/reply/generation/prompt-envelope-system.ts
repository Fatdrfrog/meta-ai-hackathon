import { citationDisciplineSystemRules } from "@/lib/airi/grounding/citation-discipline";
import type { CitationStrength } from "@/lib/airi/rag/evidence/evidence-types";
import type {
  GreetingBehavior,
  ResponseStyle,
} from "@/lib/airi/workspace-bot-contract";
import type { ReplyOutputProfile } from "@/lib/airi/reply/generation/prompt-envelope-types";

const RESPONSE_STYLE_INSTRUCTIONS: Record<ResponseStyle, string> = {
  concise:
    "Keep replies short and direct. Prefer bullet points over paragraphs. Aim for 2-4 sentences when possible.",
  balanced: "Keep the reply structured and easy to scan.",
  detailed:
    "Provide thorough, comprehensive answers. Include relevant details, examples, and context. Use clear structure with headers or lists.",
};

function resolveGreetingPolicy(
  alreadyGreeted: boolean,
  greetingBehavior: GreetingBehavior | undefined,
  agentName: string
): string {
  const behavior = greetingBehavior || "auto";
  if (behavior === "disabled") {
    return "GREETING POLICY: Never greet. Skip pleasantries entirely and go straight to the answer.";
  }
  if (behavior === "brief_only" || alreadyGreeted) {
    return `GREETING POLICY: ${agentName} already greeted this customer today. Do not greet again.`;
  }
  return "GREETING POLICY: If appropriate, a brief greeting is allowed.";
}

export function buildSystemPrompt(params: {
  language: string;
  languageName: string;
  alreadyGreeted: boolean;
  channelInstruction?: string;
  hasGroundedContext: boolean;
  outputProfile: ReplyOutputProfile;
  agentName?: string;
  greetingBehavior?: GreetingBehavior;
  customInstructions?: string;
  responseStyle?: ResponseStyle;
  citationDiscipline: CitationStrength;
}): string {
  const agentName = params.agentName || "Airi";
  const responseStyle = params.responseStyle || "balanced";
  const replyLanguageInstruction = `LANGUAGE: Write the entire reply in ${params.languageName} (ISO ${params.language}). Do not discuss language choice or limitations—answer directly in ${params.languageName}.`;
  const greetingPolicyInstruction = resolveGreetingPolicy(
    params.alreadyGreeted,
    params.greetingBehavior,
    agentName
  );
  const citationBlock = citationDisciplineSystemRules(
    params.citationDiscipline,
    params.hasGroundedContext
  );
  const noKBNote =
    !params.hasGroundedContext && params.citationDiscipline === "none"
      ? "\nGROUNDING NOTE: No specific documentation was retrieved. Do not invent concrete facts, prices, schedules, deadlines, eligibility, or links."
      : "";
  const formatHint =
    params.outputProfile === "clarification"
      ? "FORMAT TARGET: Ask a short, direct clarifying question."
      : "FORMAT TARGET: Structure the reply in the most readable format for the content. Use numbered lists for steps or requirements, bullet lists for options, short paragraphs for explanations.";
  const kazakhReadabilityHint =
    params.language === "kz" || params.language === "kk"
      ? "\n- For Kazakh: write natural Kazakh, do not invent Kazakh words, avoid literal Russian/English calques, put the answer first, then short supporting details, then one clear next step or question only when needed."
      : "";
  const customInstructionsBlock = params.customInstructions
    ? `\n\nAdditional instructions:\n${params.customInstructions}`
    : "";

  return `You are ${agentName}, a concise and helpful customer support assistant.

${replyLanguageInstruction}
${greetingPolicyInstruction}${params.channelInstruction || ""}

Rules:
- Use only facts explicitly present in the provided context.
- When grounded evidence is provided, combine all relevant entries into one answer.
- If the recent conversation already answered part of the question, continue instead of repeating everything.
- If the customer's turn contains multiple distinct asks (two questions, an "if X, what to do?" follow-up, or an enumeration), address every ask in the same reply. Never answer only the first ask and ignore the rest.
- Treat facts the customer states in the current turn as established. Do not ask them to restate, reconfirm, or choose between options that contradict a fact they just stated (e.g. if they said "I have not taken the exam", do not append a clarifier asking whether they already took it).
- ${RESPONSE_STYLE_INSTRUCTIONS[responseStyle]}
- Return one complete final answer.
- Never stop mid-sentence, mid-list item, mid-date, or mid-URL.
- ${formatHint}.${kazakhReadabilityHint}${noKBNote}${citationBlock}${customInstructionsBlock}`;
}
