const mockAssertCompanyConversationCapacity = jest.fn();
const mockGetWorkspaceBotDefault = jest.fn();
const mockGetWorkspaceCoachDefault = jest.fn();
const mockGetWorkspaceScenariosDefault = jest.fn();
const mockConversationFindOne = jest.fn();
const mockConversationCreate = jest.fn();
const mockMessageFindOne = jest.fn();

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotDefault: (...args: unknown[]) =>
    mockGetWorkspaceBotDefault(...args),
  getWorkspaceCoachDefault: (...args: unknown[]) =>
    mockGetWorkspaceCoachDefault(...args),
  getWorkspaceScenariosDefault: (...args: unknown[]) =>
    mockGetWorkspaceScenariosDefault(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  assertCompanyConversationCapacity: (...args: unknown[]) =>
    mockAssertCompanyConversationCapacity(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
    create: (...args: unknown[]) => mockConversationCreate(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
  },
}));

import { findOrCreateEmailConversation } from "./threading";

describe("findOrCreateEmailConversation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageFindOne.mockReturnValue({
      populate: jest.fn().mockResolvedValue(null),
    });
    mockConversationFindOne.mockResolvedValue({ _id: "conversation-1" });
    mockAssertCompanyConversationCapacity.mockResolvedValue(undefined);
    mockGetWorkspaceBotDefault.mockResolvedValue(true);
    mockGetWorkspaceCoachDefault.mockResolvedValue(false);
    mockGetWorkspaceScenariosDefault.mockResolvedValue(true);
    mockConversationCreate.mockResolvedValue({ _id: "new-conversation-1" });
  });

  it("matches an outbound-created conversation when an email reply reverses participants", async () => {
    const result = await findOrCreateEmailConversation({
      workspaceId: "workspace-1",
      from: ["customer@example.com"],
      to: ["sender@airi.chat"],
      subject: "Year results",
      headers: null,
    });

    expect(result).toEqual({ _id: "conversation-1" });
    expect(mockConversationFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        channel: "email",
        subject: "Year results",
        $or: [
          {
            "participants.from": { $in: ["customer@example.com"] },
            "participants.to": { $in: ["sender@airi.chat"] },
          },
          {
            "participants.from": { $in: ["sender@airi.chat"] },
            "participants.to": { $in: ["customer@example.com"] },
          },
        ],
      })
    );
    expect(mockConversationCreate).not.toHaveBeenCalled();
  });

  it("matches reply-prefixed subjects against the original outbound subject", async () => {
    await findOrCreateEmailConversation({
      workspaceId: "workspace-1",
      from: ["customer@example.com"],
      to: ["sender@airi.chat"],
      subject: "Re: Year results",
      headers: null,
    });

    expect(mockConversationFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { $in: ["Re: Year results", "Year results"] },
      })
    );
    expect(mockConversationCreate).not.toHaveBeenCalled();
  });
});
