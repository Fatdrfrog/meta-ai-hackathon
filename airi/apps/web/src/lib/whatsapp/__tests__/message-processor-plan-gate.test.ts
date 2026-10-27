// Drives the real processWhatsAppMessage against mocked models to prove the
// injected new-conversation plan gate runs inside the conversation create:
// a refused create is a typed skip that writes no Conversation, Message or
// media, and an existing conversation never consults the plan.
let mockSelectedConversation: Record<string, unknown> | null = null;
const mockConversationConstructed = jest.fn();
const mockConversationSave = jest.fn();
const mockMessageSave = jest.fn();
const mockAppendMessage = jest.fn();
const mockHandleWhatsAppMedia = jest.fn();
const mockQuery = (value: unknown) => ({
  select: () => mockQuery(value),
  limit: () => mockQuery(value),
  populate: () => mockQuery(value),
  lean: async () => value,
  then: (
    resolve: (value: unknown) => unknown,
    reject: (error: unknown) => unknown
  ) => Promise.resolve(value).then(resolve, reject),
});
const mockFindIdentity = () => mockQuery([]);

// Hoisted factories run while the imports below load, so they may only
// reference the values above lazily, inside functions.
jest.mock("@icecore/airi-runtime/mongoose", () => ({
  __esModule: true,
  default: async () => undefined,
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: class {
    $locals = {};
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
    }
    async save() {
      Object.assign(this, { _id: "new-message" });
      mockMessageSave(this);
    }
    static findOne() {
      return mockQuery(null);
    }
    static findById() {
      return mockQuery(null);
    }
    static findOneAndUpdate() {
      return mockQuery(null);
    }
  },
}));
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    find: () => mockFindIdentity(),
    findOneAndUpdate: () => ({
      exec: async () => ({ _id: "wa_70000000000", isBot: false }),
    }),
  },
}));
jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {
    find: () => mockFindIdentity(),
    findOneAndUpdate: async () => ({ _id: "wa_70000000000" }),
    findById: async () => ({
      _id: "wa_70000000000",
      workspaceId: "workspace-1",
    }),
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: class {
    _id = "new-conversation";
    constructor(data: Record<string, unknown>) {
      mockConversationConstructed(data);
      Object.assign(this, data);
    }
    async save() {
      mockConversationSave(this);
    }
    static findById() {
      return mockQuery(null);
    }
    static async updateOne() {
      return { modifiedCount: 1 };
    }
    static async findOneAndUpdate() {
      return null;
    }
  },
}));
// Mirrors the ownership helper: an existing owner wins, and a create that
// returns null yields a null owner.
jest.mock("@/lib/whatsapp/conversation-lookup", () => ({
  getOrCreateWhatsAppConversation: async ({
    create,
  }: {
    create: (key: string, aliases: string[]) => Promise<unknown>;
  }) => {
    if (mockSelectedConversation) {
      return { conversation: mockSelectedConversation, created: false };
    }
    const conversation = await create("test-identity-key", [
      "test-identity-key",
    ]);
    return conversation ? { conversation, created: true } : null;
  },
}));
jest.mock("@/models/whatsapp-pending-message-mutation", () => ({
  __esModule: true,
  default: {
    find: () => ({ sort: () => ({ lean: async () => [] }) }),
  },
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessage(...args),
}));
jest.mock("@/lib/whatsapp/identity/indexes", () => ({
  ensureWhatsAppIdentityIndexes: async () => undefined,
}));
jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotRuntimeSettings: async () => ({}),
}));
jest.mock("@/lib/posthog/server", () => ({ getPostHogClient: () => null }));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/media/handler", () => ({
  handleWhatsAppMedia: (...args: unknown[]) => mockHandleWhatsAppMedia(...args),
}));

import { processWhatsAppMessage } from "@icecore/airi-runtime/whatsapp-message-processor";
import {
  WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
  WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
  buildWhatsAppPlanSkippedProcessResult,
  resolveWhatsAppNewConversationPlanSkip,
} from "@icecore/airi-runtime/whatsapp-intake-plan-gate";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";

const capSkip = resolveWhatsAppNewConversationPlanSkip({
  trialExpired: false,
  newConversationsAllowed: false,
})!;
const trialSkip = resolveWhatsAppNewConversationPlanSkip({
  trialExpired: true,
  newConversationsAllowed: false,
})!;

// An image with an access token and no deferred hydration downloads eagerly,
// as echoes and history do.
const imageMessage = {
  id: "wamid.image-1",
  timestamp: "1786348800",
  type: "image" as const,
  image: { id: "media-1", mime_type: "image/jpeg" },
};

function processImage(
  overrides: Partial<Parameters<typeof processWhatsAppMessage>[0]> = {}
) {
  return processWhatsAppMessage({
    messageData: imageMessage,
    contactData: {
      waId: "70000000000",
      profile: { name: "Customer" },
      primaryIdType: "wa_id",
    },
    phoneNumberId: "phone-1",
    accessToken: "access-token",
    workspaceId: "workspace-1",
    direction: "inbound",
    sourceId: "source-1",
    messageDate: new Date("2026-10-18T00:00:00Z"),
    deferReferralEnrichment: true,
    getNewConversationPlanSkip: null,
    ...overrides,
  });
}

describe("processWhatsAppMessage new-conversation plan gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedConversation = null;
    mockAppendMessage.mockResolvedValue({
      appended: true,
      revision: 1,
      generation: 1,
    });
    mockHandleWhatsAppMedia.mockResolvedValue({
      publicUrl: "https://storage.example/media-1.jpg",
      size: 10,
    });
  });

  it("refuses a new conversation at the cap with a typed skip and writes nothing", async () => {
    const gate = jest.fn(async () => capSkip);

    const result = await processImage({ getNewConversationPlanSkip: gate });

    expect(result).toEqual(buildWhatsAppPlanSkippedProcessResult(capSkip));
    expect(result.planSkip?.reason).toBe(
      WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON
    );
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      itemKind: "new_conversation",
    });
    expect(mockConversationConstructed).not.toHaveBeenCalled();
    expect(mockConversationSave).not.toHaveBeenCalled();
    expect(mockMessageSave).not.toHaveBeenCalled();
    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockHandleWhatsAppMedia).not.toHaveBeenCalled();
  });

  it("asks for history imports as history_message and skips them the same way", async () => {
    const gate = jest.fn(async () => trialSkip);

    const result = await processImage({
      importMode: "history",
      rawSourcePayload: buildRawSourcePayload({
        provider: "whatsapp",
        eventType: "history_message",
        payload: {},
      }),
      getNewConversationPlanSkip: gate,
    });

    expect(result.processedAs).toBe("plan_skipped");
    expect(result.planSkip?.reason).toBe(WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON);
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ itemKind: "history_message" })
    );
    expect(mockConversationConstructed).not.toHaveBeenCalled();
    expect(mockMessageSave).not.toHaveBeenCalled();
    expect(mockHandleWhatsAppMedia).not.toHaveBeenCalled();
  });

  it("appends to an existing conversation without consulting the plan", async () => {
    mockSelectedConversation = {
      _id: "existing-conversation",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      chat: "wa_70000000000",
      status: "open",
      save: jest.fn(),
    };
    const gate = jest.fn(async () => capSkip);

    const result = await processImage({ getNewConversationPlanSkip: gate });

    expect(gate).not.toHaveBeenCalled();
    expect(result.processedAs).toBeUndefined();
    expect(result.conversationId).toBe("existing-conversation");
    expect(result.isNewConversation).toBe(false);
    expect(result.messageWasNew).toBe(true);
    expect(mockConversationConstructed).not.toHaveBeenCalled();
    expect(mockMessageSave).toHaveBeenCalledTimes(1);
    expect(mockHandleWhatsAppMedia).toHaveBeenCalledTimes(1);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      "existing-conversation",
      "new-message",
      expect.objectContaining({ direction: "inbound" })
    );
  });

  it("creates the conversation when the plan allows it", async () => {
    const gate = jest.fn(async () => null);

    const result = await processImage({ getNewConversationPlanSkip: gate });

    expect(gate).toHaveBeenCalledTimes(1);
    expect(result.isNewConversation).toBe(true);
    expect(result.conversationId).toBe("new-conversation");
    expect(mockConversationSave).toHaveBeenCalledTimes(1);
    expect(mockMessageSave).toHaveBeenCalledTimes(1);
    expect(mockHandleWhatsAppMedia).toHaveBeenCalledTimes(1);
  });
});
