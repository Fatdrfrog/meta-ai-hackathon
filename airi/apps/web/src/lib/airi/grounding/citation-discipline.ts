import type {
  CitationStrength,
  RetrievalPlan,
} from "@/lib/airi/rag/evidence/evidence-types";

function citationStrengthRank(s: CitationStrength): 0 | 1 | 2 {
  return s === "none" ? 0 : s === "preferred" ? 1 : 2;
}

function citationStrengthFromRank(r: number): CitationStrength {
  return r === 0 ? "none" : r === 1 ? "preferred" : "strict";
}

export function resolveEffectiveCitationDiscipline(params: {
  plan: RetrievalPlan;
  groundedStrictEnforcement: boolean;
  hasRetrievedSources: boolean;
}): CitationStrength {
  let level = params.plan.requiredCitationStrength;
  if (
    params.groundedStrictEnforcement &&
    params.hasRetrievedSources &&
    params.plan.factualIntent !== "none"
  ) {
    const bumped = Math.min(2, citationStrengthRank(level) + 1);
    level = citationStrengthFromRank(bumped);
  }
  return level;
}

export function citationDisciplineSystemRules(
  level: CitationStrength,
  hasGroundedContext: boolean
): string {
  if (level === "none") return "";

  if (!hasGroundedContext) {
    if (level === "strict") {
      return "\n\nCITATION-FIRST (strict, no retrieved docs): Do not state specific prices, deadlines, eligibility rules, policy names, or URLs. Offer general guidance or ask a short clarifying question.";
    }
    return "\n\nCITATION-FIRST (preferred, no retrieved docs): Avoid concrete product or policy specifics; prefer hedging or clarification over guessing.";
  }

  if (level === "preferred") {
    return "\n\nCITATION-FIRST (preferred): Ground answers in the numbered retrieved sources when you give product or policy facts. If a detail is not in those sources, hedge or ask rather than inventing. Do not include bracket citations like [1] in the customer-facing reply.";
  }

  return `\n\nCITATION-FIRST (strict): The "Retrieved grounded evidence" section lists numbered sources. For any concrete fact (price, date, deadline, eligibility, policy, link text), that fact MUST appear in one of those excerpts.
- Do not add factual details that are not supported by the excerpts.
- Use source numbers only internally for grounding. Do not include bracket citations like [1] or [2, 3] in the customer-facing reply.
- If the customer asks for a missing detail, acknowledge the gap briefly and clarify or offer escalation - do not fabricate.`;
}

export function kbBlockCitationFooter(level: CitationStrength): string {
  if (level !== "strict") return "";
  return "\n\nSTRICT SOURCE MODE: Every concrete product or policy fact in your reply must be traceable to one of the numbered excerpts above. Do not show source numbers or bracket citations to the customer.";
}

type ReplyOutputProfileName =
  | "clarification"
  | "grounded_answer"
  | "grounded_list"
  | "grounded_overview";

export function citationDisciplineTaskSuffix(
  level: CitationStrength,
  outputProfile: ReplyOutputProfileName
): string {
  if (outputProfile === "clarification" || level !== "strict") return "";
  return " Substantive factual claims must align with the numbered retrieved sources only, but do not include bracket source markers in the reply.";
}
