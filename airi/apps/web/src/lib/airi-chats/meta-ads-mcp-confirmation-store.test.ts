const mockAiriChatMessageFindOneAndUpdate = jest.fn();
const mockAiriChatMessageFind = jest.fn();

jest.mock("@/models/airi-chat-message", () => ({
  AiriChatMessage: {
    findOneAndUpdate: (...args: unknown[]) =>
      mockAiriChatMessageFindOneAndUpdate(...args),
    find: (...args: unknown[]) => mockAiriChatMessageFind(...args),
  },
}));

import { prepareMetaAdsMcpTransaction } from "@/lib/meta-ads/mcp/confirmation-contract.server";
import {
  claimAiriMetaAdsMcpConfirmation,
  completeAiriMetaAdsMcpConfirmation,
  listAiriMetaAdsMcpPendingTransactions,
  reconcileAiriMetaAdsMcpConfirmation,
} from "./meta-ads-mcp-confirmation-store";

const DEFINITION_SHA256 = "a".repeat(64);
const CATALOG_SHA256 = "b".repeat(64);

function createTransaction(id: string, toolName = "create_campaign") {
  return prepareMetaAdsMcpTransaction({
    id,
    preparedAt: "2026-08-04T09:59:00.000Z",
    target: {
      sourceId: "source-1",
      connectionId: "connection-1",
      mcpUserId: "mcp-user-1",
      adAccountId: "act_123",
      currency: "USD",
    },
    tool: {
      name: toolName,
      definitionSha256: DEFINITION_SHA256,
      catalogSha256: CATALOG_SHA256,
    },
    logicalArguments: { name: "Launch" },
    summary: "Create the Launch campaign",
    creativeAssets: [],
  });
}

describe("Airi Meta Ads MCP confirmation store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("atomically removes the digest-bound pending action and records its execution claim", async () => {
    const transaction = createTransaction("meta-mcp-mutation-1");
    const execution = {
      version: 2 as const,
      id: transaction.id,
      transaction,
      status: "executing" as const,
      claimToken: "claim-1",
      resultMessageId: "507f1f77bcf86cd799439012",
      confirmedByUserId: "user-1",
      claimedAt: "2026-08-04T10:00:00.000Z",
    };
    const lean = jest.fn().mockResolvedValue({
      _id: "507f1f77bcf86cd799439010",
      metadata: { airiMetaAdsMcpExecutions: [execution] },
    });
    const select = jest.fn().mockReturnValue({ lean });
    mockAiriChatMessageFindOneAndUpdate.mockReturnValue({ select });

    await expect(
      claimAiriMetaAdsMcpConfirmation({
        workspaceId: "workspace-1",
        threadId: "507f1f77bcf86cd799439011",
        messageId: "507f1f77bcf86cd799439010",
        mutationId: transaction.id,
        transactionDigest: transaction.transactionDigest,
        claimToken: execution.claimToken,
        resultMessageId: execution.resultMessageId,
        confirmedByUserId: execution.confirmedByUserId,
        claimedAt: execution.claimedAt,
      })
    ).resolves.toEqual(execution);

    const [locator, update, options] =
      mockAiriChatMessageFindOneAndUpdate.mock.calls[0] ?? [];
    expect(locator).toEqual(
      expect.objectContaining({
        "metadata.airiMetaAdsMcpPending": {
          $elemMatch: {
            version: 2,
            id: transaction.id,
            transactionDigest: transaction.transactionDigest,
          },
        },
        "metadata.pendingActions": {
          $elemMatch: {
            confirmationVersion: 2,
            id: transaction.id,
            kind: "meta_ads_mcp_mutation",
            mutationId: transaction.id,
            transactionDigest: transaction.transactionDigest,
          },
        },
        "metadata.airiMetaAdsMcpExecutions.id": { $ne: transaction.id },
      })
    );
    expect(update).toEqual([
      {
        $set: expect.objectContaining({
          "metadata.airiMetaAdsMcpExecutions": expect.objectContaining({
            $concatArrays: expect.arrayContaining([
              [
                expect.objectContaining({
                  version: 2,
                  id: { $literal: transaction.id },
                  transaction: expect.objectContaining({
                    $arrayElemAt: expect.any(Array),
                  }),
                  status: "executing",
                  claimToken: { $literal: execution.claimToken },
                }),
              ],
            ]),
          }),
          "metadata.airiMetaAdsMcpPending": expect.objectContaining({
            $filter: expect.any(Object),
          }),
          "metadata.pendingActions": expect.objectContaining({
            $filter: expect.any(Object),
          }),
        }),
      },
    ]);
    expect(options).toEqual({ new: true });
    expect(select).toHaveBeenCalledWith("_id metadata");
  });

  it("terminalizes only the exact active v2 claim", async () => {
    const transaction = createTransaction("meta-mcp-mutation-1");
    const execution = {
      version: 2 as const,
      id: transaction.id,
      transaction,
      status: "outcome_unknown" as const,
      claimToken: "claim-1",
      resultMessageId: "507f1f77bcf86cd799439012",
      confirmedByUserId: "user-1",
      claimedAt: "2026-08-04T10:00:00.000Z",
      responseContent: "Review Meta before retrying.",
      error: "request timed out",
      completedAt: "2026-08-04T10:00:01.000Z",
      materializedCreativeAssetIds: [],
    };
    const lean = jest.fn().mockResolvedValue({
      _id: "507f1f77bcf86cd799439010",
      metadata: { airiMetaAdsMcpExecutions: [execution] },
    });
    const select = jest.fn().mockReturnValue({ lean });
    mockAiriChatMessageFindOneAndUpdate.mockReturnValue({ select });

    await expect(
      completeAiriMetaAdsMcpConfirmation({
        workspaceId: "workspace-1",
        threadId: "507f1f77bcf86cd799439011",
        messageId: "507f1f77bcf86cd799439010",
        mutationId: execution.id,
        claimToken: execution.claimToken,
        status: execution.status,
        responseContent: execution.responseContent,
        error: execution.error,
        completedAt: execution.completedAt,
        materializedCreativeAssetIds: [],
      })
    ).resolves.toEqual(execution);

    expect(mockAiriChatMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "metadata.airiMetaAdsMcpExecutions": {
          $elemMatch: {
            version: 2,
            id: execution.id,
            claimToken: execution.claimToken,
            status: "executing",
          },
        },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "metadata.airiMetaAdsMcpExecutions.$[execution].status":
            "outcome_unknown",
          "metadata.airiMetaAdsMcpExecutions.$[execution].materializedCreativeAssetIds":
            [],
        }),
      }),
      expect.objectContaining({
        arrayFilters: [
          {
            "execution.version": 2,
            "execution.id": execution.id,
            "execution.claimToken": execution.claimToken,
            "execution.status": "executing",
          },
        ],
      })
    );
  });

  it("persists manual reconciliation provenance with the terminal result", async () => {
    const transaction = createTransaction("meta-mcp-mutation-2");
    const reconciliation = {
      actorUserId: "user-2",
      resolution: "succeeded" as const,
      note: "Visible in Ads Manager",
      providerIdentifiers: [{ kind: "campaign", id: "12001" }],
      reconciledAt: "2026-08-04T10:00:00.000Z",
    };
    const execution = {
      version: 2 as const,
      id: transaction.id,
      transaction,
      status: "succeeded" as const,
      claimToken: "claim-2",
      resultMessageId: "507f1f77bcf86cd799439013",
      confirmedByUserId: "user-1",
      claimedAt: "2026-08-04T09:50:00.000Z",
      responseContent: "Recorded after manual review.",
      error: null,
      completedAt: "2026-08-04T10:00:00.000Z",
      reconciliation,
    };
    const lean = jest.fn().mockResolvedValue({
      _id: "507f1f77bcf86cd799439010",
      metadata: { airiMetaAdsMcpExecutions: [execution] },
    });
    const select = jest.fn().mockReturnValue({ lean });
    mockAiriChatMessageFindOneAndUpdate.mockReturnValue({ select });

    await expect(
      reconcileAiriMetaAdsMcpConfirmation({
        workspaceId: "workspace-1",
        threadId: "507f1f77bcf86cd799439011",
        messageId: "507f1f77bcf86cd799439010",
        mutationId: execution.id,
        claimToken: execution.claimToken,
        expectedStatus: "outcome_unknown",
        resolution: execution.status,
        responseContent: execution.responseContent,
        error: execution.error,
        completedAt: execution.completedAt,
        reconciliation,
      })
    ).resolves.toEqual(execution);

    expect(mockAiriChatMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "metadata.airiMetaAdsMcpExecutions": {
          $elemMatch: expect.objectContaining({
            version: 2,
            id: execution.id,
            status: "outcome_unknown",
            reconciliation: { $exists: false },
          }),
        },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "metadata.airiMetaAdsMcpExecutions.$[execution].reconciliation":
            reconciliation,
        }),
      }),
      expect.any(Object)
    );
  });

  it("lists unconfirmed prepared writes for one tool and target in the requester's thread", async () => {
    const matching = createTransaction(
      "meta-mcp-pending-1",
      "ads_create_campaign"
    );
    const otherTool = createTransaction("meta-mcp-pending-2", "ads_update_ad");
    const lean = jest.fn().mockResolvedValue([
      {
        _id: "507f1f77bcf86cd799439010",
        threadId: "507f1f77bcf86cd799439011",
        metadata: {
          airiMetaAdsMcpPending: [matching, otherTool, { id: "legacy" }],
        },
      },
    ]);
    const select = jest.fn().mockReturnValue({ lean });
    const limit = jest.fn().mockReturnValue({ select });
    const sort = jest.fn().mockReturnValue({ limit });
    mockAiriChatMessageFind.mockReturnValue({ sort });

    await expect(
      listAiriMetaAdsMcpPendingTransactions({
        workspaceId: "workspace-1",
        threadId: "507f1f77bcf86cd799439011",
        toolName: "ads_create_campaign",
        connectionId: "connection-1",
        adAccountId: "act_123",
        preparedAfter: "2026-08-04T09:15:00.000Z",
      })
    ).resolves.toEqual([
      {
        threadId: "507f1f77bcf86cd799439011",
        messageId: "507f1f77bcf86cd799439010",
        transaction: matching,
      },
    ]);
    expect(mockAiriChatMessageFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId: "507f1f77bcf86cd799439011",
      role: "assistant",
      createdAt: { $gte: new Date("2026-08-04T09:15:00.000Z") },
      "metadata.airiMetaAdsMcpPending": {
        $elemMatch: {
          version: 2,
          "tool.name": "ads_create_campaign",
          "target.connectionId": "connection-1",
          "target.adAccountId": "act_123",
          preparedAt: { $gte: "2026-08-04T09:15:00.000Z" },
        },
      },
    });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(limit).toHaveBeenCalledWith(20);
  });
});
