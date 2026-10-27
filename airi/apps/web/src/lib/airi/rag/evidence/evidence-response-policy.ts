import type {
  CitationStrength,
  ResponsePolicy,
  RetrievalPlan,
} from "@/lib/airi/rag/evidence/evidence-types";
import type { ContextDecision } from "@/lib/airi/rag/types";

export function decideResponsePolicy(params: {
  decision: ContextDecision;
  plan: RetrievalPlan;
  /** Same effective level as generation ({@link resolveEffectiveCitationDiscipline}). */
  citationDiscipline: CitationStrength;
  hasVerifiedSnippet: boolean;
  unsupportedClaimCount: number;
  hasProductEvidence: boolean;
}): ResponsePolicy {
  if (params.hasVerifiedSnippet && params.decision.priority === "snippet") {
    return "snippet_direct";
  }

  const strict = params.citationDiscipline === "strict";

  if (strict && params.unsupportedClaimCount > 0 && params.hasProductEvidence) {
    return "clarify";
  }

  if (
    strict &&
    !params.hasProductEvidence &&
    params.plan.factualIntent !== "none"
  ) {
    return "handoff";
  }

  if (params.decision.priority === "generic") {
    return params.hasProductEvidence ? "answer" : "clarify";
  }

  return "answer";
}
