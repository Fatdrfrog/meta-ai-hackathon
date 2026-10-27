import { hasPermission, type ApiKeyData } from "@/lib/api-auth";
import {
  canReadCustomerAnalytics,
  canReadCustomerConversations,
} from "@/lib/customer-api/read-access";

/**
 * Which key scopes unlock which Airi MCP tools. Conversation and analytics
 * tools reuse the exact v1 read predicates. Templates and scenarios have no
 * v1 read route, so they require the explicit (and today UI-unsettable)
 * `templates: true` flag on a read key instead of inheriting `read`.
 */
export function canReadAiriMcpCatalog(apiKey: ApiKeyData): boolean {
  return hasPermission(apiKey, "read") && hasPermission(apiKey, "templates");
}

export const AIRI_MCP_SCOPE_PREDICATES = {
  analytics: canReadCustomerAnalytics,
  conversations: canReadCustomerConversations,
  catalog: canReadAiriMcpCatalog,
} as const satisfies Record<string, (apiKey: ApiKeyData) => boolean>;

export type AiriMcpScope = keyof typeof AIRI_MCP_SCOPE_PREDICATES;

export function isAiriMcpScopeAllowed(
  apiKey: ApiKeyData,
  scope: AiriMcpScope
): boolean {
  return AIRI_MCP_SCOPE_PREDICATES[scope](apiKey);
}
