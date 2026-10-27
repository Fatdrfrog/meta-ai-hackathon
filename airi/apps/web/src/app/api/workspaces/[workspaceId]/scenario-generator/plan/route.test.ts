const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockChatCompletionWithFallback = jest.fn();
const mockConnectDB = jest.fn();
const mockConversationFind = jest.fn();
const mockConversationSelect = jest.fn();
const mockEnsureCompanyStudioChatCapacity = jest.fn();
const mockRecordCreativeStudioChat = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getReasoningTextModel: () => "reasoning-text-model",
}));

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyStudioChatCapacity: (...args: unknown[]) =>
    mockEnsureCompanyStudioChatCapacity(...args),
  recordCreativeStudioChat: (...args: unknown[]) =>
    mockRecordCreativeStudioChat(...args),
  buildCompanyStudioChatLimitExceededResponse: (limit: unknown) =>
    Response.json(
      { code: "company_studio_chat_limit_exceeded", error: "locked", limit },
      { status: 402 }
    ),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { client: "supabase-admin" },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

import { CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS } from "@icecore/shared/lib/conversation-classification-freshness";

import { maxDuration, POST } from "./route";
import { hasWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";

function mockConversationRows(rows: unknown[]) {
  const query = {
    sort: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
  };
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.select.mockImplementation((fields: string) => {
    mockConversationSelect(fields);
    return query;
  });
  query.lean.mockResolvedValue(rows);
  mockConversationFind.mockReturnValue(query);
}

function currentClassificationProjection(
  classification: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    classification,
    is_classified: true,
    classification_revision: 13,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 13,
      appliedRevision: 13,
    },
    classification_meta: {
      source_revision: 13,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-current",
    },
    ...overrides,
  };
}

function expectConversationSelectContainsCanonicalFreshness() {
  const selected = String(mockConversationSelect.mock.calls[0]?.[0] || "")
    .split(/\s+/u)
    .filter(Boolean);
  for (const path of CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS) {
    expect(selected.filter(value => value === path)).toHaveLength(1);
  }
}

describe("POST /api/workspaces/[workspaceId]/scenario-generator/plan", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({
      allowed: true,
      limit: {},
    });
    mockRecordCreativeStudioChat.mockResolvedValue(undefined);
    mockConversationRows([]);
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        summary: "Generate a VIP reactivation campaign.",
      }),
    });
  });

  it("returns a Canva template search query when the planner is ready", async () => {
    mockChatCompletionWithFallback.mockImplementationOnce(async () => {
      expect(hasWorkspaceTextAiAction()).toBe(true);
      return {
        content: JSON.stringify({
          status: "ready",
          summary: "Generate a VIP reactivation campaign.",
        }),
      };
    });
    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/scenario-generator/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt:
              "Generate a reactivation campaign for VIP users who asked about pricing. Drive them to book a demo this week.",
            workflowKind: "follow_up_workflow",
            sendMode: "trigger",
            channels: ["email"],
            recipientSourceSummary: "Triggered audience",
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    expect(hasWorkspaceTextAiAction()).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      blueprint: {
        campaignName: "Generate a reactivation campaign for VIP",
      },
      templateSearchQuery:
        "Generate a reactivation campaign for VIP reactivation campaign",
    });
  });

  it("plans on the reasoning tier with a deadline inside the route duration", async () => {
    const response = await POST(
      new Request("http://localhost/api/plan", {
        method: "POST",
        body: JSON.stringify({ prompt: "Prepare a campaign" }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(1);
    const request = mockChatCompletionWithFallback.mock.calls[0][0];
    expect(request.model).toBe("reasoning-text-model");
    expect(request.resilience.timeoutMs).toBeGreaterThanOrEqual(120_000);
    expect(request.resilience.timeoutMs).toBeLessThan(maxDuration * 1000);
  });

  it("reads a planner decision that the model wrapped in a JSON fence", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: [
        "```json",
        JSON.stringify({
          status: "needs_input",
          questions: [
            { question: "Which offer should we lead with?", context: "Copy" },
          ],
        }),
        "```",
      ].join("\n"),
    });
    const response = await POST(
      new Request("http://localhost/api/plan", {
        method: "POST",
        body: JSON.stringify({ prompt: "Prepare a campaign" }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "needs_input",
      questions: [
        { question: "Which offer should we lead with?", context: "Copy" },
      ],
    });
  });

  it("returns a connection-required response instead of a successful fallback when allowance is exhausted", async () => {
    mockChatCompletionWithFallback.mockRejectedValueOnce(
      Object.assign(new Error("Connect a source"), {
        code: "own_ai_source_required",
        resetAt: "2026-10-01T00:00:00.000Z",
      })
    );
    const response = await POST(
      new Request("http://localhost/api/plan", {
        method: "POST",
        body: JSON.stringify({ prompt: "Prepare a campaign" }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    expect(response.status).toBe(402);
    // The allowance is lifetime, so the response never carries a reset date.
    expect(await response.json()).toMatchObject({
      code: "own_ai_source_required",
      resetAt: null,
    });
    expect(mockRecordCreativeStudioChat).not.toHaveBeenCalled();
  });

  it("ignores retired trigger strategies from old clients and planner output", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        status: "ready",
        summary: "Create an inbound support recovery workflow.",
        triggerStrategy: "no_human_reply_timeout",
      }),
    });

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/scenario-generator/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "Create a support recovery workflow.",
            workflowKind: "follow_up_workflow",
            sendMode: "trigger",
            channels: ["whatsapp"],
            triggerStrategy: "payment_detected",
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.blueprint).not.toHaveProperty("triggerStrategy");

    const plannerInput = JSON.parse(
      mockChatCompletionWithFallback.mock.calls[0][0].messages[1].content
    );
    expect(plannerInput).not.toHaveProperty("triggerStrategy");
  });

  it("lets the planner choose a bulk campaign for product-launch requests and sees calendar context", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        status: "ready",
        summary: "Launch the new product to WhatsApp customers.",
        campaignName: "Creative Assets Launch",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        recipientSourceSummary: "WhatsApp launch audience",
      }),
    });

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/scenario-generator/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt:
              'Help me create a marketing campaign in WhatsApp for a new launch of product "creative assets".',
            workflowKind: "follow_up_workflow",
            sendMode: "trigger",
            channels: ["whatsapp"],
            sourceContext: [
              {
                type: "google_calendar",
                label: "Google Calendar",
                role: "context",
              },
            ],
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      blueprint: {
        campaignName: "Creative Assets Launch",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        recipientSourceSummary: "WhatsApp launch audience",
      },
    });

    const plannerInput = JSON.parse(
      mockChatCompletionWithFallback.mock.calls[0][0].messages[1].content
    );
    expect(plannerInput.sourceContext).toEqual([
      {
        type: "google_calendar",
        label: "Google Calendar",
        role: "context",
      },
    ]);
  });

  it("uses the LLM planner instead of regex heuristics for follow-up questions", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        status: "needs_input",
        questions: [
          {
            question: "Which three customer cohorts should be prioritized?",
            context:
              "The selected WhatsApp conversations include pricing, loyalty, and inactive-user patterns.",
          },
        ],
      }),
    });

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/scenario-generator/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt:
              "Generate a whatsapp bulk campaign scenarios for 3 types of users that you will find from my conversations.",
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
            recipientSourceSummary: "0 selected recipients",
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "needs_input",
      questions: [
        {
          question: "Which three customer cohorts should be prioritized?",
          context:
            "The selected WhatsApp conversations include pricing, loyalty, and inactive-user patterns.",
        },
      ],
    });
  });

  it("passes recent conversation context filtered to the selected channels into the planner", async () => {
    mockConversationRows([
      {
        _id: "conversation-1",
        channel: "whatsapp",
        chat: "wa_77000000001",
        sourceId: "source-whatsapp-1",
        history_summary: "Asked about pricing and loyalty rewards.",
        ...currentClassificationProjection({
          category: "pricing",
          summary: "Current pricing summary",
        }),
        internal_labels: ["vip"],
        lastMessageAt: new Date("2026-05-01T12:00:00.000Z"),
      },
      {
        _id: "conversation-2",
        channel: "whatsapp",
        chat: "wa_77000000002",
        sourceId: "source-whatsapp-1",
        ...currentClassificationProjection({
          category: "loyalty",
          summary: "Current loyalty summary",
        }),
        internal_labels: ["returning"],
        lastMessageAt: new Date("2026-04-30T12:00:00.000Z"),
      },
    ]);

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/scenario-generator/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt:
              "Generate a WhatsApp campaign for cohorts from my conversations and drive them to book.",
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockConversationFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        channel: { $in: ["whatsapp"] },
      })
    );
    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: { type: "json_object" },
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining(
              "Asked about pricing and loyalty rewards."
            ),
          }),
        ]),
      })
    );
    const plannerPayload = String(
      mockChatCompletionWithFallback.mock.calls[0]?.[0]?.messages?.find(
        (message: { role?: string }) => message.role === "user"
      )?.content || ""
    );
    expect(plannerPayload).toContain('"category":"pricing"');
    expect(plannerPayload).toContain('"summary":"Current loyalty summary"');
    expectConversationSelectContainsCanonicalFreshness();
  });

  it("omits stale category and summary while retaining history and manual labels", async () => {
    mockConversationRows([
      {
        _id: "conversation-stale-with-history",
        channel: "whatsapp",
        chat: "wa_77000000001",
        sourceId: "source-whatsapp-1",
        history_summary: "Retained conversation history.",
        ...currentClassificationProjection(
          {
            category: "stale-pricing",
            summary: "Stale summary hidden by history",
          },
          { is_classified: false }
        ),
        internal_labels: ["vip", "stage:active"],
        lastMessageAt: new Date("2026-05-01T12:00:00.000Z"),
      },
      {
        _id: "conversation-stale-without-history",
        channel: "whatsapp",
        chat: "wa_77000000002",
        sourceId: "source-whatsapp-1",
        ...currentClassificationProjection(
          {
            category: "stale-churn",
            summary: "Stale summary without history",
          },
          { is_classified: false }
        ),
        internal_labels: ["manual-label"],
        lastMessageAt: new Date("2026-04-30T12:00:00.000Z"),
      },
    ]);

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/scenario-generator/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "Plan a retention campaign",
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    const plannerPayload = String(
      mockChatCompletionWithFallback.mock.calls[0]?.[0]?.messages?.find(
        (message: { role?: string }) => message.role === "user"
      )?.content || ""
    );
    expect(plannerPayload).toContain("Retained conversation history.");
    expect(plannerPayload).toContain('"labels":["vip","stage:active"]');
    expect(plannerPayload).toContain('"labels":["manual-label"]');
    expect(plannerPayload).not.toContain("stale-pricing");
    expect(plannerPayload).not.toContain("stale-churn");
    expect(plannerPayload).not.toContain("Stale summary hidden by history");
    expect(plannerPayload).not.toContain("Stale summary without history");
    expectConversationSelectContainsCanonicalFreshness();
  });

  it("passes selected media summaries into the planner instead of only a count", async () => {
    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/scenario-generator/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt:
              "Generate a WhatsApp promo using the attached Higgsfield image.",
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
            assetRefs: [
              {
                id: "asset-1",
                kind: "image",
                source: "higgsfield",
                url: "https://storage.example.com/higgsfield/promo.jpg",
                mimeType: "image/jpeg",
                fileName: "promo.jpg",
              },
              {
                id: "asset-2",
                kind: "executable",
                source: "untrusted-provider",
                url: "https://storage.example.com/higgsfield/ignored.bin",
                mimeType: "application/octet-stream",
              },
            ],
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    const plannerInput = JSON.parse(
      mockChatCompletionWithFallback.mock.calls[0][0].messages[1].content
    );
    expect(plannerInput.assetCount).toBe(2);
    expect(plannerInput.assets).toEqual([
      {
        id: "asset-1",
        kind: "image",
        source: "higgsfield",
        fileName: "promo.jpg",
        mimeType: "image/jpeg",
        url: "https://storage.example.com/higgsfield/promo.jpg",
      },
      {
        id: "asset-2",
        mimeType: "application/octet-stream",
        url: "https://storage.example.com/higgsfield/ignored.bin",
      },
    ]);
  });
});
