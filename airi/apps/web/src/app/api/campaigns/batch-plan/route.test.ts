const mockCreateClient = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockResolveCampaignBatchPlanPreview = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@/lib/campaign/campaign-batch-plan", () => ({
  resolveCampaignBatchPlanPreview: (...args: unknown[]) =>
    mockResolveCampaignBatchPlanPreview(...args),
}));

import { GET } from "./route";
import { supabaseAuth } from "@/test-support/supabase-auth-test-utils";

function authenticatedClient() {
  const maybeSingle = jest.fn().mockResolvedValue({
    data: { workspace_id: "workspace-1" },
    error: null,
  });
  const eqWorkspace = jest.fn(() => ({ maybeSingle }));
  const eqUser = jest.fn(() => ({ eq: eqWorkspace }));
  const select = jest.fn(() => ({ eq: eqUser }));

  return {
    auth: supabaseAuth(),
    from: jest.fn(() => ({ select })),
  };
}

describe("GET /api/campaigns/batch-plan", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockResolvedValue(authenticatedClient());
    mockResolveCampaignBatchPlanPreview.mockResolvedValue({
      channel: "whatsapp",
      batchPlan: {
        targetBatchSize: 100,
        maxParallelBatches: 2,
        interBatchDelayMs: 1_000,
      },
      recipientLimit: {
        maxRecipients: 1_000,
        source: "live_meta",
      },
      whatsappMeta: {
        phoneNumberId: "phone-number-1",
        detailsSource: "meta_phone_details",
      },
    });
  });

  it("returns the authenticated source used to resolve the WhatsApp plan", async () => {
    mockResolveWhatsAppSendContext.mockResolvedValue({
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      accessToken: "secret-token",
    });

    const response = await GET(
      new Request(
        "http://localhost/api/campaigns/batch-plan?workspaceId=workspace-1&channel=whatsapp"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        configured: true,
        whatsappMeta: expect.objectContaining({
          sourceId: "source-1",
          phoneNumberId: "phone-number-1",
        }),
      })
    );
  });

  it("checks the selected source's WABA and returns uncached readiness", async () => {
    mockResolveWhatsAppSendContext.mockResolvedValue({
      sourceId: "selected-source",
      wabaId: "selected-waba",
      phoneNumberId: "selected-phone",
      accessToken: "secret-token",
    });
    const readiness = {
      state: "blocked",
      checkedAt: new Date().toISOString(),
      remainingCapacity: null,
      reasons: [{ code: "meta_business_limit", providerCode: "141015" }],
    };
    mockResolveCampaignBatchPlanPreview.mockResolvedValue({
      channel: "whatsapp",
      readiness,
    });
    const response = await GET(
      new Request(
        "http://localhost/api/campaigns/batch-plan?workspaceId=workspace-1&channel=whatsapp&sourceId=selected-source"
      )
    );
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "selected-source",
    });
    expect(mockResolveCampaignBatchPlanPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        wabaId: "selected-waba",
        phoneNumberId: "selected-phone",
      })
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).readiness).toEqual(readiness);
  });

  it("fails closed when the resolved WhatsApp context has no source", async () => {
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone-number-1",
      accessToken: "secret-token",
    });

    const response = await GET(
      new Request(
        "http://localhost/api/campaigns/batch-plan?workspaceId=workspace-1&channel=whatsapp"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        configured: false,
        channel: "whatsapp",
        code: "whatsapp_not_connected",
        error: "WhatsApp credentials are incomplete for this workspace.",
      })
    );
    expect(mockResolveCampaignBatchPlanPreview).not.toHaveBeenCalled();
  });

  it("tells a connected number with missing credentials apart from no number", async () => {
    mockResolveWhatsAppSendContext.mockResolvedValue({
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      accessToken: null,
    });

    const response = await GET(
      new Request(
        "http://localhost/api/campaigns/batch-plan?workspaceId=workspace-1&channel=whatsapp"
      )
    );

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        configured: false,
        code: "whatsapp_credentials_incomplete",
      })
    );
  });

  it("reports no number when the workspace has no WhatsApp source", async () => {
    mockResolveWhatsAppSendContext.mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://localhost/api/campaigns/batch-plan?workspaceId=workspace-1&channel=whatsapp"
      )
    );

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        configured: false,
        code: "whatsapp_not_connected",
      })
    );
  });
});
