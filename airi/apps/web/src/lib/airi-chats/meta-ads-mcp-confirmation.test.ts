import type { MetaAdsMcpPendingMutation } from "@/lib/meta-ads/mcp/agent-loop";
import { prepareMetaAdsMcpTransaction } from "@/lib/meta-ads/mcp/confirmation-contract.server";
import { META_ADS_MCP_WRITE_REQUIRED_SCOPES } from "@/lib/meta-ads/meta-ads-mcp-readiness";

import {
  AiriMetaAdsMcpConfirmationError,
  createAiriMetaAdsMcpConfirmationService,
  type AiriMetaAdsMcpConfirmationExecution,
  type AiriMetaAdsMcpConfirmationStore,
} from "./meta-ads-mcp-confirmation";

const DEFINITION_SHA256 = "a".repeat(64);
const CATALOG_SHA256 = "b".repeat(64);

type V2Execution = Extract<AiriMetaAdsMcpConfirmationExecution, { version: 2 }>;

function createMutation(params: {
  id: string;
  toolName: string;
  logicalArguments: Record<string, unknown>;
  summary: string;
}): MetaAdsMcpPendingMutation {
  return prepareMetaAdsMcpTransaction({
    id: params.id,
    preparedAt: "2026-08-04T09:59:00.000Z",
    target: {
      sourceId: "source-1",
      connectionId: "connection-1",
      mcpUserId: "mcp-user-1",
      adAccountId: "act_123",
      currency: "USD",
    },
    tool: {
      name: params.toolName,
      definitionSha256: DEFINITION_SHA256,
      catalogSha256: CATALOG_SHA256,
    },
    logicalArguments: params.logicalArguments,
    summary: params.summary,
    creativeAssets: [],
  });
}

type ReadySupabaseQuery = {
  select(columns: string): ReadySupabaseQuery;
  eq(column: string, value: string): ReadySupabaseQuery;
  order(column: string, options: { ascending: boolean }): ReadySupabaseQuery;
  limit(value: number): ReadySupabaseQuery;
  maybeSingle(): Promise<{
    data: Record<string, unknown> | null;
    error: null;
  }>;
};

// Connection checks only trust a source owned by the workspace's company, so
// the fixture answers the workspace lookup as well as the source lookup.
function readySupabase(options: { workspaceCompanyId?: string } = {}) {
  const now = new Date().toISOString();
  const rows: Record<string, Record<string, unknown>> = {
    workspaces: { company_id: options.workspaceCompanyId ?? "company-1" },
    sources: {
      id: "source-1",
      company_id: "company-1",
      updated_at: now,
      credentials: {
        mcp_access_token: "mcp-token",
        mcp_connection_id: "connection-1",
        mcp_user_id: "mcp-user-1",
        mcp_scope: META_ADS_MCP_WRITE_REQUIRED_SCOPES.join(" "),
        mcp_scopes_verified_at: now,
        mcp_expires_at: "2099-01-01T00:00:00.000Z",
        selected_ad_account_id: "act_123",
        mcp_selected_ad_account: {
          id: "act_123",
          currency: "USD",
        },
        mcp_ad_account_ids: ["act_123"],
        mcp_assets_checked_at: now,
        mcp_provider_probe: {
          checkedAt: now,
          outcome: "success",
          warnings: [],
        },
      },
    },
  };
  return {
    from: (table: string) => {
      const query: ReadySupabaseQuery = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return query;
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createSingleMutationStore(mutation: MetaAdsMcpPendingMutation): {
  store: AiriMetaAdsMcpConfirmationStore;
  getExecution(): V2Execution | null;
} {
  let execution: V2Execution | null = null;
  const store: AiriMetaAdsMcpConfirmationStore = {
    loadState: jest.fn(async () => ({
      pendingMutation: execution ? null : mutation,
      execution,
    })),
    claim: jest.fn(async input => {
      if (execution || input.transactionDigest !== mutation.transactionDigest) {
        return null;
      }
      execution = {
        version: 2,
        id: mutation.id,
        transaction: mutation,
        status: "executing",
        claimToken: input.claimToken,
        resultMessageId: input.resultMessageId,
        confirmedByUserId: input.confirmedByUserId,
        claimedAt: input.claimedAt,
      };
      return execution;
    }),
    complete: jest.fn(async input => {
      if (
        !execution ||
        execution.status !== "executing" ||
        execution.claimToken !== input.claimToken
      ) {
        return null;
      }
      execution = {
        ...execution,
        status: input.status,
        responseContent: input.responseContent,
        error: input.error,
        completedAt: input.completedAt,
        ...(input.effectiveArgumentsSha256
          ? { effectiveArgumentsSha256: input.effectiveArgumentsSha256 }
          : {}),
        ...(input.materializedCreativeAssetIds
          ? { materializedCreativeAssetIds: input.materializedCreativeAssetIds }
          : {}),
      };
      return execution;
    }),
    reconcile: jest.fn(async () => null),
    ensureResultMessage: jest.fn(async input => ({
      _id: input.execution.resultMessageId,
      threadId: "507f1f77bcf86cd799439011",
      workspaceId: "workspace-1",
      role: "assistant" as const,
      content: input.execution.responseContent || "",
      metadata: {},
      createdAt: new Date("2026-08-04T10:00:01.000Z"),
    })),
  };

  return { store, getExecution: () => execution };
}

describe("Airi Meta Ads MCP confirmation", () => {
  it("claims a digest-bound mutation once under concurrency and replays the durable result", async () => {
    const mutation = createMutation({
      id: "meta-mcp-mutation-1",
      toolName: "create_campaign",
      logicalArguments: { name: "Launch" },
      summary: "Create the Launch campaign",
    });
    let pendingMutation: MetaAdsMcpPendingMutation | null = mutation;
    let execution: V2Execution | null = null;
    let initialLoads = 0;
    const bothInitialLoads = deferred<void>();
    const executionStarted = deferred<void>();
    const releaseExecution = deferred<void>();

    const resultMessage = {
      _id: "507f1f77bcf86cd799439012",
      threadId: "507f1f77bcf86cd799439011",
      workspaceId: "workspace-1",
      role: "assistant" as const,
      content: "Confirmed create_campaign.",
      metadata: {},
      createdAt: new Date("2026-08-04T10:00:01.000Z"),
    };

    const store: AiriMetaAdsMcpConfirmationStore = {
      loadState: jest.fn(async () => {
        if (initialLoads < 2) {
          initialLoads += 1;
          const snapshot = { pendingMutation, execution };
          if (initialLoads === 2) bothInitialLoads.resolve();
          await bothInitialLoads.promise;
          return snapshot;
        }
        return { pendingMutation, execution };
      }),
      claim: jest.fn(async input => {
        if (
          !pendingMutation ||
          execution ||
          input.transactionDigest !== pendingMutation.transactionDigest
        ) {
          return null;
        }
        const transaction = pendingMutation;
        pendingMutation = null;
        execution = {
          version: 2,
          id: transaction.id,
          transaction,
          status: "executing",
          claimToken: input.claimToken,
          resultMessageId: input.resultMessageId,
          confirmedByUserId: input.confirmedByUserId,
          claimedAt: input.claimedAt,
        };
        return execution;
      }),
      complete: jest.fn(async input => {
        if (
          !execution ||
          execution.status !== "executing" ||
          execution.claimToken !== input.claimToken
        ) {
          return null;
        }
        execution = {
          ...execution,
          status: input.status,
          responseContent: input.responseContent,
          error: input.error,
          completedAt: input.completedAt,
          materializedCreativeAssetIds:
            input.materializedCreativeAssetIds ?? [],
        };
        return execution;
      }),
      reconcile: jest.fn(async () => null),
      ensureResultMessage: jest.fn(async () => resultMessage),
    };
    const executeMutation = jest.fn(async () => {
      executionStarted.resolve();
      await releaseExecution.promise;
      return {
        ok: true as const,
        outcome: "succeeded" as const,
        dispatchStarted: true as const,
        result: { campaign_id: "campaign-1" },
        materializedCreativeAssetIds: [],
      };
    });
    const service = createAiriMetaAdsMcpConfirmationService({
      store,
      executeMutation,
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      createClaimToken: () => "claim-1",
      createResultMessageId: () => "507f1f77bcf86cd799439012",
    });
    const input = {
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "507f1f77bcf86cd799439011",
      messageId: "507f1f77bcf86cd799439010",
      mutationId: mutation.id,
      transactionDigest: mutation.transactionDigest,
    };

    const first = service.confirm(input);
    const second = service.confirm(input);
    await executionStarted.promise;
    releaseExecution.resolve();

    const concurrentResults = await Promise.allSettled([first, second]);
    expect(executeMutation).toHaveBeenCalledTimes(1);
    expect(
      concurrentResults.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = concurrentResults.find(
      result => result.status === "rejected"
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AiriMetaAdsMcpConfirmationError);
    expect(rejected.reason).toMatchObject({ code: "CONFIRMATION_IN_PROGRESS" });
    expect(execution).toMatchObject({
      status: "succeeded",
      resultMessageId: "507f1f77bcf86cd799439012",
    });
    expect(pendingMutation).toBeNull();

    const replay = await service.confirm(input);
    expect(replay).toMatchObject({
      confirmedMutationId: mutation.id,
      executionStatus: "succeeded",
      replayed: true,
      assistantMessage: resultMessage,
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it("persists an ambiguous post-dispatch failure and warns against another action", async () => {
    const mutation = createMutation({
      id: "meta-mcp-mutation-2",
      toolName: "create_ad",
      logicalArguments: { name: "Launch creative" },
      summary: "Create the Launch ad",
    });
    const { store, getExecution } = createSingleMutationStore(mutation);
    const service = createAiriMetaAdsMcpConfirmationService({
      store,
      executeMutation: jest.fn(async () => ({
        ok: false as const,
        outcome: "outcome_unknown" as const,
        dispatchStarted: true as const,
        error: "Meta Ads MCP HTTP 504",
        materializedCreativeAssetIds: [],
      })),
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      createClaimToken: () => "claim-2",
      createResultMessageId: () => "507f1f77bcf86cd799439013",
    });

    const result = await service.confirm({
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "507f1f77bcf86cd799439011",
      messageId: "507f1f77bcf86cd799439010",
      mutationId: mutation.id,
      transactionDigest: mutation.transactionDigest,
    });

    expect(result.executionStatus).toBe("outcome_unknown");
    expect(result.assistantMessage.content).toMatch(/could not verify/i);
    expect(result.assistantMessage.content).toMatch(
      /before taking another action/i
    );
    expect(getExecution()).toMatchObject({
      status: "outcome_unknown",
      error: "Meta Ads MCP HTTP 504",
    });
  });

  it.each([
    ["older than the review window", "2026-08-04T10:45:01.000Z"],
    ["prepared in the future", "2026-08-04T09:53:00.000Z"],
  ])(
    "records an expired card (%s) as not executed without sending it",
    async (_case, now) => {
      const mutation = createMutation({
        id: "meta-mcp-mutation-expired",
        toolName: "ads_create_campaign",
        logicalArguments: { name: "Launch" },
        summary: "Create the Launch campaign",
      });
      const { store, getExecution } = createSingleMutationStore(mutation);
      const executeMutation = jest.fn();
      const supabase = { from: jest.fn() };
      const service = createAiriMetaAdsMcpConfirmationService({
        store,
        executeMutation,
        now: () => new Date(now),
        createClaimToken: () => "claim-expired",
        createResultMessageId: () => "507f1f77bcf86cd799439019",
      });
      const input = {
        supabase: supabase as never,
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "507f1f77bcf86cd799439011",
        messageId: "507f1f77bcf86cd799439010",
        mutationId: mutation.id,
        transactionDigest: mutation.transactionDigest,
      };

      const result = await service.confirm(input);

      expect(executeMutation).not.toHaveBeenCalled();
      expect(supabase.from).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        executionStatus: "not_executed",
        replayed: false,
      });
      expect(result.assistantMessage.content).toContain(
        "Not executed (expired)"
      );
      expect(result.assistantMessage.content).toContain(
        "nothing was sent to Meta"
      );
      expect(getExecution()).toMatchObject({
        status: "not_executed",
        error: "The prepared Meta Ads change expired before it was confirmed.",
      });
      // The card is consumed: a second click replays the stored expiry.
      await expect(service.confirm(input)).resolves.toMatchObject({
        executionStatus: "not_executed",
        replayed: true,
      });
      expect(executeMutation).not.toHaveBeenCalled();
    }
  );

  it("persists a pre-dispatch provider failure as not executed", async () => {
    const mutation = createMutation({
      id: "meta-mcp-mutation-3",
      toolName: "ads_create_campaign",
      logicalArguments: { objective: "INVALID" },
      summary: "Create the Launch campaign",
    });
    const { store, getExecution } = createSingleMutationStore(mutation);
    const service = createAiriMetaAdsMcpConfirmationService({
      store,
      executeMutation: jest.fn(async () => ({
        ok: false as const,
        outcome: "not_executed" as const,
        dispatchStarted: false as const,
        error: "Invalid campaign objective",
      })),
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      createClaimToken: () => "claim-3",
      createResultMessageId: () => "507f1f77bcf86cd799439014",
    });

    const result = await service.confirm({
      supabase: readySupabase() as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "507f1f77bcf86cd799439011",
      messageId: "507f1f77bcf86cd799439010",
      mutationId: mutation.id,
      transactionDigest: mutation.transactionDigest,
    });

    expect(result.executionStatus).toBe("not_executed");
    expect(result.assistantMessage.content).toMatch(/not executed/i);
    expect(result.assistantMessage.content).not.toMatch(/completed/i);
    expect(getExecution()).toMatchObject({
      status: "not_executed",
      error: "Invalid campaign objective",
    });
  });

  it("refuses a Meta Ads source owned by another company before claiming", async () => {
    const mutation = createMutation({
      id: "meta-mcp-mutation-foreign",
      toolName: "ads_create_campaign",
      logicalArguments: { name: "Launch" },
      summary: "Create the Launch campaign",
    });
    const { store, getExecution } = createSingleMutationStore(mutation);
    const executeMutation = jest.fn();
    const service = createAiriMetaAdsMcpConfirmationService({
      store,
      executeMutation,
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      createClaimToken: () => "claim-foreign",
      createResultMessageId: () => "507f1f77bcf86cd799439017",
    });

    await expect(
      service.confirm({
        supabase: readySupabase({ workspaceCompanyId: "company-2" }) as never,
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "507f1f77bcf86cd799439011",
        messageId: "507f1f77bcf86cd799439010",
        mutationId: mutation.id,
        transactionDigest: mutation.transactionDigest,
      })
    ).rejects.toMatchObject({
      code: "CONFIRMATION_STATE_CONFLICT",
      message: expect.stringMatching(/connection or selected account changed/i),
    });
    expect(store.claim).not.toHaveBeenCalled();
    expect(executeMutation).not.toHaveBeenCalled();
    expect(getExecution()).toBeNull();
  });

  it("reconciles a stranded legacy execution without calling the provider again", async () => {
    const execution: Extract<
      AiriMetaAdsMcpConfirmationExecution,
      { version: 1 }
    > = {
      version: 1,
      id: "meta-mcp-mutation-stranded",
      toolName: "ads_create_campaign",
      arguments: { name: "Launch" },
      summary: "Create the Launch campaign",
      status: "executing",
      claimToken: "claim-stranded",
      resultMessageId: "507f1f77bcf86cd799439015",
      confirmedByUserId: "user-1",
      claimedAt: "2026-08-04T09:50:00.000Z",
    };
    let storedExecution = execution;
    const store: AiriMetaAdsMcpConfirmationStore = {
      loadState: jest.fn(async () => ({
        pendingMutation: null,
        execution: storedExecution,
      })),
      claim: jest.fn(),
      complete: jest.fn(),
      reconcile: jest.fn(async input => {
        storedExecution = {
          ...storedExecution,
          status: input.resolution === "succeeded" ? "succeeded" : "rejected",
          responseContent: input.responseContent,
          error: input.error,
          completedAt: input.completedAt,
          reconciliation: {
            userId: input.reconciliation.actorUserId,
            resolution: input.reconciliation.resolution,
            note: input.reconciliation.note,
            reconciledAt: input.reconciliation.reconciledAt,
          },
        };
        return storedExecution;
      }),
      ensureResultMessage: jest.fn(async input => ({
        _id: input.execution.resultMessageId,
        threadId: "507f1f77bcf86cd799439011",
        workspaceId: "workspace-1",
        role: "assistant" as const,
        content: input.execution.responseContent || "",
        metadata: {},
      })),
    };
    const executeMutation = jest.fn();
    const service = createAiriMetaAdsMcpConfirmationService({
      store,
      executeMutation,
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      createClaimToken: () => "unused",
      createResultMessageId: () => "unused",
    });

    const result = await service.reconcile({
      supabase: {} as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "507f1f77bcf86cd799439011",
      messageId: "507f1f77bcf86cd799439010",
      mutationId: execution.id,
      resolution: "succeeded",
      note: "Campaign 12001 is visible in Ads Manager.",
    });

    expect(executeMutation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      confirmedMutationId: execution.id,
      executionStatus: "succeeded",
      replayed: false,
    });
    expect(result.assistantMessage.content).toMatch(/manually reviewed/i);
    expect(result.assistantMessage.content).toMatch(/did not run/i);
    expect(store.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: "claim-stranded",
        expectedStatus: "executing",
        resolution: "succeeded",
        reconciliation: {
          actorUserId: "user-1",
          resolution: "succeeded",
          note: "Campaign 12001 is visible in Ads Manager.",
          reconciledAt: "2026-08-04T10:00:00.000Z",
        },
      })
    );
  });

  it("does not reconcile an execution that may still be running", async () => {
    const execution: AiriMetaAdsMcpConfirmationExecution = {
      version: 1,
      id: "meta-mcp-mutation-active",
      toolName: "ads_create_campaign",
      arguments: { name: "Launch" },
      summary: "Create the Launch campaign",
      status: "executing",
      claimToken: "claim-active",
      resultMessageId: "507f1f77bcf86cd799439016",
      confirmedByUserId: "user-1",
      claimedAt: "2026-08-04T09:59:00.000Z",
    };
    const store: AiriMetaAdsMcpConfirmationStore = {
      loadState: jest.fn(async () => ({ pendingMutation: null, execution })),
      claim: jest.fn(),
      complete: jest.fn(),
      reconcile: jest.fn(),
      ensureResultMessage: jest.fn(),
    };
    const service = createAiriMetaAdsMcpConfirmationService({
      store,
      executeMutation: jest.fn(),
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      createClaimToken: () => "unused",
      createResultMessageId: () => "unused",
    });

    await expect(
      service.reconcile({
        supabase: {} as never,
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "507f1f77bcf86cd799439011",
        messageId: "507f1f77bcf86cd799439010",
        mutationId: execution.id,
        resolution: "not_executed",
        note: "No matching campaign is visible in Ads Manager.",
      })
    ).rejects.toMatchObject({ code: "CONFIRMATION_IN_PROGRESS" });
    expect(store.reconcile).not.toHaveBeenCalled();
  });
});
