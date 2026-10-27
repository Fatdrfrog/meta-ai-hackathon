import type { ApiKeyData } from "@/lib/api-auth";
import { isAiriMcpScopeAllowed } from "../permissions";
import { getAnalyticsSummaryTool } from "./analytics";
import { listConversationsTool } from "./conversations";
import type { AiriMcpTool } from "./define";
import { listScenariosTool } from "./scenarios";
import { listWhatsAppTemplatesTool } from "./templates";

/** Every Airi MCP tool. All are read-only; there are no write tools. */
export const AIRI_MCP_TOOLS: readonly AiriMcpTool[] = [
  getAnalyticsSummaryTool,
  listConversationsTool,
  listWhatsAppTemplatesTool,
  listScenariosTool,
];

export function listAllowedAiriMcpTools(apiKey: ApiKeyData): AiriMcpTool[] {
  return AIRI_MCP_TOOLS.filter(tool =>
    isAiriMcpScopeAllowed(apiKey, tool.scope)
  );
}
