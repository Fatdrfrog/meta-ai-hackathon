jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDeltaBestEffort: jest.fn(),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));

import { emitWorkspaceUsageDeltaBestEffort } from "@/lib/limits/company-usage-events";
import {
  beginCampaignDispatch,
  cancelCampaignDispatch,
  createCampaignHistoryRecord,
  failCampaignDispatchBeforeStart,
  finalizeCampaignDispatch,
  findCampaignHistoryRunReservation,
  getCampaignDispatchBatchAggregates,
  getCampaignDispatchProviderCircuit,
  getCampaignDispatchStatus,
  isMissingOptionalCampaignLinkageColumnError,
  prepareFailedCampaignRetry,
  selectFailedCampaignSnapshotsForRetry,
  setCampaignDispatchPaused,
  updateCampaignDispatchProgress,
  updateCampaignHistoryRecipientCount,
} from "./campaign-history-store";

describe("campaign-history-store optional linkage compatibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const schemaCacheError = {
    code: "PGRST204",
    message:
      "Could not find the 'execution_source' column of 'campaign_history' in the schema cache",
  };

  it("detects Supabase schema-cache misses for optional campaign linkage columns", () => {
    expect(isMissingOptionalCampaignLinkageColumnError(schemaCacheError)).toBe(
      true
    );
    expect(
      isMissingOptionalCampaignLinkageColumnError({
        message: "column campaign_history.execution_source does not exist",
      })
    ).toBe(true);
    expect(
      isMissingOptionalCampaignLinkageColumnError({
        code: "PGRST204",
        message:
          "Could not find the 'required_column' column in the schema cache",
      })
    ).toBe(false);
  });

  it("atomically reserves one campaign history per scenario run", async () => {
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({
        data: { campaign_id: "campaign-1", created: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { campaign_id: "campaign-1", created: false },
        error: null,
      });
    const supabase = { from: jest.fn(), rpc };
    const params = {
      supabase,
      workspaceId: "00000000-0000-0000-0000-000000000001",
      name: "Scheduled campaign",
      channel: "whatsapp" as const,
      templateName: "promo",
      templateLanguage: "en",
      totalRecipients: 0,
      companyBulkCampaignLimit: 2,
      companySubscriptionType: "free" as const,
      scenarioId: "scenario-1",
      scenarioNodeId: "node-1",
      executionSource: "scenario_schedule" as const,
      executionRunKey: "weekly:UTC:2026-07-27:monday:10:00",
    };

    const [first, replay] = await Promise.all([
      createCampaignHistoryRecord(params),
      createCampaignHistoryRecord(params),
    ]);

    expect(first).toEqual({
      status: "ready",
      campaignId: "campaign-1",
      created: true,
    });
    expect(replay).toEqual({
      status: "ready",
      campaignId: "campaign-1",
      created: false,
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "reserve_scenario_campaign_history",
      expect.objectContaining({
        p_workspace_id: params.workspaceId,
        p_scenario_id: "scenario-1",
        p_scenario_node_id: "node-1",
        p_execution_source: "scenario_schedule",
        p_execution_run_key: params.executionRunKey,
        p_company_bulk_campaign_limit: 2,
        p_expected_subscription_type: "free",
      })
    );
    expect(emitWorkspaceUsageDeltaBestEffort).not.toHaveBeenCalled();
  });

  it("returns an atomic quota block without publishing usage", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "blocked",
        code: "company_bulk_campaign_limit_exceeded",
        company_bulk_campaign_limit: 2,
        company_bulk_campaign_count: 2,
      },
      error: null,
    }));

    await expect(
      createCampaignHistoryRecord({
        supabase: { from: jest.fn(), rpc },
        workspaceId: "00000000-0000-0000-0000-000000000001",
        name: "Scheduled campaign",
        channel: "whatsapp",
        templateName: "promo",
        templateLanguage: "en",
        totalRecipients: 0,
        companyBulkCampaignLimit: 2,
        companySubscriptionType: "free",
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
        executionRunKey: "weekly:UTC:2026-07-27:monday:10:00",
      })
    ).resolves.toEqual({
      status: "blocked",
      code: "company_bulk_campaign_limit_exceeded",
      companyBulkCampaignLimit: 2,
      companyBulkCampaignCount: 2,
    });
    expect(emitWorkspaceUsageDeltaBestEffort).not.toHaveBeenCalled();
  });

  it("returns a recipient allowance block from the locked reservation", async () => {
    const reserve = (used: number) =>
      createCampaignHistoryRecord({
        supabase: {
          from: jest.fn(),
          rpc: jest.fn(async () => ({
            data: {
              status: "blocked",
              code: "company_bulk_campaign_limit_exceeded",
              company_bulk_campaign_limit: 500,
              company_bulk_campaign_count: used,
              company_bulk_recipient_count: 1,
            },
            error: null,
          })),
        },
        workspaceId: "00000000-0000-0000-0000-000000000001",
        name: "Scheduled campaign",
        channel: "whatsapp",
        templateName: "promo",
        templateLanguage: "en",
        totalRecipients: 0,
        companyBulkCampaignLimit: 500,
        companySubscriptionType: "free",
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
        executionRunKey: "weekly:UTC:2026-07-27:monday:10:00",
      });

    await expect(reserve(500)).resolves.toEqual({
      status: "blocked",
      code: "company_bulk_campaign_limit_exceeded",
      companyBulkCampaignLimit: 500,
      companyBulkCampaignCount: 500,
    });
    // One recipient was still left, so this block is not a real decision.
    await expect(reserve(499)).resolves.toMatchObject({ status: "failed" });
    expect(emitWorkspaceUsageDeltaBestEffort).not.toHaveBeenCalled();
  });

  it("returns a retryable plan conflict from the locked reservation", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "conflict",
        code: "company_plan_changed",
        retryable: true,
        expected_subscription_type: "pro",
        current_subscription_type: "free",
      },
      error: null,
    }));

    await expect(
      createCampaignHistoryRecord({
        supabase: { from: jest.fn(), rpc },
        workspaceId: "00000000-0000-0000-0000-000000000001",
        name: "Scheduled campaign",
        channel: "whatsapp",
        totalRecipients: 0,
        companyBulkCampaignLimit: null,
        companySubscriptionType: "pro",
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
        executionRunKey: "weekly:UTC:2026-07-27:monday:10:00",
      })
    ).resolves.toEqual({
      status: "conflict",
      code: "company_plan_changed",
      expectedSubscriptionType: "pro",
      currentSubscriptionType: "free",
    });
  });

  it("preserves an empty-audience scenario reservation as terminal", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "skipped",
        code: "empty_audience",
        campaign_id: "campaign-empty",
        created: false,
      },
      error: null,
    }));

    await expect(
      createCampaignHistoryRecord({
        supabase: { from: jest.fn(), rpc },
        workspaceId: "00000000-0000-0000-0000-000000000001",
        name: "Scheduled campaign",
        channel: "whatsapp",
        totalRecipients: 0,
        companyBulkCampaignLimit: 2,
        companySubscriptionType: "free",
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
        executionRunKey: "weekly:UTC:2026-07-27:monday:10:00",
      })
    ).resolves.toEqual({
      status: "skipped",
      code: "empty_audience",
      campaignId: "campaign-empty",
    });
    expect(emitWorkspaceUsageDeltaBestEffort).not.toHaveBeenCalled();
  });

  it("finds a reserved scenario run and its terminal empty-audience marker", async () => {
    const builder = createMutationBuilder({
      data: {
        id: "campaign-1",
        channel: "whatsapp",
        stop_reason: "empty_audience",
        bulk_quota_reserved_at: null,
      },
      error: null,
    });
    const select = jest.fn(() => builder);
    const supabase = {
      from: jest.fn(() => ({ select })),
    };

    await expect(
      findCampaignHistoryRunReservation({
        supabase,
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
        executionRunKey: "weekly:UTC:2026-07-27:monday:10:00",
      })
    ).resolves.toEqual({
      campaignId: "campaign-1",
      channel: "whatsapp",
      stopReason: "empty_audience",
      bulkQuotaReservedAt: null,
    });

    expect(select).toHaveBeenCalledWith(
      "id, channel, stop_reason, bulk_quota_reserved_at"
    );
    expect(builder.eq.mock.calls).toEqual([
      ["workspace_id", "workspace-1"],
      ["scenario_id", "scenario-1"],
      ["scenario_node_id", "node-1"],
      ["execution_source", "scenario_schedule"],
      ["execution_run_key", "weekly:UTC:2026-07-27:monday:10:00"],
    ]);
  });

  it("finds the original timestamp reservation within a birthday's local day", async () => {
    const builder = {
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          id: "campaign-legacy",
          channel: "telegram",
          execution_run_key: "scheduled:2026-04-17T04:00:00.000Z",
          stop_reason: null,
          bulk_quota_reserved_at: null,
        },
        error: null,
      }),
    };
    const select = jest.fn(() => builder);
    const result = await findCampaignHistoryRunReservation({
      supabase: { from: jest.fn(() => ({ select })) },
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      scenarioNodeId: "bulk-root",
      executionSource: "scenario_schedule",
      executionRunKey: "birthday:2026-04-17",
      legacyScheduledForRange: {
        start: "2026-04-16T19:00:00.000Z",
        end: "2026-04-17T19:00:00.000Z",
      },
    });
    expect(result).toMatchObject({
      campaignId: "campaign-legacy",
      executionRunKey: "scheduled:2026-04-17T04:00:00.000Z",
    });
    expect(builder.eq.mock.calls).toEqual([
      ["workspace_id", "workspace-1"],
      ["scenario_id", "scenario-1"],
      ["scenario_node_id", "bulk-root"],
      ["execution_source", "scenario_schedule"],
    ]);
    expect(builder.gte).toHaveBeenCalledWith(
      "execution_run_key",
      "scheduled:2026-04-16T19:00:00.000Z"
    );
    expect(builder.lt).toHaveBeenCalledWith(
      "execution_run_key",
      "scheduled:2026-04-17T19:00:00.000Z"
    );
    expect(builder.order).toHaveBeenCalledWith("execution_run_key", {
      ascending: true,
    });
    expect(builder.limit).toHaveBeenCalledWith(1);
  });

  it("fails closed when the materialized recipient total cannot be persisted", async () => {
    const rpc = jest.fn(async () => ({
      data: null,
      error: { message: "campaign history update failed" },
    }));
    const supabase = { from: jest.fn(), rpc };

    await expect(
      updateCampaignHistoryRecipientCount({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        channel: "whatsapp",
        totalRecipients: 12,
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
        executionRunKey: "scheduled:2026-07-27T10:00:00.000Z",
      })
    ).rejects.toThrow("campaign history update failed");
    expect(rpc).toHaveBeenCalledWith(
      "reconcile_scenario_campaign_recipient_total",
      {
        p_workspace_id: "workspace-1",
        p_campaign_id: "campaign-1",
        p_total_recipients: 12,
        p_scenario_id: "scenario-1",
        p_scenario_node_id: "node-1",
        p_execution_source: "scenario_schedule",
        p_execution_run_key: "scheduled:2026-07-27T10:00:00.000Z",
      }
    );
  });

  it("accepts the row-locked monotonic recipient total", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        campaign_id: "campaign-1",
        total_recipients: 15,
        became_counted: false,
      },
      error: null,
    }));

    await expect(
      updateCampaignHistoryRecipientCount({
        supabase: { from: jest.fn(), rpc },
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        channel: "whatsapp",
        totalRecipients: 12,
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
        executionRunKey: "scheduled:2026-07-27T10:00:00.000Z",
      })
    ).resolves.toBe(15);
    expect(emitWorkspaceUsageDeltaBestEffort).not.toHaveBeenCalled();
  });

  it("publishes usage only when a provisional reservation becomes countable", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        campaign_id: "campaign-1",
        total_recipients: 12,
        became_counted: true,
      },
      error: null,
    }));

    await expect(
      updateCampaignHistoryRecipientCount({
        supabase: { from: jest.fn(), rpc },
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        channel: "whatsapp",
        totalRecipients: 12,
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
        executionRunKey: "scheduled:2026-07-27T10:00:00.000Z",
      })
    ).resolves.toBe(12);

    expect(emitWorkspaceUsageDeltaBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        metric: "bulk_campaign_count",
        delta: 1,
        objectId: "campaign-1",
      }),
      { logContext: "reconcileScenarioCampaignRecipientTotal" }
    );
  });
});

function createMutationBuilder(result: {
  data?: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}) {
  const builder = {
    eq: jest.fn(),
    is: jest.fn(),
    in: jest.fn(),
    not: jest.fn(),
    gt: jest.fn(),
    lte: jest.fn(),
    select: jest.fn(),
    maybeSingle: jest.fn(async () => result),
  };
  builder.eq.mockReturnValue(builder);
  builder.is.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  builder.not.mockReturnValue(builder);
  builder.gt.mockReturnValue(builder);
  builder.lte.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  return builder;
}

describe("campaign-history-store lifecycle ledger", () => {
  it("reads the persisted provider circuit with one workspace-scoped lookup and no delivery scan", async () => {
    const row = {
      id: "campaign-1",
      workspace_id: "workspace-1",
      provider_circuit_state: "open",
      provider_circuit_provider: "meta",
      provider_circuit_code: "131048",
    };
    const query = createMutationBuilder({ data: row, error: null });
    const select = jest.fn(() => query);
    const rpc = jest.fn();
    await expect(
      getCampaignDispatchProviderCircuit({
        supabase: { from: jest.fn(() => ({ select })), rpc },
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
      })
    ).resolves.toEqual({ state: "open", provider: "meta", code: "131048" });
    expect(query.eq.mock.calls).toEqual([
      ["id", "campaign-1"],
      ["workspace_id", "workspace-1"],
    ]);
    expect(select).toHaveBeenCalledWith(
      "id,workspace_id,provider_circuit_state,provider_circuit_provider,provider_circuit_code"
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {
      id: "campaign-1",
      workspace_id: "other-workspace",
      provider_circuit_state: "closed",
    },
    {
      id: "campaign-1",
      workspace_id: "workspace-1",
      provider_circuit_state: "unknown",
    },
    {
      id: "campaign-1",
      workspace_id: "workspace-1",
      provider_circuit_state: "open",
      provider_circuit_provider: "meta",
    },
  ])(
    "fails closed for missing or invalid campaign circuit state %#",
    async data => {
      const query = createMutationBuilder({ data, error: null });
      await expect(
        getCampaignDispatchProviderCircuit({
          supabase: { from: jest.fn(() => ({ select: () => query })) },
          workspaceId: "workspace-1",
          campaignId: "campaign-1",
        })
      ).rejects.toThrow(/getCampaignDispatchProviderCircuit/);
    }
  );

  it("returns a closed persisted circuit without requiring error metadata", async () => {
    const query = createMutationBuilder({
      data: {
        id: "campaign-1",
        workspace_id: "workspace-1",
        provider_circuit_state: "closed",
      },
      error: null,
    });
    await expect(
      getCampaignDispatchProviderCircuit({
        supabase: { from: jest.fn(() => ({ select: () => query })) },
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
      })
    ).resolves.toEqual({ state: "closed" });
  });

  const now = new Date("2026-07-24T08:00:00.000Z");

  it("begins through the atomic RPC and binds idempotency to the workflow", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        outcome: "already_started",
        campaign_id: "campaign-1",
        workflow_id: "workflow-1",
        dispatch_status: "running",
      },
      error: null,
    }));
    const supabase = { from: jest.fn(), rpc };

    await expect(
      beginCampaignDispatch({
        supabase,
        campaignId: "campaign-1",
        expectedWorkflowId: "workflow-1",
        now,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: "already_started",
        status: "running",
        workflowId: "workflow-1",
      })
    );

    expect(rpc).toHaveBeenCalledWith("begin_bulk_campaign_dispatch", {
      p_campaign_id: "campaign-1",
      p_workflow_id: "workflow-1",
      p_now: now.toISOString(),
    });
  });

  it("fails closed when the required lifecycle RPC is absent", async () => {
    const rpc = jest.fn(async () => ({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find begin_bulk_campaign_dispatch",
      },
    }));
    const supabase = { from: jest.fn(), rpc };

    await expect(
      beginCampaignDispatch({
        supabase,
        campaignId: "campaign-1",
        expectedWorkflowId: "workflow-1",
        now,
      })
    ).rejects.toThrow("begin_bulk_campaign_dispatch");
  });

  it("delegates progress bounds and regression protection to the locked RPC", async () => {
    const rpc = jest.fn(async () => ({
      data: { applied: true, dispatch_status: "running" },
      error: null,
    }));
    const supabase = { from: jest.fn(), rpc };

    await expect(
      updateCampaignDispatchProgress({
        supabase,
        campaignId: "campaign-1",
        processedCount: 6,
        acceptedCount: 4,
        failedCount: 2,
        attemptedCount: 6,
        notAttemptedCount: 4,
        now,
      })
    ).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("update_bulk_campaign_progress", {
      p_campaign_id: "campaign-1",
      p_processed_count: 6,
      p_accepted_count: 4,
      p_failed_count: 2,
      p_attempted_count: 6,
      p_not_attempted_count: 4,
      p_now: now.toISOString(),
    });
  });

  it("finalizes through the locked terminal CAS RPC", async () => {
    const rpc = jest.fn(async () => ({
      data: { applied: true, dispatch_status: "failed" },
      error: null,
    }));
    const supabase = { from: jest.fn(), rpc };

    await expect(
      finalizeCampaignDispatch({
        supabase,
        campaignId: "campaign-1",
        status: "failed",
        processedCount: 4,
        acceptedCount: 0,
        failedCount: 4,
        attemptedCount: 4,
        notAttemptedCount: 6,
        stopReason: "provider_circuit_open",
        providerCircuit: {
          state: "open",
          provider: "meta",
          code: "131042",
        },
        now,
      })
    ).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("finalize_bulk_campaign_dispatch", {
      p_campaign_id: "campaign-1",
      p_dispatch_status: "failed",
      p_processed_count: 4,
      p_accepted_count: 0,
      p_failed_count: 4,
      p_attempted_count: 4,
      p_not_attempted_count: 6,
      p_stop_reason: "provider_circuit_open",
      p_provider_circuit_state: "open",
      p_provider_circuit_provider: "meta",
      p_provider_circuit_code: "131042",
      p_now: now.toISOString(),
    });
  });

  it("treats an ambiguous already-finalized RPC commit as idempotent", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        applied: true,
        outcome: "already_finalized",
        dispatch_status: "completed",
      },
      error: null,
    }));

    await expect(
      finalizeCampaignDispatch({
        supabase: { from: jest.fn(), rpc },
        campaignId: "campaign-1",
        status: "completed",
        processedCount: 10,
        acceptedCount: 10,
        failedCount: 0,
        attemptedCount: 10,
        notAttemptedCount: 0,
        now,
      })
    ).resolves.toBe(true);
  });

  it("fails an admitted dispatch before start through the guarded RPC", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        applied: true,
        outcome: "already_failed",
        dispatch_status: "failed",
      },
      error: null,
    }));

    await expect(
      failCampaignDispatchBeforeStart({
        supabase: { from: jest.fn(), rpc },
        campaignId: "campaign-1",
        stopReason: "workflow_start_failed",
        now,
      })
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("fail_bulk_campaign_before_start", {
      p_campaign_id: "campaign-1",
      p_stop_reason: "workflow_start_failed",
      p_now: now.toISOString(),
    });
  });

  it("records an explicit pre-start expiry reason", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        applied: true,
        outcome: "failed",
        dispatch_status: "failed",
      },
      error: null,
    }));

    await expect(
      failCampaignDispatchBeforeStart({
        supabase: { from: jest.fn(), rpc },
        campaignId: "campaign-1",
        stopReason: "dispatch_expired_before_start",
        now,
      })
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("fail_bulk_campaign_before_start", {
      p_campaign_id: "campaign-1",
      p_stop_reason: "dispatch_expired_before_start",
      p_now: now.toISOString(),
    });
  });

  it("cancels active dispatches idempotently and always scopes by workspace", async () => {
    const activeMutation = createMutationBuilder({
      data: {
        id: "campaign-1",
        workflow_id: "workflow-1",
        dispatch_status: "cancelled",
      },
      error: null,
    });
    const alreadyCancelledMutation = createMutationBuilder({
      data: null,
      error: null,
    });
    const statusSelect = createMutationBuilder({
      data: {
        id: "campaign-1",
        workflow_id: "workflow-1",
        dispatch_status: "cancelled",
      },
      error: null,
    });
    const update = jest
      .fn()
      .mockReturnValueOnce(activeMutation)
      .mockReturnValueOnce(alreadyCancelledMutation);
    const select = jest.fn(() => statusSelect);
    const supabase = {
      from: jest.fn(() => ({ update, select })),
    };

    await expect(
      cancelCampaignDispatch({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        now,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: "cancelled",
        status: "cancelled",
        workflowId: "workflow-1",
      })
    );
    await expect(
      cancelCampaignDispatch({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        now,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: "already_cancelled",
        status: "cancelled",
      })
    );

    expect(activeMutation.eq).toHaveBeenCalledWith(
      "workspace_id",
      "workspace-1"
    );
    expect(alreadyCancelledMutation.eq).toHaveBeenCalledWith(
      "workspace_id",
      "workspace-1"
    );
    expect(statusSelect.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
  });

  it("pauses and resumes active dispatches without changing lifecycle status", async () => {
    const pauseMutation = createMutationBuilder({
      data: {
        id: "campaign-1",
        workflow_id: "workflow-1",
        dispatch_status: "running",
        stop_reason: "paused_by_operator",
      },
      error: null,
    });
    const resumeMutation = createMutationBuilder({
      data: {
        id: "campaign-1",
        workflow_id: "workflow-1",
        dispatch_status: "running",
        stop_reason: null,
      },
      error: null,
    });
    const update = jest
      .fn()
      .mockReturnValueOnce(pauseMutation)
      .mockReturnValueOnce(resumeMutation);
    const supabase = {
      from: jest.fn(() => ({ update, select: jest.fn() })),
    };

    await expect(
      setCampaignDispatchPaused({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        paused: true,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: "paused",
        status: "running",
        workflowId: "workflow-1",
      })
    );
    await expect(
      setCampaignDispatchPaused({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        paused: false,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: "resumed",
        status: "running",
      })
    );

    expect(update).toHaveBeenNthCalledWith(1, {
      stop_reason: "paused_by_operator",
    });
    expect(update).toHaveBeenNthCalledWith(2, { stop_reason: null });
    expect(pauseMutation.eq).toHaveBeenCalledWith(
      "workspace_id",
      "workspace-1"
    );
    expect(pauseMutation.is).toHaveBeenCalledWith("stop_reason", null);
    expect(resumeMutation.eq).toHaveBeenCalledWith(
      "stop_reason",
      "paused_by_operator"
    );
    expect(pauseMutation.in).toHaveBeenCalledWith("dispatch_status", [
      "queued",
      "scheduled",
      "running",
    ]);
  });

  it("falls back to the current row when pause/resume matches no mutation", async () => {
    const pausedRow = {
      id: "campaign-1",
      workflow_id: "workflow-1",
      dispatch_status: "running",
      stop_reason: "paused_by_operator",
    };
    const pauseMutation = createMutationBuilder({ data: null, error: null });
    const resumeMutation = createMutationBuilder({ data: null, error: null });
    const pausedSelect = createMutationBuilder({
      data: pausedRow,
      error: null,
    });
    const missingSelect = createMutationBuilder({ data: null, error: null });
    const update = jest
      .fn()
      .mockReturnValueOnce(pauseMutation)
      .mockReturnValueOnce(resumeMutation);
    const select = jest
      .fn()
      .mockReturnValueOnce(pausedSelect)
      .mockReturnValueOnce(missingSelect);
    const supabase = {
      from: jest.fn(() => ({ update, select })),
    };

    await expect(
      setCampaignDispatchPaused({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        paused: true,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: "already_paused",
        status: "running",
      })
    );
    await expect(
      setCampaignDispatchPaused({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        paused: false,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: "not_found",
        status: null,
      })
    );
  });

  it("returns workspace-scoped aggregate status without recipient identity or snapshots", async () => {
    const history = createMutationBuilder({
      data: {
        id: "campaign-1",
        workspace_id: "workspace-1",
        workflow_id: "workflow-1",
        dispatch_status: "running",
        total_recipients: 5,
        processed_count: 4,
        accepted_count: 3,
        attempted_count: 4,
        not_attempted_count: 1,
        successful_sends: 3,
        failed_sends: 1,
        provider_circuit_state: "closed",
      },
      error: null,
    });
    const rpc = jest.fn(async () => ({
      data: {
        pending: 1,
        accepted: 1,
        delivered: 1,
        read: 1,
        failed: 1,
        retryable_failed_recipient_count: 1,
      },
      error: null,
    }));
    const supabase = {
      from: jest.fn((table: string) => {
        if (table === "campaign_history") {
          return { select: jest.fn(() => history) };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
      rpc,
    };

    const status = await getCampaignDispatchStatus({
      supabase,
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
    });

    expect(status).toEqual(
      expect.objectContaining({
        campaignId: "campaign-1",
        workspaceId: "workspace-1",
        status: "running",
        delivery: {
          pending: 1,
          accepted: 1,
          delivered: 1,
          read: 1,
          failed: 1,
        },
      })
    );
    expect(history.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(JSON.stringify(status)).not.toContain("recipient_hash");
    expect(JSON.stringify(status)).not.toContain("dispatch_snapshot");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("get_bulk_campaign_delivery_counts", {
      p_campaign_id: "campaign-1",
    });
  });

  it("selects failed immutable snapshots internally in ordinal order after workspace authorization", async () => {
    const history = createMutationBuilder({
      data: { id: "campaign-1" },
      error: null,
    });
    const rpc = jest.fn(async () => ({
      data: [
        {
          campaign_id: "campaign-1",
          status: "failed",
          channel: "whatsapp",
          recipient: "77000000001",
          snapshot_ordinal: 1,
          dispatch_snapshot: { phone: "77000000001", template: "promo" },
          provider: "postmark",
          error_code: null,
          failure_scope: "provider",
          failure_reason:
            '{"providerCode":"SMTP_RATE_LIMIT","providerScope":"provider"}',
          error_message: "Provider throttled the send",
        },
      ],
      error: null,
    }));
    const supabase = {
      from: jest.fn((table: string) => {
        if (table !== "campaign_history") {
          throw new Error(`Unexpected direct table read: ${table}`);
        }
        return { select: jest.fn(() => history) };
      }),
      rpc,
    };

    const snapshots = await selectFailedCampaignSnapshotsForRetry({
      supabase,
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
    });

    expect(history.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(rpc).toHaveBeenCalledWith("get_bulk_campaign_retryable_snapshots", {
      p_campaign_id: "campaign-1",
      p_workspace_id: "workspace-1",
    });
    expect(snapshots).toEqual([
      {
        campaignId: "campaign-1",
        channel: "whatsapp",
        recipient: "77000000001",
        snapshotOrdinal: 1,
        dispatchSnapshot: { phone: "77000000001", template: "promo" },
        providerFailure: {
          provider: "postmark",
          code: "SMTP_RATE_LIMIT",
          scope: "provider",
          message: "Provider throttled the send",
        },
      },
    ]);
  });

  it("returns one typed retry preparation with terminal source metadata and current failed snapshots", async () => {
    const history = createMutationBuilder({
      data: {
        id: "campaign-1",
        workspace_id: "workspace-1",
        channel: "whatsapp",
        name: "July follow-up",
        template_name: "july_follow_up",
        template_language: "en",
        message_text: null,
        total_recipients: 2,
        dispatch_status: "failed",
        provider_circuit_state: "open",
        provider_circuit_provider: "meta",
        provider_circuit_code: "131042",
        provider_circuit_opened_at: "2026-07-24T09:00:00.000Z",
      },
      error: null,
    });
    const rpc = jest.fn(async () => ({
      data: [
        {
          campaign_id: "campaign-1",
          status: "failed",
          channel: "whatsapp",
          recipient: "77000000001",
          snapshot_ordinal: 0,
          dispatch_snapshot: {
            workspaceId: "workspace-1",
            campaignId: "campaign-1",
            channel: "whatsapp",
            recipient: { phone: "77000000001" },
            phoneNumberId: "phone-1",
            templateName: "july_follow_up",
          },
          provider: "meta",
          error_code: 131042,
          failure_scope: "provider",
          failure_reason: "provider",
          error_message: "Payment issue",
        },
      ],
      error: null,
    }));
    const supabase = {
      from: jest.fn((table: string) => {
        if (table !== "campaign_history") {
          throw new Error(`Unexpected direct table read: ${table}`);
        }
        return { select: jest.fn(() => history) };
      }),
      rpc,
    };

    await expect(
      prepareFailedCampaignRetry({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
      })
    ).resolves.toEqual({
      source: {
        campaignId: "campaign-1",
        workspaceId: "workspace-1",
        channel: "whatsapp",
        name: "July follow-up",
        templateName: "july_follow_up",
        templateLanguage: "en",
        messageText: null,
        totalRecipients: 2,
        status: "failed",
        providerCircuit: {
          state: "open",
          provider: "meta",
          code: "131042",
          openedAt: "2026-07-24T09:00:00.000Z",
        },
      },
      failedSnapshots: [
        {
          campaignId: "campaign-1",
          channel: "whatsapp",
          recipient: "77000000001",
          snapshotOrdinal: 0,
          dispatchSnapshot: {
            workspaceId: "workspace-1",
            campaignId: "campaign-1",
            channel: "whatsapp",
            recipient: { phone: "77000000001" },
            phoneNumberId: "phone-1",
            templateName: "july_follow_up",
          },
          providerFailure: {
            provider: "meta",
            code: 131042,
            scope: "provider",
            message: "Payment issue",
          },
        },
      ],
    });
    expect(history.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(rpc).toHaveBeenCalledWith("get_bulk_campaign_retryable_snapshots", {
      p_campaign_id: "campaign-1",
      p_workspace_id: "workspace-1",
    });
  });

  function retryChainStore(
    overrides: Record<string, Record<string, unknown>> = {}
  ) {
    const rows: Record<string, Record<string, unknown>> = Object.fromEntries(
      ["child", "middle", "original"].map((id, index) => [
        id,
        {
          id,
          workspace_id: "workspace-1",
          channel: "whatsapp",
          name: "Retry fixture",
          dispatch_status: "failed",
          total_recipients: 2,
          provider_circuit_state: "closed",
          retry_of_campaign_id: ["middle", "original", null][index],
          ...overrides[id],
        },
      ])
    );
    const builders: Array<{ eq: jest.Mock }> = [];
    const from = jest.fn(() => {
      const filters: Record<string, string> = {};
      const builder: {
        select: jest.Mock;
        eq: jest.Mock;
        maybeSingle: jest.Mock;
      } = {
        select: jest.fn(() => builder),
        eq: jest.fn((column: string, value: string) => {
          filters[column] = value;
          return builder;
        }),
        maybeSingle: jest.fn(async () => ({
          data: rows[filters.id] || null,
          error: null,
        })),
      };
      builders.push(builder);
      return builder;
    });
    const rpc = jest.fn(
      async (name: string, args: Record<string, unknown>) => ({
        data:
          name === "get_bulk_campaign_retryable_snapshots"
            ? []
            : (args.p_campaign_ids as string[]).map(id => ({
                campaign_id: id,
                pending: 0,
                accepted: 0,
                delivered: 0,
                read: 0,
                failed: 2,
                retryable_failed_recipient_count: 2,
                common_provider_failure_provider:
                  id === "original" ? "meta" : null,
                common_provider_failure_code:
                  id === "original" ? "131048" : null,
                common_provider_failure_count: id === "original" ? 2 : 0,
              })),
        error: null,
      })
    );
    return { supabase: { from, rpc }, builders, rows };
  }

  it("retains an original Meta restriction through two locally suppressed retries", async () => {
    const { supabase, builders } = retryChainStore();
    const result = await prepareFailedCampaignRetry({
      supabase,
      workspaceId: "workspace-1",
      campaignId: "child",
    });
    expect(result?.ancestorProviderCircuit).toEqual({
      state: "open",
      provider: "meta",
      code: "131048",
      failureCount: 2,
    });
    expect(builders).toHaveLength(3);
    for (const builder of builders)
      expect(builder.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "get_bulk_campaign_retryable_snapshots",
      expect.objectContaining({ p_campaign_id: "original" })
    );
  });

  it("stops inherited acknowledgment requirements at a recorded child acknowledgment", async () => {
    const { supabase } = retryChainStore({
      child: {
        provider_circuit_acknowledged_at: "2026-09-16T00:00:00.000Z",
        provider_circuit_acknowledged_by: "actor-1",
      },
    });
    const result = await prepareFailedCampaignRetry({
      supabase,
      workspaceId: "workspace-1",
      campaignId: "child",
    });
    expect(result?.ancestorProviderCircuit).toBeUndefined();
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["cycle", { middle: { retry_of_campaign_id: "child" } }],
    ["missing ancestor", { middle: { retry_of_campaign_id: "missing" } }],
    ["foreign ancestor", { middle: { workspace_id: "workspace-2" } }],
    ["different channel", { middle: { channel: "email" } }],
    [
      "malformed acknowledgment",
      {
        child: {
          provider_circuit_acknowledged_at: "not-a-date",
          provider_circuit_acknowledged_by: "actor-1",
        },
      },
    ],
  ])("rejects retry ancestry with %s", async (_label, overrides) => {
    const { supabase } = retryChainStore(
      overrides as Record<string, Record<string, unknown>>
    );
    await expect(
      prepareFailedCampaignRetry({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "child",
      })
    ).rejects.toThrow(/retry ancestry/i);
  });

  it("bounds ancestor reads at twenty without loading each ancestor audience", async () => {
    const { supabase, rows } = retryChainStore();
    rows.child.retry_of_campaign_id = "ancestor-0";
    for (let index = 0; index < 21; index++)
      rows[`ancestor-${index}`] = {
        ...rows.middle,
        id: `ancestor-${index}`,
        retry_of_campaign_id: `ancestor-${index + 1}`,
      };
    await expect(
      prepareFailedCampaignRetry({
        supabase,
        workspaceId: "workspace-1",
        campaignId: "child",
      })
    ).rejects.toThrow(/retry ancestry/i);
    expect(supabase.from.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it.each([
    [131049, "131048", 131049],
    [131048, "contact_frequency_limit", 131048],
    [null, "131048", "131048"],
    [null, " 131048 ", "131048"],
    [null, "131049", "131049"],
    [null, "999999", "999999"],
    [null, "contact_frequency_limit", null],
  ])(
    "prefers canonical Meta code %s over legacy %s",
    async (errorCode, legacyCode, expectedCode) => {
      const history = createMutationBuilder({
        data: { id: "campaign-1" },
        error: null,
      });
      const snapshots = await selectFailedCampaignSnapshotsForRetry({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        supabase: {
          from: jest.fn(() => ({ select: () => history })),
          rpc: jest.fn(async () => ({
            data: [
              {
                campaign_id: "campaign-1",
                status: "failed",
                channel: "whatsapp",
                recipient: "77000000001",
                snapshot_ordinal: 0,
                dispatch_snapshot: {},
                provider: "meta",
                error_code: errorCode,
                failure_reason: JSON.stringify({
                  providerCode: legacyCode,
                  providerScope: "provider",
                }),
              },
            ],
            error: null,
          })),
        },
      });
      expect(snapshots[0]?.providerFailure.code).toBe(expectedCode);
    }
  );

  it.each([
    ["meta", "131048", 1, "open"],
    ["meta", "contact_frequency_limit", 1, "closed"],
    ["meta", "131049", 1, "closed"],
    ["postmark", "131048", 1, "closed"],
    ["meta", "contact_frequency_limit", 2, "closed"],
    ["meta", "131049", 2, "closed"],
    ["meta", "999999", 2, "closed"],
  ])(
    "classifies aggregate %s/%s count %i as %s",
    async (provider, code, count, state) => {
      const aggregates = await getCampaignDispatchBatchAggregates({
        supabase: {
          from: jest.fn(),
          rpc: jest.fn(async () => ({
            data: [
              {
                campaign_id: "campaign-1",
                pending: 0,
                accepted: 0,
                delivered: 10,
                read: 0,
                failed: 1,
                retryable_failed_recipient_count: 1,
                top_failure_reason: "Failure",
                top_failure_count: 1,
                common_provider_failure_provider: provider,
                common_provider_failure_code: code,
                common_provider_failure_count: count,
              },
            ],
            error: null,
          })),
        },
        workspaceId: "workspace-1",
        campaignIds: ["campaign-1"],
      });
      expect(aggregates.get("campaign-1")?.providerCircuit).toEqual(
        state === "open"
          ? { state, provider, code, failureCount: count }
          : { state }
      );
    }
  );

  it("does not report a leftover Meta throughput rejection as an open circuit", async () => {
    const rpc = jest.fn(async () => ({
      data: [
        {
          campaign_id: "campaign-1",
          pending: 0,
          accepted: 238,
          delivered: 0,
          read: 0,
          failed: 1,
          retryable_failed_recipient_count: 1,
          top_failure_reason: "Rate limit hit",
          top_failure_error_code: 130429,
          top_failure_count: 1,
          // What the delivery counts reported before 20261020140817.
          common_provider_failure_provider: "meta",
          common_provider_failure_code: "130429",
          common_provider_failure_count: 1,
        },
      ],
      error: null,
    }));

    const aggregates = await getCampaignDispatchBatchAggregates({
      supabase: { from: jest.fn(), rpc },
      workspaceId: "workspace-1",
      campaignIds: ["campaign-1"],
    });

    expect(aggregates.get("campaign-1")).toMatchObject({
      retryableFailedRecipientCount: 1,
      providerCircuit: { state: "closed" },
    });
  });

  it("loads aggregate delivery/circuit summaries for a history page with one workspace-scoped RPC", async () => {
    const rpc = jest.fn(async () => ({
      data: [
        {
          campaign_id: "campaign-1",
          pending: 0,
          accepted: 0,
          delivered: 0,
          read: 0,
          failed: 2,
          retryable_failed_recipient_count: 2,
          top_failure_reason: "Payment issue",
          top_failure_error_code: 131042,
          top_failure_count: 2,
          common_provider_failure_provider: "meta",
          common_provider_failure_code: "131042",
          common_provider_failure_count: 2,
        },
        {
          campaign_id: "campaign-2",
          pending: 1,
          accepted: 1,
          delivered: 1,
          read: 1,
          failed: 0,
          retryable_failed_recipient_count: 0,
          top_failure_reason: null,
          top_failure_error_code: null,
          top_failure_count: null,
          common_provider_failure_provider: null,
          common_provider_failure_code: null,
          common_provider_failure_count: 0,
        },
      ],
      error: null,
    }));

    const aggregates = await getCampaignDispatchBatchAggregates({
      supabase: { from: jest.fn(), rpc },
      workspaceId: "workspace-1",
      campaignIds: ["campaign-1", "campaign-2"],
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "get_bulk_campaign_delivery_counts_batch",
      {
        p_workspace_id: "workspace-1",
        p_campaign_ids: ["campaign-1", "campaign-2"],
      }
    );
    expect(aggregates.get("campaign-1")).toEqual({
      delivery: {
        pending: 0,
        accepted: 0,
        delivered: 0,
        read: 0,
        failed: 2,
      },
      topFailure: {
        reason: "Payment issue",
        errorCode: 131042,
        count: 2,
      },
      retryableFailedRecipientCount: 2,
      providerCircuit: {
        state: "open",
        provider: "meta",
        code: "131042",
        failureCount: 2,
      },
    });
    expect(aggregates.get("campaign-2")).toEqual({
      delivery: {
        pending: 1,
        accepted: 1,
        delivered: 1,
        read: 1,
        failed: 0,
      },
      topFailure: null,
      retryableFailedRecipientCount: 0,
      providerCircuit: { state: "closed" },
    });
  });

  it("keeps bounced delivery failures separate from retryable failed snapshots", async () => {
    const rpc = jest.fn(async () => ({
      data: [
        {
          campaign_id: "bounced-only",
          pending: 0,
          accepted: 0,
          delivered: 0,
          read: 0,
          failed: 2,
          retryable_failed_recipient_count: 0,
          top_failure_reason: "Mailbox rejected",
          top_failure_error_code: 550,
          top_failure_count: 2,
          common_provider_failure_provider: null,
          common_provider_failure_code: null,
          common_provider_failure_count: 0,
        },
        {
          campaign_id: "mixed-failures",
          pending: 0,
          accepted: 0,
          delivered: 0,
          read: 0,
          failed: 3,
          retryable_failed_recipient_count: 1,
          top_failure_reason: "Immediate provider failure",
          top_failure_error_code: 500,
          top_failure_count: 1,
          common_provider_failure_provider: null,
          common_provider_failure_code: null,
          common_provider_failure_count: 0,
        },
      ],
      error: null,
    }));

    const aggregates = await getCampaignDispatchBatchAggregates({
      supabase: { from: jest.fn(), rpc },
      workspaceId: "workspace-1",
      campaignIds: ["bounced-only", "mixed-failures"],
    });

    expect(aggregates.get("bounced-only")).toEqual(
      expect.objectContaining({
        delivery: expect.objectContaining({ failed: 2 }),
        retryableFailedRecipientCount: 0,
      })
    );
    expect(aggregates.get("mixed-failures")).toEqual(
      expect.objectContaining({
        delivery: expect.objectContaining({ failed: 3 }),
        retryableFailedRecipientCount: 1,
      })
    );
  });
});
