import assert from "node:assert/strict";
import test from "node:test";

import {
  isBulkCampaignReadiness,
  isBulkCampaignRootNode,
  mergeBulkCampaignReadiness,
  normalizeBulkCampaignRecipientPolicy,
  type BulkCampaignReadiness,
  type BulkCampaignAudienceIntent,
} from "./scenario-bulk";

const ready: BulkCampaignReadiness = {
  state: "ready",
  checkedAt: "2026-09-15T19:00:00.000Z",
  remainingCapacity: null,
  reasons: [],
};

test("readiness rejects malformed or contradictory decisions", () => {
  for (const value of [
    undefined,
    {},
    { ...ready, checkedAt: "bad" },
    { ...ready, remainingCapacity: 250 },
    { ...ready, state: "blocked" },
    { ...ready, reasons: [{ code: "meta_billing" }] },
    { ...ready, state: "unavailable", reasons: [{ code: "unknown" }] },
    {
      ...ready,
      state: "blocked",
      reasons: [
        { code: "contact_frequency_limit", affectedRecipientCount: -1 },
      ],
    },
  ])
    assert.equal(isBulkCampaignReadiness(value), false);
  assert.equal(isBulkCampaignReadiness(ready), true);
});

test("one blocked source remains blocked when other source checks are ready or unavailable", () => {
  const blocked: BulkCampaignReadiness = {
    ...ready,
    checkedAt: "2026-09-15T18:59:00.000Z",
    state: "blocked",
    reasons: [{ code: "meta_business_limit", providerCode: "141015" }],
  };
  const result = mergeBulkCampaignReadiness([
    ready,
    blocked,
    blocked,
    undefined,
  ]);
  assert.equal(result.state, "blocked");
  assert.equal(result.checkedAt, blocked.checkedAt);
  assert.deepEqual(result.reasons, [
    blocked.reasons[0],
    { code: "meta_check_unavailable" },
  ]);
  assert.equal(result.remainingCapacity, null);
});

test("missing checks never become ready and all ready checks keep capacity unknown", () => {
  assert.equal(mergeBulkCampaignReadiness([]).state, "unavailable");
  assert.equal(
    mergeBulkCampaignReadiness([ready, undefined]).state,
    "unavailable",
  );
  assert.deepEqual(mergeBulkCampaignReadiness([ready]), ready);
});

test("normalizes an absent recipient policy to version 1 disabled", () => {
  assert.deepEqual(normalizeBulkCampaignRecipientPolicy(undefined), {
    version: 1,
    excludePriorFailedBulkSends: false,
  });
});

test("rejects an unknown persisted policy version", () => {
  assert.throws(
    () =>
      normalizeBulkCampaignRecipientPolicy({
        version: 2,
        excludePriorFailedBulkSends: true,
      }),
    /Unsupported bulk campaign recipient policy version/,
  );
});

test("keeps every audience intent mutually exclusive by construction", () => {
  const cases: BulkCampaignAudienceIntent[] = [
    { kind: "inline", recipients: [{ phone: "+15550000001" }] },
    {
      kind: "analytics_with_fill_up",
      analytics: { filters: { status: "all" } },
      fillUpRecipients: [],
    },
    { kind: "registered_users", selectedUserIds: ["user-1"] },
    {
      kind: "registered_business_phones",
      selectedPhones: ["+15550000002"],
    },
    {
      kind: "telegram_subscribers",
      sourceId: "source-1",
      selectedChatIds: ["chat-1"],
    },
  ];

  assert.deepEqual(
    cases.map((value) => value.kind),
    [
      "inline",
      "analytics_with_fill_up",
      "registered_users",
      "registered_business_phones",
      "telegram_subscribers",
    ],
  );
});

test("recognizes only bulk-campaign roots from the node itself", () => {
  const root = {
    id: "bulk-root",
    data: { kind: "bulk", bulkRootConfig: { workflowKind: "bulk_campaign" } },
  };
  assert.equal(isBulkCampaignRootNode(root), true);

  for (const node of [
    {
      id: "follow-up",
      data: {
        kind: "bulk",
        bulkRootConfig: { workflowKind: "follow_up_workflow" },
      },
    },
    { id: "missing-config", data: { kind: "bulk" } },
    {
      id: "array-config",
      data: {
        kind: "bulk",
        bulkRootConfig: [{ workflowKind: "bulk_campaign" }],
      },
    },
    {
      id: "action",
      data: {
        kind: "action",
        bulkRootConfig: { workflowKind: "bulk_campaign" },
      },
    },
    { id: "no-data" },
    null,
    undefined,
  ])
    assert.equal(isBulkCampaignRootNode(node), false);
});
