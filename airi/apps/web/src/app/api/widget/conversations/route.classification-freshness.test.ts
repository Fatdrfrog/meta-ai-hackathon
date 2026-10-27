const mockAppendMessageToConversationById = jest.fn();
const mockCheckRateLimit = jest.fn();
const mockConnectDB = jest.fn();
const mockConversationFindOne = jest.fn();
const mockConversationFindById = jest.fn();
const mockConversationCreate = jest.fn();
const mockDirectIngressAiriConversation = jest.fn();
const mockAcceptAiriConversationIngress = jest.fn();
const mockBuildAiriConversationIngressIntent = jest.fn();
const mockEnqueueConversationMediaAnalysis = jest.fn();
const mockGenerateVisitorToken = jest.fn();
const mockMessageCreate = jest.fn();
const mockMessageFindById = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockResolveAuthorizedWidgetSource = jest.fn();
const mockTrackWidgetEvent = jest.fn();
const mockTriggerConversationRealtime = jest.fn();
const mockTriggerConversationReopened = jest.fn();
const mockUserFindOneAndUpdate = jest.fn();

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceCoachDefault: jest.fn(async () => true),
  getWorkspaceScenariosDefault: jest.fn(async () => true),
}));
jest.mock("@/lib/analytics", () => ({
  trackWidgetEvent: (...args: unknown[]) => mockTrackWidgetEvent(...args),
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessageToConversationById(...args),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  buildCompanyLimitExceededBody: jest.fn(),
  ensureCompanyConversationCapacity: jest.fn(async () => ({ allowed: true })),
}));
jest.mock("@/lib/logger", () => ({
  widgetLogger: {
    error: jest.fn(),
    messageSent: jest.fn(),
    rateLimitExceeded: jest.fn(),
  },
}));
jest.mock("@/lib/media/conversation-media-analysis-jobs", () => ({
  enqueueConversationMediaAnalysis: (...args: unknown[]) =>
    mockEnqueueConversationMediaAnalysis(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/lib/realtime/server", () => ({
  triggerRealtimeEvent: (...args: unknown[]) => mockRealtimeTrigger(...args),
}));
jest.mock("@/lib/realtime-updates", () => ({
  triggerConversationRealtime: (...args: unknown[]) =>
    mockTriggerConversationRealtime(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/temporal/airi-direct-ingress", () => ({
  directIngressAiriConversation: (...args: unknown[]) =>
    mockDirectIngressAiriConversation(...args),
  acceptAiriConversationIngress: (...args: unknown[]) =>
    mockAcceptAiriConversationIngress(...args),
}));
jest.mock("@/lib/temporal/airi-turn-context", () => ({
  buildAiriConversationIngressIntent: (...args: unknown[]) =>
    mockBuildAiriConversationIngressIntent(...args),
}));
jest.mock("@/lib/webhook-events", () => ({
  triggerConversationReopened: (...args: unknown[]) =>
    mockTriggerConversationReopened(...args),
}));
jest.mock("@/lib/widget/auto-tagger", () => ({
  generateTagsFromUrl: jest.fn(async () => []),
  inferPriorityFromUrl: jest.fn(),
  suggestCategoryFromUrl: jest.fn(),
}));
jest.mock("@/lib/widget/cors", () => ({
  handleCorsOptions: jest.fn(() => new Response(null, { status: 204 })),
  jsonWithCors: (body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
}));
jest.mock("@/lib/widget/source-context", () => ({
  resolveAuthorizedWidgetSource: (...args: unknown[]) =>
    mockResolveAuthorizedWidgetSource(...args),
}));
jest.mock("@/lib/widget/visitor-auth", () => ({
  generateVisitorToken: (...args: unknown[]) =>
    mockGenerateVisitorToken(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    create: (...args: unknown[]) => mockConversationCreate(...args),
    findById: (...args: unknown[]) => mockConversationFindById(...args),
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    create: (...args: unknown[]) => mockMessageCreate(...args),
    findById: (...args: unknown[]) => mockMessageFindById(...args),
  },
}));
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockUserFindOneAndUpdate(...args),
  },
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimiter: jest.fn(() => ({})),
  rateLimitPresets: { widgetMessages: {} },
}));

import mongoose from "mongoose";
import {
  NON_READY_CLASSIFICATION_CASES,
  readyClassificationFields,
} from "@/lib/classifier/classified-conversation-test-utils";
import { POST } from "./route";

const NOW = new Date("2026-08-11T15:00:00.000Z");
const EXISTING_CLASSIFICATION = {
  category: "Sales",
  priority: "high",
  sentiment: "positive",
  summary: "Customer returned to purchase",
  action: "Send checkout link",
  tags: ["returning"],
  confidence: {
    category: 0.93,
    priority: 0.86,
    sentiment: 0.89,
  },
};

function buildClosedConversation() {
  return {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    channel: "web_widget",
    status: "closed",
    visitor_id: "visitor-1",
    page_url: "https://example.com/pricing",
    user: "visitor-1",
    messages: [],
    createdAt: new Date("2026-08-10T15:00:00.000Z"),
    airi_bot_enabled: true,
    airi_scenarios_enabled: true,
    ...readyClassificationFields(18),
    classification: {
      ...EXISTING_CLASSIFICATION,
      tags: [...EXISTING_CLASSIFICATION.tags],
      confidence: { ...EXISTING_CLASSIFICATION.confidence },
    },
    save: jest.fn().mockResolvedValue(undefined),
  };
}

const NON_CURRENT_CLASSIFICATION_CASES: ReadonlyArray<{
  name: string;
  mutate: (conversation: ReturnType<typeof buildClosedConversation>) => void;
}> = [
  ...NON_READY_CLASSIFICATION_CASES,
  {
    name: "revision mismatch",
    mutate: conversation => {
      conversation.classification_state.requestedRevision = 17;
    },
  },
  {
    name: "blank analysis id",
    mutate: conversation => {
      conversation.classification_meta.analysis_revision_id = "   ";
    },
  },
  {
    name: "partial root",
    mutate: conversation => {
      delete (conversation as Partial<typeof conversation>)
        .classification_revision;
    },
  },
];

function sortedResult(value: unknown) {
  return { sort: jest.fn().mockResolvedValue(value) };
}

async function reopenThroughWidget(
  conversation: ReturnType<typeof buildClosedConversation>
) {
  mockConversationFindOne
    .mockImplementationOnce(() => sortedResult(null))
    .mockImplementationOnce(() => sortedResult(null))
    .mockImplementationOnce(() => sortedResult(conversation));

  const request = new Request("http://localhost/api/widget/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientKey: "key-1",
      mediaUrl: "https://example.com/image.jpg",
      mediaType: "image",
      metadata: {
        customerId: "visitor-1",
        pageUrl: "https://example.com/pricing",
      },
    }),
  });

  const response = await POST(request as Parameters<typeof POST>[0]);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(
    expect.objectContaining({ success: true, conversationId: "conversation-1" })
  );
}

describe("widget conversation reopen classification freshness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockAppendMessageToConversationById.mockResolvedValue({ appended: true });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: NOW.getTime() + 60_000,
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockDirectIngressAiriConversation.mockResolvedValue(undefined);
    mockAcceptAiriConversationIngress.mockResolvedValue({ status: "accepted" });
    mockBuildAiriConversationIngressIntent.mockImplementation(payload => ({
      version: 1,
      workspaceId: payload.workspaceId,
      conversationId: String(payload.conversation._id),
      messageId: String(payload.newMessage._id),
      sourceId: payload.chatDocument.sourceId,
    }));
    mockEnqueueConversationMediaAnalysis.mockResolvedValue({ queued: true });
    mockGenerateVisitorToken.mockResolvedValue("visitor-token");
    mockMessageCreate.mockImplementation(async payload => ({
      _id: "message-1",
      ...payload,
    }));
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockResolveAuthorizedWidgetSource.mockResolvedValue({
      ok: true,
      source: {
        id: "source-1",
        workspace_id: "workspace-1",
        company_id: "company-1",
      },
      credentials: { settings: { airi_enabled: true } },
    });
    mockTriggerConversationRealtime.mockResolvedValue(undefined);
    mockTriggerConversationReopened.mockResolvedValue(undefined);
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: "visitor-1" });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps the complete classification and payload for an exact current-ready reopen", async () => {
    const conversation = buildClosedConversation();
    await reopenThroughWidget(conversation);

    expect(conversation.status).toBe("open");
    expect(conversation.save).toHaveBeenCalledTimes(1);
    expect(mockTriggerConversationReopened).toHaveBeenCalledWith(
      "workspace-1",
      {
        conversation_id: "conversation-1",
        status: "open",
        previous_status: "closed",
        channel: "web_widget",
        classification: EXISTING_CLASSIFICATION,
        created_at: "2026-08-10T15:00:00.000Z",
        updated_at: NOW.toISOString(),
      }
    );
  });

  it.each(NON_CURRENT_CLASSIFICATION_CASES)(
    "omits the classification own property for a $name reopen root",
    async ({ mutate }) => {
      const conversation = buildClosedConversation();
      mutate(conversation);

      await reopenThroughWidget(conversation);

      const payload = mockTriggerConversationReopened.mock.calls[0]?.[1];
      expect(payload).toEqual({
        conversation_id: "conversation-1",
        status: "open",
        previous_status: "closed",
        channel: "web_widget",
        created_at: "2026-08-10T15:00:00.000Z",
        updated_at: NOW.toISOString(),
      });
      expect(Object.hasOwn(payload, "classification")).toBe(false);
    }
  );

  it("does not await the best-effort reopened webhook", async () => {
    mockTriggerConversationReopened.mockReturnValue(
      new Promise<never>(() => undefined)
    );

    await expect(
      reopenThroughWidget(buildClosedConversation())
    ).resolves.toBeUndefined();
  });

  describe("durable message acceptance", () => {
    const requestBody = {
      clientKey: "key-1",
      clientMessageId: "send-1",
      mediaUrl: "https://example.com/image.jpg",
      mediaType: "image",
      metadata: {
        customerId: "visitor-1",
        pageUrl: "https://example.com/pricing",
        ragContext: "Current pricing page",
      },
    };
    const messages = new Map<string, Record<string, unknown>>();
    const conversations = new Map<
      string,
      ReturnType<typeof buildClosedConversation>
    >();
    const post = (overrides: Record<string, unknown> = {}) =>
      POST(
        new Request("http://localhost/api/widget/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...requestBody, ...overrides }),
        }) as Parameters<typeof POST>[0]
      );

    beforeEach(() => {
      messages.clear();
      conversations.clear();
      mockConversationFindOne.mockImplementation(() => sortedResult(null));
      mockConversationFindById.mockImplementation(
        async id => conversations.get(String(id)) || null
      );
      mockConversationCreate.mockImplementation(async payload => {
        const id = String(
          payload._id || `conversation-${conversations.size + 1}`
        );
        if (conversations.has(id)) throw { code: 11000 };
        const conversation = {
          ...buildClosedConversation(),
          ...payload,
          _id: id,
        };
        conversations.set(id, conversation);
        return conversation;
      });
      mockMessageFindById.mockImplementation(id => ({
        select: jest.fn(async () => messages.get(String(id)) || null),
      }));
      mockMessageCreate.mockImplementation(async payload => {
        const id = String(payload._id || `message-${messages.size + 1}`);
        if (messages.has(id)) throw { code: 11000 };
        const message = { ...payload, _id: id };
        messages.set(id, message);
        return message;
      });
    });

    it("reuses the saved inbound and repairs admission after a failed response", async () => {
      mockAcceptAiriConversationIngress.mockRejectedValueOnce(
        new Error("context write unavailable")
      );
      expect((await post()).status).toBe(500);
      expect(messages.size).toBe(1);
      const saved = [...messages.values()][0];
      expect(saved.airiIngressIntent).toEqual(
        expect.objectContaining({ messageId: saved._id })
      );

      const retry = await post();
      expect(retry.status).toBe(200);
      const response = await retry.json();
      expect(response.message.id).toBe(saved._id);
      expect(response.conversationId).toBe(String(saved.conversation));
      expect(response.message).not.toHaveProperty("airiIngressIntent");
      expect(response.message).not.toHaveProperty("widgetRequestHash");
      expect(messages.size).toBe(1);
      expect(conversations.size).toBe(1);
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(2);
      expect(mockDirectIngressAiriConversation).not.toHaveBeenCalled();
      expect(mockAcceptAiriConversationIngress.mock.calls[1][0]._id).toBe(
        saved._id
      );
    });

    it("accepts a persisted message while Temporal delivery is pending", async () => {
      mockAcceptAiriConversationIngress.mockResolvedValue({
        status: "pending",
      });
      const response = await post();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).not.toHaveProperty("airiIngressIntent");
      expect(body.message).not.toHaveProperty("widgetRequestHash");
      const realtimeMessage = mockRealtimeTrigger.mock.calls[0][2];
      expect(realtimeMessage).not.toHaveProperty("airiIngressIntent");
      expect(realtimeMessage).not.toHaveProperty("widgetRequestHash");
      expect(messages.size).toBe(1);
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
      expect(
        mockEnqueueConversationMediaAnalysis.mock.invocationCallOrder[0]
      ).toBeLessThan(
        mockAcceptAiriConversationIngress.mock.invocationCallOrder[0]
      );
    });

    it("retries a lost success response after its temporary intent was materialized", async () => {
      mockAcceptAiriConversationIngress.mockImplementation(async message => {
        delete message.airiIngressIntent;
        return { accepted: true, status: "signaled" };
      });
      const first = await (await post()).json();
      const retry = await (await post()).json();
      expect(retry.message.id).toBe(first.message.id);
      expect(messages.size).toBe(1);
      expect(conversations.size).toBe(1);
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(2);
      expect(mockTrackWidgetEvent).toHaveBeenCalledTimes(1);
    });

    it("reuses the saved message when Mongo minimizes empty metadata objects", async () => {
      const metadata = { ...requestBody.metadata, appMetadata: {} };
      expect((await post({ metadata })).status).toBe(200);
      const saved = [...messages.values()][0];
      const RawPayload = mongoose.model(
        "WidgetIngressRawPayloadFixture",
        new mongoose.Schema<{ payload: { metadata: Record<string, unknown> } }>(
          { payload: mongoose.Schema.Types.Mixed },
          { _id: false }
        )
      );
      const storedPayload = new RawPayload(saved.rawSourcePayload).toObject();
      expect(storedPayload.payload.metadata).not.toHaveProperty("appMetadata");
      saved.rawSourcePayload = storedPayload;
      expect((await post({ metadata })).status).toBe(200);
      expect(messages.size).toBe(1);
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(2);
    });

    it("recovers one winning message and conversation under concurrent first sends", async () => {
      const responses = await Promise.all([post(), post()]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const bodies = await Promise.all(
        responses.map(response => response.json())
      );
      expect(bodies[0].message.id).toBe(bodies[1].message.id);
      expect(bodies[0].conversationId).toBe(bodies[1].conversationId);
      expect(messages.size).toBe(1);
      expect(conversations.size).toBe(1);
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(2);
    });

    it("rejects changed content for an already accepted client identity", async () => {
      expect((await post()).status).toBe(200);
      expect((await post({ text: "Different message" })).status).toBe(409);
      expect(messages.size).toBe(1);
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
    });

    it("rejects a recovered message that belongs to another visitor", async () => {
      expect((await post()).status).toBe(200);
      [...messages.values()][0].author = "another-visitor";
      expect((await post()).status).toBe(409);
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
    });

    it("rejects a recovered message carrying another source's intent", async () => {
      expect((await post()).status).toBe(200);
      [...messages.values()][0].airiIngressIntent = {
        sourceId: "another-source",
      };
      expect((await post()).status).toBe(409);
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
    });

    it("requires current source authorization even for an existing message", async () => {
      expect((await post()).status).toBe(200);
      mockResolveAuthorizedWidgetSource.mockResolvedValue({
        ok: false,
        status: 403,
        error: "Widget source inactive",
      });
      expect((await post()).status).toBe(403);
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
    });

    it("rejects an explicit conversation from another source before saving an intent", async () => {
      const conversation = {
        ...buildClosedConversation(),
        sourceId: "another-source",
      };
      conversations.set(conversation._id, conversation);
      const response = await post({ conversationId: conversation._id });
      expect(response.status).toBe(404);
      expect(mockMessageCreate).not.toHaveBeenCalled();
      expect(mockAcceptAiriConversationIngress).not.toHaveBeenCalled();
    });

    it("does not select another source's conversation for the same visitor and page", async () => {
      const conversation = {
        ...buildClosedConversation(),
        sourceId: "another-source",
        status: "open",
      };
      conversations.set(conversation._id, conversation);
      mockConversationFindOne.mockImplementation(filter => {
        const matchesSource =
          !filter.$or ||
          filter.$or.some(
            (scope: { sourceId: string | null }) =>
              scope.sourceId === conversation.sourceId
          );
        return sortedResult(matchesSource ? conversation : null);
      });
      const response = await post();
      expect(response.status).toBe(200);
      expect((await response.json()).conversationId).not.toBe(conversation._id);
      expect(messages.size).toBe(1);
    });

    it("accepts an unassigned legacy conversation and saves the authorized source in its intent", async () => {
      const conversation = buildClosedConversation();
      delete (conversation as Partial<typeof conversation>).sourceId;
      conversations.set(conversation._id, conversation);
      const response = await post({ conversationId: conversation._id });
      expect(response.status).toBe(200);
      expect([...messages.values()][0].airiIngressIntent).toEqual(
        expect.objectContaining({ sourceId: "source-1" })
      );
    });

    it.each(["", "contains spaces", "x".repeat(129), null, 123])(
      "rejects invalid supplied clientMessageId %p before persistence",
      async clientMessageId => {
        expect((await post({ clientMessageId })).status).toBe(400);
        expect(messages.size).toBe(0);
      }
    );

    it("keeps legacy requests without an id accepted as separate messages", async () => {
      expect((await post({ clientMessageId: undefined })).status).toBe(200);
      expect((await post({ clientMessageId: undefined })).status).toBe(200);
      expect(messages.size).toBe(2);
    });

    it("requires a stable visitor identity when a client message id is supplied", async () => {
      expect((await post({ metadata: {} })).status).toBe(400);
      expect(messages.size).toBe(0);
    });

    it("rejects oversized metadata nesting before persistence", async () => {
      let appMetadata: Record<string, unknown> = {};
      for (let index = 0; index < 70; index++)
        appMetadata = { nested: appMetadata };
      const response = await post({
        metadata: { ...requestBody.metadata, appMetadata },
      });
      expect(response.status).toBe(400);
      expect(mockMessageCreate).not.toHaveBeenCalled();
    });

    it("isolates the same client id across visitors and authorized sources", async () => {
      expect((await post()).status).toBe(200);
      expect(
        (
          await post({
            metadata: { ...requestBody.metadata, customerId: "visitor-2" },
          })
        ).status
      ).toBe(200);
      mockResolveAuthorizedWidgetSource.mockResolvedValue({
        ok: true,
        source: {
          id: "source-2",
          workspace_id: "workspace-1",
          company_id: "company-1",
        },
        credentials: { settings: { airi_enabled: true } },
      });
      expect((await post()).status).toBe(200);
      mockResolveAuthorizedWidgetSource.mockResolvedValue({
        ok: true,
        source: {
          id: "source-2",
          workspace_id: "workspace-2",
          company_id: "company-1",
        },
        credentials: { settings: { airi_enabled: true } },
      });
      expect((await post()).status).toBe(200);
      expect(messages.size).toBe(4);
    });
  });
});
