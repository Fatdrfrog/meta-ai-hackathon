import {
  buildHistorySettingPersistenceMutation,
  resolveIncludeRecentConversationInRetrievalContext,
  getWorkspaceBotRuntimeSettings,
  updateWorkspaceBotRuntimeSettings,
} from "@/lib/airi/workspace-bot-default";
import {
  resolveConversationScenariosEnabled,
  resolveWorkspaceScenariosDefault,
} from "@/lib/airi/workspace-bot-contract";

const mockCacheGet = jest.fn();
const mockCacheDel = jest.fn();
const mockSettingsLean = jest.fn();
const mockSettingsSelect = jest.fn(() => ({ lean: mockSettingsLean }));
const mockSettingsWrite = jest.fn();

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (prefix: string, ids: string[]) =>
    `${prefix}:${ids.join(":")}`,
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: jest.fn(),
    del: (...args: unknown[]) => mockCacheDel(...args),
  },
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/workspace-airi-settings", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(() => ({ select: mockSettingsSelect })),
    findOneAndUpdate: (...args: unknown[]) => mockSettingsWrite(...args),
  },
}));

describe("workspace WhatsApp voice reply settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockSettingsLean.mockResolvedValue({});
  });

  it("keeps legacy workspaces opted out", async () => {
    expect(
      (await getWorkspaceBotRuntimeSettings("workspace-1"))
        .whatsappVoiceRepliesEnabled
    ).toBe(false);
  });

  it("reads an explicit opt-in from storage", async () => {
    mockSettingsLean.mockResolvedValue({
      whatsapp_voice_replies_enabled: true,
    });
    expect(
      (await getWorkspaceBotRuntimeSettings("workspace-1"))
        .whatsappVoiceRepliesEnabled
    ).toBe(true);
    expect(mockSettingsSelect).toHaveBeenCalledWith(
      expect.stringContaining("whatsapp_voice_replies_enabled")
    );
  });

  it("normalizes stale cache entries to opt-out", async () => {
    mockCacheGet.mockResolvedValue({ defaultBotEnabled: true });
    expect(
      (await getWorkspaceBotRuntimeSettings("workspace-1"))
        .whatsappVoiceRepliesEnabled
    ).toBe(false);
  });

  it("reads an opt-in from cached settings", async () => {
    mockCacheGet.mockResolvedValue({ whatsappVoiceRepliesEnabled: true });
    expect(
      (await getWorkspaceBotRuntimeSettings("workspace-1"))
        .whatsappVoiceRepliesEnabled
    ).toBe(true);
  });

  it.each([null, "true", 1])(
    "does not enable voice replies for invalid stored value %s",
    async value => {
      mockSettingsLean.mockResolvedValue({
        whatsapp_voice_replies_enabled: value,
      });
      expect(
        (await getWorkspaceBotRuntimeSettings("workspace-1"))
          .whatsappVoiceRepliesEnabled
      ).toBe(false);
    }
  );

  it("preserves the voice opt-in when another setting changes", async () => {
    mockSettingsLean.mockResolvedValue({
      whatsapp_voice_replies_enabled: true,
    });
    const result = await updateWorkspaceBotRuntimeSettings(
      "workspace-1",
      {
        responseStyle: "concise",
        includeRecentConversationInRetrievalContext: true,
      },
      "user-1"
    );
    expect(result.whatsappVoiceRepliesEnabled).toBe(true);
    expect(mockSettingsWrite.mock.calls[0][1].$set).not.toHaveProperty(
      "whatsapp_voice_replies_enabled"
    );
  });

  it.each([true, false])(
    "persists the %s opt-in and invalidates cached settings",
    async enabled => {
      await updateWorkspaceBotRuntimeSettings(
        "workspace-1",
        {
          whatsappVoiceRepliesEnabled: enabled,
          includeRecentConversationInRetrievalContext: true,
        },
        "user-1"
      );
      expect(mockSettingsWrite).toHaveBeenCalledWith(
        { workspaceId: "workspace-1" },
        {
          $set: {
            updated_by: "user-1",
            include_recent_conversation_in_retrieval_context: true,
            whatsapp_voice_replies_enabled: enabled,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      expect(mockCacheDel).toHaveBeenCalledWith(
        "airi:workspace-bot-runtime-settings:workspace-1"
      );
    }
  );
});

describe("workspace bot settings retrieval history", () => {
  it("reads the current retrieval-history field from stored settings", () => {
    expect(
      resolveIncludeRecentConversationInRetrievalContext(
        {
          include_recent_conversation_in_retrieval_context: false,
        },
        true
      )
    ).toBe(false);
  });

  it("prefers the runtime cache shape when present", () => {
    expect(
      resolveIncludeRecentConversationInRetrievalContext(
        {
          includeRecentConversationInRetrievalContext: true,
          include_recent_conversation_in_retrieval_context: false,
        },
        false
      )
    ).toBe(true);
  });

  it("persists only the current retrieval-history field", async () => {
    await expect(
      buildHistorySettingPersistenceMutation("workspace-1", false)
    ).resolves.toEqual({
      setPayload: {
        include_recent_conversation_in_retrieval_context: false,
      },
    });
  });
});

describe("workspace and conversation scenario defaults", () => {
  it("defaults scenarios ON when workspace settings are missing", () => {
    expect(resolveWorkspaceScenariosDefault(null)).toBe(true);
    expect(resolveWorkspaceScenariosDefault({})).toBe(true);
  });

  it("keeps existing workspaces compatible by falling back to bot default", () => {
    expect(
      resolveWorkspaceScenariosDefault({
        airi_bot_default_enabled: true,
      })
    ).toBe(true);
  });

  it("respects an explicit workspace scenarios default over bot default", () => {
    expect(
      resolveWorkspaceScenariosDefault({
        airi_scenarios_default_enabled: false,
        airi_bot_default_enabled: true,
      })
    ).toBe(false);
  });

  it("keeps existing conversations compatible by falling back to bot state", () => {
    expect(
      resolveConversationScenariosEnabled({
        airi_bot_enabled: true,
        airi_enabled: false,
      })
    ).toBe(true);
  });

  it("respects an explicit conversation scenarios toggle over bot state", () => {
    expect(
      resolveConversationScenariosEnabled({
        airi_scenarios_enabled: true,
        airi_bot_enabled: false,
        airi_enabled: false,
      })
    ).toBe(true);
  });

  it("uses the workspace scenarios default when conversation flags are absent", () => {
    expect(resolveConversationScenariosEnabled({}, true)).toBe(true);
  });
});
