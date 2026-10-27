import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";
import { Types } from "mongoose";

import { buildCampaignAudienceQueryDefinition } from "./campaign-audience";

describe("buildCampaignAudienceQueryDefinition", () => {
  it("does not exclude WhatsApp marketing conversations without opt-in", () => {
    const currentFilter = buildCurrentConversationClassificationFilter();
    const definition = buildCampaignAudienceQueryDefinition({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      templateCategory: "MARKETING",
      category: "lead",
    });

    expect(definition.deliveryBaseQuery).toEqual({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      "classification.category": "lead",
      ...currentFilter,
    });
    expect(definition.eligibleQuery).toEqual({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      "classification.category": "lead",
      ...currentFilter,
    });
    expect(definition.marketingOptInConsentQuery).toEqual({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      "classification.category": "lead",
      ...currentFilter,
      "whatsapp_opt_in.status": true,
    });
  });

  it("preserves the exact current predicate through base, delivery, already-sent, and normal eligibility queries", () => {
    const scenarioId = new Types.ObjectId();
    const currentFilter = buildCurrentConversationClassificationFilter();
    const definition = buildCampaignAudienceQueryDefinition({
      workspaceId: "workspace-1",
      channel: "email",
      category: "sales_qualified",
      scenarioId,
      nodeId: "node-1",
    });
    const base = {
      workspaceId: "workspace-1",
      channel: "email",
      "classification.category": "sales_qualified",
      ...currentFilter,
    };
    const historyElemMatch = {
      nodeId: "node-1",
      $or: [{ scenarioId }, { scheduleId: scenarioId }],
    };

    expect(definition.baseQuery).toEqual(base);
    expect(definition.deliveryBaseQuery).toEqual(base);
    expect(definition.alreadySentQuery).toEqual({
      ...base,
      bulk_campaign_history: { $elemMatch: historyElemMatch },
    });
    expect(definition.eligibleQuery).toEqual({
      ...base,
      bulk_campaign_history: {
        $not: { $elemMatch: historyElemMatch },
      },
    });
  });

  it("preserves the exact current predicate in relative history eligibility", () => {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const scenarioId = new Types.ObjectId();
    const currentFilter = buildCurrentConversationClassificationFilter();
    const definition = buildCampaignAudienceQueryDefinition({
      workspaceId: "workspace-1",
      channel: "telegram",
      category: "active",
      scheduleType: "relative",
      delayDays: 2,
      now,
      incomingNodeIds: ["previous-node"],
      scenarioId,
      nodeId: "node-1",
    });

    expect(definition.eligibleQuery).toEqual({
      workspaceId: "workspace-1",
      channel: "telegram",
      "classification.category": "active",
      ...currentFilter,
      $and: [
        {
          bulk_campaign_history: {
            $elemMatch: {
              nodeId: { $in: ["previous-node"] },
              sentAt: { $lte: new Date("2026-08-09T12:00:00.000Z") },
              $or: [{ scenarioId }, { scheduleId: scenarioId }],
            },
          },
        },
        {
          bulk_campaign_history: {
            $not: {
              $elemMatch: {
                nodeId: "node-1",
                $or: [{ scenarioId }, { scheduleId: scenarioId }],
              },
            },
          },
        },
      ],
    });
  });

  it("preserves the exact current predicate in relative created-at eligibility", () => {
    const currentFilter = buildCurrentConversationClassificationFilter();
    const definition = buildCampaignAudienceQueryDefinition({
      workspaceId: "workspace-1",
      channel: "email",
      category: "active",
      scheduleType: "relative",
      delayDays: 1,
      now: new Date("2026-08-11T12:00:00.000Z"),
    });

    expect(definition.eligibleQuery).toEqual({
      workspaceId: "workspace-1",
      channel: "email",
      "classification.category": "active",
      ...currentFilter,
      createdAt: { $lte: new Date("2026-08-10T12:00:00.000Z") },
    });
  });

  it("keeps explicit-ID and manual-label-only targeting independent", () => {
    const selectedId = new Types.ObjectId();
    const explicit = buildCampaignAudienceQueryDefinition({
      workspaceId: "workspace-1",
      channel: "email",
      targetingMode: "explicit",
      selectedConversationIds: [selectedId.toHexString()],
      category: "active",
    });
    const manualLabel = buildCampaignAudienceQueryDefinition({
      workspaceId: "workspace-1",
      channel: "email",
      internalLabel: "vip",
    });

    expect(explicit.baseQuery).toEqual({
      workspaceId: "workspace-1",
      channel: "email",
      _id: { $in: [selectedId] },
    });
    expect(manualLabel.baseQuery).toEqual({
      workspaceId: "workspace-1",
      channel: "email",
      internal_labels: "vip",
    });
    for (const query of [
      explicit.baseQuery,
      explicit.deliveryBaseQuery,
      explicit.eligibleQuery,
      manualLabel.baseQuery,
      manualLabel.deliveryBaseQuery,
      manualLabel.eligibleQuery,
    ]) {
      expect(query).not.toHaveProperty("$expr");
      expect(query).not.toHaveProperty("is_classified");
      expect(query).not.toHaveProperty("classification.category");
    }
  });
});
