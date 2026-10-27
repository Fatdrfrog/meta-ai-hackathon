const mockSendTelegramMessage = jest.fn();
const mockGetExistingBusinessConnection = jest.fn();

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotDefault: jest.fn(async () => true),
  getWorkspaceCoachDefault: jest.fn(async () => true),
  getWorkspaceScenariosDefault: jest.fn(async () => true),
}));
jest.mock("@/lib/cache", () => ({
  invalidateConversationCache: jest.fn(),
  invalidateRequestsForWorkspace: jest.fn(),
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: jest.fn(),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE:
    "company_conversation_limit_exceeded",
  ensureCompanyConversationCapacity: jest.fn(async () => ({ allowed: true })),
}));
jest.mock("@/lib/media/conversation-media-analysis-jobs", () => ({
  enqueueConversationMediaAnalysis: jest.fn(),
}));
jest.mock("@/lib/realtime/server", () => ({
  realtime: { trigger: jest.fn() },
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/telegram", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));
jest.mock("@/models/chat", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/conversation", () => ({ Conversation: {} }));
jest.mock("@/models/message", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/user", () => ({ __esModule: true, default: {} }));
jest.mock("./handleBusinessConnectionUpdate", () => ({
  getExistingBusinessConnection: (...args: unknown[]) =>
    mockGetExistingBusinessConnection(...args),
  linkBusinessConnectionToSource: jest.fn(),
}));

import enIntegrationMessages from "../../../../messages/settings/integrations/en/page.json";
import type { TelegramMessage } from "@/types/telegram";
import { handleCommands } from "./helpers";

describe("Telegram command translations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetExistingBusinessConnection.mockResolvedValue(null);
    mockSendTelegramMessage.mockResolvedValue(undefined);
  });

  it("sends the /help greeting from the integration message catalog", async () => {
    const message: TelegramMessage = {
      message_id: 1,
      date: 1_700_000_000,
      text: "/help",
      chat: {
        id: 42,
        type: "private",
      },
      from: {
        id: 42,
        is_bot: false,
        first_name: "Test",
      },
    };

    await expect(handleCommands(message, undefined, "bot-token")).resolves.toBe(
      true
    );

    expect(mockGetExistingBusinessConnection).toHaveBeenCalledWith(
      42,
      undefined
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "42",
      enIntegrationMessages.TelegramWebhook.helpGreeting,
      { botToken: "bot-token" }
    );
  });
});
