jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

import type { ApiKeyData } from "@/lib/api-auth";
import {
  canReadCustomerAnalytics,
  canReadCustomerConversations,
} from "./read-access";

function key(permissions: ApiKeyData["permissions"]): ApiKeyData {
  return {
    id: "key-1",
    workspace_id: "workspace-1",
    key_prefix: "sk_test",
    name: "Test",
    permissions,
    rate_limit_per_minute: 60,
    is_active: true,
  };
}

describe("customer API read scopes", () => {
  it.each([
    [{ read: true }, true, true],
    [{ read: true, conversations: true, analytics: false }, true, false],
    [{ read: true, conversations: false, analytics: true }, false, true],
    [{ read: false, conversations: true, analytics: true }, false, false],
    [{ write: true, conversations: true, analytics: true }, false, false],
  ])(
    "%j reads conversations=%s analytics=%s",
    (permissions, conversations, analytics) => {
      expect(canReadCustomerConversations(key(permissions))).toBe(
        conversations
      );
      expect(canReadCustomerAnalytics(key(permissions))).toBe(analytics);
    }
  );
});
