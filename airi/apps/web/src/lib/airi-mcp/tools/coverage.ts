import type { AiriMcpVisibility } from "../types";
import {
  arraySchema,
  BOOLEAN_SCHEMA,
  COUNT_SCHEMA,
  STRING_SCHEMA,
  type JsonSchema,
} from "./define";

const VISIBILITY_REASONS = ["trial_expired", "conversation_limit"] as const;

/** Plan-visibility facts shared by every conversation-based tool output. */
export const VISIBILITY_COVERAGE_PROPERTIES: Record<string, JsonSchema> = {
  plan_visibility_limited: BOOLEAN_SCHEMA,
  hidden_conversation_count: COUNT_SCHEMA,
  visibility_reason: {
    type: ["string", "null"],
    enum: [...VISIBILITY_REASONS, null],
  },
  notes: arraySchema(STRING_SCHEMA),
};

/** The plan gate and its hidden count are company-wide, not per workspace. */
function describeHiddenConversations(visibility: AiriMcpVisibility): string {
  const hidden = visibility.hiddenConversationCount;
  if (visibility.reason === "trial_expired") {
    return `The company's trial has expired, so its conversations are hidden (${hidden} across its workspaces).`;
  }
  return `The company's plan hides ${hidden} conversation(s) across its workspaces. Only the company's oldest conversations within the plan limit are visible, so recent periods can be under-counted.`;
}

export function describeVisibilityCoverage(visibility: AiriMcpVisibility) {
  const notes: string[] = [];
  if (visibility.limited) {
    notes.push(describeHiddenConversations(visibility));
  }
  return {
    plan_visibility_limited: visibility.limited,
    hidden_conversation_count: visibility.hiddenConversationCount,
    visibility_reason: visibility.reason,
    notes,
  };
}
