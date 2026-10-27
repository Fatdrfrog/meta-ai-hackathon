import {
  createBulkCampaignTerminalReplayPolicyEvent,
  createBulkCampaignTerminalReplayFactsUnavailableEvent,
  emitBulkCampaignPolicyEvent,
  parseBulkCampaignPersistedPolicyEventFacts,
  type BulkCampaignLegacyReplayEvent,
  type BulkCampaignPolicyEvent,
} from "./bulk-campaign-observability";

describe("bulk campaign policy observability", () => {
  it("emits a terminal replay fallback without mutable request facts", () => {
    const logger = { info: jest.fn() };
    const event = {
      ...createBulkCampaignTerminalReplayFactsUnavailableEvent({
        workspaceId: "00000000-0000-4000-8000-000000000101",
      }),
      channel: "whatsapp",
      recipients: [{ phone: "+15550000002" }],
    } as never;

    emitBulkCampaignPolicyEvent(logger, event);

    expect(logger.info).toHaveBeenCalledWith("bulk_campaign.policy", {
      workspaceId: "00000000-0000-4000-8000-000000000101",
      factsUnavailable: "terminal_replay",
      errorCode: "bulk_campaign_terminal_replay",
      idempotentReplay: true,
    });
    expect(JSON.stringify(logger.info.mock.calls[0]?.[1])).not.toMatch(
      /whatsapp|15550000002/
    );
  });

  it.each(["failed", "expired", "cancelled", "completed"] as const)(
    "projects immutable aggregate terminal replay facts for %s",
    dispatchStatus => {
      const event = createBulkCampaignTerminalReplayPolicyEvent({
        replay: {
          workspaceId: "00000000-0000-4000-8000-000000000101",
          channel: "whatsapp",
          messageKind: "template",
          executionSource: "scenario_run_now",
          scenarioId: "scenario-persisted",
          rootNodeId: "root-persisted",
          planLimit: { source: "cached_meta", value: 1 },
          policy: { version: 1, excludePriorFailedBulkSends: true },
        },
        outcome: {
          disposition: "queued",
          evaluatedAt: "2026-08-21T00:00:00.000Z",
          lifecycleStatus: "queued",
          requestedTotal: 3,
          acceptedTotal: 1,
          queuedTotal: 1,
          uniqueRecipients: { requested: 3, accepted: 1, queued: 1 },
          skippedByReason: { prior_failure: 2 },
          warnings: { missingMarketingConsent: 0 },
        },
        dispatchStatus,
      });

      expect(event).toEqual({
        workspaceId: "00000000-0000-4000-8000-000000000101",
        channel: "whatsapp",
        messageKind: "template",
        executionSource: "scenario_run_now",
        scenarioId: "scenario-persisted",
        rootNodeId: "root-persisted",
        itemCounts: { requested: 3, accepted: 1, queued: 0 },
        uniqueRecipientCounts: { requested: 3, accepted: 1, queued: 0 },
        skippedByReason: { prior_failure: 2 },
        warnings: { missingMarketingConsent: 0 },
        disposition: "blocked",
        lifecycleStatus: dispatchStatus,
        planLimit: { source: "cached_meta", value: 1 },
        policy: { version: 1, excludePriorFailedBulkSends: true },
        errorCode: "bulk_campaign_terminal_replay",
        idempotentReplay: true,
      });
    }
  );

  it("emits one aggregate-only event and drops recipient-shaped extra fields", () => {
    const logger = { info: jest.fn() };

    const event: BulkCampaignPolicyEvent = {
      workspaceId: "00000000-0000-4000-8000-000000000101",
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "scenario_run_now",
      scenarioId: "scenario-1",
      rootNodeId: "root-1",
      itemCounts: { requested: 4, accepted: 1, queued: 1 },
      uniqueRecipientCounts: { requested: 4, accepted: 1, queued: 1 },
      skippedByReason: { prior_failure: 2, recipient_limit: 1 },
      warnings: { missingMarketingConsent: 1 },
      disposition: "queued",
      lifecycleStatus: "queued",
      planLimit: { source: "live_meta", value: 2 },
      policy: { version: 1, excludePriorFailedBulkSends: true },
      errorCode: null,
      idempotentReplay: false,
      // @ts-expect-error Raw recipient data is intentionally not part of the event contract.
      recipients: [{ phone: "+77000000001" }],
      recipientHashes: ["secret-hash"],
      variables: { name: "Private" },
      templateBody: "Hello {{name}}",
    };
    emitBulkCampaignPolicyEvent(logger, event);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "bulk_campaign.policy",
      expect.objectContaining({
        workspaceId: "00000000-0000-4000-8000-000000000101",
        itemCounts: { requested: 4, accepted: 1, queued: 1 },
        skippedByReason: { prior_failure: 2, recipient_limit: 1 },
      })
    );
    const emitted = logger.info.mock.calls[0][1];
    expect(emitted).not.toHaveProperty("recipients");
    expect(emitted).not.toHaveProperty("recipientHashes");
    expect(emitted).not.toHaveProperty("variables");
    expect(emitted).not.toHaveProperty("templateBody");
    expect(JSON.stringify(emitted)).not.toContain("77000000001");
    expect(JSON.stringify(emitted)).not.toContain("secret-hash");
    expect(JSON.stringify(emitted)).not.toContain("Private");
  });

  it("deeply allowlists every nested aggregate before emitting", () => {
    const logger = { info: jest.fn() };
    const malicious = {
      workspaceId: "00000000-0000-4000-8000-000000000101",
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "ad_hoc",
      itemCounts: {
        requested: 3,
        accepted: 1,
        queued: 1,
        phone: "+77000000002",
      },
      uniqueRecipientCounts: {
        requested: 2,
        accepted: 1,
        queued: 1,
        recipientHash: "nested-secret-hash",
      },
      skippedByReason: {
        ineligible: 2,
        variables: { customer: "Nested Private" },
      },
      warnings: {
        missingMarketingConsent: 0,
        body: "private template body",
      },
      disposition: "queued",
      lifecycleStatus: "queued",
      planLimit: {
        source: "live_meta",
        value: 1,
        recipient: { phone: "+77000000003" },
      },
      policy: {
        version: 1,
        excludePriorFailedBulkSends: false,
        recipientHashes: ["policy-secret-hash"],
      },
      idempotentReplay: false,
    } as unknown as BulkCampaignPolicyEvent;

    emitBulkCampaignPolicyEvent(logger, malicious);

    expect(logger.info).toHaveBeenCalledWith("bulk_campaign.policy", {
      workspaceId: "00000000-0000-4000-8000-000000000101",
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "ad_hoc",
      itemCounts: { requested: 3, accepted: 1, queued: 1 },
      uniqueRecipientCounts: { requested: 2, accepted: 1, queued: 1 },
      skippedByReason: { ineligible: 2 },
      warnings: { missingMarketingConsent: 0 },
      disposition: "queued",
      lifecycleStatus: "queued",
      planLimit: { source: "live_meta", value: 1 },
      policy: { version: 1, excludePriorFailedBulkSends: false },
      idempotentReplay: false,
    });
    const serialized = JSON.stringify(logger.info.mock.calls[0]?.[1]);
    expect(serialized).not.toMatch(
      /77000000002|77000000003|nested-secret-hash|Nested Private|private template body|policy-secret-hash/
    );
  });

  it("strictly validates persisted event enums, counts, plan, policy, and nested fields", () => {
    const valid = {
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "scenario_run_now",
      scenarioId: "scenario-1",
      rootNodeId: "root-1",
      itemCounts: { requested: 3, accepted: 1, queued: 1 },
      uniqueRecipientCounts: { requested: 2, accepted: 1, queued: 1 },
      skippedByReason: { ineligible: 2 },
      warnings: { missingMarketingConsent: 0 },
      disposition: "queued",
      lifecycleStatus: "queued",
      planLimit: { source: "live_meta", value: 1 },
      policy: { version: 1, excludePriorFailedBulkSends: false },
    };

    expect(parseBulkCampaignPersistedPolicyEventFacts(valid)).toEqual(valid);
    const invalid = [
      { ...valid, channel: "reader@example.com" },
      {
        ...valid,
        itemCounts: { ...valid.itemCounts, requested: "+15550000002" },
      },
      { ...valid, itemCounts: { ...valid.itemCounts, requested: -1 } },
      { ...valid, itemCounts: { ...valid.itemCounts, requested: 1.5 } },
      {
        ...valid,
        itemCounts: {
          ...valid.itemCounts,
          requested: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      {
        ...valid,
        itemCounts: { ...valid.itemCounts, phone: "+15550000002" },
      },
      { ...valid, planLimit: { source: "live_meta", value: null } },
      { ...valid, planLimit: { source: "unavailable", value: 1 } },
      {
        ...valid,
        policy: { version: 2, excludePriorFailedBulkSends: false },
      },
      {
        ...valid,
        warnings: {
          missingMarketingConsent: 0,
          email: "reader@example.com",
        },
      },
      { ...valid, recipients: [{ phone: "+15550000002" }] },
    ];
    for (const value of invalid) {
      expect(parseBulkCampaignPersistedPolicyEventFacts(value)).toBeNull();
    }
  });

  it("emits response-only legacy replay facts without inventing request context", () => {
    const logger = { info: jest.fn() };
    const legacyReplay: BulkCampaignLegacyReplayEvent = {
      workspaceId: "00000000-0000-4000-8000-000000000101",
      factsUnavailable: "legacy_response_only",
      itemCounts: { requested: 2, accepted: 0, queued: 0 },
      uniqueRecipientCounts: { requested: 1, accepted: 0, queued: 0 },
      skippedByReason: { ineligible: 2 },
      warnings: { missingMarketingConsent: 0 },
      disposition: "no_op",
      lifecycleStatus: "completed",
      idempotentReplay: true,
    };

    emitBulkCampaignPolicyEvent(logger, legacyReplay);

    expect(logger.info).toHaveBeenCalledWith("bulk_campaign.policy", {
      workspaceId: "00000000-0000-4000-8000-000000000101",
      factsUnavailable: "legacy_response_only",
      itemCounts: { requested: 2, accepted: 0, queued: 0 },
      uniqueRecipientCounts: { requested: 1, accepted: 0, queued: 0 },
      skippedByReason: { ineligible: 2 },
      warnings: { missingMarketingConsent: 0 },
      disposition: "no_op",
      lifecycleStatus: "completed",
      idempotentReplay: true,
    });
    const emitted = logger.info.mock.calls[0]?.[1];
    expect(emitted).not.toHaveProperty("channel");
    expect(emitted).not.toHaveProperty("messageKind");
    expect(emitted).not.toHaveProperty("executionSource");
    expect(emitted).not.toHaveProperty("planLimit");
    expect(emitted).not.toHaveProperty("policy");
  });
});
