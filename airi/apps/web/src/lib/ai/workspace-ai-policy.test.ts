import {
  getWorkspaceTextAiAllowance,
  hasWorkspaceTextAiAction,
  resolveWorkspaceTextAiBilling,
  withWorkspaceTextAiAction,
  WorkspaceAiSourceRequiredError,
  reserveWorkspaceTextAiSpend,
  settleWorkspaceTextAiSpend,
} from "./workspace-ai-policy";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  GoogleAiConnectionError,
  resolveGoogleAiCredentialsForWorkspace,
} from "@/lib/google/google-ai-source";

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: jest.fn(), from: jest.fn() },
}));
jest.mock("@/lib/google/google-ai-source", () => ({
  ...jest.requireActual("@/lib/google/google-ai-source"),
  resolveGoogleAiCredentialsForWorkspace: jest.fn(),
}));

const workspaceId = "20000000-0000-0000-0000-000000000001";
const companyId = "10000000-0000-0000-0000-000000000001";
const sourceId = "30000000-0000-0000-0000-000000000001";
const action = { workspaceId, actionId: "reply:message-1" };
const periodStart = "2026-09-01T00:00:00.000Z";
const resetAt = null;
const decision = {
  workspace_id: workspaceId,
  company_id: companyId,
  plan: "pro",
  billing_source: "platform",
  source_id: null,
  period_start: periodStart,
  reset_at: resetAt,
  allowance_period: "lifetime",
};
const rpc = jest.mocked(supabaseAdmin.rpc);
const from = jest.mocked(supabaseAdmin.from);
const credentials = jest.mocked(resolveGoogleAiCredentialsForWorkspace);
const sponsoredAction = {
  workspaceId,
  actionId: "classification:conversation-1:7",
  sponsorship: "platform" as const,
};

function mockWorkspaceCompany(result: { company_id: string } | null) {
  const maybeSingle = jest.fn(async () => ({ data: result, error: null }));
  const eq = jest.fn(() => ({ maybeSingle }));
  const select = jest.fn(() => ({ eq }));
  from.mockReturnValue({ select } as never);
  return { select, eq };
}

describe("workspace text AI action policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rpc.mockResolvedValue({ data: decision, error: null } as never);
    credentials.mockResolvedValue({ sourceId, apiKey: "customer-secret" });
  });

  it("bills a platform-sponsored action without admitting or reserving company spend", async () => {
    const { select, eq } = mockWorkspaceCompany({ company_id: companyId });
    await withWorkspaceTextAiAction(sponsoredAction, async () => {
      await expect(resolveWorkspaceTextAiBilling()).resolves.toEqual({
        billingSource: "platform",
        workspaceId,
        companyId,
        actionId: sponsoredAction.actionId,
        sourceId: null,
      });
      await expect(
        reserveWorkspaceTextAiSpend({
          provider: "anthropic",
          model: "claude-haiku-4-5",
          request: "classify",
          maxOutputTokens: 100,
        })
      ).resolves.toBeNull();
      await expect(resolveWorkspaceTextAiBilling()).resolves.toMatchObject({
        companyId,
      });
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("workspaces");
    expect(select).toHaveBeenCalledWith("company_id");
    expect(eq).toHaveBeenCalledWith("id", workspaceId);
  });

  it("keeps request bounds for sponsored spend", async () => {
    mockWorkspaceCompany({ company_id: companyId });
    await withWorkspaceTextAiAction(sponsoredAction, async () => {
      await expect(
        reserveWorkspaceTextAiSpend({
          provider: "anthropic",
          model: "unpriced-model",
          request: "classify",
          maxOutputTokens: 100,
        })
      ).rejects.toMatchObject({ code: "workspace_ai_spend_limit" });
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails a sponsored action closed when its company cannot be resolved", async () => {
    mockWorkspaceCompany(null);
    await withWorkspaceTextAiAction(sponsoredAction, async () => {
      await expect(resolveWorkspaceTextAiBilling()).rejects.toMatchObject({
        code: "workspace_ai_policy_unavailable",
      });
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("lets the outermost action decide sponsorship for nested actions", async () => {
    mockWorkspaceCompany({ company_id: companyId });
    await withWorkspaceTextAiAction(sponsoredAction, () =>
      withWorkspaceTextAiAction(action, async () => {
        await expect(resolveWorkspaceTextAiBilling()).resolves.toMatchObject({
          billingSource: "platform",
          actionId: sponsoredAction.actionId,
        });
      })
    );
    expect(rpc).not.toHaveBeenCalled();

    await withWorkspaceTextAiAction(action, () =>
      withWorkspaceTextAiAction(sponsoredAction, async () => {
        await resolveWorkspaceTextAiBilling();
      })
    );
    expect(rpc).toHaveBeenCalledWith("admit_workspace_text_ai_action", {
      p_workspace_id: workspaceId,
      p_action_id: action.actionId,
    });
  });

  it("rejects unscoped paid inference before spending", async () => {
    await expect(
      reserveWorkspaceTextAiSpend({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        request: "hi",
        maxOutputTokens: 100,
      })
    ).rejects.toMatchObject({ code: "workspace_ai_policy_unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reserves before provider work and retains an unknown incurred outcome", async () => {
    const calls: string[] = [];
    rpc.mockImplementation((name, args) => {
      calls.push(name);
      return Promise.resolve({
        data:
          name === "admit_workspace_text_ai_action"
            ? decision
            : name === "reserve_workspace_ai_spend"
              ? {
                  code: "reserved",
                  workspace_id: workspaceId,
                  action_id: action.actionId,
                  operation_id: args!.p_operation_id,
                  max_cost_micros: args!.p_max_cost_micros,
                }
              : { code: "uncertain" },
        error: null,
      }) as never;
    });
    await withWorkspaceTextAiAction(action, async () => {
      const reserved = await reserveWorkspaceTextAiSpend({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        request: "hi",
        maxOutputTokens: 100,
      });
      calls.push("provider");
      await settleWorkspaceTextAiSpend(reserved, "claude-haiku-4-5", undefined);
    });
    expect(calls).toEqual([
      "admit_workspace_text_ai_action",
      "reserve_workspace_ai_spend",
      "provider",
      "settle_workspace_ai_spend",
    ]);
  });

  it("prices zero-output embeddings through the same reservation and settlement", async () => {
    rpc.mockImplementation(
      (name, args) =>
        Promise.resolve({
          data:
            name === "admit_workspace_text_ai_action"
              ? decision
              : name === "reserve_workspace_ai_spend"
                ? {
                    code: "reserved",
                    workspace_id: workspaceId,
                    action_id: action.actionId,
                    operation_id: args!.p_operation_id,
                    max_cost_micros: args!.p_max_cost_micros,
                  }
                : { code: "settled" },
          error: null,
        }) as never
    );
    await withWorkspaceTextAiAction(action, async () => {
      const reservation = await reserveWorkspaceTextAiSpend({
        provider: "vertex",
        model: "gemini-embedding-001",
        request: { text: "document" },
        maxOutputTokens: 0,
      });
      await settleWorkspaceTextAiSpend(reservation, "gemini-embedding-001", {
        prompt_tokens: 1000,
        completion_tokens: 0,
      });
    });
    expect(rpc).toHaveBeenCalledWith(
      "settle_workspace_ai_spend",
      expect.objectContaining({ p_actual_cost_micros: 150 })
    );
  });

  it("leaves unscoped infrastructure calls alone and admits lazily", async () => {
    expect(hasWorkspaceTextAiAction()).toBe(false);
    await expect(resolveWorkspaceTextAiBilling()).resolves.toBeNull();
    await withWorkspaceTextAiAction(action, async () => {
      expect(hasWorkspaceTextAiAction()).toBe(true);
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(hasWorkspaceTextAiAction()).toBe(false);
  });

  it("shares one admission across parallel inference, child actions and retries", async () => {
    await withWorkspaceTextAiAction(action, async () => {
      const billing = await Promise.all([
        resolveWorkspaceTextAiBilling(),
        withWorkspaceTextAiAction(
          { ...action, actionId: "child" },
          resolveWorkspaceTextAiBilling
        ),
        resolveWorkspaceTextAiBilling(),
      ]);
      expect(billing).toEqual(
        Array(3).fill({
          billingSource: "platform",
          workspaceId,
          companyId,
          actionId: action.actionId,
          sourceId: null,
        })
      );
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("admit_workspace_text_ai_action", {
      p_workspace_id: workspaceId,
      p_action_id: action.actionId,
    });
  });

  it("rejects a nested different workspace before running its callback", async () => {
    const run = jest.fn();
    await withWorkspaceTextAiAction(action, async () => {
      await expect(
        withWorkspaceTextAiAction(
          { workspaceId: "other", actionId: "child" },
          run
        )
      ).rejects.toThrow("workspace");
    });
    expect(run).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps independent concurrent scopes isolated", async () => {
    rpc.mockImplementation(
      (_name, args) =>
        Promise.resolve({
          data: { ...decision, workspace_id: args!.p_workspace_id },
          error: null,
        }) as never
    );
    const otherId = "20000000-0000-0000-0000-000000000002";
    const result = await Promise.all(
      [workspaceId, otherId].map(id =>
        withWorkspaceTextAiAction(
          { workspaceId: id, actionId: "same" },
          resolveWorkspaceTextAiBilling
        )
      )
    );
    expect(result.map(value => value?.workspaceId)).toEqual([
      workspaceId,
      otherId,
    ]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("resolves only the pinned source immediately before each inference and excludes its key from serialization", async () => {
    rpc.mockResolvedValue({
      data: { ...decision, billing_source: "customer", source_id: sourceId },
      error: null,
    } as never);
    await withWorkspaceTextAiAction(action, async () => {
      const billing = await resolveWorkspaceTextAiBilling();
      expect(billing?.billingSource).toBe("customer");
      expect(billing && "apiKey" in billing && billing.apiKey).toBe(
        "customer-secret"
      );
      expect(JSON.stringify(billing)).not.toContain("customer-secret");
      expect(Object.keys(billing!)).not.toContain("apiKey");
      await resolveWorkspaceTextAiBilling();
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(credentials).toHaveBeenCalledWith({
      supabase: supabaseAdmin,
      workspaceId,
      sourceId,
    });
  });

  it("returns a safe source-required error after allowance exhaustion", async () => {
    rpc.mockResolvedValue({
      data: { ...decision, billing_source: "own_ai_source_required" },
      error: null,
    } as never);
    const error = await withWorkspaceTextAiAction(
      action,
      resolveWorkspaceTextAiBilling
    ).catch(value => value);
    expect(error).toBeInstanceOf(WorkspaceAiSourceRequiredError);
    expect(error).toMatchObject({
      code: "own_ai_source_required",
      resetAt,
      workspaceId,
      integrationPath: `/panel/w/${workspaceId}/settings/integrations`,
    });
    expect(credentials).not.toHaveBeenCalled();
  });

  it("never falls back when the pinned source was deleted", async () => {
    rpc.mockResolvedValue({
      data: { ...decision, billing_source: "customer", source_id: sourceId },
      error: null,
    } as never);
    credentials.mockRejectedValue(
      new GoogleAiConnectionError("GOOGLE_AI_ACCESS_DENIED")
    );
    await expect(
      withWorkspaceTextAiAction(action, resolveWorkspaceTextAiBilling)
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("never falls back or leaks unexpected credential failures", async () => {
    rpc.mockResolvedValue({
      data: { ...decision, billing_source: "customer", source_id: sourceId },
      error: null,
    } as never);
    credentials.mockRejectedValue(
      new Error("provider included customer-secret")
    );
    const error = await withWorkspaceTextAiAction(
      action,
      resolveWorkspaceTextAiBilling
    ).catch(value => value);
    expect(error.message).not.toContain("customer-secret");
    expect(error.cause).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    {},
    { ...decision, workspace_id: "wrong-workspace" },
    { ...decision, billing_source: "customer", source_id: null },
    { ...decision, billing_source: "platform", source_id: sourceId },
    { ...decision, reset_at: "garbage" },
    { ...decision, plan: "unknown" },
  ])("fails closed for malformed admission data %p", async data => {
    rpc.mockResolvedValue({ data, error: null } as never);
    await expect(
      withWorkspaceTextAiAction(action, resolveWorkspaceTextAiBilling)
    ).rejects.toMatchObject({ code: "workspace_ai_policy_unavailable" });
    expect(credentials).not.toHaveBeenCalled();
  });

  it("memoizes an uncertain RPC failure and never includes its payload", async () => {
    rpc.mockRejectedValue(new Error("database customer-secret"));
    await withWorkspaceTextAiAction(action, async () => {
      for (let retry = 0; retry < 2; retry++) {
        const error = await resolveWorkspaceTextAiBilling().catch(
          value => value
        );
        expect(error.code).toBe("workspace_ai_policy_unavailable");
        expect(error.message).not.toContain("customer-secret");
      }
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("returns lifetime historical usage above the original grant without refilling it", async () => {
    rpc.mockResolvedValue({
      data: {
        ...decision,
        included_actions: 500,
        used_actions: 867,
        remaining_actions: 0,
        has_customer_source: true,
        spend_limit_reached: false,
        credentials: "must not escape",
      },
      error: null,
    } as never);
    await expect(getWorkspaceTextAiAllowance(workspaceId)).resolves.toEqual({
      workspaceId,
      companyId,
      plan: "pro",
      includedActions: 500,
      usedActions: 867,
      remainingActions: 0,
      hasCustomerSource: true,
      spendLimitReached: false,
      periodStart,
      resetAt,
      allowancePeriod: "lifetime",
    });
    expect(credentials).not.toHaveBeenCalled();
  });

  it("rejects an inconsistent allowance projection", async () => {
    rpc.mockResolvedValue({
      data: {
        ...decision,
        included_actions: 500,
        used_actions: 501,
        remaining_actions: -1,
        has_customer_source: false,
      },
      error: null,
    } as never);
    await expect(
      getWorkspaceTextAiAllowance(workspaceId)
    ).rejects.toMatchObject({ code: "workspace_ai_policy_unavailable" });
  });

  it("preserves unused actions while projecting an exhausted spend budget", async () => {
    rpc.mockResolvedValue({ data: {
      ...decision, included_actions: 500, used_actions: 50,
      remaining_actions: 450, has_customer_source: false, spend_limit_reached: true,
    }, error: null } as never);
    await expect(getWorkspaceTextAiAllowance(workspaceId)).resolves.toMatchObject({
      remainingActions: 450, spendLimitReached: true,
    });
  });

  it("rejects a missing spend projection instead of assuming capacity", async () => {
    rpc.mockResolvedValue({ data: {
      ...decision, included_actions: 500, used_actions: 50,
      remaining_actions: 450, has_customer_source: false,
    }, error: null } as never);
    await expect(getWorkspaceTextAiAllowance(workspaceId)).rejects.toMatchObject({
      code: "workspace_ai_policy_unavailable",
    });
  });
});
