import { hasPermission, type ApiKeyData } from "@/lib/api-auth";

/**
 * Read scopes of customer API keys, shared by the v1 routes and the Airi MCP
 * endpoint so neither can drift wider than the other. Legacy keys without a
 * domain flag inherit their read permission; an explicit `false` denies.
 */
export function canReadCustomerConversations(apiKey: ApiKeyData): boolean {
  return (
    hasPermission(apiKey, "read") && apiKey.permissions.conversations !== false
  );
}

export function canReadCustomerAnalytics(apiKey: ApiKeyData): boolean {
  return (
    hasPermission(apiKey, "read") && apiKey.permissions.analytics !== false
  );
}
