import { NextRequest } from "next/server";

const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockPreviewGeneratedBulkCampaignEligibility = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/campaign/generated-bulk-send-orchestrator", () => ({
  previewGeneratedBulkCampaignEligibility: (...args: unknown[]) =>
    mockPreviewGeneratedBulkCampaignEligibility(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

import { BulkCampaignEligibilityError } from "@/lib/campaign/bulk-campaign-recipient-eligibility";
import { WhatsAppTemplateCatalogError } from "@/lib/whatsapp/templates/catalog-contracts";

import { POST } from "./route";

const SCENARIO_ID = "65f000000000000000000002";

function post(body: unknown, scenarioId = SCENARIO_ID) {
  return POST(
    new NextRequest(
      `https://airi.chat/api/scenarios/${scenarioId}/bulk-recipient-eligibility`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    ),
    { params: Promise.resolve({ scenarioId }) }
  );
}

describe("POST /api/scenarios/[scenarioId]/bulk-recipient-eligibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mockPreviewGeneratedBulkCampaignEligibility.mockResolvedValue({
      status: 200,
      body: {
        state: "ready",
        requestedTotal: 2,
        acceptedTotal: 1,
        uniqueRecipients: { requested: 2, accepted: 1 },
        skippedByReason: { prior_failure: 1 },
        warnings: { missingMarketingConsent: 0 },
        allExcluded: false,
      },
    });
  });

  it("authenticates the identifier-only workspace before loading the persisted revision", async () => {
    const response = await post({
      workspaceId: "workspace-1",
      observedPlanRevision: "plan-observation-1",
    });

    expect(response.status).toBe(200);
    expect(mockRequireScenarioWorkspaceAccess).toHaveBeenCalledWith(
      "workspace-1"
    );
    expect(mockPreviewGeneratedBulkCampaignEligibility).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId: SCENARIO_ID,
      observedPlanRevision: "plan-observation-1",
    });
  });

  it.each([
    ["revision", "client-revision"],
    ["recipientPolicy", { version: 1, excludePriorFailedBulkSends: true }],
    ["excludePriorFailedBulkSends", true],
    ["audience", { kind: "inline", recipients: [] }],
    ["recipients", [{ phone: "+15550000001" }]],
    ["analyticsAudience", { type: "bulk_analytics" }],
    ["unknown", "must-not-be-stripped"],
  ])("rejects the preview override key %s", async (key, value) => {
    const response = await post({ workspaceId: "workspace-1", [key]: value });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(mockRequireScenarioWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockPreviewGeneratedBulkCampaignEligibility).not.toHaveBeenCalled();
  });

  it("returns a deferred marker without accepting future recipient materialization", async () => {
    mockPreviewGeneratedBulkCampaignEligibility.mockResolvedValue({
      status: 200,
      body: {
        state: "deferred",
        appliesAt: "each_run",
        policy: { version: 1, excludePriorFailedBulkSends: true },
      },
    });

    const response = await post({ workspaceId: "workspace-1" });

    expect(await response.json()).toEqual({
      state: "deferred",
      appliesAt: "each_run",
      policy: { version: 1, excludePriorFailedBulkSends: true },
    });
  });

  it("returns access denial before any Scenario or revision lookup", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });

    const response = await post({ workspaceId: "workspace-foreign" });

    expect(response.status).toBe(403);
    expect(mockPreviewGeneratedBulkCampaignEligibility).not.toHaveBeenCalled();
  });

  it("rejects malformed identifiers before authentication", async () => {
    const badScenario = await post(
      { workspaceId: "workspace-1" },
      "not-an-object-id"
    );
    const missingWorkspace = await post({});

    expect(badScenario.status).toBe(400);
    expect(missingWorkspace.status).toBe(400);
    expect(mockRequireScenarioWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("answers a Meta rate limit with a coded 503 and Retry-After", async () => {
    const catalogError = new WhatsAppTemplateCatalogError({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      message: "Meta temporarily limited WhatsApp template requests.",
      providerCode: 80008,
    });
    mockPreviewGeneratedBulkCampaignEligibility.mockRejectedValue(
      new BulkCampaignEligibilityError("meta_rate_limited", {
        cause: catalogError,
        retryAfterSeconds: 240,
      })
    );

    const response = await post({ workspaceId: "workspace-1" });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("240");
    expect(await response.json()).toEqual({
      state: "blocked",
      error: { code: "meta_rate_limited" },
      retryAfterSeconds: 240,
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId: "workspace-1",
        code: "meta_rate_limited",
        catalogCode: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        providerCode: 80008,
      })
    );
  });

  it("answers an unexpected failure with a coded 503 instead of a bare 500", async () => {
    mockPreviewGeneratedBulkCampaignEligibility.mockRejectedValue(
      new Error("Mongo connection lost")
    );

    const response = await post({ workspaceId: "workspace-1" });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual({
      state: "blocked",
      error: { code: "eligibility_lookup_failed" },
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId: "workspace-1",
        code: "eligibility_lookup_failed",
        message: "Mongo connection lost",
      })
    );
  });

  it("does not attribute a failed access check to the requested workspace", async () => {
    mockRequireScenarioWorkspaceAccess.mockRejectedValue(
      new Error("Supabase unavailable")
    );

    const response = await post({ workspaceId: "workspace-1" });

    expect(response.status).toBe(503);
    expect(mockPreviewGeneratedBulkCampaignEligibility).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({ workspaceId: null })
    );
    // No policy event is emitted without a granted workspace.
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});
