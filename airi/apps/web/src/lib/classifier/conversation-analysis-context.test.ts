jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

import {
  CLASSIFICATION_MESSAGE_SELECT,
  buildConversationMetadataContext,
  formatClassificationMessage,
  resolveClassificationSourceId,
  resolveConversationClassificationBusinessContextStrict,
} from "@/lib/classifier/conversation-analysis-context";
import { supabaseAdmin } from "@/lib/supabase/admin";

type QueryResult = { data: unknown; error: unknown };

const mockFrom = supabaseAdmin.from as jest.Mock;

function installStrictReadResults(results: Record<string, QueryResult[]>) {
  mockFrom.mockImplementation((table: string) => {
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      maybeSingle: jest.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockImplementation(async () => {
      const result = results[table]?.shift();
      if (!result) throw new Error(`Missing ${table} fixture`);
      return result;
    });
    return query;
  });
}

describe("conversation analysis context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("prefers the explicit conversation source before the populated chat source", () => {
    expect(
      resolveClassificationSourceId({
        sourceId: "conversation-source",
        chat: { sourceId: "chat-source" },
      })
    ).toBe("conversation-source");

    expect(
      resolveClassificationSourceId({ chat: { sourceId: "chat-source" } })
    ).toBe("chat-source");
  });

  it("projects every field consumed by transcript formatting, including media state", () => {
    expect(CLASSIFICATION_MESSAGE_SELECT.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "direction",
        "subject",
        "ragContext",
        "mediaAnalysis",
        "origin",
        "whatsappFlowReply",
        "whatsappOrder",
        "whatsappProductInquiry",
        "whatsappServiceMessage",
        "whatsappTemplate",
        "whatsappReferral",
        "whatsappLocation",
      ])
    );
  });

  it("labels outbound human replies as agent messages", () => {
    expect(
      formatClassificationMessage({
        text: "I can help with that.",
        direction: "outbound",
        author: { firstName: "Maya", isBot: false },
      })
    ).toBe("[Human] Maya: I can help with that.");
  });

  it("keeps stored analysis for attachment images without a legacy image URL", () => {
    expect(
      formatClassificationMessage({
        direction: "inbound",
        imageAnalysis: "Receipt: 7000 KZT; displayed status successful.",
      })
    ).toContain("[Image Content: Receipt: 7000 KZT; displayed status successful.]");
  });

  it("preserves later payment status and amount only when evidence context is requested", () => {
    const analysis = `Payment document. ${"Transfer detail. ".repeat(30)}Amount: 7000 KZT. Status: failed.`;
    const input = {
      direction: "inbound",
      imageUrl: "https://example.com/receipt.png",
      imageAnalysis: analysis,
      ragContext: `${"Ordinary page context. ".repeat(20)}PAGE_CONTEXT_END`,
    };
    const expanded = formatClassificationMessage(input, {
      preservePaymentEvidence: true,
    });

    expect(expanded).toContain("Amount: 7000 KZT. Status: failed.");
    expect(expanded).not.toContain("PAGE_CONTEXT_END");
    expect(formatClassificationMessage(input)).not.toContain("Status: failed.");
  });

  it("bounds expanded evidence text while retaining more than the ordinary context", () => {
    const text = `I paid. ${"a".repeat(600)} 7000 KZT. ${"b".repeat(1500)}TEXT_END`;
    const formatted = formatClassificationMessage(
      { direction: "inbound", text },
      { preservePaymentEvidence: true }
    );

    expect(formatted).toContain("7000 KZT");
    expect(formatted).not.toContain("TEXT_END");
    expect(formatted.slice("[Human] Customer: ".length).length).toBeLessThanOrEqual(
      1200
    );
  });

  it("adds compact structured commerce and flow context", () => {
    const formatted = formatClassificationMessage({
      text: "",
      direction: "inbound",
      author: { firstName: "Customer", isBot: false },
      ragContext: "Customer is viewing the pricing page for Premium.",
      whatsappFlowReply: {
        body: "Submitted checkout form",
        responseJson: JSON.stringify({
          selected_plan: "Premium",
          budget: "120000 KZT",
        }),
      },
      whatsappOrder: {
        totalQuantity: 2,
        totalAmount: 15000,
        currency: "KZT",
        productItems: [{ product_retailer_id: "SKU-1" }],
      },
      whatsappProductInquiry: { productRetailerId: "SKU-2" },
      whatsappTemplate: { name: "summer_offer", category: "MARKETING" },
    });

    expect(formatted).toContain(
      "[Page Context: Customer is viewing the pricing page for Premium.]"
    );
    expect(formatted).toContain(
      "[Flow Reply: Submitted checkout form; selected_plan=Premium; budget=120000 KZT]"
    );
    expect(formatted).toContain(
      "[WhatsApp Order: quantity 2; total 15000 KZT; products SKU-1]"
    );
    expect(formatted).toContain("[Product Inquiry: retailer SKU-2]");
    expect(formatted).toContain(
      "[Template Context: summer_offer; category MARKETING]"
    );
  });

  it("uses canonical service-message labels without stale template context", () => {
    const formatted = formatClassificationMessage({
      text: "[outbound]",
      direction: "outbound",
      whatsappServiceMessage: {
        version: 1,
        kind: "list",
        command: {
          kind: "list",
          body: "Choose a plan",
          buttonLabel: "View plans",
          sections: [
            {
              title: "Subscriptions",
              rows: [
                {
                  id: "premium",
                  title: "Premium",
                  description: "Priority support",
                },
              ],
            },
          ],
        },
      },
      whatsappTemplate: { name: "stale_template", category: "MARKETING" },
    });

    expect(formatted).toContain(
      "[Service Message: list; Choose a plan; View plans; Subscriptions; Premium; Priority support]"
    );
    expect(formatted).not.toContain("stale_template");
  });

  it("builds conversation-level context from denormalized fields", () => {
    const context = buildConversationMetadataContext({
      channel: "web_widget",
      page_url: "https://airi.chat/pricing",
      sourceId: "source-1",
      engagement_metrics: {
        messageCount: 4,
        inboundCount: 3,
        outboundCount: 1,
        score: 72,
      },
      whatsappReferral: {
        headline: "Spring sale",
        body: "Book before Friday",
        sourceType: "ad",
      },
    });

    expect(context).toContain("Channel: web_widget");
    expect(context).toContain("Source ID: source-1");
    expect(context).toContain("Widget page: https://airi.chat/pricing");
    expect(context).toContain(
      "Conversation engagement: score 72; messages 4; inbound 3; outbound 1"
    );
    expect(context).toContain(
      "WhatsApp referral: ad; Spring sale; Book before Friday"
    );
    expect(context).not.toContain("undefined");
  });

  it("resolves company and source identity from the claimed workspace", async () => {
    installStrictReadResults({
      workspaces: [
        { data: { id: "workspace-1", company_id: "company-1" }, error: null },
      ],
      companies: [
        {
          data: {
            id: "company-1",
            business_context: "premium retail support",
            airi_language: "ru",
          },
          error: null,
        },
      ],
      sources: [
        {
          data: {
            id: "source-1",
            workspace_id: "workspace-1",
            company_id: "company-1",
            type: "whatsapp",
          },
          error: null,
        },
      ],
    });

    await expect(
      resolveConversationClassificationBusinessContextStrict({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).resolves.toEqual({
      workspaceId: "workspace-1",
      companyId: "company-1",
      businessContext: "premium retail support",
      airiLanguage: "ru",
      source: { id: "source-1", type: "whatsapp" },
    });
    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual([
      "workspaces",
      "companies",
      "sources",
    ]);
  });

  it("defaults optional context only after required rows are read", async () => {
    installStrictReadResults({
      workspaces: [
        { data: { id: "workspace-1", company_id: "company-1" }, error: null },
      ],
      companies: [
        {
          data: {
            id: "company-1",
            business_context: null,
            airi_language: null,
          },
          error: null,
        },
      ],
    });

    await expect(
      resolveConversationClassificationBusinessContextStrict({
        workspaceId: "workspace-1",
        sourceId: null,
      })
    ).resolves.toEqual({
      workspaceId: "workspace-1",
      companyId: "company-1",
      businessContext: "customer support",
      airiLanguage: "en",
      source: null,
    });
  });

  it("rejects a non-null blank source identity instead of treating it as absent", async () => {
    installStrictReadResults({
      workspaces: [
        { data: { id: "workspace-1", company_id: "company-1" }, error: null },
      ],
      companies: [
        {
          data: {
            id: "company-1",
            business_context: "support",
            airi_language: "en",
          },
          error: null,
        },
      ],
    });

    await expect(
      resolveConversationClassificationBusinessContextStrict({
        workspaceId: "workspace-1",
        sourceId: "   ",
      })
    ).rejects.toMatchObject({ code: "source_read_failed", retryable: true });
  });

  it.each([
    [
      "business_context_read_failed",
      {
        workspaces: [
          { data: null, error: { message: "workspace transport failed" } },
        ],
      },
    ],
    [
      "workspace_not_found",
      { workspaces: [{ data: null, error: null }] },
    ],
    [
      "workspace_not_found",
      {
        workspaces: [
          {
            data: { id: "other-workspace", company_id: "company-1" },
            error: null,
          },
        ],
      },
    ],
    [
      "workspace_company_missing",
      {
        workspaces: [
          { data: { id: "workspace-1", company_id: null }, error: null },
        ],
      },
    ],
    [
      "company_not_found",
      {
        workspaces: [
          {
            data: { id: "workspace-1", company_id: "company-1" },
            error: null,
          },
        ],
        companies: [{ data: null, error: null }],
      },
    ],
    [
      "company_not_found",
      {
        workspaces: [
          {
            data: { id: "workspace-1", company_id: "company-1" },
            error: null,
          },
        ],
        companies: [
          {
            data: {
              id: "other-company",
              business_context: "wrong tenant",
              airi_language: "en",
            },
            error: null,
          },
        ],
      },
    ],
  ])("throws bounded %s instead of fabricating required identity", async (code, fixtures) => {
    installStrictReadResults(fixtures as Record<string, QueryResult[]>);

    await expect(
      resolveConversationClassificationBusinessContextStrict({
        workspaceId: "workspace-1",
        sourceId: null,
      })
    ).rejects.toMatchObject({ code, retryable: true });
  });

  it.each([
    ["source_read_failed", { data: null, error: { message: "source failed" } }],
    ["source_not_found", { data: null, error: null }],
    [
      "source_not_found",
      {
        data: {
          id: "other-source",
          workspace_id: "workspace-1",
          company_id: "company-1",
          type: "whatsapp",
        },
        error: null,
      },
    ],
    [
      "source_workspace_mismatch",
      {
        data: {
          id: "source-1",
          workspace_id: "other-workspace",
          company_id: "company-1",
          type: "whatsapp",
        },
        error: null,
      },
    ],
    [
      "source_company_mismatch",
      {
        data: {
          id: "source-1",
          workspace_id: "workspace-1",
          company_id: "other-company",
          type: "whatsapp",
        },
        error: null,
      },
    ],
    [
      "source_read_failed",
      {
        data: {
          id: "source-1",
          workspace_id: "workspace-1",
          company_id: "company-1",
          type: "   ",
        },
        error: null,
      },
    ],
  ])("rejects an untrusted source with %s", async (code, sourceResult) => {
    installStrictReadResults({
      workspaces: [
        { data: { id: "workspace-1", company_id: "company-1" }, error: null },
      ],
      companies: [
        {
          data: {
            id: "company-1",
            business_context: "support",
            airi_language: "en",
          },
          error: null,
        },
      ],
      sources: [sourceResult],
    });

    await expect(
      resolveConversationClassificationBusinessContextStrict({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).rejects.toMatchObject({ code, retryable: true });
  });
});
