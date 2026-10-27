import {
  UpdateAiriBotSchema,
  buildExistingConversationBotRolloutUpdate,
  GET,
  PATCH,
} from "@/app/api/workspaces/[workspaceId]/airi-bot/route";
import { stripBlankCustomActionDrafts } from "@/lib/airi/workspace-bot-schema";
import { DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS } from "@/lib/airi/workspace-bot-contract";
import { NextRequest } from "next/server";

const mockVoiceAccess = jest.fn();
const mockSettingsRead = jest.fn();
const mockSettingsWrite = jest.fn();
const mockConnectDb = jest.fn();
const mockRolloutWrite = jest.fn();
const mockConversationsWrite = jest.fn();
const mockQuery = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn(),
  then: (resolve: (value: { count: number }) => unknown) =>
    Promise.resolve({ count: 0 }).then(resolve),
};
const mockSupabase = {
  auth: { getUser: jest.fn() },
  from: jest.fn(() => mockQuery),
};

jest.mock("@/lib/airi/voice-reply-access", () => ({
  resolveWorkspaceVoiceReplyAccess: (...args: unknown[]) =>
    mockVoiceAccess(...args),
}));
jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotRuntimeSettings: (...args: unknown[]) =>
    mockSettingsRead(...args),
  updateWorkspaceBotRuntimeSettings: (...args: unknown[]) =>
    mockSettingsWrite(...args),
  setWorkspaceBotDefault: (...args: unknown[]) => mockRolloutWrite(...args),
  setWorkspaceScenariosDefault: (...args: unknown[]) =>
    mockRolloutWrite(...args),
  setWorkspaceCoachDefault: (...args: unknown[]) => mockRolloutWrite(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockSupabase,
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    countDocuments: jest.fn(async () => 0),
    updateMany: (...args: unknown[]) => mockConversationsWrite(...args),
  },
}));

describe("workspace voice-reply access", () => {
  const params = { params: Promise.resolve({ workspaceId: "workspace-1" }) };
  const request = (body: unknown) =>
    new NextRequest("http://localhost/api/workspaces/workspace-1/airi-bot", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    mockQuery.maybeSingle.mockResolvedValue({
      data: { workspace_id: "workspace-1" },
    });
    mockSettingsRead.mockResolvedValue(DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS);
    mockSettingsWrite.mockImplementation(async (_id, patch) => ({
      ...DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS,
      ...patch,
    }));
    mockVoiceAccess.mockResolvedValue({
      available: true,
      reason: null,
      apiKey: "secret-key",
      defaultVoiceId: "voice-1",
    });
  });

  it.each([
    ["subscription_required", 402],
    ["elevenlabs_required", 400],
  ])("rejects enabling with %s before any mutation", async (reason, status) => {
    mockVoiceAccess.mockResolvedValue({
      available: false,
      reason,
      apiKey: null,
      defaultVoiceId: null,
    });
    const result = await PATCH(
      request({
        whatsappVoiceRepliesEnabled: true,
        enabled: true,
        applyToExisting: true,
      }),
      params
    );
    expect(result.status).toBe(status);
    expect(await result.json()).toMatchObject({
      voiceReplyAccess: { available: false, reason },
    });
    expect(mockConnectDb).not.toHaveBeenCalled();
    expect(mockSettingsWrite).not.toHaveBeenCalled();
    expect(mockRolloutWrite).not.toHaveBeenCalled();
    expect(mockConversationsWrite).not.toHaveBeenCalled();
  });

  it("persists an eligible opt-in and never returns credentials", async () => {
    const result = await PATCH(
      request({ whatsappVoiceRepliesEnabled: true }),
      params
    );
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.whatsappVoiceRepliesEnabled).toBe(true);
    expect(data.voiceReplyAccess).toEqual({ available: true, reason: null });
    expect(JSON.stringify(data)).not.toContain("secret-key");
    expect(JSON.stringify(data)).not.toContain("voice-1");
    expect(mockSettingsWrite).toHaveBeenCalledWith(
      "workspace-1",
      { whatsappVoiceRepliesEnabled: true },
      "user-1"
    );
  });

  it("allows turning replies off after downgrade", async () => {
    mockVoiceAccess.mockResolvedValue({
      available: false,
      reason: "subscription_required",
      apiKey: null,
      defaultVoiceId: null,
    });
    const result = await PATCH(
      request({ whatsappVoiceRepliesEnabled: false }),
      params
    );
    expect(result.status).toBe(200);
    expect((await result.json()).whatsappVoiceRepliesEnabled).toBe(false);
  });

  it("still allows opt-out when access lookup is unavailable", async () => {
    mockVoiceAccess.mockRejectedValue(new Error("Plan lookup unavailable"));
    const result = await PATCH(
      request({ whatsappVoiceRepliesEnabled: false }),
      params
    );
    expect(result.status).toBe(200);
    expect((await result.json()).whatsappVoiceRepliesEnabled).toBe(false);
  });

  it("fails closed before writes when an opt-in cannot verify the plan", async () => {
    mockVoiceAccess.mockRejectedValue(new Error("Plan lookup unavailable"));
    const logError = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await PATCH(
        request({ whatsappVoiceRepliesEnabled: true }),
        params
      );
      expect(result.status).toBe(500);
      expect(mockSettingsWrite).not.toHaveBeenCalled();
      expect(mockConnectDb).not.toHaveBeenCalled();
    } finally {
      logError.mockRestore();
    }
  });

  it("publishes sanitized availability with GET settings", async () => {
    const result = await GET(
      new NextRequest("http://localhost/api/workspaces/workspace-1/airi-bot"),
      params
    );
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.whatsappVoiceRepliesEnabled).toBe(false);
    expect(data.voiceReplyAccess).toEqual({ available: true, reason: null });
    expect(JSON.stringify(data)).not.toContain("secret-key");
  });

  it("does not inspect or mutate voice settings without workspace access", async () => {
    mockQuery.maybeSingle.mockResolvedValue({ data: null });
    const result = await PATCH(
      request({ whatsappVoiceRepliesEnabled: true }),
      params
    );
    expect(result.status).toBe(404);
    expect(mockVoiceAccess).not.toHaveBeenCalled();
    expect(mockSettingsWrite).not.toHaveBeenCalled();
  });
});

describe("workspace airi-bot PATCH validation", () => {
  it.each([true, false])("accepts a voice-reply-only %s patch", enabled => {
    const parsed = UpdateAiriBotSchema.safeParse({
      whatsappVoiceRepliesEnabled: enabled,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.whatsappVoiceRepliesEnabled).toBe(enabled);
  });

  it("rejects a string voice-reply opt-in", () => {
    expect(
      UpdateAiriBotSchema.safeParse({ whatsappVoiceRepliesEnabled: "true" })
        .success
    ).toBe(false);
  });
  it("drops fully blank custom action drafts before validation", () => {
    expect(
      stripBlankCustomActionDrafts([
        { action: "", when: "" },
        { action: " Refund policy ", when: " When a user asks about refunds " },
      ])
    ).toEqual([
      {
        action: " Refund policy ",
        when: " When a user asks about refunds ",
      },
    ]);
  });

  it("accepts payloads that only contain blank custom action drafts", () => {
    const parsed = UpdateAiriBotSchema.safeParse({
      customAvailableActions: [{ action: "", when: "" }],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.customAvailableActions).toEqual([]);
    }
  });

  it("still rejects partially filled custom action rows", () => {
    const parsed = UpdateAiriBotSchema.safeParse({
      customAvailableActions: [{ action: "Refund policy", when: "" }],
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a runtime-only engine patch", () => {
    const parsed = UpdateAiriBotSchema.safeParse({
      elevenlabsAgentId: "agent_1234567890",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts a scenarios rollout patch", () => {
    const parsed = UpdateAiriBotSchema.safeParse({
      scenariosEnabled: true,
      applyScenariosToExisting: false,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a scenarios rollout patch without apply intent", () => {
    const parsed = UpdateAiriBotSchema.safeParse({
      scenariosEnabled: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("builds an enable-all rollout that clears active handoff state only for handed-off conversations", () => {
    const [stage] = buildExistingConversationBotRolloutUpdate({
      enabled: true,
      assignedBy: "user_1",
      scenarioDefaultForUnsetConversations: false,
    });

    expect(stage).toEqual({
      $set: expect.objectContaining({
        airi_bot_enabled: true,
        airi_assigned_by: "user_1",
        airi_handoff_active: false,
        airi_handoff_started_at: {
          $cond: [
            { $eq: ["$airi_handoff_active", true] },
            null,
            "$airi_handoff_started_at",
          ],
        },
        airi_handoff_source: {
          $cond: [
            { $eq: ["$airi_handoff_active", true] },
            null,
            "$airi_handoff_source",
          ],
        },
        airi_handoff_reason: {
          $cond: [
            { $eq: ["$airi_handoff_active", true] },
            null,
            "$airi_handoff_reason",
          ],
        },
        airi_handoff_restore_bot_enabled: {
          $cond: [
            { $eq: ["$airi_handoff_active", true] },
            null,
            "$airi_handoff_restore_bot_enabled",
          ],
        },
        status: {
          $cond: [{ $eq: ["$airi_handoff_active", true] }, "open", "$status"],
        },
      }),
    });
  });

  it("does not clear handoff state when disabling all conversations", () => {
    const [stage] = buildExistingConversationBotRolloutUpdate({
      enabled: false,
      assignedBy: "user_1",
      scenarioDefaultForUnsetConversations: false,
    });

    expect(stage.$set).not.toHaveProperty("airi_handoff_active");
    expect(stage.$set).not.toHaveProperty("status");
  });
});
