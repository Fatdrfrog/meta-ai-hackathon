/** @jest-environment node */
const mockSupabaseAdmin = { from: jest.fn() };
const mockReadApprovedTemplates = jest.fn();
const mockScenario = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: mockSupabaseAdmin }));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/scenario", () => ({
  Scenario: { findOne: () => ({ lean: () => mockScenario() }) },
}));
jest.mock("@/lib/whatsapp/templates/send-lookup", () => ({
  listApprovedWhatsAppTemplatesForSend: jest.fn(),
  readApprovedWhatsAppTemplatesForSend: (...args: unknown[]) =>
    mockReadApprovedTemplates(...args),
}));

import {
  verifyBulkCampaignProvenanceCapability,
  verifyBulkCampaignScenarioScheduleCapability,
} from "./bulk-campaign-provenance";

const workspaceId = "workspace-1";
const scenarioId = "scenario-1";
const messageIntent = {
  kind: "whatsapp_template" as const,
  sourceId: "source-1",
  templateName: "promo",
  language: "en-US",
};

// A builder birthday campaign: a conversation-mode scenario whose bulk root
// stores no sourceIds, so the node run supplies the workspace source.
const builderScenario = {
  _id: scenarioId,
  workspaceId,
  mode: "conversation",
  deletedAt: null,
  nodes: [
    {
      id: "bulk-root",
      data: {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          channels: ["whatsapp"],
        },
      },
    },
    {
      id: "marketing-action",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "promo",
        actionWhatsAppTemplateLanguage: "en-US",
        actionWhatsAppTemplateCategory: "MARKETING",
      },
    },
  ],
  edges: [
    {
      source: "bulk-root",
      sourceHandle: "right-source",
      target: "marketing-action",
    },
  ],
};

beforeEach(() => {
  mockScenario.mockReset().mockResolvedValue(builderScenario);
  mockReadApprovedTemplates.mockReset().mockResolvedValue({
    templates: [
      {
        id: "template-promo",
        name: "promo",
        language: "en_US",
        status: "APPROVED",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Provider promo" }],
      },
    ],
    catalog: null,
  });
});

describe("bulk campaign provenance source reader", () => {
  it("reads a scheduled run's templates with the server-only source reader", async () => {
    await expect(
      verifyBulkCampaignScenarioScheduleCapability({
        workspaceId,
        scenarioId,
        scheduledNodeId: "bulk-root",
        channel: "whatsapp",
        messageIntent,
      } as Parameters<typeof verifyBulkCampaignScenarioScheduleCapability>[0])
    ).resolves.toBeDefined();

    expect(mockReadApprovedTemplates).toHaveBeenCalledWith(workspaceId, {
      sourceId: "source-1",
      supabase: mockSupabaseAdmin,
    });
  });

  it("keeps a signed-in send on the session-scoped source reader", async () => {
    await verifyBulkCampaignProvenanceCapability({
      workspaceId,
      intent: {
        kind: "scenario_run_now",
        scenarioId,
        rootNodeId: "bulk-root",
        actionNodeId: "marketing-action",
      },
      channel: "whatsapp",
      messageIntent,
    } as Parameters<typeof verifyBulkCampaignProvenanceCapability>[0]);

    expect(mockReadApprovedTemplates).toHaveBeenCalledWith(workspaceId, {
      sourceId: "source-1",
    });
  });
});
