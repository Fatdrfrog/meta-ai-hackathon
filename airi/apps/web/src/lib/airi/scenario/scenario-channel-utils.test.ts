import { encryptString } from "@/lib/crypto";
import {
  fetchSourceWithCredentials,
  fetchSourceWithCredentialsResult,
} from "@/lib/sources/utils";
import {
  clearWhatsAppSendContextCache,
  resolveWhatsAppSendContext,
} from "@/lib/whatsapp/send-context";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import User from "@/models/user";
import {
  buildChannelSpecificParams,
  resolveChatDocument,
  resolveConversationUserName,
} from "./scenario-channel-utils";

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: jest.fn(),
  fetchSourceWithCredentialsResult: jest.fn(),
}));
jest.mock("@/models/chat", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/user", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/conversation", () => ({ Conversation: {} }));

const scope = { workspaceId: "workspace-1", sourceId: "source-1" };
const waitStartedAt = "2026-09-11T10:00:00.000Z";
function source(boundary?: unknown) {
  return {
    id: scope.sourceId,
    workspace_id: scope.workspaceId,
    credentials: {
      access_token: "token",
      phone_number_id: "phone-1",
      waba_id: "222",
      conversions_api: {
        enabled: false,
        ...(boundary === undefined
          ? {}
          : { attribution_boundary_at: boundary }),
      },
    },
  };
}
function build(sourceBindingNotAfter?: string) {
  return buildChannelSpecificParams({
    workspaceId: scope.workspaceId,
    conversation: {
      _id: "conversation-1",
      sourceId: scope.sourceId,
      channel: "whatsapp",
      chat: "wa_77071234567",
    } as never,
    chatDocument: { _id: "chat-1", title: "Customer" } as never,
    sourceBindingNotAfter,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearWhatsAppSendContextCache(scope);
  (fetchSourceWithCredentialsResult as jest.Mock).mockResolvedValue({
    ok: true,
    source: source(),
  });
});

it.each([undefined, "2026-09-11T09:00:00Z", waitStartedAt])(
  "allows a wait belonging to the unchanged binding %j",
  async boundary => {
    (fetchSourceWithCredentialsResult as jest.Mock).mockResolvedValue({
      ok: true,
      source: source(boundary),
    });
    expect(await build(waitStartedAt)).toMatchObject({
      ok: true,
      whatsAppInfo: { phoneNumberId: "phone-1" },
    });
  }
);

it.each(["2026-09-11T10:00:00.001Z", "invalid", "2026-09-11", null])(
  "rejects a newer or malformed binding boundary %j",
  async boundary => {
    (fetchSourceWithCredentialsResult as jest.Mock).mockResolvedValue({
      ok: true,
      source: source(boundary),
    });
    expect(await build(waitStartedAt)).toEqual({
      ok: false,
      reason: "whatsapp_source_binding_changed",
    });
  }
);

it("does not use cached credentials after a source rebind", async () => {
  await resolveWhatsAppSendContext(scope);
  (fetchSourceWithCredentialsResult as jest.Mock).mockResolvedValue({
    ok: true,
    source: source("2026-09-11T11:00:00Z"),
  });
  expect(await build(waitStartedAt)).toEqual({
    ok: false,
    reason: "whatsapp_source_binding_changed",
  });
  expect(fetchSourceWithCredentialsResult).toHaveBeenCalledTimes(2);
});

it("throws source query errors for retry instead of classifying them as unavailable", async () => {
  const failure = new Error("Source database unavailable");
  (fetchSourceWithCredentialsResult as jest.Mock).mockResolvedValue({
    ok: false,
    error: failure,
  });
  await expect(build(waitStartedAt)).rejects.toBe(failure);
});

it("returns confirmed source absence as unavailable", async () => {
  (fetchSourceWithCredentialsResult as jest.Mock).mockResolvedValue({
    ok: true,
    source: null,
  });
  expect(await build(waitStartedAt)).toEqual({
    ok: false,
    reason: "source_not_found",
  });
});

it("fails closed for malformed wait times", async () => {
  expect(await build("invalid")).toEqual({
    ok: false,
    reason: "whatsapp_source_binding_changed",
  });
});

it("preserves normal caller caching without the explicit binding fence", async () => {
  await resolveWhatsAppSendContext(scope);
  (fetchSourceWithCredentialsResult as jest.Mock).mockResolvedValue({
    ok: true,
    source: source("2026-09-11T11:00:00Z"),
  });
  expect(await build()).toMatchObject({ ok: true });
  expect(fetchSourceWithCredentialsResult).toHaveBeenCalledTimes(1);
});

it.each([
  ["an encrypted", () => encryptString("123:scenario")],
  ["a plain-text legacy", () => "123:scenario"],
])("sends Telegram scenario steps with %s bot token", async (_label, token) => {
  const previousEncryptionSecret = process.env.ENCRYPTION_SECRET;
  process.env.ENCRYPTION_SECRET = "local-test-encryption-only";
  try {
    (fetchSourceWithCredentials as jest.Mock).mockResolvedValue({
      id: "source-1",
      workspace_id: "workspace-1",
      type: "telegram",
      credentials: { bot_token: token() },
    });

    await expect(
      buildChannelSpecificParams({
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-1",
          channel: "telegram",
          chat: "tg_1",
        } as never,
        chatDocument: { _id: "chat-1" } as never,
      })
    ).resolves.toEqual({ ok: true, botToken: "123:scenario" });
  } finally {
    if (previousEncryptionSecret === undefined) {
      delete process.env.ENCRYPTION_SECRET;
    } else {
      process.env.ENCRYPTION_SECRET = previousEncryptionSecret;
    }
  }
});

describe("the chat a scenario reply goes through", () => {
  // A customer has one chat record for every workspace they write to.
  const sharedChat = (chat: Record<string, unknown>) => {
    (Chat as unknown as { findOne: jest.Mock }).findOne = jest.fn(() => ({
      lean: async () => chat,
    }));
  };
  const timerConversation = {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    chat: "wa_77071234567",
  } as never;

  it("keeps the conversation's workspace and number after another workspace takes the chat", async () => {
    sharedChat({
      _id: "wa_77071234567",
      workspaceId: "workspace-2",
      sourceId: "source-2",
    });

    const { chatDocument } = await resolveChatDocument(timerConversation);

    expect(chatDocument).toMatchObject({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
  });

  it("follows the chat's live number inside the conversation's workspace", async () => {
    sharedChat({
      _id: "wa_77071234567",
      workspaceId: "workspace-1",
      sourceId: "source-1-reconnected",
    });

    const { chatDocument } = await resolveChatDocument(timerConversation);

    expect(chatDocument).toMatchObject({
      workspaceId: "workspace-1",
      sourceId: "source-1-reconnected",
    });
  });
});

describe("the contact name a scenario message uses", () => {
  // Every workspace that talks to the number reads the same contact.
  const sharedContact = (user: { firstName?: string; lastName?: string }) => {
    (User as unknown as { findById: jest.Mock }).findById = jest.fn(() => ({
      select: () => ({ lean: async () => user }),
    }));
  };
  const storedConversation = jest.fn();
  beforeEach(() => {
    storedConversation.mockReset();
    (Conversation as unknown as { findById: jest.Mock }).findById = jest.fn(
      (id: string) => ({
        select: () => ({ lean: async () => storedConversation(id) }),
      })
    );
  });
  const conversation = (id: string, extra: Record<string, unknown> = {}) =>
    ({ _id: id, user: "wa_77071234567", ...extra }) as never;
  const chat = { _id: "wa_77071234567", title: "77071234567" } as never;

  it("keeps one workspace's file name off another workspace's conversation", async () => {
    sharedContact({ firstName: "Customer" });

    await expect(
      resolveConversationUserName(
        conversation("conversation-a", {
          campaign_recipient_name: "Айгерим (долг 50 000)",
        }),
        chat
      )
    ).resolves.toBe("Айгерим (долг 50 000)");
    await expect(
      resolveConversationUserName(
        conversation("conversation-b", { campaign_recipient_name: null }),
        chat
      )
    ).resolves.toBe("Customer");
  });

  it("reads the file name stored on the conversation when it wasn't loaded", async () => {
    sharedContact({ firstName: "77071234567" });
    storedConversation.mockReturnValue({ campaign_recipient_name: "Dana" });

    await expect(
      resolveConversationUserName(conversation("conversation-a"), chat)
    ).resolves.toBe("Dana");
    expect(storedConversation).toHaveBeenCalledWith("conversation-a");
  });

  it("prefers a name from WhatsApp or a manager over the file's", async () => {
    sharedContact({ firstName: "Aigerim", lastName: "S." });

    await expect(
      resolveConversationUserName(
        conversation("conversation-a", { campaign_recipient_name: "Dana" }),
        chat
      )
    ).resolves.toBe("Aigerim S.");
    expect(storedConversation).not.toHaveBeenCalled();
  });
});
