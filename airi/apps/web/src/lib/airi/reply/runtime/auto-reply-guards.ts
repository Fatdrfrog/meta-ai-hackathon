import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";

export function isUnrestrictedResultBetter(
  resultType: string,
  resultPriority?: string
): boolean {
  if (resultType === "verified_snippet") return true;
  if (resultType === "suggestion_with_ai") return true;
  if (resultType === "ai_reply" && resultPriority !== "generic") {
    return true;
  }
  return false;
}

export function shouldAttachScenarioButtons(params: {
  scenarioRuntime: AiriScenarioRuntimeConfig | null;
  ragResultType: string;
}): boolean {
  if (!params.scenarioRuntime) return false;
  return params.ragResultType === "ai_reply";
}
