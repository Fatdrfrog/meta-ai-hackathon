import { isRecord } from "@icecore/shared/lib/value-utils";

export type WorkspaceAiRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
};

export type WorkspaceAiAdmission = {
  workspaceId: string;
  companyId: string;
  plan: "free" | "pro" | "enterprise";
  billingSource: "platform" | "customer" | "own_ai_source_required";
  sourceId: string | null;
};

export class WorkspaceAiSpendError extends Error {
  constructor(
    readonly code:
      | "workspace_ai_policy_unavailable"
      | "own_ai_source_required"
      | "workspace_ai_spend_limit"
      | "workspace_ai_operation_replayed",
  ) {
    super(
      code === "workspace_ai_spend_limit"
        ? "The company's AI spending safety limit has been reached."
        : code === "workspace_ai_operation_replayed"
          ? "This provider operation was already reserved. Reconcile its existing result before retrying."
          : code === "own_ai_source_required"
            ? "Connect a compatible AI source to continue."
            : "AI allowance could not be verified. Try again later.",
    );
    this.name = "WorkspaceAiSpendError";
  }
}

async function call(
  client: WorkspaceAiRpcClient,
  name: string,
  args: Record<string, unknown>,
) {
  try {
    const { data, error } = await client.rpc(name, args);
    if (error || !isRecord(data))
      throw new WorkspaceAiSpendError("workspace_ai_policy_unavailable");
    return data;
  } catch {
    throw new WorkspaceAiSpendError("workspace_ai_policy_unavailable");
  }
}

/** Resolves the durable payer without decrypting a provider-specific credential. */
export async function admitWorkspaceAiAction(params: {
  supabase: WorkspaceAiRpcClient;
  workspaceId: string;
  actionId: string;
}): Promise<WorkspaceAiAdmission> {
  const data = await call(params.supabase, "admit_workspace_text_ai_action", {
    p_workspace_id: params.workspaceId,
    p_action_id: params.actionId,
  });
  if (
    data.allowance_period !== "lifetime" ||
    data.reset_at !== null ||
    data.workspace_id !== params.workspaceId ||
    typeof data.company_id !== "string" ||
    !data.company_id ||
    !["free", "pro", "enterprise"].includes(String(data.plan)) ||
    !["platform", "customer", "own_ai_source_required"].includes(
      String(data.billing_source),
    ) ||
    (data.billing_source === "customer"
      ? typeof data.source_id !== "string" || !data.source_id
      : data.source_id !== null)
  ) {
    throw new WorkspaceAiSpendError("workspace_ai_policy_unavailable");
  }
  return {
    workspaceId: params.workspaceId,
    companyId: data.company_id,
    plan: data.plan as WorkspaceAiAdmission["plan"],
    billingSource: data.billing_source as WorkspaceAiAdmission["billingSource"],
    sourceId: data.source_id as string | null,
  };
}

export type WorkspaceAiSpendReservation = {
  workspaceId: string;
  actionId: string;
  operationId: string;
  maxCostMicros: number;
};

/** Only a newly reserved operation may issue a paid request; replays reuse the owner's stored result. */
export async function reserveWorkspaceAiSpend(
  params: WorkspaceAiSpendReservation & {
    supabase: WorkspaceAiRpcClient;
    provider: "anthropic" | "vertex" | "elevenlabs";
  },
): Promise<WorkspaceAiSpendReservation> {
  if (
    !Number.isSafeInteger(params.maxCostMicros) ||
    params.maxCostMicros <= 0
  ) {
    throw new WorkspaceAiSpendError("workspace_ai_policy_unavailable");
  }
  const data = await call(params.supabase, "reserve_workspace_ai_spend", {
    p_workspace_id: params.workspaceId,
    p_action_id: params.actionId,
    p_operation_id: params.operationId,
    p_provider: params.provider,
    p_max_cost_micros: params.maxCostMicros,
  });
  if (
    data.code === "own_ai_source_required" ||
    data.code === "workspace_ai_spend_limit" ||
    data.code === "workspace_ai_operation_replayed"
  ) {
    throw new WorkspaceAiSpendError(data.code);
  }
  if (
    data.code !== "reserved" ||
    data.workspace_id !== params.workspaceId ||
    data.action_id !== params.actionId ||
    data.operation_id !== params.operationId ||
    data.max_cost_micros !== params.maxCostMicros
  ) {
    throw new WorkspaceAiSpendError("workspace_ai_policy_unavailable");
  }
  return {
    workspaceId: params.workspaceId,
    actionId: params.actionId,
    operationId: params.operationId,
    maxCostMicros: params.maxCostMicros,
  };
}

/** null means incurred usage is unknown: keep the entire reservation until reconciliation. */
export async function settleWorkspaceAiSpend(params: {
  supabase: WorkspaceAiRpcClient;
  reservation: WorkspaceAiSpendReservation;
  actualCostMicros: number | null;
}): Promise<void> {
  if (
    params.actualCostMicros !== null &&
    (!Number.isSafeInteger(params.actualCostMicros) ||
      params.actualCostMicros < 0)
  ) {
    throw new WorkspaceAiSpendError("workspace_ai_policy_unavailable");
  }
  const data = await call(params.supabase, "settle_workspace_ai_spend", {
    p_workspace_id: params.reservation.workspaceId,
    p_action_id: params.reservation.actionId,
    p_operation_id: params.reservation.operationId,
    p_actual_cost_micros: params.actualCostMicros,
  });
  if (
    data.code !== (params.actualCostMicros === null ? "uncertain" : "settled")
  ) {
    throw new WorkspaceAiSpendError("workspace_ai_policy_unavailable");
  }
}
