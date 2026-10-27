import {
  Conversation,
  CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC,
  CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC,
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_KEYS,
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME,
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_PARTIAL_FILTER,
  CONVERSATION_CLASSIFICATION_PENDING_INDEX_KEYS,
  CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME,
  CONVERSATION_CLASSIFICATION_PENDING_PARTIAL_FILTER,
  CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_KEYS,
  CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME,
  CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_KEYS,
  CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_NAME,
  CONVERSATION_INSTAGRAM_REFERRAL_AD_PARTIAL_FILTER,
  CONVERSATION_REQUESTS_BACKFILL_INDEX_KEYS,
  CONVERSATION_REQUESTS_BACKFILL_INDEX_NAME,
  CONVERSATION_VISIBILITY_GATE_INDEX_KEYS,
  CONVERSATION_VISIBILITY_GATE_INDEX_NAME,
  CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_KEYS,
  CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_NAME,
  CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_KEYS,
  CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_NAME,
} from "../conversation";

describe("Conversation indexes", () => {
  it("indexes offline evaluation dates only for conversations with both classifications", () => {
    expect(Conversation.schema.indexes()).toContainEqual([
      { createdAt: 1 },
      expect.objectContaining({
        name: "conversations_offline_eval_created_v1",
        partialFilterExpression: {
          "classification.category": { $exists: true },
          "shadow_classification.category": { $exists: true },
        },
      }),
    ]);
  });
  it("declares partial unique WhatsApp ownership indexes without enrolling default empty aliases", () => {
    for (const spec of [CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC, CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC]) {
      expect(Conversation.schema.indexes()).toContainEqual([spec.keys, expect.objectContaining(spec.options)]);
    }
    expect(new Conversation().get("whatsappConversationIdentityKey")).toBeUndefined();
    expect(new Conversation().get("whatsappConversationIdentityKeys")).toBeUndefined();
  });
  it("does not recreate the redundant workspace prefix", () => {
    expect(Conversation.schema.indexes().some(([keys]) => JSON.stringify(keys) === JSON.stringify({ workspaceId: 1 }))).toBe(false);
  });
  it.each(["user", "chat"])("indexes cross-workspace %s dependency pages without narrowing Mixed IDs", field => {
    expect(Conversation.schema.indexes()).toContainEqual([
      { [field]: 1, _id: 1 },
      expect.objectContaining({ name: `conversations_requests_${field}_id_v1` }),
    ]);
    const definition = Conversation.schema.indexes().find(([keys]) =>
      JSON.stringify(keys) === JSON.stringify({ [field]: 1, _id: 1 })
    );
    expect(definition?.[1].partialFilterExpression).toBeUndefined();
    expect(definition?.[1].unique).not.toBe(true);
    expect(Conversation.schema.path(field).instance).toBe("Mixed");
  });

  it("declares a covering oldest-first company visibility index", () => {
    expect(CONVERSATION_VISIBILITY_GATE_INDEX_KEYS).toEqual({
      workspaceId: 1,
      createdAt: 1,
      _id: 1,
    });
    expect(Object.entries(CONVERSATION_VISIBILITY_GATE_INDEX_KEYS)).toEqual([
      ["workspaceId", 1],
      ["createdAt", 1],
      ["_id", 1],
    ]);
    expect(CONVERSATION_VISIBILITY_GATE_INDEX_NAME).toBe(
      "conversations_workspace_created_id_asc_v1"
    );
    expect(Conversation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { workspaceId: 1, createdAt: 1, _id: 1 },
          expect.objectContaining({
            name: "conversations_workspace_created_id_asc_v1",
          }),
        ],
      ])
    );
  });

  it("casts legacy-routing provenance through set and unset updates", async () => {
    const updateOne = jest
      .spyOn(Conversation.collection, "updateOne")
      .mockResolvedValue({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
      });
    const provenance = {
      kind: "interactive_no_reply_assignment",
      conditionNodeId: "condition-1",
      sourceActionNodeId: "action-1",
    } as const;

    try {
      await Conversation.updateOne(
        { workspaceId: "workspace-1" },
        {
          $set: {
            "airi_scenario_state.pendingLegacyRouting": provenance,
          },
        }
      );
      await Conversation.updateOne(
        { workspaceId: "workspace-1" },
        {
          $unset: {
            "airi_scenario_state.pendingLegacyRouting": "",
          },
        }
      );

      expect(updateOne.mock.calls[0][1]).toMatchObject({
        $set: {
          "airi_scenario_state.pendingLegacyRouting": provenance,
        },
      });
      expect(updateOne.mock.calls[1][1]).toMatchObject({
        $unset: {
          "airi_scenario_state.pendingLegacyRouting": "",
        },
      });
      expect(
        Conversation.schema.path(
          "airi_scenario_state.pendingLegacyRouting.conditionNodeId"
        )
      ).toBeDefined();
    } finally {
      updateOne.mockRestore();
    }
  });

  it("declares separate due-work and expired-lease classification indexes", () => {
    expect(Conversation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          CONVERSATION_CLASSIFICATION_PENDING_INDEX_KEYS,
          expect.objectContaining({
            name: CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME,
            partialFilterExpression:
              CONVERSATION_CLASSIFICATION_PENDING_PARTIAL_FILTER,
          }),
        ],
        [
          CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_KEYS,
          expect.objectContaining({
            name: CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME,
            partialFilterExpression:
              CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_PARTIAL_FILTER,
          }),
        ],
      ])
    );
    expect(CONVERSATION_CLASSIFICATION_PENDING_PARTIAL_FILTER).toEqual({
      "classification_state.contractVersion": 2,
      "classification_state.status": { $in: ["pending", "blocked"] },
    });
  });

  it("declares the Instagram referral ad audience index", () => {
    expect(Conversation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_KEYS,
          expect.objectContaining({
            name: CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_NAME,
            partialFilterExpression:
              CONVERSATION_INSTAGRAM_REFERRAL_AD_PARTIAL_FILTER,
          }),
        ],
      ])
    );
  });

  it("declares first-response read-model fields", () => {
    expect(Conversation.schema.path("first_response_at")).toBeDefined();
    expect(Conversation.schema.path("first_response_seconds")).toBeDefined();
    expect(Conversation.schema.path("first_response_manager_id")).toBeDefined();
    expect(
      Conversation.schema.path("first_response_manager_name")
    ).toBeDefined();
  });

  it("declares the first-response analytics index its reader hints", () => {
    expect(Conversation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_KEYS,
          expect.objectContaining({
            name: CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME,
          }),
        ],
      ])
    );
  });

  const declares = (keys: Record<string, number>) =>
    Conversation.schema
      .indexes()
      .some(([actual]) => JSON.stringify(actual) === JSON.stringify(keys));

  it.each([
    { workspaceId: 1, rename: 1 },
    { workspaceId: 1, channel: 1, subject: 1, createdAt: -1 },
    { workspaceId: 1, "engagement_metrics.score": -1, lastMessageAt: -1 },
    {
      workspaceId: 1,
      channel: 1,
      "engagement_metrics.score": -1,
      lastMessageAt: -1,
    },
    {
      workspaceId: 1,
      channel: 1,
      "classification.category": 1,
      "whatsapp_opt_in.status": 1,
      lastMessageAt: -1,
    },
    { workspaceId: 1, channel: 1, "whatsapp_opt_in.status": 1 },
    { workspaceId: 1, channel: 1, internal_labels: 1, lastMessageAt: -1 },
    { workspaceId: 1, channel: 1, page_url: 1 },
    { workspaceId: 1, channel: 1, visitor_id: 1 },
    { workspaceId: 1, channel: 1, last_outbound_at: -1 },
    { customerId: 1 },
    { sourceId: 1 },
    { workspaceId: 1, churn_risk_level: 1, lastMessageAt: -1 },
    { workspaceId: 1, "whatsappReferral.ctwaClid": 1 },
    { workspaceId: 1, first_response_manager_id: 1, first_inbound_at: 1 },
    { workspaceId: 1, chat: 1, lastMessageAt: -1 },
    { workspaceId: 1, "external_thread.provider": 1 },
    { workspaceId: 1, handled_by_agent_id: 1 },
    { workspaceId: 1, "followUpAudience.analyzedAt": -1, lastMessageAt: -1 },
    { workspaceId: 1, "followUpAudience.effectiveCategoryKey": 1 },
    { workspaceId: 1, channel: 1, "followUpAudience.status": 1 },
  ])("does not declare an index retired after the 2026-10-20 review %j", keys => {
    expect(declares(keys)).toBe(false);
  });

  it.each([
    { workspaceId: 1, status: 1, lastMessageAt: -1 },
    { workspaceId: 1, is_read_by_manager: 1, lastMessageAt: -1 },
    { workspaceId: 1, customerId: 1, lastMessageAt: -1 },
    { workspaceId: 1, channel: 1, last_inbound_at: -1 },
    { workspaceId: 1, "classification.category": 1 },
    { workspaceId: 1, internal_labels: 1 },
    { workspaceId: 1, channel: 1, lastMessageAt: -1 },
    { workspaceId: 1, chat: 1, createdAt: -1 },
    { workspaceId: 1, visitor_id: 1, channel: 1, lastMessageAt: -1 },
    {
      workspaceId: 1,
      channel: 1,
      "bulk_campaign_history.scheduleId": 1,
      "bulk_campaign_history.scenarioId": 1,
      "bulk_campaign_history.nodeId": 1,
      "bulk_campaign_history.sentAt": -1,
    },
  ])("keeps the index %j that production queries rely on", keys => {
    expect(declares(keys)).toBe(true);
  });

  it("declares WhatsApp source identity lookup indexes", () => {
    expect(Conversation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_KEYS,
          expect.objectContaining({
            name: CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_NAME,
          }),
        ],
        [
          CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_KEYS,
          expect.objectContaining({
            name: CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_NAME,
          }),
        ],
      ])
    );
  });

  it("declares the resumable workspace Requests backfill index", () => {
    expect(CONVERSATION_REQUESTS_BACKFILL_INDEX_KEYS).toEqual({
      workspaceId: 1,
      _id: 1,
    });
    expect(Conversation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          CONVERSATION_REQUESTS_BACKFILL_INDEX_KEYS,
          expect.objectContaining({
            name: CONVERSATION_REQUESTS_BACKFILL_INDEX_NAME,
          }),
        ],
      ])
    );
  });
});
