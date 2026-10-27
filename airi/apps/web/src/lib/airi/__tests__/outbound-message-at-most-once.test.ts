const mockSendWhatsappMessage = jest.fn();
const mockSendWhatsappMedia = jest.fn();
const mockPrepareWhatsAppVoiceReply = jest.fn();
const mockResolveScenarioAttachment = jest.fn();
const mockReserveTemporalOutboundDispatch = jest.fn();
const mockFetchSourceWithCredentialsResult = jest.fn();
const mockSendWhatsappInteractiveReplyButtons = jest.fn();
const mockSendWhatsappInteractiveReplyButtonsMessage = jest.fn();
const mockSendWhatsappInteractiveFlow = jest.fn();
const mockAppendMessageToConversationById = jest.fn();
const mockTriggerRealtimeEvent = jest.fn();
const mockCheckMessagingWindowForConversation = jest.fn();
const mockFindOneAndUpdateUser = jest.fn();
const mockBehaviorRun = jest.fn();
const mockBehaviorGuard = jest.fn();
const mockBehaviorAttempt = jest.fn();
const mockSendTemplate = jest.fn();
const mockTemplateAvailable = jest.fn(() => true);
const mockTrackScenarioFlowSent = jest.fn();
const mockRefreshTemplateMedia = jest.fn();
const mockCurrentConversation = jest.fn();
const mockScenarioDeliveryOwnership = jest.fn();
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (scope: unknown) => ({
      select: () => ({ lean: async () => mockCurrentConversation(scope) }),
    }),
  },
}));
jest.mock("@icecore/airi-runtime/delivery-gates", () => ({
  resolveScenarioDeliveryOwnership: (...args: unknown[]) =>
    mockScenarioDeliveryOwnership(...args),
}));
jest.mock("@/lib/whatsapp/templates/send-lookup", () => ({
  refreshWhatsAppTemplateMediaForSend: (...args: unknown[]) =>
    mockRefreshTemplateMedia(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/whatsapp/media-upload", () => ({
  isWhatsAppTemplateMediaDownloadError: (error: { code?: string }) =>
    error?.code === "WHATSAPP_TEMPLATE_MEDIA_DOWNLOAD_FAILED",
}));
jest.mock("@/lib/scenarios/behavior-delivery", () => ({
  findOutboundBehaviorRun: (...args: unknown[]) => mockBehaviorRun(...args),
  guardBehaviorDelivery: (...args: unknown[]) => mockBehaviorGuard(...args),
  markBehaviorContactAttempted: (...args: unknown[]) =>
    mockBehaviorAttempt(...args),
}));
jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveFreshWhatsAppSendContext: jest.fn(async () => ({
    phoneNumberId: "phone-number-id",
    accessToken: "access-token",
  })),
  resolveWhatsAppSendContext: jest.fn(async () => null),
}));
jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    findOne: () => {
      const query = {
        select: () => query,
        lean: async () =>
          mockTemplateAvailable()
            ? {
                category: "MARKETING",
                components: [{ type: "BODY", text: "Come back" }],
              }
            : null,
      };
      return query;
    },
  },
}));
jest.mock("@/lib/cross-store-outbox", () => ({
  enqueueWhatsAppLlmHelpfulnessPromptWithOutbox: jest.fn(),
}));

type DispatchState =
  | "reserved"
  | "dispatching"
  | "sent"
  | "not_attempted"
  | "outcome_unknown";

type UnknownRecord = Record<string, unknown>;

type StoredMessage = UnknownRecord & {
  _id: string;
  temporalDispatch?: {
    version: 1;
    state: DispatchState;
    deliveryKey: string;
    attemptToken: string;
    claimedAt?: Date;
    finishedAt?: Date;
    terminalCode?: string;
  };
};

const storedMessages = new Map<string, StoredMessage>();

function readPath(value: UnknownRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function matchesFilter(message: StoredMessage, filter: UnknownRecord): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") {
      return (expected as UnknownRecord[]).some((candidate): boolean =>
        matchesFilter(message, candidate)
      );
    }
    const actual = readPath(message, key);
    if (expected && typeof expected === "object" && "$in" in expected) {
      return (expected as { $in: unknown[] }).$in.includes(actual);
    }
    if (expected && typeof expected === "object" && "$eq" in expected) {
      const predicate = expected as { $eq: unknown; $type?: string };
      return (
        actual === predicate.$eq &&
        (predicate.$type !== "string" || typeof actual === "string")
      );
    }
    return String(actual ?? "") === String(expected ?? "");
  });
}

function applyUpdate(
  message: StoredMessage,
  update: UnknownRecord
): StoredMessage {
  const set =
    update.$set && typeof update.$set === "object"
      ? (update.$set as UnknownRecord)
      : {};
  for (const [path, value] of Object.entries(set)) {
    const segments = path.split(".");
    let owner: UnknownRecord = message;
    for (const segment of segments.slice(0, -1)) {
      if (!owner[segment] || typeof owner[segment] !== "object") {
        owner[segment] = {};
      }
      owner = owner[segment] as UnknownRecord;
    }
    owner[segments.at(-1)!] = value;
  }
  return message;
}

function queryResult<T>(resolve: () => T | Promise<T>) {
  const query = {
    sort: () => query,
    select: () => query,
    lean: () => Promise.resolve(resolve()),
    then: (
      onFulfilled: (value: T) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };
  return query;
}

jest.mock("@/models/message", () => {
  class MessageModel {
    static schema = {
      path: (path: string) =>
        path === "temporalDispatch"
          ? { options: { select: false } }
          : undefined,
    };

    static findOne = jest.fn((filter: UnknownRecord) =>
      queryResult(
        () =>
          [...storedMessages.values()].find(message =>
            matchesFilter(message, filter)
          ) || null
      )
    );

    static findById = jest.fn((id: unknown) => ({
      populate: jest.fn(async () => storedMessages.get(String(id)) || null),
    }));

    static findOneAndUpdate = jest.fn(
      (
        filter: UnknownRecord,
        update: UnknownRecord,
        _options?: UnknownRecord
      ) =>
        queryResult(() => {
          const existing =
            [...storedMessages.values()].find(message =>
              matchesFilter(message, filter)
            ) || null;
          return existing ? applyUpdate(existing, update) : null;
        })
    );

    _id: string;
    [key: string]: unknown;

    constructor(payload: UnknownRecord) {
      Object.assign(this, payload);
      this._id = String(payload._id || `message-${storedMessages.size + 1}`);
    }

    set(payload: UnknownRecord) {
      Object.assign(this, payload);
      return this;
    }

    async save() {
      const duplicate = [...storedMessages.values()].find(
        message =>
          message._id !== this._id &&
          this.temporalDeliveryKey &&
          message.temporalDeliveryKey === this.temporalDeliveryKey
      );
      if (duplicate) {
        const error = new Error("duplicate temporalDeliveryKey") as Error & {
          code?: number;
        };
        error.code = 11000;
        throw error;
      }
      storedMessages.set(this._id, this as StoredMessage);
      return this;
    }
  }

  return {
    __esModule: true,
    buildTemporalDeliveryKeyFilter: (...args: unknown[]) =>
      jest
        .requireActual("@/models/message")
        .buildTemporalDeliveryKeyFilter(...args),
    default: MessageModel,
  };
});

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdateUser(...args),
  },
}));

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappMessage: (...args: unknown[]) => mockSendWhatsappMessage(...args),
  sendWhatsappMedia: (...args: unknown[]) => mockSendWhatsappMedia(...args),
  sendWhatsappTemplate: (...args: unknown[]) => mockSendTemplate(...args),
  sendWhatsappInteractiveReplyButtons: (...args: unknown[]) =>
    mockSendWhatsappInteractiveReplyButtons(...args),
  sendWhatsappInteractiveReplyButtonsMessage: (...args: unknown[]) =>
    mockSendWhatsappInteractiveReplyButtonsMessage(...args),
  sendWhatsappInteractiveList: jest.fn(),
  sendWhatsappInteractiveFlow: (...args: unknown[]) =>
    mockSendWhatsappInteractiveFlow(...args),
  sendWhatsappInteractiveCtaUrl: jest.fn(),
  sendWhatsappContacts: jest.fn(),
  sendWhatsappLocation: jest.fn(),
}));

jest.mock("@/lib/telegram", () => ({
  sendTelegramMessage: jest.fn(),
  sendTelegramPhoto: jest.fn(),
  sendTelegramDocument: jest.fn(),
}));

jest.mock("@/lib/airi/reply/delivery/temporal-outbound", () => ({
  reserveTemporalOutboundDispatch: (...args: unknown[]) =>
    mockReserveTemporalOutboundDispatch(...args),
}));

jest.mock("@/lib/airi/reply/delivery/whatsapp-voice-reply", () => ({
  WHATSAPP_VOICE_REPLY_MAX_CHARACTERS: 600,
  prepareWhatsAppVoiceReply: (...args: unknown[]) =>
    mockPrepareWhatsAppVoiceReply(...args),
}));

jest.mock("@/lib/airi/conversation", () => ({
  isGreetingMessage: () => false,
  markGreetingSentToday: jest.fn(),
}));

jest.mock("@/lib/airi/reply/delivery/reply-rich-text-format", () => ({
  formatReplyMarkdownForInstagram: (value: string) => value,
  formatReplyMarkdownForTelegramHtml: (value: string) => value,
  formatReplyMarkdownForWhatsApp: (value: string) => value,
}));

jest.mock("@/lib/messaging-window", () => ({
  checkMessagingWindow: jest.fn(),
  checkMessagingWindowForConversation: (...args: unknown[]) =>
    mockCheckMessagingWindowForConversation(...args),
}));

jest.mock("@/lib/email/email-source", () => ({
  getWorkspaceEmailSource: jest.fn(async () => null),
  resolveEmailProviderForWorkspaceSource: jest.fn(async () => null),
}));

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderConfig: jest.fn(async () => null),
  isManagedEmailProviderPending: jest.fn(() => false),
}));

jest.mock("@/lib/postmark", () => ({
  postmarkSendEmail: jest.fn(),
}));

jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessageToConversationById(...args),
}));

jest.mock("@/lib/realtime/server", () => ({
  triggerRealtimeEvent: (...args: unknown[]) =>
    mockTriggerRealtimeEvent(...args),
}));

jest.mock("@/lib/scenarios/scenario-flow-analytics", () => ({
  trackScenarioFlowSent: (...args: unknown[]) =>
    mockTrackScenarioFlowSent(...args),
}));

jest.mock("@/lib/scenarios/scenario-flow-suppression", () => ({
  WHATSAPP_FLOW_INTEGRITY_BLOCK_CODE: 139000,
  getActiveScenarioFlowSuppression: jest.fn(async () => null),
  getWhatsAppFlowErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  isWhatsAppFlowIntegrityBlockError: () => false,
  suppressScenarioFlowAfterIntegrityBlock: jest.fn(),
}));

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: jest.fn(async () => null),
  fetchSourceWithCredentialsResult: (...args: unknown[]) =>
    mockFetchSourceWithCredentialsResult(...args),
}));

jest.mock("@/lib/llm-analytics/whatsapp-feedback", () => ({
  sendWhatsAppLlmHelpfulnessPrompt: jest.fn(),
  upsertWhatsAppLlmAnswerReviewItem: jest.fn(),
}));

jest.mock("@/lib/scenarios/scenario-asset-resolve", () => ({
  resolveScenarioActionAttachmentHttpsUrl: (...args: unknown[]) =>
    mockResolveScenarioAttachment(...args),
  resolveScenarioAssetHttpsUrl: jest.fn(),
}));

jest.mock("@icecore/shared/lib/whatsapp/contact-identities", () => ({
  getWhatsAppLogIdentity: () => "77012345678",
  buildNormalizedWhatsAppContact: (value: Record<string, unknown>) => value,
  resolveStoredWhatsAppRecipientTarget: jest.fn(),
  resolveWhatsAppRecipientTarget: (contact?: { waId?: string } | null) =>
    contact?.waId ? { kind: "phone", value: contact.waId } : null,
}));

import {
  resolveWhatsAppVoiceReplyIntent,
  sendAndPersistOutbound,
} from "@/lib/airi/reply/delivery/outbound-message";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { encryptString } from "@/lib/crypto";
import { sendTelegramMessage } from "@/lib/telegram";

const baseContext = {
  type: "whatsapp",
  workspaceId: "workspace-1",
  conversation: {
    _id: "conversation-1",
    sourceId: "source-1",
    workspaceId: "workspace-1",
  },
  chatDocument: { _id: "chat-1", sourceId: "source-1" },
  content: "Your video is ready.",
  whatsAppInfo: {
    phoneNumberId: "phone-number-id",
    accessToken: "access-token",
    contactData: { waId: "77012345678" },
  },
  temporalDeliveryKey: "delivery-key-1",
  temporalReservedMessageId: "507f1f77bcf86cd799439011",
  temporalDispatchPolicy: "at_most_once",
} as const;

function getDeliveryOwner() {
  return storedMessages.get(baseContext.temporalReservedMessageId);
}

describe("automatic WhatsApp voice reply intent", () => {
  const eligible = {
    channel: "whatsapp",
    enabled: true,
    inboundMediaType: "audio",
    text: "We can deliver tomorrow.",
    language: "ru",
    grounded: true,
  } as const;

  it("selects voice for a short automatic response to an incoming voice message", () => {
    expect(resolveWhatsAppVoiceReplyIntent(eligible)).toEqual({
      language: "ru",
    });
  });

  it.each([
    { enabled: false },
    { channel: "telegram" },
    { inboundMediaType: "text" },
    { text: " " },
    { text: "x".repeat(601) },
    { hasScenario: true },
    { hasInteractivePayload: true },
    { hasAttachments: true },
    { proactive: true },
    { grounded: false },
  ])("preserves text for an ineligible reply: %j", override => {
    expect(
      resolveWhatsAppVoiceReplyIntent({ ...eligible, ...override })
    ).toBeUndefined();
  });
});

describe("sendAndPersistOutbound at-most-once dispatch", () => {
  beforeEach(() => {
    mockTemplateAvailable.mockReturnValue(true);
    jest.clearAllMocks();
    mockRefreshTemplateMedia
      .mockReset()
      .mockImplementation(async params => params.components);
    mockCurrentConversation
      .mockReset()
      .mockReturnValue({ _id: "conversation-1" });
    mockScenarioDeliveryOwnership.mockReset().mockReturnValue({ allow: true });
    storedMessages.clear();
    mockReserveTemporalOutboundDispatch.mockImplementation(() => {
      throw new Error("Temporal outbound capture is not active");
    });
    mockPrepareWhatsAppVoiceReply.mockResolvedValue(null);
    mockResolveScenarioAttachment.mockImplementation(
      async ({ attachment }) => ({
        ...attachment,
        url: "https://media.example/reply.ogg",
      })
    );
    mockSendWhatsappMedia.mockResolvedValue({ messageId: "wamid.voice-1" });
    mockBehaviorRun.mockResolvedValue(null);
    mockBehaviorGuard.mockResolvedValue(null);
    mockSendTemplate
      .mockReset()
      .mockImplementation(async (...args: unknown[]) => {
        await (
          args[6] as { beforeSend?: () => Promise<void> } | undefined
        )?.beforeSend?.();
        return { messageId: "wamid.behavior-template" };
      });
    mockFindOneAndUpdateUser.mockReturnValue({
      exec: jest.fn(async () => ({ _id: "airi-bot" })),
    });
    mockCheckMessagingWindowForConversation.mockResolvedValue({
      isWithinWindow: true,
    });
    mockSendWhatsappMessage.mockResolvedValue({
      messageId: "wamid.provider-1",
    });
    mockSendWhatsappInteractiveReplyButtonsMessage
      .mockReset()
      .mockResolvedValue({
        messageId: "wamid.service-1",
      });
    mockSendWhatsappInteractiveFlow
      .mockReset()
      .mockResolvedValue({ messageId: "wamid.flow-1" });
    mockAppendMessageToConversationById.mockResolvedValue(undefined);
    mockTriggerRealtimeEvent.mockResolvedValue(undefined);
  });

  it("captures voice intent without generating or dispatching audio during preparation", async () => {
    mockReserveTemporalOutboundDispatch.mockReturnValue({
      placeholderMessageId: baseContext.temporalReservedMessageId,
      placeholderDate: new Date("2026-10-07T10:00:00Z"),
    });
    const context = {
      ...baseContext,
      temporalDeliveryKey: undefined,
      temporalReservedMessageId: undefined,
      whatsappVoiceReply: { language: "ru" },
    };

    const captured = await sendAndPersistOutbound(context as never);

    expect(captured._id).toBe(baseContext.temporalReservedMessageId);
    expect(mockReserveTemporalOutboundDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchPolicy: "at_most_once",
        context: expect.objectContaining({
          whatsappVoiceReply: { language: "ru" },
        }),
      })
    );
    expect(mockPrepareWhatsAppVoiceReply).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
  });

  it("keeps the Telegram bot token out of the captured delivery context", async () => {
    mockReserveTemporalOutboundDispatch.mockReturnValue({
      placeholderMessageId: baseContext.temporalReservedMessageId,
      placeholderDate: new Date("2026-10-07T10:00:00Z"),
    });

    await sendAndPersistOutbound({
      ...baseContext,
      temporalDeliveryKey: undefined,
      temporalReservedMessageId: undefined,
      botToken: "123:bot-secret",
    } as never);

    const [{ context }] = mockReserveTemporalOutboundDispatch.mock.calls[0] as [
      { context: Record<string, unknown> },
    ];
    expect(context).not.toHaveProperty("botToken");
    expect(JSON.stringify(context)).not.toContain("123:bot-secret");
  });

  it("sends one voice note and stores its readable text and audio under the dispatch owner", async () => {
    mockPrepareWhatsAppVoiceReply.mockResolvedValue({
      url: "gcs://assets/workspaces/workspace-1/reply.ogg",
      mediaType: "audio",
      mimeType: "audio/ogg",
      fileName: "reply.ogg",
    });
    const context = { ...baseContext, whatsappVoiceReply: { language: "ru" } };

    const sent = await sendAndPersistOutbound(context as never);
    const replayed = await sendAndPersistOutbound(context as never);

    expect(mockPrepareWhatsAppVoiceReply).toHaveBeenCalledTimes(1);
    expect(mockPrepareWhatsAppVoiceReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      deliveryKey: "delivery-key-1",
      text: "Your video is ready.",
      language: "ru",
    });
    expect(mockSendWhatsappMedia).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsappMedia).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.objectContaining({
        type: "audio",
        link: "https://media.example/reply.ogg",
        voice: true,
      })
    );
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(sent.text).toBe("Your video is ready.");
    expect(sent.mediaType).toBe("audio");
    expect(sent.imageUrl).toBe("https://media.example/reply.ogg");
    expect(sent.whatsappServiceMessage).toEqual(
      expect.objectContaining({
        kind: "media",
        command: expect.objectContaining({
          voice: true,
          attachment: expect.objectContaining({
            url: "gcs://assets/workspaces/workspace-1/reply.ogg",
            mediaType: "audio",
          }),
        }),
      })
    );
    expect(sent.temporalDispatch.state).toBe("sent");
    expect(replayed._id).toBe(sent._id);
  });

  it("falls back to one text message when voice generation is unavailable", async () => {
    const result = await sendAndPersistOutbound({
      ...baseContext,
      whatsappVoiceReply: { language: "ru" },
    } as never);

    expect(mockPrepareWhatsAppVoiceReply).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
    expect(mockSendWhatsappMessage).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Your video is ready.");
    expect(result.temporalDispatch.state).toBe("sent");
  });

  it("does not spend voice generation after the messaging window closes", async () => {
    mockCheckMessagingWindowForConversation.mockResolvedValue({
      isWithinWindow: false,
    });

    const result = await sendAndPersistOutbound({
      ...baseContext,
      whatsappVoiceReply: { language: "ru" },
    } as never);

    expect(result.temporalDispatch.state).toBe("not_attempted");
    expect(mockPrepareWhatsAppVoiceReply).not.toHaveBeenCalled();
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
  });

  it("keeps direct callers deliverable as text when no Temporal dispatch owner exists", async () => {
    const result = await sendAndPersistOutbound({
      ...baseContext,
      temporalDeliveryKey: undefined,
      temporalReservedMessageId: undefined,
      whatsappVoiceReply: { language: "ru" },
    } as never);

    expect(mockPrepareWhatsAppVoiceReply).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
    expect(mockSendWhatsappMessage).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Your video is ready.");
  });

  it("falls back to readable text when signing the generated audio fails before dispatch", async () => {
    mockPrepareWhatsAppVoiceReply.mockResolvedValue({
      url: "gcs://assets/workspaces/workspace-1/reply.ogg",
      mediaType: "audio",
      mimeType: "audio/ogg",
    });
    mockResolveScenarioAttachment.mockRejectedValue(
      new Error("signer unavailable")
    );

    const result = await sendAndPersistOutbound({
      ...baseContext,
      whatsappVoiceReply: { language: "ru" },
    } as never);

    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
    expect(mockSendWhatsappMessage).toHaveBeenCalledTimes(1);
    expect(result.temporalDispatch.state).toBe("sent");
    expect(result.text).toBe("Your video is ready.");
  });

  it("speaks the finalized answer without its internal assistant prefix", async () => {
    await sendAndPersistOutbound({
      ...baseContext,
      content: "Airi: We can deliver tomorrow.",
      whatsappVoiceReply: { language: "kk" },
    } as never);

    expect(mockPrepareWhatsAppVoiceReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "We can deliver tomorrow.",
        language: "kk",
      })
    );
    expect(getDeliveryOwner()?.text).toBe("Airi: We can deliver tomorrow.");
  });

  it("never falls back to text or regenerates audio after an uncertain voice send", async () => {
    mockPrepareWhatsAppVoiceReply.mockResolvedValue({
      url: "gcs://assets/workspaces/workspace-1/reply.ogg",
      mediaType: "audio",
      mimeType: "audio/ogg",
    });
    mockSendWhatsappMedia.mockRejectedValue(
      new Error("timeout after provider accepted")
    );
    const context = { ...baseContext, whatsappVoiceReply: { language: "ru" } };

    const first = await sendAndPersistOutbound(context as never);
    const retried = await sendAndPersistOutbound(context as never);

    expect(first.temporalDispatch.state).toBe("outcome_unknown");
    expect(retried.temporalDispatch.state).toBe("outcome_unknown");
    expect(mockSendWhatsappMedia).toHaveBeenCalledTimes(1);
    expect(mockPrepareWhatsAppVoiceReply).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
  });

  it("retains authored media instead of replacing it with a generated voice note", async () => {
    const result = await sendAndPersistOutbound({
      ...baseContext,
      whatsappVoiceReply: { language: "ru" },
      scenarioAttachments: [
        { url: "https://media.example/authored.pdf", mediaType: "document" },
      ],
    } as never);

    expect(result.temporalDispatch.state).toBe("sent");
    expect(mockPrepareWhatsAppVoiceReply).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.not.objectContaining({ voice: true })
    );
  });

  it("does not replace native clarification choices with voice", async () => {
    const result = await sendAndPersistOutbound({
      ...baseContext,
      whatsappVoiceReply: { language: "ru" },
      groundedReplyOptions: [
        { id: "option-1", label: "Yes", sourceKind: "kb", sourceIds: ["kb-1"] },
      ],
    } as never);

    expect(result.temporalDispatch.state).toBe("not_attempted");
    expect(mockPrepareWhatsAppVoiceReply).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
  });

  it("prepares a voice note for the existing direct delivery path", async () => {
    mockPrepareWhatsAppVoiceReply.mockResolvedValue({
      url: "gcs://assets/workspaces/workspace-1/reply.ogg",
      mediaType: "audio",
      mimeType: "audio/ogg",
    });

    const result = await sendAndPersistOutbound({
      ...baseContext,
      temporalDispatchPolicy: undefined,
      whatsappVoiceReply: { language: "ru" },
    } as never);

    expect(mockSendWhatsappMedia).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.objectContaining({ type: "audio", voice: true })
    );
    expect(result.text).toBe("Your video is ready.");
    expect(result.mediaType).toBe("audio");
  });

  it("persists the reserved owner before Meta dispatch", async () => {
    mockSendWhatsappMessage.mockImplementationOnce(async () => {
      const owner = getDeliveryOwner();
      expect(owner?.temporalDispatch?.state).toBe("dispatching");
      expect(owner).not.toHaveProperty("workspaceId");
      expect(owner).not.toHaveProperty("channel");
      expect(owner).not.toHaveProperty("date");
      expect(owner).not.toHaveProperty("conversation");
      expect(owner).not.toHaveProperty("direction");
      return { messageId: "wamid.provider-1" };
    });

    const result = await sendAndPersistOutbound(baseContext as never);

    expect(result.temporalDispatch.state).toBe("sent");
    expect(getDeliveryOwner()?.messageId).toBe("ws_wamid.provider-1");
    expect(result.workspaceId).toBe(baseContext.workspaceId);
    expect(result.channel).toBe(baseContext.type);
    expect(result.conversation).toBe(baseContext.conversation._id);
    expect(result.direction).toBe("outbound");
    expect(result.date).toBeInstanceOf(Date);
  });

  it("blocks a prepared behavior message after conversion without calling Meta", async () => {
    mockBehaviorRun.mockResolvedValue({ _id: "run-1" });
    mockBehaviorGuard.mockResolvedValue("converted");
    const result = await sendAndPersistOutbound({
      ...baseContext,
      temporalDispatchPolicy: undefined,
      sourceMessageId: "customer-behavior:run-1",
      scenarioOrigin: { scenarioId: "scenario" },
      whatsappTemplate: { name: "return", languageCode: "ru" },
    } as never);
    expect(result.temporalDispatch.state).toBe("not_attempted");
    expect(result.temporalDispatch.terminalCode).toBe("converted");
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it("does not consume contact capacity when the approved template is unavailable", async () => {
    mockBehaviorRun.mockResolvedValue({ _id: "run-1" });
    mockTemplateAvailable.mockReturnValue(false);
    const result = await sendAndPersistOutbound({
      ...baseContext,
      temporalDispatchPolicy: undefined,
      scenarioOrigin: { scenarioId: "scenario" },
      sourceMessageId: "customer-behavior:run-1",
      whatsappTemplate: {
        name: "cart_recovery",
        languageCode: "en",
        components: [],
      },
    } as never);
    expect(result.temporalDispatch.terminalCode).toBe("template_unavailable");
    expect(mockBehaviorGuard).not.toHaveBeenCalled();
    expect(mockBehaviorAttempt).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it("uses the existing dispatch fence for templates and never retries an uncertain Meta outcome", async () => {
    mockBehaviorRun.mockResolvedValue({ _id: "run-1" });
    mockSendTemplate.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[6] as { beforeSend?: () => Promise<void> }).beforeSend?.();
      throw new Error("connection reset after provider accepted");
    });
    mockCheckMessagingWindowForConversation.mockResolvedValue({
      isWithinWindow: false,
    });
    const context = {
      ...baseContext,
      temporalDispatchPolicy: undefined,
      sourceMessageId: "customer-behavior:run-1",
      scenarioOrigin: { scenarioId: "scenario" },
      whatsappTemplate: { name: "return", languageCode: "ru" },
    };
    const first = await sendAndPersistOutbound(context as never);
    const retried = await sendAndPersistOutbound(context as never);
    expect(first.temporalDispatch.state).toBe("outcome_unknown");
    expect(retried.temporalDispatch.state).toBe("outcome_unknown");
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockBehaviorAttempt).toHaveBeenCalledTimes(1);
  });

  it("keeps a scenario template reserved when header preparation fails before the provider boundary", async () => {
    const context = {
      ...baseContext,
      temporalDispatchPolicy: undefined,
      scenarioOrigin: { scenarioId: "scenario", actionNodeId: "followup-1" },
      whatsappTemplate: { name: "followup", languageCode: "ru" },
    };
    mockSendTemplate.mockImplementationOnce(async () => {
      expect(getDeliveryOwner()?.temporalDispatch?.state).toBe("reserved");
      throw new Error("Failed to download template header media: HTTP 403");
    });

    await expect(
      sendAndPersistOutbound(context as never)
    ).rejects.toMatchObject({
      code: "AIRI_OUTBOUND_PREPARATION_FAILED",
    });
    expect(getDeliveryOwner()?.temporalDispatch?.state).toBe("reserved");

    const result = await sendAndPersistOutbound(context as never);
    expect(result.temporalDispatch.state).toBe("sent");
    expect(mockSendTemplate).toHaveBeenCalledTimes(2);
  });

  it("cancels a prepared follow-up when the customer replies during header preparation", async () => {
    const captured = {
      ...baseContext.conversation,
      last_inbound_at: "2026-10-09T10:00:00Z",
      airi_scenario_state: {
        lockedScenarioId: "scenario",
        currentActionNodeId: "followup",
        pendingConditionNodeId: "followup-wait",
      },
    };
    mockCurrentConversation.mockReturnValue(captured);
    mockScenarioDeliveryOwnership.mockImplementation(
      jest.requireActual("@icecore/airi-runtime/delivery-gates")
        .resolveScenarioDeliveryOwnership
    );
    let providerPosts = 0;
    mockSendTemplate.mockImplementationOnce(async (...args: unknown[]) => {
      mockCurrentConversation.mockReturnValue({
        ...captured,
        last_inbound_at: "2026-10-09T10:01:00Z",
      });
      await (args[6] as { beforeSend: () => Promise<void> }).beforeSend();
      providerPosts += 1;
      return { messageId: "must-not-send" };
    });
    const context = {
      ...baseContext,
      temporalDispatchPolicy: undefined,
      conversation: captured,
      scenarioOrigin: { scenarioId: "scenario", actionNodeId: "followup" },
      whatsappTemplate: { name: "followup", languageCode: "ru" },
    };

    const result = await sendAndPersistOutbound(context as never);
    expect(providerPosts).toBe(0);
    expect(mockCurrentConversation).toHaveBeenCalledWith({
      _id: "conversation-1",
      workspaceId: "workspace-1",
    });
    expect(result.temporalDispatch.state).toBe("not_attempted");
    expect(result.temporalDispatch.terminalCode).toBe("newer_inbound");
    await sendAndPersistOutbound(context as never);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "initial terminal action",
      state: { lockedScenarioId: "scenario", currentActionNodeId: null },
    },
    {
      label: "non-pending continuation",
      state: {
        lockedScenarioId: "scenario",
        currentActionNodeId: "next-action",
      },
    },
    {
      label: "pending follow-up",
      state: {
        lockedScenarioId: "scenario",
        currentActionNodeId: "followup",
        pendingConditionNodeId: "followup-wait",
      },
    },
  ])(
    "allows a still-owned $label through the actual provider guard",
    async ({ state }) => {
      const captured = {
        ...baseContext.conversation,
        last_inbound_at: "2026-10-09T10:00:00Z",
      };
      mockCurrentConversation.mockReturnValue({
        ...captured,
        airi_scenario_state: state,
      });
      mockScenarioDeliveryOwnership.mockImplementation(
        jest.requireActual("@icecore/airi-runtime/delivery-gates")
          .resolveScenarioDeliveryOwnership
      );
      const result = await sendAndPersistOutbound({
        ...baseContext,
        temporalDispatchPolicy: undefined,
        conversation: captured,
        scenarioOrigin: { scenarioId: "scenario", actionNodeId: "followup" },
        whatsappTemplate: { name: "followup", languageCode: "ru" },
      } as never);
      expect(result.temporalDispatch.state).toBe("sent");
      expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    }
  );

  it("never resends an ordinary scenario template after the provider boundary was crossed", async () => {
    const context = {
      ...baseContext,
      temporalDispatchPolicy: undefined,
      scenarioOrigin: { scenarioId: "scenario", actionNodeId: "followup-1" },
      whatsappTemplate: { name: "followup", languageCode: "ru" },
    };
    mockSendTemplate.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[6] as { beforeSend: () => Promise<void> }).beforeSend();
      expect(getDeliveryOwner()?.temporalDispatch?.state).toBe("dispatching");
      throw new Error("connection reset after provider accepted");
    });

    const first = await sendAndPersistOutbound(context as never);
    const replay = await sendAndPersistOutbound(context as never);
    expect(first.temporalDispatch.state).toBe("outcome_unknown");
    expect(replay.temporalDispatch.state).toBe("outcome_unknown");
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it("allows only one concurrent template preparation to cross the provider boundary", async () => {
    let releasePreparation!: () => void;
    const preparing = new Promise<void>(resolve => {
      releasePreparation = resolve;
    });
    let providerPosts = 0;
    mockSendTemplate.mockImplementation(async (...args: unknown[]) => {
      await preparing;
      await (args[6] as { beforeSend: () => Promise<void> }).beforeSend();
      providerPosts += 1;
      return { messageId: "wamid.template-winner" };
    });
    const context = {
      ...baseContext,
      temporalDispatchPolicy: undefined,
      scenarioOrigin: { scenarioId: "scenario" },
      whatsappTemplate: { name: "followup", languageCode: "ru" },
    };
    const first = sendAndPersistOutbound(context as never);
    const second = sendAndPersistOutbound(context as never);
    await new Promise(resolve => setImmediate(resolve));
    releasePreparation();
    await Promise.all([first, second]);
    expect(providerPosts).toBe(1);
    expect(getDeliveryOwner()?.temporalDispatch?.state).toBe("sent");
  });

  it("preserves template Flow metadata and tracking while using the durable dispatch owner", async () => {
    const result = await sendAndPersistOutbound({
      ...baseContext,
      temporalDispatchPolicy: undefined,
      scenarioOrigin: { scenarioId: "scenario", actionNodeId: "order" },
      whatsappTemplate: { name: "order", languageCode: "ru" },
      whatsappFlowCta: {
        flowId: "123456789",
        flowToken: "flow-token",
        scenarioId: "scenario",
        actionNodeId: "order",
      },
    } as never);

    expect(result.temporalDispatch.state).toBe("sent");
    expect(result.text).toBe(baseContext.content);
    expect(result.whatsappFlow).toMatchObject({
      flowId: "123456789",
      flowToken: "flow-token",
    });
    expect(mockTrackScenarioFlowSent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "123456789",
        flowToken: "flow-token",
        outboundMessageId: "ws_wamid.behavior-template",
      })
    );
  });

  it("refreshes a captured template header at delivery and safely retries catalog unavailability", async () => {
    const freshComponents = [
      {
        type: "header",
        parameters: [
          {
            type: "video",
            video: { link: "https://scontent.whatsapp.net/asset.mp4?fresh=1" },
          },
        ],
      },
    ];
    const context = {
      ...baseContext,
      temporalDispatchPolicy: undefined,
      scenarioOrigin: { scenarioId: "scenario" },
      whatsappTemplate: {
        name: "followup",
        languageCode: "ru",
        components: [],
      },
    };
    mockRefreshTemplateMedia.mockRejectedValueOnce(
      new Error("Template catalog unavailable")
    );

    await expect(
      sendAndPersistOutbound(context as never)
    ).rejects.toMatchObject({
      code: "AIRI_OUTBOUND_PREPARATION_FAILED",
    });
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(getDeliveryOwner()?.temporalDispatch?.state).toBe("reserved");

    mockRefreshTemplateMedia.mockResolvedValueOnce(freshComponents);
    const result = await sendAndPersistOutbound(context as never);
    expect(result.temporalDispatch.state).toBe("sent");
    expect(mockRefreshTemplateMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        templateName: "followup",
        languageCode: "ru",
      })
    );
    expect(mockSendTemplate).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "followup",
      "ru",
      freshComponents,
      expect.objectContaining({ beforeSend: expect.any(Function) })
    );
  });

  it("forces a catalog refresh once for expired media before the message POST", async () => {
    let providerPosts = 0;
    const expired = Object.assign(new Error("media HTTP 403"), {
      code: "WHATSAPP_TEMPLATE_MEDIA_DOWNLOAD_FAILED",
      status: 403,
    });
    mockSendTemplate
      .mockRejectedValueOnce(expired)
      .mockImplementationOnce(async (...args: unknown[]) => {
        await (args[6] as { beforeSend: () => Promise<void> }).beforeSend();
        providerPosts += 1;
        return { messageId: "wamid.refreshed" };
      });
    const context = {
      ...baseContext,
      temporalDispatchPolicy: undefined,
      scenarioOrigin: { scenarioId: "scenario" },
      whatsappTemplate: {
        name: "followup",
        languageCode: "ru",
        components: [],
      },
    };

    const result = await sendAndPersistOutbound(context as never);
    expect(result.temporalDispatch.state).toBe("sent");
    expect(providerPosts).toBe(1);
    expect(mockRefreshTemplateMedia).toHaveBeenCalledTimes(2);
    expect(mockRefreshTemplateMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true })
    );
  });

  it("never refreshes or resends after the message POST boundary even for a download-shaped error", async () => {
    mockSendTemplate.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[6] as { beforeSend: () => Promise<void> }).beforeSend();
      throw Object.assign(new Error("post-boundary failure"), {
        code: "WHATSAPP_TEMPLATE_MEDIA_DOWNLOAD_FAILED",
        status: 403,
      });
    });
    const result = await sendAndPersistOutbound({
      ...baseContext,
      temporalDispatchPolicy: undefined,
      scenarioOrigin: { scenarioId: "scenario" },
      whatsappTemplate: {
        name: "followup",
        languageCode: "ru",
        components: [],
      },
    } as never);
    expect(result.temporalDispatch.state).toBe("outcome_unknown");
    expect(mockRefreshTemplateMedia).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it("retries an explicitly rejected service message under its existing durable owner", async () => {
    const rejected = new MetaGraphRequestError({
      message: "Meta could not send",
      status: 500,
      statusText: "Internal Server Error",
      url: "https://graph.facebook.com/v25.0/phone/messages",
      details: { error: { code: 131000, message: "Something went wrong" } },
    });
    mockSendWhatsappInteractiveReplyButtonsMessage.mockRejectedValueOnce(
      rejected
    );
    const context = {
      ...baseContext,
      temporalDispatchPolicy: undefined,
      scenarioOrigin: { scenarioId: "scenario", actionNodeId: "ortecke" },
      whatsappServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "yes", label: "Yes" }],
        },
      },
    };

    await expect(
      sendAndPersistOutbound(context as never)
    ).rejects.toMatchObject({
      code: "AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE",
    });
    expect(getDeliveryOwner()?.temporalDispatch?.state).toBe("reserved");
    const result = await sendAndPersistOutbound(context as never);
    expect(result.temporalDispatch.state).toBe("sent");
    expect(result.whatsappServiceMessage).toMatchObject({
      kind: "reply_buttons",
    });
    expect(
      mockSendWhatsappInteractiveReplyButtonsMessage
    ).toHaveBeenCalledTimes(2);
  });

  it("retains explicit provider rejection evidence through the Flow error boundary", async () => {
    mockSendWhatsappInteractiveFlow.mockRejectedValueOnce(
      new MetaGraphRequestError({
        message: "Something went wrong",
        status: 500,
        statusText: "Server Error",
        url: "https://graph.facebook.com/v25.0/phone/messages",
        details: { error: { code: 131000 } },
      })
    );
    await expect(
      sendAndPersistOutbound({
        ...baseContext,
        temporalDispatchPolicy: undefined,
        scenarioOrigin: { scenarioId: "scenario" },
        whatsappServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Open" },
            flowConfig: {
              templateId: "flow",
              screens: [],
              metaFlowId: "123456789",
              ctaText: "Open",
            },
          },
        },
      } as never)
    ).rejects.toMatchObject({
      code: "AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE",
    });
    expect(getDeliveryOwner()?.temporalDispatch?.state).toBe("reserved");
  });

  it.each([
    new Error("timeout after provider accepted"),
    new MetaGraphRequestError({
      message: "body unavailable",
      status: 200,
      statusText: "OK",
      url: "https://graph.facebook.com/v25.0/phone/messages",
      details: { reason: "response_body_unavailable" },
    }),
    new MetaGraphRequestError({
      message: "not allowed",
      status: 400,
      statusText: "Bad Request",
      url: "https://graph.facebook.com/v25.0/phone/messages",
      details: { error: { code: 131047 } },
    }),
    new MetaGraphRequestError({
      message: "conflicting receipt",
      status: 500,
      statusText: "Server Error",
      url: "https://graph.facebook.com/v25.0/phone/messages",
      details: {
        error: { code: 131000 },
        messages: [{ id: "wamid.accepted" }],
      },
    }),
  ])(
    "never retries service message failure without explicit safe rejection evidence: %s",
    async error => {
      mockSendWhatsappInteractiveReplyButtonsMessage.mockRejectedValueOnce(
        error
      );
      const context = {
        ...baseContext,
        temporalDispatchPolicy: undefined,
        scenarioOrigin: { scenarioId: "scenario" },
        whatsappServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [{ id: "yes", label: "Yes" }],
          },
        },
      };
      const first = await sendAndPersistOutbound(context as never);
      const replay = await sendAndPersistOutbound(context as never);
      expect(first.temporalDispatch.state).toBe("outcome_unknown");
      expect(replay.temporalDispatch.state).toBe("outcome_unknown");
      expect(
        mockSendWhatsappInteractiveReplyButtonsMessage
      ).toHaveBeenCalledTimes(1);
    }
  );

  it("leaves transient preparation failures reserved so a retry can send once", async () => {
    mockCheckMessagingWindowForConversation.mockRejectedValueOnce(
      new Error("temporary database timeout")
    );

    await expect(sendAndPersistOutbound(baseContext as never)).rejects.toThrow(
      "temporary database timeout"
    );

    const reserved = getDeliveryOwner();
    expect(reserved?.temporalDispatch?.state).toBe("reserved");
    expect(reserved).not.toHaveProperty("workspaceId");
    expect(reserved).not.toHaveProperty("channel");
    expect(reserved).not.toHaveProperty("date");
    expect(reserved).not.toHaveProperty("conversation");
    expect(reserved).not.toHaveProperty("direction");
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();

    const result = await sendAndPersistOutbound(baseContext as never);

    expect(mockSendWhatsappMessage).toHaveBeenCalledTimes(1);
    expect(result.temporalDispatch.state).toBe("sent");
    expect(result.workspaceId).toBe(baseContext.workspaceId);
    expect(result.channel).toBe(baseContext.type);
    expect(result.conversation).toBe(baseContext.conversation._id);
    expect(result.direction).toBe("outbound");
    expect(result.date).toBeInstanceOf(Date);
  });

  it("allows only one concurrent reserved-to-dispatching winner to call Meta", async () => {
    let releaseProvider!: () => void;
    const providerPending = new Promise<void>(resolve => {
      releaseProvider = resolve;
    });
    mockSendWhatsappMessage.mockImplementationOnce(async () => {
      await providerPending;
      return { messageId: "wamid.provider-1" };
    });

    const first = sendAndPersistOutbound(baseContext as never);
    await new Promise(resolve => setImmediate(resolve));
    const secondResult = await sendAndPersistOutbound(baseContext as never);
    expect(secondResult.temporalDispatch.state).toBe("dispatching");
    releaseProvider();

    const firstResult = await first;
    expect(mockSendWhatsappMessage).toHaveBeenCalledTimes(1);
    expect(firstResult.temporalDispatch.state).toBe("sent");
  });

  it("recovers the same sent owner and provider receipt without resending", async () => {
    const first = await sendAndPersistOutbound(baseContext as never);
    const replay = await sendAndPersistOutbound(baseContext as never);

    expect(mockSendWhatsappMessage).toHaveBeenCalledTimes(1);
    expect(String(replay._id)).toBe(String(first._id));
    expect(replay.messageId).toBe(first.messageId);
    expect(replay.temporalDispatch.state).toBe("sent");
    expect(first.temporalDeliveryKey).toBe("delivery-key-1");
    const MessageModel = jest.requireMock("@/models/message").default;
    expect(MessageModel.findOne).toHaveBeenCalledWith({
      $or: [
        { _id: "507f1f77bcf86cd799439011" },
        { temporalDeliveryKey: { $eq: "delivery-key-1", $type: "string" } },
      ],
    });
    expect(MessageModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        temporalDeliveryKey: { $eq: "delivery-key-1", $type: "string" },
        "temporalDispatch.state": "reserved",
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it("classifies a closed service window as not_attempted before Meta", async () => {
    mockCheckMessagingWindowForConversation.mockResolvedValue({
      isWithinWindow: false,
    });

    const result = await sendAndPersistOutbound(baseContext as never);

    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(result.temporalDispatch.state).toBe("not_attempted");
    expect(result.temporalDispatch.terminalCode).toBe("service_window_closed");
  });

  it("classifies an exception after dispatch permission as outcome_unknown", async () => {
    mockSendWhatsappMessage.mockRejectedValueOnce(
      new Error("provider connection reset")
    );

    const first = await sendAndPersistOutbound(baseContext as never);
    const replay = await sendAndPersistOutbound(baseContext as never);

    expect(mockSendWhatsappMessage).toHaveBeenCalledTimes(1);
    expect(first.temporalDispatch.state).toBe("outcome_unknown");
    expect(replay.temporalDispatch.state).toBe("outcome_unknown");
  });

  it("never calls Meta when replaying an in-flight dispatch", async () => {
    const MessageModel = jest.requireMock("@/models/message").default;
    const owner = new MessageModel({
      ...baseContext,
      _id: baseContext.temporalReservedMessageId,
      direction: "outbound",
      temporalDispatch: {
        version: 1,
        state: "dispatching",
        deliveryKey: baseContext.temporalDeliveryKey,
        attemptToken: "attempt-1",
        claimedAt: new Date(),
      },
    });
    await owner.save();

    const result = await sendAndPersistOutbound(baseContext as never);

    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(result.temporalDispatch.state).toBe("dispatching");
  });

  it("rejects a legacy multi-provider fallback payload before claiming", async () => {
    mockSendWhatsappInteractiveReplyButtons.mockRejectedValueOnce(
      new Error("ambiguous interactive transport failure")
    );

    const result = await sendAndPersistOutbound({
      ...baseContext,
      groundedReplyOptions: [
        {
          id: "option-1",
          callbackKey: "gqr_0",
          label: "Option 1",
          sourceKind: "kb",
          sourceIds: ["kb-1"],
        },
      ],
    } as never);

    expect(mockSendWhatsappInteractiveReplyButtons).not.toHaveBeenCalled();
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(result.temporalDispatch.state).toBe("not_attempted");
    expect(result.temporalDispatch.terminalCode).toBe(
      "unsupported_strict_payload"
    );
  });

  it("fails closed when reserved id and delivery key do not identify one owner", async () => {
    const MessageModel = jest.requireMock("@/models/message").default;
    const collision = new MessageModel({
      _id: baseContext.temporalReservedMessageId,
      workspaceId: "workspace-1",
      channel: "whatsapp",
      date: new Date(),
      temporalDeliveryKey: "other-delivery-key",
      temporalDispatch: {
        version: 1,
        state: "reserved",
        deliveryKey: "other-delivery-key",
        attemptToken: "attempt-collision",
      },
    });
    await collision.save();

    await expect(sendAndPersistOutbound(baseContext as never)).rejects.toThrow(
      "identity"
    );
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
  });

  it("preserves the existing default dispatch-before-persist behavior", async () => {
    mockSendWhatsappMessage.mockImplementationOnce(async () => {
      expect(storedMessages.size).toBe(0);
      return { messageId: "wamid.default" };
    });

    const result = await sendAndPersistOutbound({
      ...baseContext,
      temporalDeliveryKey: undefined,
      temporalReservedMessageId: undefined,
      temporalDispatchPolicy: undefined,
    } as never);

    expect(result.temporalDispatch).toBeUndefined();
    expect(mockSendWhatsappMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps private dispatch state excluded from customer projections", () => {
    const ActualMessageModel = jest.requireActual("@/models/message").default;
    expect(
      ActualMessageModel.schema.path("temporalDispatch")?.options.select
    ).toBe(false);
  });

  it("requires a date for normal messages but permits a private unsent owner without one", () => {
    const ActualMessageModel = jest.requireActual("@/models/message").default;
    const normalMessage = new ActualMessageModel({
      workspaceId: "workspace-1",
      direction: "outbound",
    });
    const reservedOwner = new ActualMessageModel({
      temporalDeliveryKey: "delivery-key-schema",
      temporalDispatch: {
        version: 1,
        state: "reserved",
        deliveryKey: "delivery-key-schema",
        attemptToken: "attempt-schema",
      },
    });

    expect(normalMessage.validateSync()?.errors.date).toBeDefined();
    expect(normalMessage.channel).toBe("telegram");
    expect(reservedOwner.validateSync()?.errors.date).toBeUndefined();
    expect(reservedOwner.workspaceId).toBeUndefined();
    expect(reservedOwner.channel).toBeUndefined();
    expect(reservedOwner.date).toBeUndefined();
    expect(reservedOwner.conversation).toBeUndefined();
    expect(reservedOwner.direction).toBeUndefined();
  });
});

describe("Telegram delivery of a captured reply", () => {
  const previousEncryptionSecret = process.env.ENCRYPTION_SECRET;
  const telegramContext = {
    type: "telegram",
    workspaceId: "workspace-1",
    conversation: {
      _id: "conversation-1",
      sourceId: "telegram-source-1",
      workspaceId: "workspace-1",
    },
    chatDocument: { _id: "chat-1", sourceId: "telegram-source-1" },
    chatId: "12345",
    content: "Hello from the tenant bot",
  };

  beforeAll(() => {
    process.env.ENCRYPTION_SECRET = "local-test-encryption-only";
  });

  afterAll(() => {
    if (previousEncryptionSecret === undefined) {
      delete process.env.ENCRYPTION_SECRET;
    } else {
      process.env.ENCRYPTION_SECRET = previousEncryptionSecret;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    storedMessages.clear();
    mockReserveTemporalOutboundDispatch.mockImplementation(() => {
      throw new Error("Temporal outbound capture is not active");
    });
    mockFindOneAndUpdateUser.mockReturnValue({
      exec: jest.fn(async () => ({ _id: "airi-bot" })),
    });
    mockAppendMessageToConversationById.mockResolvedValue(undefined);
    mockTriggerRealtimeEvent.mockResolvedValue(undefined);
    jest
      .mocked(sendTelegramMessage)
      .mockResolvedValue({ messageId: 77, date: 1793000000 } as never);
  });

  it("re-reads and decrypts the bot token, since the captured context has none", async () => {
    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ok: true,
      source: {
        id: "telegram-source-1",
        type: "telegram",
        workspace_id: "workspace-1",
        credentials: { bot_token: encryptString("123:tenant-bot") },
      },
    });

    await sendAndPersistOutbound({ ...telegramContext } as never);

    expect(mockFetchSourceWithCredentialsResult).toHaveBeenCalledWith(
      "telegram-source-1",
      "telegram"
    );
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      "12345",
      expect.any(String),
      expect.objectContaining({ botToken: "123:tenant-bot" })
    );
  });

  it("fails the send instead of using the platform bot when the saved token cannot be decrypted", async () => {
    const sealed = encryptString("123:other-key");
    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ok: true,
      source: {
        id: "telegram-source-1",
        type: "telegram",
        workspace_id: "workspace-1",
        credentials: { bot_token: sealed },
      },
    });
    process.env.ENCRYPTION_SECRET = "a-different-key";

    try {
      await expect(
        sendAndPersistOutbound({ ...telegramContext } as never)
      ).rejects.toThrow("Telegram bot token could not be decrypted");
    } finally {
      process.env.ENCRYPTION_SECRET = "local-test-encryption-only";
    }
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("fails the send instead of using the platform bot when the source cannot be read", async () => {
    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ok: false,
      error: new Error("sources query timed out"),
    });

    await expect(
      sendAndPersistOutbound({ ...telegramContext } as never)
    ).rejects.toThrow("Telegram bot token could not be loaded");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});
