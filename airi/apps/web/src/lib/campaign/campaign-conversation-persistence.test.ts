const mockAppendMessageToConversationById = jest.fn();
const mockConnectDB = jest.fn();
const mockFindOrCreateEmailConversation = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockTriggerConversationChanged = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageCreate = jest.fn();
const mockMessageFindById = jest.fn();
const mockChatFindOneAndUpdate = jest.fn();
const mockConversationFindOne = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockUserFindOneAndUpdate = jest.fn();
const mockWhatsAppTemplateFindOne = jest.fn();
const mockMessageConstruct = jest.fn();

// Ownership races are covered against Mongo in conversation-ownership.integration;
// this suite exercises campaign behavior with the existing canonical lookup seam.
jest.mock("@/lib/whatsapp/conversation-lookup", () => {
  const actual = jest.requireActual("@/lib/whatsapp/conversation-lookup");
  return {
    ...actual,
    getOrCreateWhatsAppConversation: async (params: {
      candidateIds: string[];
      create: (key: string) => Promise<unknown>;
    }) => {
      const conversation =
        await actual.findExistingWhatsAppConversationByIdentity({
          ...params,
          candidateIds: params.candidateIds.flatMap(
            actual.resolveWhatsAppConversationIdentityCandidates
          ),
        });
      return conversation
        ? { conversation, created: false }
        : {
            conversation: await params.create("test-identity-key"),
            created: true,
          };
    },
  };
});

jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessageToConversationById(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/email/threading", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFindOrCreateEmailConversation(...args),
  findOrCreateEmailConversation: (...args: unknown[]) =>
    mockFindOrCreateEmailConversation(...args),
}));

jest.mock("@/lib/realtime/server", () => ({
  Realtime: {
    trigger: (...args: unknown[]) => mockRealtimeTrigger(...args),
  },
}));

jest.mock("@/lib/realtime-updates", () => ({
  triggerConversationChanged: (...args: unknown[]) =>
    mockTriggerConversationChanged(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE:
    "company_conversation_limit_exceeded",
  assertCompanyConversationCapacity: jest.fn(),
  isCompanyConversationLimitExceeded: jest.fn(() => false),
}));

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotDefault: jest.fn(),
  getWorkspaceCoachDefault: jest.fn(),
  getWorkspaceScenariosDefault: jest.fn(),
}));

jest.mock("@icecore/shared/lib/whatsapp/contact-identities", () => ({
  buildWhatsAppCanonicalIdFromPhone: jest.fn(),
  normalizeWhatsAppPhone: jest.fn(),
  listWhatsAppPhoneIdentityVariants: jest.fn(),
  parseWhatsAppRecipientTarget: jest.fn(),
}));

jest.mock("@icecore/shared/lib/whatsapp/identity-snapshot", () => ({
  buildWhatsAppIdentitySnapshot: jest.fn(),
}));

jest.mock("@/lib/whatsapp/templates/preview", () => ({
  buildStoredWhatsAppTemplatePreview: jest.fn(),
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockChatFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: Object.assign(
    function MockConversation(
      this: Record<string, unknown>,
      data: Record<string, unknown>
    ) {
      Object.assign(this, data);
      this._id = "conversation-1";
      this.save = jest.fn().mockResolvedValue(this);
    },
    {
      findOne: (...args: unknown[]) => mockConversationFindOne(...args),
    find: (filter: Record<string, unknown>) => ({ select: () => ({ sort: () => ({ limit: async () => {
      if (!filter.chat && !filter.user) return [];
      if (filter.whatsappConversationIdentityKey || filter.$or || filter["airi_scenario_state.lockedScenarioId"]) return [];
      const result = await mockConversationFindOne(filter)?.sort();
      return result ? [result] : [];
    } }) }) }),
      updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
    }
  ),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: Object.assign(
    function MockMessage(
      this: Record<string, unknown>,
      payload: Record<string, unknown>
    ) {
      mockMessageConstruct(payload);
      Object.assign(this, payload);
      this._id = "message-1";
      this.save = jest.fn().mockResolvedValue(this);
    },
    {
      findOne: (...args: unknown[]) => mockMessageFindOne(...args),
      create: (...args: unknown[]) => mockMessageCreate(...args),
      findById: (...args: unknown[]) => mockMessageFindById(...args),
    }
  ),
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockUserFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    findOne: (...args: unknown[]) => mockWhatsAppTemplateFindOne(...args),
  },
}));

import {
  persistCampaignEmailConversationMessage,
  persistCampaignWhatsAppConversationMessage,
} from "./campaign-conversation-persistence";
import { readScenarioFormSubmissions } from "@icecore/scenario-contracts";
import { Types } from "mongoose";

function findOneResult<T>(value: T) {
  return {
    sort: jest.fn().mockResolvedValue(value),
  };
}

describe("persistCampaignEmailConversationMessage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOrCreateEmailConversation.mockResolvedValue({
      _id: "conversation-1",
    });
    mockMessageFindOne.mockResolvedValue(null);
    mockMessageCreate.mockResolvedValue({ _id: "message-1" });
    mockMessageFindById.mockReturnValue({
      populate: jest.fn().mockResolvedValue({ _id: "message-1" }),
    });
    mockAppendMessageToConversationById.mockResolvedValue(undefined);
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockTriggerConversationChanged.mockResolvedValue(undefined);
    mockChatFindOneAndUpdate.mockResolvedValue({ _id: "wa_77001234567" });
    mockConversationFindOne.mockReset();
    mockConversationUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockUserFindOneAndUpdate.mockResolvedValue({
      _id: "whatsapp_business_phone-number-1",
    });
    mockWhatsAppTemplateFindOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    });

    const contactIdentities = jest.requireMock(
      "@icecore/shared/lib/whatsapp/contact-identities"
    );
    contactIdentities.parseWhatsAppRecipientTarget.mockReturnValue(null);
    contactIdentities.normalizeWhatsAppPhone.mockImplementation(
      (value: unknown) => {
        const digits = String(value || "").replace(/\D+/g, "");
        if (digits.length < 6) return undefined;
        if (/^8\d{10}$/.test(digits)) return `7${digits.slice(1)}`;
        return digits;
      }
    );
    contactIdentities.listWhatsAppPhoneIdentityVariants.mockImplementation(
      (value: unknown) => {
        const digits = String(value || "").replace(/\D+/g, "");
        if (digits.length < 6) return [];
        const canonical = /^8\d{10}$/.test(digits)
          ? `7${digits.slice(1)}`
          : digits;
        const variants = [canonical];
        if (/^7\d{10}$/.test(canonical)) {
          variants.push(`8${canonical.slice(1)}`);
        }
        if (!variants.includes(digits)) variants.push(digits);
        return variants;
      }
    );
    contactIdentities.buildWhatsAppCanonicalIdFromPhone.mockImplementation(
      (phone: string) => `wa_${phone}`
    );

    const identitySnapshot = jest.requireMock(
      "@icecore/shared/lib/whatsapp/identity-snapshot"
    );
    identitySnapshot.buildWhatsAppIdentitySnapshot.mockReturnValue({
      waId: "77001234567",
      primaryIdType: "wa_id",
    });

    const templatePreview = jest.requireMock(
      "@/lib/whatsapp/templates/preview"
    );
    templatePreview.buildStoredWhatsAppTemplatePreview.mockReturnValue({
      name: "hello_world",
    });
  });

  it("stores successful bulk emails as read outbound conversation messages", async () => {
    const result = await persistCampaignEmailConversationMessage({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      scenarioId: "scenario-1",
      nodeId: "node-1",
      executionSource: "ad_hoc",
      originKind: "campaign",
      recipientEmail: "Alice@Example.com",
      fromAddress: "Sender@Airi.chat",
      messageId: "bulk:message-1",
      subject: "Hello Alice",
      text: "Hi Alice",
      html: "<p>Hi Alice</p>",
      sentByUserId: "manager-1",
      sentAt: "2026-06-03T14:51:24.000Z",
    });

    expect(result).toEqual({
      persisted: true,
      conversationId: "conversation-1",
      messageId: "bulk:message-1",
      created: true,
    });
    expect(mockFindOrCreateEmailConversation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      to: ["alice@example.com"],
      from: ["sender@airi.chat"],
      subject: "Hello Alice",
      headers: {},
    });
    expect(mockMessageFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channel: "email",
      "external_ids.messageId": "bulk:message-1",
    });
    expect(mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        conversation: "conversation-1",
        channel: "email",
        direction: "outbound",
        subject: "Hello Alice",
        text: "Hi Alice",
        html: "<p>Hi Alice</p>",
        headers: {},
        external_ids: { messageId: "bulk:message-1" },
        origin: expect.objectContaining({
          kind: "campaign",
          campaignId: "campaign-1",
          scenarioId: "scenario-1",
          nodeId: "node-1",
          executionSource: "ad_hoc",
          sentByUserId: "manager-1",
        }),
        delivery: expect.objectContaining({
          status: "sent",
          recipientId: "alice@example.com",
        }),
      })
    );
    expect(mockAppendMessageToConversationById).toHaveBeenCalledWith(
      "conversation-1",
      "message-1",
      expect.objectContaining({
        set: expect.objectContaining({
          is_read_by_manager: true,
        }),
      })
    );
    expect(
      mockAppendMessageToConversationById.mock.calls[0]?.[2]?.set
    ).not.toHaveProperty("is_classified");
  });

  it("is idempotent for the same provider correlation message id", async () => {
    const existingDate = new Date("2026-06-03T14:51:24.000Z");
    mockMessageFindOne.mockResolvedValue({
      _id: "existing-message-1",
      conversation: "conversation-1",
      date: existingDate,
    });

    const result = await persistCampaignEmailConversationMessage({
      workspaceId: "workspace-1",
      recipientEmail: "alice@example.com",
      fromAddress: "sender@airi.chat",
      messageId: "bulk:message-1",
      subject: "Hello Alice",
      sentAt: "2026-06-03T14:52:00.000Z",
    });

    expect(result).toEqual({
      persisted: true,
      conversationId: "conversation-1",
      messageId: "bulk:message-1",
      created: false,
    });
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockAppendMessageToConversationById).toHaveBeenCalledWith(
      "conversation-1",
      "existing-message-1",
      expect.objectContaining({
        lastMessageAt: existingDate,
        set: expect.objectContaining({
          is_read_by_manager: true,
        }),
      })
    );
  });
});

describe("persistCampaignWhatsAppConversationMessage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockMessageFindOne.mockResolvedValue(null);
    mockMessageFindById.mockReturnValue({
      populate: jest.fn().mockResolvedValue({ _id: "message-1" }),
    });
    mockAppendMessageToConversationById.mockResolvedValue(undefined);
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockTriggerConversationChanged.mockResolvedValue(undefined);
    mockUserFindOneAndUpdate.mockResolvedValue({
      _id: "whatsapp_business_phone-number-1",
    });

    const contactIdentities = jest.requireMock(
      "@icecore/shared/lib/whatsapp/contact-identities"
    );
    contactIdentities.parseWhatsAppRecipientTarget.mockReturnValue(null);
    contactIdentities.normalizeWhatsAppPhone.mockImplementation(
      (value: unknown) => {
        const digits = String(value || "").replace(/\D+/g, "");
        if (digits.length < 6) return undefined;
        if (/^8\d{10}$/.test(digits)) return `7${digits.slice(1)}`;
        return digits;
      }
    );
    contactIdentities.listWhatsAppPhoneIdentityVariants.mockImplementation(
      (value: unknown) => {
        const digits = String(value || "").replace(/\D+/g, "");
        if (digits.length < 6) return [];
        const canonical = /^8\d{10}$/.test(digits)
          ? `7${digits.slice(1)}`
          : digits;
        const variants = [canonical];
        if (/^7\d{10}$/.test(canonical)) {
          variants.push(`8${canonical.slice(1)}`);
        }
        if (!variants.includes(digits)) variants.push(digits);
        return variants;
      }
    );
    contactIdentities.buildWhatsAppCanonicalIdFromPhone.mockImplementation(
      (phone: string) => `wa_${phone}`
    );

    const templatePreview = jest.requireMock(
      "@/lib/whatsapp/templates/preview"
    );
    templatePreview.buildStoredWhatsAppTemplatePreview.mockReturnValue({
      name: "hello_world",
    });
  });

  it("reopens a closed canonical owner without clearing scenario state or handoff", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const scenarioState = { lockedScenarioId: "active-scenario" };
    const conversation = { _id: "conversation-1", chat: "wa_77001234567", user: "wa_77001234567", status: "closed", airi_handoff_active: true, airi_scenario_state: scenarioState, save };
    mockConversationFindOne.mockReturnValueOnce(findOneResult(conversation));
    await persistCampaignWhatsAppConversationMessage({ workspaceId: "workspace-1", sourceId: "source-1", phoneNumberId: "phone-number-1", recipientPhone: "77001234567", messageId: "wamid.reopen", whatsappMessageType: "service_text", messageText: "Hello", campaignId: "campaign-1", sentAt: "2026-07-28T08:00:00.000Z" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(conversation.status).toBe("open");
    expect(conversation.airi_handoff_active).toBe(true);
    expect(conversation.airi_scenario_state).toBe(scenarioState);
  });

  it("reuses one batch's author and template lookups across its recipients", async () => {
    const lookupCache = { authors: new Map(), templateComponents: new Map() };
    for (const [index, phone] of ["77001234567", "77001234568"].entries()) {
      mockConversationFindOne.mockReturnValueOnce(
        findOneResult({
          _id: `conversation-${index}`,
          chat: `wa_${phone}`,
          user: `wa_${phone}`,
        })
      );
      const result = await persistCampaignWhatsAppConversationMessage({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        phoneNumberId: "phone-number-1",
        recipientPhone: phone,
        messageId: `wamid.batch-${index}`,
        templateName: "hello_world",
        languageCode: "ru",
        campaignId: "campaign-1",
        sentAt: "2026-07-28T08:00:00.000Z",
        lookupCache,
      });
      expect(result.persisted).toBe(true);
    }

    expect(mockUserFindOneAndUpdate).toHaveBeenCalledTimes(1);
    // An exact-language miss falls back once; the batch reuses that answer.
    expect(mockWhatsAppTemplateFindOne).toHaveBeenCalledTimes(2);
    expect(mockMessageConstruct).toHaveBeenCalledTimes(2);
  });

  it("looks up the author and template again without a batch cache", async () => {
    for (const index of [0, 1]) {
      mockConversationFindOne.mockReturnValueOnce(
        findOneResult({
          _id: "conversation-1",
          chat: "wa_77001234567",
          user: "wa_77001234567",
        })
      );
      await persistCampaignWhatsAppConversationMessage({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        phoneNumberId: "phone-number-1",
        recipientPhone: "77001234567",
        messageId: `wamid.uncached-${index}`,
        templateName: "hello_world",
        campaignId: "campaign-1",
        sentAt: "2026-07-28T08:00:00.000Z",
      });
    }
    expect(mockUserFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("drops a failed lookup from the batch cache so the next recipient retries it", async () => {
    const lookupCache = { authors: new Map(), templateComponents: new Map() };
    mockUserFindOneAndUpdate.mockRejectedValueOnce(new Error("Mongo unavailable"));
    mockConversationFindOne.mockReturnValue(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
      })
    );
    const params = {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      recipientPhone: "77001234567",
      templateName: "hello_world",
      campaignId: "campaign-1",
      sentAt: "2026-07-28T08:00:00.000Z",
      lookupCache,
    };

    await expect(
      persistCampaignWhatsAppConversationMessage({
        ...params,
        messageId: "wamid.retry-0",
      })
    ).rejects.toThrow("Mongo unavailable");
    await expect(
      persistCampaignWhatsAppConversationMessage({
        ...params,
        messageId: "wamid.retry-1",
      })
    ).resolves.toMatchObject({ persisted: true });
    expect(mockUserFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not share a failed template read with later recipients of the batch", async () => {
    const exactComponents = [{ type: "BODY", text: "Сәлем" }];
    const otherLanguageComponents = [{ type: "BODY", text: "Hello" }];
    let exactReads = 0;
    mockWhatsAppTemplateFindOne.mockImplementation(
      (query: { language?: string }) => ({
        select: () => ({
          lean: async () => {
            if (!query.language) return { components: otherLanguageComponents };
            exactReads += 1;
            if (exactReads === 1) throw new Error("Mongo read timed out");
            return { components: exactComponents };
          },
        }),
      })
    );
    const lookupCache = { authors: new Map(), templateComponents: new Map() };
    for (const [index, phone] of ["77001234567", "77001234568"].entries()) {
      mockConversationFindOne.mockReturnValueOnce(
        findOneResult({
          _id: `conversation-${index}`,
          chat: `wa_${phone}`,
          user: `wa_${phone}`,
        })
      );
      await persistCampaignWhatsAppConversationMessage({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        phoneNumberId: "phone-number-1",
        recipientPhone: phone,
        messageId: `wamid.template-retry-${index}`,
        templateName: "hello_world",
        languageCode: "kk",
        campaignId: "campaign-1",
        sentAt: "2026-07-28T08:00:00.000Z",
        lookupCache,
      });
    }

    const preview = jest.requireMock("@/lib/whatsapp/templates/preview")
      .buildStoredWhatsAppTemplatePreview as jest.Mock;
    expect(
      preview.mock.calls.map(([args]) => (args as { components?: unknown }).components)
    ).toEqual([exactComponents, exactComponents]);
  });

  it("returns before realtime fanout settles when the caller does not wait for it", async () => {
    let releaseRealtime!: () => void;
    mockTriggerConversationChanged.mockReturnValue(
      new Promise<void>(resolve => {
        releaseRealtime = resolve;
      })
    );
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
      })
    );

    const result = await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      recipientPhone: "77001234567",
      messageId: "wamid.no-wait",
      templateName: "hello_world",
      campaignId: "campaign-1",
      sentAt: "2026-07-28T08:00:00.000Z",
      awaitRealtime: false,
    });

    expect(result.persisted).toBe(true);
    expect(mockTriggerConversationChanged).toHaveBeenCalledWith(
      "conversation-1"
    );
    releaseRealtime();
  });

  it("waits for realtime fanout by default", async () => {
    let settled = false;
    mockTriggerConversationChanged.mockReturnValue(
      new Promise<void>(resolve =>
        setTimeout(() => {
          settled = true;
          resolve();
        }, 20)
      )
    );
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
      })
    );

    await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      recipientPhone: "77001234567",
      messageId: "wamid.wait",
      templateName: "hello_world",
      campaignId: "campaign-1",
      sentAt: "2026-07-28T08:00:00.000Z",
    });

    expect(settled).toBe(true);
  });

  it("stores exact service text without fabricating template metadata", async () => {
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
      })
    );

    const result = await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      recipientPhone: "+7 700 123 45 67",
      messageId: "wamid.service-1",
      whatsappMessageType: "service_text",
      messageText: " Thanks for contacting us.\n",
      campaignId: "campaign-1",
      sentAt: "2026-07-28T08:00:00.000Z",
    });

    expect(result.persisted).toBe(true);
    expect(mockMessageConstruct).toHaveBeenCalledWith(
      expect.objectContaining({
        text: " Thanks for contacting us.\n",
        channel: "whatsapp",
        origin: expect.objectContaining({
          kind: "campaign",
          campaignId: "campaign-1",
        }),
      })
    );
    const payload = mockMessageConstruct.mock.calls.at(-1)?.[0];
    expect(payload).not.toHaveProperty("whatsappTemplate");
    expect(payload.origin).not.toHaveProperty("templateName");
    expect(mockWhatsAppTemplateFindOne).not.toHaveBeenCalled();
  });

  it("uses canonical indexed conversation lookups instead of a broad identity $or", async () => {
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
      })
    );

    const result = await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      recipientPhone: "+7 700 123 45 67",
      messageId: "wamid.message-1",
      templateName: "hello_world",
      sentAt: "2026-06-03T14:51:24.000Z",
    });

    expect(result).toEqual({
      persisted: true,
      conversationId: "conversation-1",
      messageId: "wamid.message-1",
      created: true,
    });
    expect(mockConversationFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      sourceId: "source-1",
      chat: {
        $in: expect.arrayContaining([
          "+7 700 123 45 67",
          "77001234567",
          "wa_77001234567",
          "87001234567",
          "wa_87001234567",
        ]),
      },
    });
    expect(JSON.stringify(mockConversationFindOne.mock.calls)).not.toContain(
      '"$or"'
    );
  });

  it("matches Kazakhstan local 8-prefix recipients to Meta wa_id conversations", async () => {
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
      })
    );

    const result = await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      recipientPhone: "87001234567",
      messageId: "wamid.message-1",
      templateName: "hello_world",
      sentAt: "2026-06-03T14:51:24.000Z",
    });

    expect(result).toEqual({
      persisted: true,
      conversationId: "conversation-1",
      messageId: "wamid.message-1",
      created: true,
    });
    expect(mockConversationFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      sourceId: "source-1",
      chat: {
        $in: expect.arrayContaining([
          "87001234567",
          "77001234567",
          "wa_77001234567",
          "wa_87001234567",
        ]),
      },
    });
  });

  it("enables scenario routing when a scenario-backed WhatsApp campaign template is persisted", async () => {
    const scenarioId = "507f1f77bcf86cd799439011";
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
      })
    );

    await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      campaignId: "campaign-1",
      scenarioId,
      nodeId: "action-1",
      executionSource: "scenario_run_now",
      recipientPhone: "+7 700 123 45 67",
      messageId: "wamid.message-1",
      templateName: "hello_world",
      sentAt: "2026-06-03T14:51:24.000Z",
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      [
        {
          $set: expect.objectContaining({
            airi_scenarios_enabled: true,
            airi_scenario_state: {
              $mergeObjects: expect.arrayContaining([
                {
                  $literal: expect.objectContaining({
                    lockedScenarioId: scenarioId,
                    currentActionNodeId: "action-1",
                  }),
                },
              ]),
            },
          }),
        },
      ]
    );
  });

  it("atomically initializes null scenario state without replacing valid state or bulk history", async () => {
    const scenarioId = "507f1f77bcf86cd799439011";
    const sentAt = new Date("2026-06-03T14:51:24.000Z");
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
        airi_scenario_state: null,
      })
    );

    await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      campaignId: "campaign-1",
      scenarioId,
      nodeId: "action-1",
      executionSource: "scenario_run_now",
      recipientPhone: "+7 700 123 45 67",
      messageId: "wamid.message-1",
      templateName: "hello_world",
      sentAt,
    });

    expect(mockConversationUpdateOne).toHaveBeenLastCalledWith(
      { _id: "conversation-1" },
      [
        {
          $set: {
            airi_scenarios_enabled: true,
            airi_scenario_state: {
              $mergeObjects: [
                {
                  $cond: [
                    {
                      $eq: [{ $type: "$airi_scenario_state" }, "object"],
                    },
                    "$airi_scenario_state",
                    {},
                  ],
                },
                {
                  $literal: {
                    lockedScenarioId: scenarioId,
                    lockedScenarioName: "Scenario",
                    currentActionNodeId: "action-1",
                    currentPathNodeIds: ["action-1"],
                    currentBranchNodeIds: [],
                    pendingConditionNodeId: null,
                    pendingSourceActionNodeId: null,
                    pendingLegacyRouting: null,
                    pendingStartedAt: null,
                    pendingLastOutboundMessageId: null,
                    pendingLinkedConditionId: null,
                    lastMatchedAt: sentAt,
                    lastMessageId: "message-1",
                    formAnswers: null,
                    routedLocations: null,
                  },
                },
              ],
            },
            bulk_campaign_history: {
              $setUnion: [
                {
                  $cond: [
                    { $isArray: "$bulk_campaign_history" },
                    "$bulk_campaign_history",
                    [],
                  ],
                },
                {
                  $literal: [
                    {
                      scheduleId: new Types.ObjectId(scenarioId),
                      scenarioId: new Types.ObjectId(scenarioId),
                      nodeId: "action-1",
                      sentAt,
                      templateName: "hello_world",
                    },
                  ],
                },
              ],
            },
          },
        },
      ]
    );
  });

  it("clears stale legacy-routing provenance when a campaign replaces pending state", async () => {
    const scenarioId = "507f1f77bcf86cd799439011";
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
        airi_scenario_state: {
          pendingConditionNodeId: "legacy-condition",
          pendingSourceActionNodeId: "legacy-action",
          pendingLegacyRouting: {
            kind: "interactive_no_reply_assignment",
            conditionNodeId: "legacy-condition",
            sourceActionNodeId: "legacy-action",
          },
        },
      })
    );

    await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      campaignId: "campaign-1",
      scenarioId,
      nodeId: "action-1",
      executionSource: "scenario_run_now",
      recipientPhone: "+7 700 123 45 67",
      messageId: "wamid.message-1",
      templateName: "hello_world",
      sentAt: "2026-06-03T14:51:24.000Z",
    });

    expect(mockConversationUpdateOne).toHaveBeenLastCalledWith(
      { _id: "conversation-1" },
      [
        {
          $set: expect.objectContaining({
            airi_scenario_state: {
              $mergeObjects: expect.arrayContaining([
                {
                  $literal: expect.objectContaining({
                    pendingConditionNodeId: null,
                    pendingSourceActionNodeId: null,
                    pendingLegacyRouting: null,
                  }),
                },
              ]),
            },
          }),
        },
      ]
    );
  });

  it("clears an earlier run's form answers when a campaign sends the scenario again", async () => {
    const scenarioId = "507f1f77bcf86cd799439011";
    const abandonedRun = {
      lockedScenarioId: scenarioId,
      currentActionNodeId: "abandoned-step",
      formAnswers: {
        scenarioId,
        submissions: [
          {
            sourceActionNodeId: "order-form",
            flowId: null,
            inboundMessageId: "inbound-last-week",
            submittedAt: "2026-09-23T10:00:00.000Z",
            fields: [
              {
                key: "size",
                label: "Size",
                fieldType: "Dropdown",
                value: "Large",
              },
            ],
          },
        ],
      },
    };
    expect(readScenarioFormSubmissions(abandonedRun, scenarioId)).toHaveLength(
      1
    );
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
        airi_scenario_state: abandonedRun,
      })
    );

    await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      campaignId: "campaign-1",
      scenarioId,
      nodeId: "action-1",
      executionSource: "scenario_run_now",
      recipientPhone: "+7 700 123 45 67",
      messageId: "wamid.message-1",
      templateName: "hello_world",
      sentAt: "2026-09-30T14:51:24.000Z",
    });

    // The update merges its patch over the stored state, as $mergeObjects
    // does, so the patch itself must clear the earlier run's answers.
    const [[, pipeline]] = mockConversationUpdateOne.mock.calls.slice(-1);
    const [, patch] = pipeline[0].$set.airi_scenario_state.$mergeObjects;
    const nextState = { ...abandonedRun, ...patch.$literal };
    expect(nextState).toMatchObject({
      lockedScenarioId: scenarioId,
      currentActionNodeId: "action-1",
    });
    expect(readScenarioFormSubmissions(nextState, scenarioId)).toEqual([]);
  });

  it("enables scenario routing when the WhatsApp campaign message already exists", async () => {
    const scenarioId = "507f1f77bcf86cd799439011";
    const existingDate = new Date("2026-06-03T14:51:24.000Z");
    mockConversationFindOne.mockReturnValueOnce(
      findOneResult({
        _id: "conversation-1",
        chat: "wa_77001234567",
        user: "wa_77001234567",
      })
    );
    mockMessageFindOne.mockResolvedValue({
      _id: "existing-message-1",
      direction: "outbound",
      date: existingDate,
    });

    const result = await persistCampaignWhatsAppConversationMessage({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      campaignId: "campaign-1",
      scenarioId,
      nodeId: "action-1",
      executionSource: "scenario_run_now",
      recipientPhone: "+7 700 123 45 67",
      messageId: "wamid.message-1",
      templateName: "hello_world",
      sentAt: "2026-06-03T14:51:24.000Z",
    });

    expect(result).toEqual({
      persisted: true,
      conversationId: "conversation-1",
      messageId: "wamid.message-1",
      created: false,
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      [
        {
          $set: expect.objectContaining({
            airi_scenarios_enabled: true,
            airi_scenario_state: {
              $mergeObjects: expect.arrayContaining([
                {
                  $literal: expect.objectContaining({
                    currentActionNodeId: "action-1",
                    lastMessageId: "existing-message-1",
                  }),
                },
              ]),
            },
          }),
        },
      ]
    );
  });
});

describe("the recipient file's name", () => {
  const conversationFor = (workspaceId: string) => ({
    _id: `conversation-${workspaceId}`,
    chat: "wa_77001234567",
    user: "wa_77001234567",
    sourceId: "source-1",
    status: "open",
  });
  const send = (recipientName?: string | null, workspaceId = "workspace-1") =>
    persistCampaignWhatsAppConversationMessage({
      workspaceId,
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      recipientPhone: "+7 700 123 45 67",
      recipientName,
      messageId: "wamid.message-1",
      templateName: "fall_offer",
      sentAt: "2026-10-07T08:00:00.000Z",
    });
  const nameWrites = () =>
    mockConversationUpdateOne.mock.calls.filter(
      ([, update]) =>
        (update as { $set?: Record<string, unknown> })?.$set
          ?.campaign_recipient_name !== undefined
    );

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockMessageFindOne.mockResolvedValue(null);
    mockMessageFindById.mockReturnValue({
      populate: jest.fn().mockResolvedValue({ _id: "message-1" }),
    });
    mockAppendMessageToConversationById.mockResolvedValue(undefined);
    mockConversationUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockUserFindOneAndUpdate.mockImplementation(
      async (filter: { _id: string }) => ({ _id: filter._id })
    );
    mockChatFindOneAndUpdate.mockImplementation(
      async (filter: { _id: string }) => ({ _id: filter._id })
    );

    const contactIdentities = jest.requireMock(
      "@icecore/shared/lib/whatsapp/contact-identities"
    );
    contactIdentities.parseWhatsAppRecipientTarget.mockReturnValue(null);
    contactIdentities.normalizeWhatsAppPhone.mockImplementation(
      (value: unknown) => String(value || "").replace(/\D+/g, "") || undefined
    );
    contactIdentities.listWhatsAppPhoneIdentityVariants.mockImplementation(
      (value: unknown) => [String(value || "").replace(/\D+/g, "")]
    );
    contactIdentities.buildWhatsAppCanonicalIdFromPhone.mockImplementation(
      (phone: string) => `wa_${phone}`
    );
    jest
      .requireMock("@icecore/shared/lib/whatsapp/identity-snapshot")
      .buildWhatsAppIdentitySnapshot.mockImplementation(
        (contact: { waId: string; profile: { name: string } }) => ({
          waId: contact.waId,
          profileName: contact.profile.name,
          primaryIdType: "wa_id",
        })
      );
  });

  // The first campaign creates its contact and conversation inside the atomic
  // owner callback; existing conversations return before that callback.
  function conversationAfterContactIsSaved() {
    mockConversationFindOne.mockImplementation(() =>
      findOneResult(
        mockChatFindOneAndUpdate.mock.calls.length > 0
          ? conversationFor("workspace-1")
          : null
      )
    );
  }

  it("keeps the name on the conversation and the shared contact's placeholders", async () => {
    conversationAfterContactIsSaved();

    const result = await send("  Айгуль\n Сапарова ");

    expect(result).toMatchObject({ persisted: true });
    // The WhatsApp contact and chat are shared by every workspace.
    expect(mockUserFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: "wa_77001234567" },
      {
        $set: {
          isBot: false,
          workspaceId: "workspace-1",
          whatsapp: {
            waId: "77001234567",
            profileName: "77001234567",
            primaryIdType: "wa_id",
          },
        },
        $setOnInsert: { firstName: "Customer" },
      },
      { upsert: true, new: true }
    );
    expect(mockChatFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: "wa_77001234567" },
      { $set: expect.objectContaining({ title: "77001234567" }) },
      { upsert: true, new: true }
    );
    expect(JSON.stringify(mockUserFindOneAndUpdate.mock.calls)).not.toContain(
      "Айгуль"
    );
    expect(JSON.stringify(mockChatFindOneAndUpdate.mock.calls)).not.toContain(
      "Айгуль"
    );
    expect(nameWrites()).toEqual([
      [
        { _id: "conversation-1" },
        { $set: { campaign_recipient_name: "Айгуль Сапарова" } },
      ],
    ]);
  });

  it("keeps one workspace's file name off another workspace's conversation", async () => {
    mockConversationFindOne.mockImplementation((filter: unknown) =>
      findOneResult(
        conversationFor(
          JSON.stringify(filter).includes("workspace-2")
            ? "workspace-2"
            : "workspace-1"
        )
      )
    );

    await send("Айгерим (долг 50 000)", "workspace-1");
    await send(null, "workspace-2");

    expect(nameWrites()).toEqual([
      [
        { _id: "conversation-workspace-1" },
        { $set: { campaign_recipient_name: "Айгерим (долг 50 000)" } },
      ],
    ]);
    // Neither send rewrote the shared contact.
    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalledWith(
      { _id: "wa_77001234567" },
      expect.anything(),
      expect.anything()
    );
    expect(mockChatFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("stores no name when the row has none or only a phone", async () => {
    conversationAfterContactIsSaved();

    await send("+7 (700) 123-45-67");
    await send("Customer");
    await send(" ");

    expect(nameWrites()).toEqual([]);
  });

  it("still records the message when the name cannot be saved", async () => {
    mockConversationFindOne.mockReturnValue(
      findOneResult(conversationFor("workspace-1"))
    );
    mockConversationUpdateOne.mockImplementation(
      async (_filter: unknown, update: { $set?: Record<string, unknown> }) => {
        if (update?.$set?.campaign_recipient_name !== undefined) {
          throw new Error("write conflict");
        }
        return { modifiedCount: 1 };
      }
    );
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await send("Айгуль");

    expect(result).toEqual({
      persisted: true,
      conversationId: "conversation-workspace-1",
      messageId: "wamid.message-1",
      created: true,
    });
    expect(mockMessageConstruct).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[Campaign Conversation] Could not save recipient name",
      expect.objectContaining({ error: "write conflict" })
    );
    warn.mockRestore();
  });
});
