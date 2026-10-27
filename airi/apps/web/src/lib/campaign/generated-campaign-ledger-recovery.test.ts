import {
  buildBulkCampaignDispatchWorkflowId,
  type BulkCampaignDispatchItem,
} from "@icecore/temporal";

import { createPreparedBulkCampaignContentHash } from "./bulk-campaign-content-hash";
import { deriveBulkSendChildCampaignId } from "./bulk-send-api-idempotency";
import {
  advanceGeneratedRecipientAudience,
  createGeneratedRecipientAudience,
} from "./generated-recipient-audience";
import {
  GeneratedChildCampaignRecoveryAmbiguousError,
  recoverGeneratedChildCampaignAdmission,
} from "./generated-campaign-ledger-recovery";

type RecoveryFixture = {
  history?: Record<string, unknown> | null;
  historyError?: { message: string } | null;
  messages?: Array<Record<string, unknown>>;
  messageErrorAfterOrdinal?: number;
};

type TestHistoryQuery = {
  eq: (column: string, value: string) => TestHistoryQuery;
  maybeSingle: jest.Mock;
};

type TestMessageQuery = {
  eq: (column: string, value: string) => TestMessageQuery;
  gt: (column: string, value: number) => TestMessageQuery;
  order: jest.Mock;
  limit: jest.Mock;
};

function createSupabaseFixture(fixture: RecoveryFixture) {
  const historyFilters: Array<[string, string]> = [];
  const messageFilters: Array<[string, string]> = [];
  const messageGreaterThan: Array<[string, number]> = [];
  const messageLimits: number[] = [];
  const historySelect = jest.fn(() => {
    const query: TestHistoryQuery = {
      eq(column: string, value: string) {
        historyFilters.push([column, value]);
        return query;
      },
      maybeSingle: jest.fn(async () => ({
        data: fixture.history ?? null,
        error: fixture.historyError ?? null,
      })),
    };
    return query;
  });
  const messageSelect = jest.fn(() => {
    const query: TestMessageQuery = {
      eq(column: string, value: string) {
        messageFilters.push([column, value]);
        return query;
      },
      order: jest.fn(() => query),
      gt(column: string, value: number) {
        messageGreaterThan.push([column, value]);
        return query;
      },
      limit: jest.fn(async (limit: number) => {
        messageLimits.push(limit);
        const afterOrdinal =
          messageGreaterThan[messageGreaterThan.length - 1]?.[1] ?? -1;
        if (fixture.messageErrorAfterOrdinal === afterOrdinal) {
          return { data: null, error: { message: "message page failed" } };
        }
        return {
          data: (fixture.messages || [])
            .filter(
              row =>
                typeof row.snapshot_ordinal === "number" &&
                row.snapshot_ordinal > afterOrdinal
            )
            .slice(0, limit),
          error: null,
        };
      }),
    };
    return query;
  });
  const from = jest.fn((table: string) => {
    if (table === "campaign_history") {
      return { select: historySelect };
    }
    if (table === "campaign_messages") {
      return { select: messageSelect };
    }
    throw new Error(`Unexpected table ${table}`);
  });
  return {
    supabase: { from },
    historyFilters,
    historySelect,
    messageFilters,
    messageGreaterThan,
    messageLimits,
    messageSelect,
  };
}

const parentOperationId = "operation-1";
const partitionKey = "whatsapp:source-1:phone-1";
const campaignId = deriveBulkSendChildCampaignId(
  parentOperationId,
  partitionKey
);
const workflowId = buildBulkCampaignDispatchWorkflowId({
  workspaceId: "workspace-1",
  executionId: campaignId,
});
const assignedAudience = advanceGeneratedRecipientAudience(
  createGeneratedRecipientAudience(),
  ["generated-1", "generated-2", "generated-3"]
);

function snapshotRow(
  ordinal: number,
  generatedRecipientMessageId: string
): Record<string, unknown> {
  const dispatchSnapshot: BulkCampaignDispatchItem = {
    workspaceId: "workspace-1",
    campaignId,
    generatedRecipientMessageId,
    scenarioId: "scenario-1",
    scenarioNodeId: `recipient-node-${ordinal}`,
    executionSource: "scenario_run_now",
    sentByUserId: "user-1",
    channel: "whatsapp",
    sourceId: "source-1",
    recipient: { phone: `7700000000${ordinal}` },
    phoneNumberId: "phone-number-1",
    templateName: "launch",
    languageCode: "en",
  };
  return {
    campaign_id: campaignId,
    scenario_id: "scenario-1",
    scenario_node_id: "root-node-1",
    execution_source: "scenario_run_now",
    channel: "whatsapp",
    snapshot_ordinal: ordinal,
    recipient_hash: (ordinal + 1).toString(16).padStart(64, "0"),
    dispatch_snapshot: {
      ...dispatchSnapshot,
      _audience_upload: {
        content_hash: "ledger-copy",
      },
    },
  };
}

const baseMessages = [
  snapshotRow(0, "generated-1"),
  snapshotRow(1, "generated-2"),
  snapshotRow(2, "generated-3"),
];
function immutableSnapshot(
  row: Record<string, unknown>
): Record<string, unknown> {
  const snapshot = {
    ...(row.dispatch_snapshot as Record<string, unknown>),
  };
  delete snapshot._audience_upload;
  return snapshot;
}
const expectedContentHash = createPreparedBulkCampaignContentHash(
  baseMessages.map(row => ({
    recipientHash: String(row.recipient_hash),
    dispatchSnapshot: immutableSnapshot(row),
  }))
);
const baseHistory = {
  id: campaignId,
  workspace_id: "workspace-1",
  scenario_id: "scenario-1",
  scenario_node_id: "root-node-1",
  execution_source: "scenario_run_now",
  sent_by: "user-1",
  channel: "whatsapp",
  dispatch_status: "queued",
  workflow_id: workflowId,
  total_recipients: 3,
  requested_at: "2026-07-27T10:00:00.000Z",
  scheduled_at: null,
  dispatch_expires_at: "2026-07-27T22:00:00.000Z",
  audience_count: 3,
  audience_fingerprint: "audience-fingerprint",
  audience_hash_version: "v1",
  audience_source_type: "scenario_generated",
  audience_content_hash: expectedContentHash,
};

const baseInput = {
  workspaceId: "workspace-1",
  scenarioId: "scenario-1",
  scenarioNodeId: "root-node-1",
  parentOperationId,
  partitionKey,
  campaignId,
  channel: "whatsapp" as const,
  assignedAudience,
  expectedContentHash,
  expectedPolicyMetadata: null,
};

const canonicalPolicyMetadata = {
  policy: { version: 1 as const, excludePriorFailedBulkSends: false },
  authoritativeRecipientLimit: {
    source: "live_meta" as const,
    value: 100,
    rawLimit: "100",
  },
  outcome: {
    evaluatedAt: "2026-07-27T10:00:00.000Z",
    requestedTotal: 3,
    acceptedTotal: 3,
    uniqueRecipients: { requested: 3, accepted: 3 },
    skippedByReason: {},
    warnings: { missingMarketingConsent: 0 },
  },
  batchPlan: {
    batchSize: 50,
    delayMs: 1_000,
    ratePerSecond: 20,
    rateSource: "meta" as const,
  },
  requestDigest: { version: 1 as const, digest: "f".repeat(64) },
};

describe("generated campaign ledger recovery", () => {
  it("returns not admitted when the exact workspace child history is absent", async () => {
    const fixture = createSupabaseFixture({ history: null });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
      })
    ).resolves.toEqual({ status: "not_admitted" });

    expect(fixture.historyFilters).toEqual([
      ["id", campaignId],
      ["workspace_id", "workspace-1"],
    ]);
    expect(fixture.messageSelect).not.toHaveBeenCalled();
  });

  it("recovers an active admitted child from bounded immutable snapshot pages", async () => {
    const fixture = createSupabaseFixture({
      history: baseHistory,
      messages: baseMessages,
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
        pageSize: 2,
      })
    ).resolves.toEqual({
      status: "admitted",
      campaign: {
        campaignId,
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenarioNodeId: "root-node-1",
        sentBy: "user-1",
        channel: "whatsapp",
        dispatchStatus: "queued",
        workflowId,
        totalRecipients: 3,
        requestedAt: "2026-07-27T10:00:00.000Z",
        scheduledAt: null,
        dispatchExpiresAt: "2026-07-27T22:00:00.000Z",
        contentHash: expectedContentHash,
        audience: {
          count: 3,
          fingerprint: "audience-fingerprint",
          hashVersion: "v1",
          sourceType: "scenario_generated",
        },
      },
      admittedAudience: assignedAudience,
      admittedItems: baseMessages.map(
        row => immutableSnapshot(row) as BulkCampaignDispatchItem
      ),
    });

    expect(fixture.messageFilters).toEqual([
      ["campaign_id", campaignId],
      ["campaign_id", campaignId],
    ]);
    expect(fixture.messageGreaterThan).toEqual([
      ["snapshot_ordinal", -1],
      ["snapshot_ordinal", 1],
    ]);
    expect(fixture.messageLimits).toEqual([2, 2]);
    expect(fixture.messageSelect).toHaveBeenCalledWith(
      "campaign_id,scenario_id,scenario_node_id,execution_source,channel,snapshot_ordinal,recipient_hash,dispatch_snapshot"
    );
  });

  it("accepts exact zero-key legacy metadata but requires the canonical five-key group for current-v2 recovery", async () => {
    const legacyFixture = createSupabaseFixture({
      history: { ...baseHistory, audience_metadata: { contentHash: "legacy" } },
      messages: baseMessages,
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: legacyFixture.supabase,
        ...baseInput,
        expectedPolicyMetadata: null,
      })
    ).resolves.toMatchObject({ status: "admitted" });

    const currentZeroKeyFixture = createSupabaseFixture({
      history: { ...baseHistory, audience_metadata: { contentHash: "legacy" } },
      messages: baseMessages,
    });
    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: currentZeroKeyFixture.supabase,
        ...baseInput,
        expectedPolicyMetadata: canonicalPolicyMetadata,
      })
    ).rejects.toThrow("policy admission metadata does not match compatibility");

    const currentFixture = createSupabaseFixture({
      history: {
        ...baseHistory,
        audience_metadata: {
          contentHash: expectedContentHash,
          replacementHistory: [],
          ...canonicalPolicyMetadata,
        },
      },
      messages: baseMessages,
    });
    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: currentFixture.supabase,
        ...baseInput,
        expectedPolicyMetadata: canonicalPolicyMetadata,
      })
    ).resolves.toMatchObject({ status: "admitted" });
  });

  it("fails current-v2 recovery when any canonical policy metadata fact changed", async () => {
    const fixture = createSupabaseFixture({
      history: {
        ...baseHistory,
        audience_metadata: {
          ...canonicalPolicyMetadata,
          requestDigest: { version: 1, digest: "e".repeat(64) },
        },
      },
      messages: baseMessages,
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
        expectedPolicyMetadata: canonicalPolicyMetadata,
      })
    ).rejects.toThrow("policy admission metadata does not match compatibility");
  });

  it("self-validates immutable SQL content before provider rehydration", async () => {
    const fixture = createSupabaseFixture({
      history: baseHistory,
      messages: baseMessages,
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
        expectedContentHash: undefined,
      })
    ).resolves.toMatchObject({
      status: "admitted",
      campaign: { contentHash: expectedContentHash },
      admittedAudience: assignedAudience,
    });
  });

  it("recovers a valid child above one page up to the generated-message ceiling", async () => {
    const messageIds = Array.from(
      { length: 1001 },
      (_, index) => `generated-${index}`
    );
    const firstAudiencePage = advanceGeneratedRecipientAudience(
      createGeneratedRecipientAudience(),
      messageIds.slice(0, 1000)
    );
    const largeAudience = advanceGeneratedRecipientAudience(
      firstAudiencePage,
      messageIds.slice(1000)
    );
    const largeMessages = messageIds.map((messageId, ordinal) =>
      snapshotRow(ordinal, messageId)
    );
    const largeContentHash = createPreparedBulkCampaignContentHash(
      largeMessages.map(row => ({
        recipientHash: String(row.recipient_hash),
        dispatchSnapshot: immutableSnapshot(row),
      }))
    );
    const fixture = createSupabaseFixture({
      history: {
        ...baseHistory,
        total_recipients: 1001,
        audience_count: 1001,
        audience_content_hash: largeContentHash,
      },
      messages: largeMessages,
    });

    const result = await recoverGeneratedChildCampaignAdmission({
      supabase: fixture.supabase,
      ...baseInput,
      assignedAudience: largeAudience,
      expectedContentHash: undefined,
      pageSize: 1000,
    });

    expect(result).toMatchObject({
      status: "admitted",
      admittedAudience: largeAudience,
    });
    if (result.status !== "admitted") {
      throw new Error("Expected admitted recovery");
    }
    expect(result.admittedItems).toHaveLength(1001);
    expect(fixture.messageLimits).toEqual([1000, 1000]);
  });

  it("rejects recovery above the 3,000 generated-message ceiling before reading SQL", async () => {
    const fixture = createSupabaseFixture({ history: baseHistory });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
        assignedAudience: {
          version: 1,
          count: 3001,
          digest: "a".repeat(64),
        },
      })
    ).rejects.toBeInstanceOf(GeneratedChildCampaignRecoveryAmbiguousError);
    expect(fixture.historySelect).not.toHaveBeenCalled();
  });

  it("fails closed when immutable content does not match the canonical prepared content", async () => {
    const contentMismatch = baseMessages.map(row => ({
      ...row,
      dispatch_snapshot: { ...(row.dispatch_snapshot as object) },
    }));
    contentMismatch[1] = {
      ...contentMismatch[1],
      dispatch_snapshot: {
        ...(contentMismatch[1]?.dispatch_snapshot as object),
        templateName: "tampered-template",
      },
    };
    const fixture = createSupabaseFixture({
      history: baseHistory,
      messages: contentMismatch,
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
      })
    ).rejects.toThrow(
      "Generated child recovery immutable content does not match admission"
    );
  });

  it("fails closed when caller preparation does not match admitted content", async () => {
    const fixture = createSupabaseFixture({
      history: baseHistory,
      messages: baseMessages,
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
        expectedContentHash: "f".repeat(64),
      })
    ).rejects.toThrow(
      "Generated child recovery history content does not match preparation"
    );
    expect(fixture.messageSelect).not.toHaveBeenCalled();
  });

  it("binds the operational sender even though content hashing normalizes it", async () => {
    const foreignSenderMessages = baseMessages.map(row => ({
      ...row,
      dispatch_snapshot: { ...(row.dispatch_snapshot as object) },
    }));
    foreignSenderMessages[0] = {
      ...foreignSenderMessages[0],
      dispatch_snapshot: {
        ...(foreignSenderMessages[0]?.dispatch_snapshot as object),
        sentByUserId: "foreign-user",
      },
    };
    const fixture = createSupabaseFixture({
      history: baseHistory,
      messages: foreignSenderMessages,
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
      })
    ).rejects.toThrow(
      "Generated child recovery immutable dispatch snapshot is foreign"
    );
  });

  it("treats a terminal campaign as admitted instead of attempting a replay", async () => {
    const fixture = createSupabaseFixture({
      history: { ...baseHistory, dispatch_status: "completed" },
      messages: [
        snapshotRow(0, "generated-1"),
        snapshotRow(1, "generated-2"),
        snapshotRow(2, "generated-3"),
      ],
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
      })
    ).resolves.toMatchObject({
      status: "admitted",
      campaign: { dispatchStatus: "completed" },
    });
  });

  it("rejects a raw pre-normalization audience as recovery evidence", async () => {
    const fixture = createSupabaseFixture({
      history: baseHistory,
      messages: [
        snapshotRow(0, "generated-1"),
        snapshotRow(1, "generated-2"),
        snapshotRow(2, "generated-3"),
      ],
    });
    const rawPartitionCandidates = advanceGeneratedRecipientAudience(
      createGeneratedRecipientAudience(),
      ["generated-1", "generated-1", "generated-2", "generated-3"]
    );

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
        // Recovery accepts only the exact post-queue-normalization audience
        // assigned in Mongo and snapshotted in SQL.
        assignedAudience: rawPartitionCandidates,
      })
    ).rejects.toThrow(
      "Generated child recovery history audience does not match assignment"
    );
    expect(fixture.messageSelect).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "duplicate generated IDs",
      rows: [
        snapshotRow(0, "generated-1"),
        snapshotRow(1, "generated-1"),
        snapshotRow(2, "generated-3"),
      ],
    },
    {
      name: "foreign generated IDs",
      rows: [
        snapshotRow(0, "generated-1"),
        snapshotRow(1, "generated-foreign"),
        snapshotRow(2, "generated-3"),
      ],
    },
    {
      name: "missing generated IDs",
      rows: [
        snapshotRow(0, "generated-1"),
        {
          ...snapshotRow(1, "generated-2"),
          dispatch_snapshot: { recipient: "77000000001" },
        },
        snapshotRow(2, "generated-3"),
      ],
    },
    {
      name: "missing snapshot ordinals",
      rows: [
        snapshotRow(0, "generated-1"),
        snapshotRow(2, "generated-2"),
        snapshotRow(3, "generated-3"),
      ],
    },
  ])("fails closed for $name", async ({ rows }) => {
    const fixture = createSupabaseFixture({
      history: baseHistory,
      messages: rows,
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
      })
    ).rejects.toBeInstanceOf(GeneratedChildCampaignRecoveryAmbiguousError);
  });

  it.each([
    ["workspace_id", "workspace-2"],
    ["scenario_id", "scenario-2"],
    ["scenario_node_id", "root-node-2"],
    ["channel", "telegram"],
    ["execution_source", "ad_hoc"],
    ["audience_source_type", "uploaded_file"],
  ])("fails closed when history %s is foreign", async (column, value) => {
    const fixture = createSupabaseFixture({
      history: { ...baseHistory, [column]: value },
      messages: [
        snapshotRow(0, "generated-1"),
        snapshotRow(1, "generated-2"),
        snapshotRow(2, "generated-3"),
      ],
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
      })
    ).rejects.toBeInstanceOf(GeneratedChildCampaignRecoveryAmbiguousError);
    expect(fixture.messageSelect).not.toHaveBeenCalled();
  });

  it("validates the deterministic child identity before reading history", async () => {
    const fixture = createSupabaseFixture({ history: baseHistory });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
        campaignId: "not-the-deterministic-child",
      })
    ).rejects.toBeInstanceOf(GeneratedChildCampaignRecoveryAmbiguousError);
    expect(fixture.historySelect).not.toHaveBeenCalled();
  });

  it("fails closed when a message snapshot belongs to another scenario root", async () => {
    const fixture = createSupabaseFixture({
      history: baseHistory,
      messages: [
        snapshotRow(0, "generated-1"),
        {
          ...snapshotRow(1, "generated-2"),
          scenario_node_id: "root-node-2",
        },
        snapshotRow(2, "generated-3"),
      ],
    });

    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: fixture.supabase,
        ...baseInput,
      })
    ).rejects.toBeInstanceOf(GeneratedChildCampaignRecoveryAmbiguousError);
  });

  it("turns history and paged-message read errors into ambiguous recovery", async () => {
    const historyFailure = createSupabaseFixture({
      historyError: { message: "history failed" },
    });
    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: historyFailure.supabase,
        ...baseInput,
      })
    ).rejects.toBeInstanceOf(GeneratedChildCampaignRecoveryAmbiguousError);

    const messageFailure = createSupabaseFixture({
      history: baseHistory,
      messages: [
        snapshotRow(0, "generated-1"),
        snapshotRow(1, "generated-2"),
        snapshotRow(2, "generated-3"),
      ],
      messageErrorAfterOrdinal: 1,
    });
    await expect(
      recoverGeneratedChildCampaignAdmission({
        supabase: messageFailure.supabase,
        ...baseInput,
        pageSize: 2,
      })
    ).rejects.toBeInstanceOf(GeneratedChildCampaignRecoveryAmbiguousError);
  });
});
