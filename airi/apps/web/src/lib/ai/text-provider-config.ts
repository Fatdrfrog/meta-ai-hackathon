import "server-only";

import { canUseAnthropicAI } from "./anthropic-config";
import { canUseVertexAI } from "./vertex-config";
import { hasWorkspaceTextAiAction } from "./workspace-ai-policy";

/** Availability hint only. Admission and credentials resolve at inference time. */
export function canUseTextAI(): boolean {
  return hasWorkspaceTextAiAction() || canUseAnthropicAI() || canUseVertexAI();
}
