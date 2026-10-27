const mockUpdateMany = jest.fn();
const mockBulkWrite = jest.fn();
const mockCountDocuments = jest.fn();
const mockFind = jest.fn();
const mockCreateIndex = jest.fn();
const mockDropIndex = jest.fn();
const mockConnectDB = jest.fn();

type TestPageQuery = {
  sort: jest.Mock;
  limit: jest.Mock;
  select: jest.Mock;
  hint: jest.Mock;
  lean: jest.Mock;
};

jest.mock("@/models/scenario-generated-recipient-message", () => ({
  SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_KEYS: {
    workspaceId: 1,
    scenarioId: 1,
    generationJobId: 1,
    nodeId: 1,
    recipient: 1,
    channel: 1,
    sourceId: 1,
  },
  SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_OPTIONS: {
    background: true,
    name: "scenario_generated_recipient_revision_identity_unique",
    unique: true,
  },
  SCENARIO_GENERATED_RECIPIENT_LEGACY_IDENTITY_INDEX_NAME:
    "workspaceId_1_scenarioId_1_nodeId_1_recipient_1_channel_1",
  SCENARIO_GENERATED_RECIPIENT_SOURCE_IDENTITY_INDEX_NAME:
    "scenario_generated_recipient_source_identity_unique",
  SCENARIO_GENERATED_RECIPIENT_LEGACY_OPERATION_INDEX_NAME:
    "scenario_generated_operation_status_page",
  SCENARIO_GENERATED_RECIPIENT_LEGACY_DRAFT_PAGE_INDEX_NAME:
    "scenario_generated_draft_page",
  SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_KEYS: {
    workspaceId: 1,
    scenarioId: 1,
    sendOperationId: 1,
    createdAt: 1,
    _id: 1,
  },
  SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_OPTIONS: {
    background: true,
    name: "scenario_generated_operation_page",
  },
  SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_KEYS: {
    workspaceId: 1,
    scenarioId: 1,
    generationJobId: 1,
    sendStatus: 1,
    createdAt: 1,
    _id: 1,
  },
  SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_OPTIONS: {
    background: true,
    name: "scenario_generated_revision_draft_page",
  },
  ScenarioGeneratedRecipientMessage: {
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    bulkWrite: (...args: unknown[]) => mockBulkWrite(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
    find: (...args: unknown[]) => mockFind(...args),
    collection: {
      createIndex: (...args: unknown[]) => mockCreateIndex(...args),
      dropIndex: (...args: unknown[]) => mockDropIndex(...args),
    },
  },
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/campaign/bulk-send-api-idempotency", () => ({
  deriveBulkSendChildCampaignId: (operationId: string, partitionKey: string) =>
    `child:${operationId}:${partitionKey}`,
}));

import {
  advanceGeneratedRecipientAudience,
  createGeneratedRecipientAudience,
} from "@/lib/campaign/generated-recipient-audience";

import {
  assignGeneratedSendPartition,
  claimGeneratedSendRevision,
  commitGeneratedSendAssignedPartitionSkip,
  commitGeneratedSendPartialOutcomes,
  ensureScenarioGeneratedRecipientMessageIndexes,
  loadGeneratedSendRevisionPage,
  loadGeneratedSendOperationPage,
  verifyGeneratedSendOperationCoverage,
} from "./generated-send-command";

const scope = {
  workspaceId: "workspace-1",
  scenarioId: "scenario-1",
  operationId: "operation-1",
  audienceRevision: "generation-job-1",
};
const partitionKey = "whatsapp:phone-number-1";
const campaignId = `child:${scope.operationId}:${partitionKey}`;

function queryFor(rows: unknown[]): TestPageQuery {
  const query: TestPageQuery = {
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
    select: jest.fn(() => query),
    hint: jest.fn(() => query),
    lean: jest.fn(async () => rows),
  };
  return query;
}

function generatedRow(params: {
  id: string;
  status: "draft" | "preparing" | "queued" | "skipped";
  createdAt?: string;
  campaignId?: string | null;
  partitionKey?: string | null;
  skipReason?: string | null;
  skipDetail?: string | null;
  error?: string | null;
}) {
  return {
    _id: params.id,
    workspaceId: scope.workspaceId,
    scenarioId: scope.scenarioId,
    generationJobId: scope.audienceRevision,
    nodeId: `node-${params.id}`,
    branchId: null,
    channel: "whatsapp",
    recipient: `recipient-${params.id}`,
    text: `Text ${params.id}`,
    sendStatus: params.status,
    sendOperationId: params.status === "draft" ? null : scope.operationId,
    campaignId: params.campaignId ?? null,
    sendPartitionKey: params.partitionKey ?? null,
    skipReason: params.skipReason ?? null,
    skipDetail: params.skipDetail ?? null,
    error: params.error ?? null,
    createdAt: new Date(params.createdAt || "2026-07-27T10:01:00.000Z"),
  };
}

describe("generated send command", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockReset().mockResolvedValue(undefined);
    mockCreateIndex.mockReset().mockResolvedValue("created");
    mockDropIndex.mockReset().mockResolvedValue(undefined);
    mockUpdateMany
      .mockReset()
      .mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });
    mockCountDocuments.mockReset().mockResolvedValue(0);
    mockFind.mockReset();
    mockBulkWrite.mockReset().mockImplementation(async operations => {
      const count = (operations as Array<Record<string, unknown>>).reduce(
        (total, operation) => {
          const ids = (
            operation as {
              updateMany?: { filter?: { _id?: { $in?: unknown[] } } };
            }
          ).updateMany?.filter?._id?.$in;
          return total + (ids?.length || 0);
        },
        0
      );
      return { matchedCount: count, modifiedCount: count };
    });
  });

  it("does not hide a non-missing legacy-index drop failure", async () => {
    mockDropIndex.mockRejectedValueOnce(
      Object.assign(new Error("drop denied"), { code: 13 })
    );

    await expect(
      ensureScenarioGeneratedRecipientMessageIndexes()
    ).rejects.toThrow("drop denied");
    expect(mockCreateIndex).toHaveBeenCalledTimes(1);
  });

  it("materializes stable operation and revision draft indexes once", async () => {
    mockDropIndex
      .mockRejectedValueOnce({ code: 27, codeName: "IndexNotFound" })
      .mockRejectedValueOnce({ code: 27, codeName: "IndexNotFound" })
      .mockRejectedValueOnce({ code: 27, codeName: "IndexNotFound" })
      .mockRejectedValueOnce({ code: 27, codeName: "IndexNotFound" });

    await Promise.all([
      ensureScenarioGeneratedRecipientMessageIndexes(),
      ensureScenarioGeneratedRecipientMessageIndexes(),
    ]);
    await ensureScenarioGeneratedRecipientMessageIndexes();

    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockCreateIndex).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: 1,
        scenarioId: 1,
        generationJobId: 1,
        nodeId: 1,
        recipient: 1,
        channel: 1,
        sourceId: 1,
      },
      {
        background: true,
        name: "scenario_generated_recipient_revision_identity_unique",
        unique: true,
      }
    );
    expect(mockDropIndex.mock.calls.map(call => call[0])).toEqual([
      "workspaceId_1_scenarioId_1_nodeId_1_recipient_1_channel_1",
      "scenario_generated_recipient_source_identity_unique",
      "scenario_generated_operation_status_page",
      "scenario_generated_draft_page",
    ]);
    expect(mockCreateIndex).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId: 1,
        scenarioId: 1,
        sendOperationId: 1,
        createdAt: 1,
        _id: 1,
      },
      {
        background: true,
        name: "scenario_generated_operation_page",
      }
    );
    expect(mockCreateIndex).toHaveBeenNthCalledWith(
      3,
      {
        workspaceId: 1,
        scenarioId: 1,
        generationJobId: 1,
        sendStatus: 1,
        createdAt: 1,
        _id: 1,
      },
      {
        background: true,
        name: "scenario_generated_revision_draft_page",
      }
    );
  });

  it("claims one closed revision with a constant-size server-side command", async () => {
    mockUpdateMany.mockResolvedValueOnce({ matchedCount: 3, modifiedCount: 2 });
    mockCountDocuments.mockResolvedValueOnce(3).mockResolvedValueOnce(3);

    await expect(claimGeneratedSendRevision(scope)).resolves.toEqual({
      ...scope,
      revisionCount: 3,
      claimedCount: 3,
      matchedCount: 3,
      modifiedCount: 2,
      claimed: true,
    });

    const [filter, update] = mockUpdateMany.mock.calls[0]!;
    expect(filter).toEqual({
      workspaceId: scope.workspaceId,
      scenarioId: scope.scenarioId,
      generationJobId: scope.audienceRevision,
      $or: [
        { sendStatus: "draft" },
        {
          sendStatus: "preparing",
          sendOperationId: scope.operationId,
        },
      ],
    });
    expect(filter).not.toHaveProperty("_id");
    expect(update).toEqual([
      {
        $set: {
          sendStatus: "preparing",
          sendOperationId: scope.operationId,
          campaignId: {
            $cond: [{ $eq: ["$sendStatus", "draft"] }, null, "$campaignId"],
          },
          sendPartitionKey: {
            $cond: [
              { $eq: ["$sendStatus", "draft"] },
              null,
              "$sendPartitionKey",
            ],
          },
          skipReason: null,
          skipDetail: null,
          error: null,
        },
      },
    ]);
  });

  it("fails a revision claim when any row remains foreign-owned", async () => {
    mockCountDocuments.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    await expect(claimGeneratedSendRevision(scope)).resolves.toMatchObject({
      revisionCount: 3,
      claimedCount: 2,
      claimed: false,
    });
  });

  it("loads operation pages with a stable cursor that excludes sendStatus", async () => {
    const query = queryFor([
      generatedRow({
        id: "message-2",
        status: "queued",
        createdAt: "2026-07-27T10:02:00.000Z",
        campaignId,
        partitionKey,
      }),
    ]);
    mockFind.mockReturnValueOnce(query);

    await expect(
      loadGeneratedSendOperationPage({
        ...scope,
        after: {
          createdAt: "2026-07-27T10:01:00.000Z",
          messageId: "message-1",
        },
        pageSize: 2,
      })
    ).resolves.toMatchObject({
      rows: [
        {
          _id: "message-2",
          sendStatus: "queued",
          campaignId,
          sendPartitionKey: partitionKey,
        },
      ],
      nextCursor: null,
    });
    const filter = mockFind.mock.calls[0]![0];
    expect(filter).toMatchObject({
      workspaceId: scope.workspaceId,
      scenarioId: scope.scenarioId,
      generationJobId: scope.audienceRevision,
      sendOperationId: scope.operationId,
      $or: expect.any(Array),
    });
    expect(JSON.stringify(filter.$or)).not.toContain("sendStatus");
    expect(query.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
    expect(query.hint).toHaveBeenCalledWith(
      "scenario_generated_operation_page"
    );
  });

  it("pages one persisted generated revision read-only in stable original order", async () => {
    const indexCache = (
      globalThis as typeof globalThis & {
        __scenarioGeneratedRecipientIndexCacheV2?: {
          ready: boolean;
          promise: Promise<void> | null;
        };
      }
    ).__scenarioGeneratedRecipientIndexCacheV2!;
    indexCache.ready = false;
    indexCache.promise = null;
    const rows = [
      generatedRow({
        id: "revision-row-1",
        status: "draft",
        createdAt: "2026-07-27T10:01:00.000Z",
      }),
    ];
    const query = queryFor(rows);
    mockFind.mockReturnValue(query);

    const result = await loadGeneratedSendRevisionPage({
      workspaceId: scope.workspaceId,
      scenarioId: scope.scenarioId,
      audienceRevision: scope.audienceRevision,
      after: {
        createdAt: "2026-07-27T10:00:00.000Z",
        messageId: "revision-row-0",
      },
      pageSize: 500,
    });

    expect(mockFind).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      scenarioId: scope.scenarioId,
      generationJobId: scope.audienceRevision,
      sendStatus: "draft",
      $or: [
        { createdAt: { $gt: new Date("2026-07-27T10:00:00.000Z") } },
        {
          createdAt: new Date("2026-07-27T10:00:00.000Z"),
          _id: { $gt: "revision-row-0" },
        },
      ],
    });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
    expect(query.limit).toHaveBeenCalledWith(500);
    expect(query.hint).toHaveBeenCalledWith(
      "scenario_generated_revision_draft_page"
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        _id: "revision-row-1",
        generationJobId: scope.audienceRevision,
      }),
    ]);
    expect(result.rows[0]).not.toHaveProperty("sendStatus");
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockCreateIndex).not.toHaveBeenCalled();
    expect(mockDropIndex).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockBulkWrite).not.toHaveBeenCalled();
    indexCache.ready = true;
  });

  it("fails closed when an assigned row has a wrong or missing partition key", async () => {
    mockFind.mockReturnValueOnce(
      queryFor([
        generatedRow({
          id: "message-1",
          status: "preparing",
          campaignId,
          partitionKey: null,
        }),
      ])
    );

    await expect(loadGeneratedSendOperationPage(scope)).rejects.toThrow(
      "partition assignment is malformed"
    );
  });

  it("derives and persists the exact child pair for one bounded page", async () => {
    await expect(
      assignGeneratedSendPartition({
        ...scope,
        messageIds: ["message-1", "message-2"],
        partitionKey,
      })
    ).resolves.toEqual({
      campaignId,
      partitionKey,
      requestedCount: 2,
      matchedCount: 2,
      modifiedCount: 2,
      assigned: true,
    });

    const [filter, update] = mockUpdateMany.mock.calls[0]!;
    expect(filter).toMatchObject({
      _id: { $in: ["message-1", "message-2"] },
      workspaceId: scope.workspaceId,
      scenarioId: scope.scenarioId,
      generationJobId: scope.audienceRevision,
      sendOperationId: scope.operationId,
      sendStatus: "preparing",
      $or: [
        { campaignId: null, sendPartitionKey: null },
        { campaignId, sendPartitionKey: partitionKey },
      ],
    });
    expect(update).toEqual({
      $set: { campaignId, sendPartitionKey: partitionKey },
    });
  });

  it("rejects oversized or duplicate partition pages before Mongo", async () => {
    await expect(
      assignGeneratedSendPartition({
        ...scope,
        messageIds: Array.from(
          { length: 1001 },
          (_, index) => `message-${index}`
        ),
        partitionKey,
      })
    ).rejects.toThrow("at most 1000");
    await expect(
      assignGeneratedSendPartition({
        ...scope,
        messageIds: ["message-1", "message-1"],
        partitionKey,
      })
    ).rejects.toThrow("must be unique");
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("commits queued outcomes only with the exact persisted child pair", async () => {
    mockFind
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => [
            generatedRow({
              id: "message-1",
              status: "preparing",
              campaignId,
              partitionKey,
            }),
          ],
        }),
      })
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => [
            generatedRow({
              id: "message-1",
              status: "queued",
              campaignId,
              partitionKey,
            }),
          ],
        }),
      });
    mockBulkWrite.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await expect(
      commitGeneratedSendPartialOutcomes({
        ...scope,
        messageIds: ["message-1"],
        queuedByMessageId: {
          "message-1": { campaignId, partitionKey },
        },
        skippedByMessageId: {},
      })
    ).resolves.toMatchObject({
      subsetCount: 1,
      queuedMatchedCount: 1,
      queuedModifiedCount: 1,
      committed: true,
    });
    const [operations] = mockBulkWrite.mock.calls[0]!;
    expect(operations[0].updateMany.filter).toMatchObject({
      campaignId,
      sendPartitionKey: partitionKey,
    });
    expect(operations[0].updateMany.update.$set).toMatchObject({
      sendStatus: "queued",
      campaignId,
      sendPartitionKey: partitionKey,
    });
  });

  it("rejects a queued campaign/key pair that is not deterministic", async () => {
    await expect(
      commitGeneratedSendPartialOutcomes({
        ...scope,
        messageIds: ["message-1"],
        queuedByMessageId: {
          "message-1": {
            campaignId,
            partitionKey: "whatsapp:rotated-source",
          },
        },
        skippedByMessageId: {},
      })
    ).rejects.toThrow("campaign and partition identity is invalid");
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("rejects oversized outcome maps before reading Mongo", async () => {
    const queuedByMessageId = Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [
        `message-${index}`,
        { campaignId, partitionKey },
      ])
    );

    await expect(
      commitGeneratedSendPartialOutcomes({
        ...scope,
        messageIds: ["message-0"],
        queuedByMessageId,
        skippedByMessageId: {},
      })
    ).rejects.toThrow("at most 1000 outcomes");
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("makes each outcome page terminal-idempotent", async () => {
    mockFind.mockReturnValueOnce({
      select: () => ({
        lean: async () => [
          generatedRow({
            id: "message-1",
            status: "queued",
            campaignId,
            partitionKey,
          }),
        ],
      }),
    });

    await expect(
      commitGeneratedSendPartialOutcomes({
        ...scope,
        messageIds: ["message-1"],
        queuedByMessageId: {
          "message-1": { campaignId, partitionKey },
        },
        skippedByMessageId: {},
      })
    ).resolves.toMatchObject({
      queuedMatchedCount: 1,
      queuedModifiedCount: 0,
      committed: true,
    });
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("clears partition evidence when a preparing row is skipped", async () => {
    mockFind
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => [
            generatedRow({
              id: "message-1",
              status: "preparing",
            }),
          ],
        }),
      })
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => [
            generatedRow({
              id: "message-1",
              status: "skipped",
              skipReason: "missing_action_node",
              error: "Generated send skipped: missing_action_node",
            }),
          ],
        }),
      });

    await commitGeneratedSendPartialOutcomes({
      ...scope,
      messageIds: ["message-1"],
      queuedByMessageId: {},
      skippedByMessageId: {
        "message-1": { reason: "missing_action_node" },
      },
    });

    const [operations] = mockBulkWrite.mock.calls[0]!;
    expect(operations[0].updateMany.update.$set).toMatchObject({
      sendStatus: "skipped",
      campaignId: null,
      sendPartitionKey: null,
    });
  });

  it("terminal-skips an assigned unadmitted page without erasing its child identity", async () => {
    mockFind
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => [
            generatedRow({
              id: "message-1",
              status: "preparing",
              campaignId,
              partitionKey,
            }),
          ],
        }),
      })
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => [
            generatedRow({
              id: "message-1",
              status: "skipped",
              campaignId,
              partitionKey,
              skipReason: "bulk_campaign_dispatch_expired",
              skipDetail: "Original command deadline elapsed",
              error:
                "Generated send skipped: bulk_campaign_dispatch_expired (Original command deadline elapsed)",
            }),
          ],
        }),
      });
    mockUpdateMany.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await expect(
      commitGeneratedSendAssignedPartitionSkip({
        ...scope,
        messageIds: ["message-1"],
        assignment: { campaignId, partitionKey },
        outcome: {
          reason: "bulk_campaign_dispatch_expired",
          detail: "Original command deadline elapsed",
        },
      })
    ).resolves.toEqual({
      requestedCount: 1,
      matchedCount: 1,
      modifiedCount: 1,
      committed: true,
    });

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: scope.workspaceId,
        scenarioId: scope.scenarioId,
        generationJobId: scope.audienceRevision,
        sendOperationId: scope.operationId,
        sendStatus: "preparing",
        campaignId,
        sendPartitionKey: partitionKey,
        _id: { $in: ["message-1"] },
      }),
      {
        $set: {
          sendStatus: "skipped",
          skipReason: "bulk_campaign_dispatch_expired",
          skipDetail: "Original command deadline elapsed",
          error:
            "Generated send skipped: bulk_campaign_dispatch_expired (Original command deadline elapsed)",
        },
      }
    );
  });

  it("makes an exact assigned terminal skip idempotent", async () => {
    mockFind.mockReturnValueOnce({
      select: () => ({
        lean: async () => [
          generatedRow({
            id: "message-1",
            status: "skipped",
            campaignId,
            partitionKey,
            skipReason: "bulk_campaign_dispatch_expired",
            error: "Generated send skipped: bulk_campaign_dispatch_expired",
          }),
        ],
      }),
    });

    await expect(
      commitGeneratedSendAssignedPartitionSkip({
        ...scope,
        messageIds: ["message-1"],
        assignment: { campaignId, partitionKey },
        outcome: { reason: "bulk_campaign_dispatch_expired" },
      })
    ).resolves.toEqual({
      requestedCount: 1,
      matchedCount: 1,
      modifiedCount: 0,
      committed: true,
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects divergent or oversized assigned terminal skips before mutation", async () => {
    mockFind.mockReturnValueOnce({
      select: () => ({
        lean: async () => [
          generatedRow({
            id: "message-1",
            status: "skipped",
            skipReason: "missing_action_node",
            error: "Generated send skipped: missing_action_node",
          }),
        ],
      }),
    });

    await expect(
      commitGeneratedSendAssignedPartitionSkip({
        ...scope,
        messageIds: ["message-1"],
        assignment: { campaignId, partitionKey },
        outcome: { reason: "bulk_campaign_dispatch_expired" },
      })
    ).rejects.toThrow("assigned partition skip state is divergent");
    await expect(
      commitGeneratedSendAssignedPartitionSkip({
        ...scope,
        messageIds: Array.from(
          { length: 1001 },
          (_, index) => `message-${index}`
        ),
        assignment: { campaignId, partitionKey },
        outcome: { reason: "bulk_campaign_dispatch_expired" },
      })
    ).rejects.toThrow("at most 1000");
    await expect(
      commitGeneratedSendAssignedPartitionSkip({
        ...scope,
        messageIds: ["message-1"],
        assignment: {
          campaignId,
          partitionKey: "whatsapp:rotated-source",
        },
        outcome: { reason: "bulk_campaign_dispatch_expired" },
      })
    ).rejects.toThrow("campaign and partition identity is invalid");
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("streams stable operation pages into bounded exact coverage evidence", async () => {
    const firstPage = [
      generatedRow({
        id: "message-1",
        status: "queued",
        createdAt: "2026-07-27T10:01:00.000Z",
        campaignId,
        partitionKey,
      }),
      generatedRow({
        id: "message-2",
        status: "skipped",
        createdAt: "2026-07-27T10:02:00.000Z",
        campaignId,
        partitionKey,
        skipReason: "bulk_campaign_dispatch_expired",
        error: "Generated send skipped: bulk_campaign_dispatch_expired",
      }),
    ];
    const secondPage = [
      generatedRow({
        id: "message-3",
        status: "queued",
        createdAt: "2026-07-27T10:03:00.000Z",
        campaignId,
        partitionKey,
      }),
    ];
    mockFind
      .mockReturnValueOnce(queryFor(firstPage))
      .mockReturnValueOnce(queryFor(secondPage));
    mockCountDocuments.mockResolvedValueOnce(3);
    const expectedAudience = advanceGeneratedRecipientAudience(
      createGeneratedRecipientAudience(),
      ["message-1", "message-2", "message-3"]
    );

    await expect(
      verifyGeneratedSendOperationCoverage({
        ...scope,
        expectedAudience,
        pageSize: 2,
      })
    ).resolves.toMatchObject({
      expectedCount: 3,
      ownedCount: 3,
      queuedCount: 2,
      skippedCount: 1,
      incompleteCount: 0,
      unexpectedRevisionCount: 0,
      audienceMatches: true,
      complete: true,
    });
    const secondFilter = mockFind.mock.calls[1]![0];
    expect(JSON.stringify(secondFilter.$or)).not.toContain("sendStatus");
  });

  it("fails coverage on a digest mismatch or operation row from another revision", async () => {
    mockFind.mockReturnValueOnce(
      queryFor([
        generatedRow({
          id: "message-2",
          status: "queued",
          campaignId,
          partitionKey,
        }),
      ])
    );
    mockCountDocuments.mockResolvedValueOnce(2);
    const expectedAudience = advanceGeneratedRecipientAudience(
      createGeneratedRecipientAudience(),
      ["message-1"]
    );

    await expect(
      verifyGeneratedSendOperationCoverage({
        ...scope,
        expectedAudience,
      })
    ).resolves.toMatchObject({
      ownedCount: 1,
      unexpectedRevisionCount: 1,
      audienceMatches: false,
      complete: false,
    });
  });
});
