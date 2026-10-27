import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isRecord } from "@icecore/shared/lib/value-utils";
import {
  admitWorkspaceAiAction,
  reserveWorkspaceAiSpend,
  settleWorkspaceAiSpend,
  WorkspaceAiSpendError,
  type WorkspaceAiAdmission,
  type WorkspaceAiSpendReservation,
} from "@icecore/airi-runtime/workspace-ai-spend";
import {
  estimateLlmCostUsd,
  resolveLlmModelPricing,
} from "@icecore/airi-runtime/llm-pricing";
import type { LlmTokenUsage } from "@icecore/airi-runtime/llm-analytics";
import { getCompanyIdForWorkspace } from "@icecore/shared/lib/workspace-company";
import {
  GoogleAiConnectionError,
  resolveGoogleAiCredentialsForWorkspace,
} from "@/lib/google/google-ai-source";

type Plan = "free" | "pro" | "enterprise";
type Admission = WorkspaceAiAdmission;

export type WorkspaceTextAiBilling = { companyId: string; actionId: string } & (
  | { billingSource: "platform"; workspaceId: string; sourceId: null }
  | {
      billingSource: "customer";
      workspaceId: string;
      sourceId: string;
      apiKey: string;
    }
);

export type WorkspaceTextAiAllowance = {
  workspaceId: string;
  companyId: string;
  plan: Plan;
  includedActions: number | null;
  usedActions: number;
  remainingActions: number | null;
  spendLimitReached: boolean;
  periodStart: string;
  resetAt: null;
  allowancePeriod: "lifetime";
  hasCustomerSource: boolean;
};

export class WorkspaceAiSourceRequiredError extends Error {
  readonly code = "own_ai_source_required";
  readonly integrationPath: string;

  constructor(
    readonly workspaceId: string,
    readonly resetAt: string | null = null
  ) {
    super(
      "Your included AI allowance is used. Connect your Google AI source to continue."
    );
    this.name = "WorkspaceAiSourceRequiredError";
    this.integrationPath = `/panel/w/${encodeURIComponent(workspaceId)}/settings/integrations`;
  }
}

export class WorkspaceAiPolicyUnavailableError extends Error {
  readonly code = "workspace_ai_policy_unavailable";

  constructor() {
    super("AI allowance could not be verified. Try again later.");
    this.name = "WorkspaceAiPolicyUnavailableError";
  }
}

/** "platform": the platform pays without consuming the company's AI allowance or spend limit. */
export type WorkspaceAiSponsorship = "platform";

type ActionScope = {
  workspaceId: string;
  actionId: string;
  sponsorship: WorkspaceAiSponsorship | null;
  admission?: Promise<Admission>;
  companyId?: Promise<string>;
  operationCounts: Map<string, number>;
};
const actionScope = new AsyncLocalStorage<ActionScope>();

export type WorkspaceAiAction = {
  workspaceId: string;
  actionId: string;
  sponsorship?: WorkspaceAiSponsorship;
};

export function getWorkspaceTextAiAction(): WorkspaceAiAction | undefined {
  const scope = actionScope.getStore();
  return scope
    ? { workspaceId: scope.workspaceId, actionId: scope.actionId }
    : undefined;
}

export function hasWorkspaceTextAiAction(): boolean {
  return actionScope.getStore() !== undefined;
}

/**
 * Trusted server entrypoints supply a durable logical action identity, never a model-call ID.
 * A nested call joins the outer action, so the outermost action decides who pays.
 */
export async function withWorkspaceTextAiAction<T>(
  params: WorkspaceAiAction,
  run: () => Promise<T>
): Promise<T> {
  if (
    !params.workspaceId?.trim() ||
    params.workspaceId.length > 128 ||
    !params.actionId?.trim() ||
    params.actionId.length > 512
  ) {
    throw new Error("A workspace and stable AI action identity are required.");
  }
  const current = actionScope.getStore();
  if (current) {
    if (current.workspaceId !== params.workspaceId) {
      throw new Error("An AI action cannot change workspace.");
    }
    return run();
  }
  return actionScope.run(
    {
      workspaceId: params.workspaceId,
      actionId: params.actionId,
      sponsorship: params.sponsorship ?? null,
      operationCounts: new Map(),
    },
    run
  );
}

function parseDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new WorkspaceAiPolicyUnavailableError();
  }
  return new Date(value).toISOString();
}

function parseCommon(data: unknown, workspaceId: string) {
  if (
    !isRecord(data) ||
    data.workspace_id !== workspaceId ||
    typeof data.company_id !== "string" ||
    !data.company_id ||
    !["free", "pro", "enterprise"].includes(String(data.plan))
  ) {
    throw new WorkspaceAiPolicyUnavailableError();
  }
  const periodStart = parseDate(data.period_start);
  if (data.allowance_period !== "lifetime" || data.reset_at !== null) {
    throw new WorkspaceAiPolicyUnavailableError();
  }
  return {
    data,
    companyId: data.company_id,
    plan: data.plan as Plan,
    periodStart,
    resetAt: null,
  };
}

async function admit(scope: ActionScope): Promise<Admission> {
  try {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    return await admitWorkspaceAiAction({
      supabase: supabaseAdmin,
      workspaceId: scope.workspaceId,
      actionId: scope.actionId,
    });
  } catch {
    // Database transport errors can contain URLs and payloads; never retain them.
    throw new WorkspaceAiPolicyUnavailableError();
  }
}

async function resolveSponsoredCompanyId(scope: ActionScope): Promise<string> {
  try {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const companyId = await getCompanyIdForWorkspace(
      supabaseAdmin,
      scope.workspaceId
    );
    if (companyId) return companyId;
  } catch {
    // Database transport errors can contain URLs and payloads; never retain them.
  }
  throw new WorkspaceAiPolicyUnavailableError();
}

/** Call immediately before inference. The context stores only the durable decision, never credentials. */
export async function resolveWorkspaceTextAiBilling(): Promise<WorkspaceTextAiBilling | null> {
  const scope = actionScope.getStore();
  if (!scope) return null;
  if (scope.sponsorship === "platform") {
    // No admission: a sponsored action never consumes the company's allowance.
    scope.companyId ??= resolveSponsoredCompanyId(scope);
    return {
      billingSource: "platform",
      workspaceId: scope.workspaceId,
      companyId: await scope.companyId,
      actionId: scope.actionId,
      sourceId: null,
    };
  }
  scope.admission ??= admit(scope);
  const decision = await scope.admission;
  if (decision.billingSource === "own_ai_source_required") {
    throw new WorkspaceAiSourceRequiredError(scope.workspaceId, null);
  }
  if (decision.billingSource === "platform") {
    return {
      billingSource: "platform",
      workspaceId: scope.workspaceId,
      companyId: decision.companyId,
      actionId: scope.actionId,
      sourceId: null,
    };
  }
  try {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const credentials = await resolveGoogleAiCredentialsForWorkspace({
      supabase: supabaseAdmin,
      workspaceId: scope.workspaceId,
      sourceId: decision.sourceId!,
    });
    const billing = {
      billingSource: "customer",
      workspaceId: scope.workspaceId,
      companyId: decision.companyId,
      actionId: scope.actionId,
      sourceId: credentials.sourceId,
    };
    // Protect accidental JSON/log spread serialization without changing provider access.
    Object.defineProperty(billing, "apiKey", {
      value: credentials.apiKey,
      enumerable: false,
    });
    return billing as WorkspaceTextAiBilling;
  } catch (error) {
    if (error instanceof GoogleAiConnectionError) {
      if (error.code === "GOOGLE_AI_ACCESS_DENIED") {
        throw new WorkspaceAiSourceRequiredError(scope.workspaceId, null);
      }
      throw new GoogleAiConnectionError(error.code);
    }
    throw new WorkspaceAiPolicyUnavailableError();
  }
}

/** Largest serialized request a reservation accepts; inline media must fit inside it. */
export const MAX_WORKSPACE_TEXT_AI_REQUEST_BYTES = 262_144;

/** Provider boundaries call this even when no facade/action wrapper was supplied. */
export async function reserveWorkspaceTextAiSpend(params: {
  provider: "anthropic" | "vertex";
  model: string;
  request: unknown;
  maxOutputTokens: number;
}): Promise<WorkspaceAiSpendReservation | null> {
  const scope = actionScope.getStore();
  if (!scope) throw new WorkspaceAiPolicyUnavailableError();
  if (scope.sponsorship !== "platform") {
    scope.admission ??= admit(scope);
    const decision = await scope.admission;
    if (
      decision.billingSource === "own_ai_source_required" ||
      (decision.billingSource === "customer" && params.provider === "anthropic")
    ) {
      throw new WorkspaceAiSourceRequiredError(scope.workspaceId);
    }
    if (decision.billingSource === "customer") return null;
  }
  const serialized = JSON.stringify(params.request);
  if (typeof serialized !== "string")
    throw new WorkspaceAiPolicyUnavailableError();
  const inputBytes = Buffer.byteLength(serialized, "utf8");
  const resolved = resolveLlmModelPricing(params.model);
  if (
    !resolved.pricingMatched ||
    inputBytes > MAX_WORKSPACE_TEXT_AI_REQUEST_BYTES ||
    !Number.isSafeInteger(params.maxOutputTokens) ||
    params.maxOutputTokens < 0 ||
    (params.maxOutputTokens === 0 &&
      resolved.pricing.outputUsdPerMillion !== 0) ||
    params.maxOutputTokens > 65536
  ) {
    throw new WorkspaceAiSpendError("workspace_ai_spend_limit");
  }
  // Sponsored spend stays in LLM analytics (estimated cost per call), outside the company limit.
  if (scope.sponsorship === "platform") return null;
  const rates = resolved.pricing;
  // UTF-8 bytes bound text tokens; reserve uncached/cache-write input and the
  // entire output cap, including thinking. Keep a margin for framing overhead.
  const maxCostMicros = Math.ceil(
    (inputBytes + 1024) *
      Math.max(
        rates.inputUsdPerMillion,
        rates.cacheWriteInputUsdPerMillion ?? 0
      ) +
      params.maxOutputTokens * rates.outputUsdPerMillion
  );
  const fingerprint = `${params.provider}:${createHash("sha256").update(params.model).update(serialized).digest("hex")}`;
  const occurrence = scope.operationCounts.get(fingerprint) ?? 0;
  scope.operationCounts.set(fingerprint, occurrence + 1);
  const operationId = `${fingerprint}:${occurrence}`;
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  return reserveWorkspaceAiSpend({
    supabase: supabaseAdmin,
    workspaceId: scope.workspaceId,
    actionId: scope.actionId,
    operationId,
    provider: params.provider,
    maxCostMicros,
  });
}

export async function settleWorkspaceTextAiSpend(
  reservation: WorkspaceAiSpendReservation | null,
  model: string,
  usage: LlmTokenUsage | undefined
): Promise<void> {
  if (!reservation) return;
  const actualCostMicros =
    usage &&
    usage.prompt_tokens !== undefined &&
    usage.completion_tokens !== undefined
      ? Math.ceil(
          estimateLlmCostUsd({
            model,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            thinkingTokens: usage.thinking_tokens,
            cachedPromptTokens: usage.cached_prompt_tokens,
            cacheWritePromptTokens: usage.cache_write_prompt_tokens,
          }).totalCostUsd * 1_000_000
        )
      : null;
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  await settleWorkspaceAiSpend({
    supabase: supabaseAdmin,
    reservation,
    actualCostMicros,
  });
}

/** Server callers must authorize workspace access before returning this projection to a user. */
export async function getWorkspaceTextAiAllowance(
  workspaceId: string
): Promise<WorkspaceTextAiAllowance> {
  try {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const { data, error } = await supabaseAdmin.rpc(
      "get_workspace_text_ai_allowance",
      { p_workspace_id: workspaceId }
    );
    if (error) throw new WorkspaceAiPolicyUnavailableError();
    const parsed = parseCommon(data, workspaceId);
    const includedActions = parsed.data.included_actions;
    const usedActions = parsed.data.used_actions;
    const remainingActions = parsed.data.remaining_actions;
    const hasCustomerSource = parsed.data.has_customer_source;
    const spendLimitReached = parsed.data.spend_limit_reached;
    if (
      typeof usedActions !== "number" ||
      !Number.isSafeInteger(usedActions) ||
      usedActions < 0 ||
      typeof hasCustomerSource !== "boolean" ||
      typeof spendLimitReached !== "boolean" ||
      typeof includedActions !== "number" ||
      !Number.isSafeInteger(includedActions) ||
      includedActions < 0 ||
      (parsed.plan === "pro" && includedActions !== 500) ||
      remainingActions !== Math.max(0, includedActions - usedActions)
    ) {
      throw new WorkspaceAiPolicyUnavailableError();
    }
    return {
      workspaceId,
      companyId: parsed.companyId,
      plan: parsed.plan,
      includedActions: includedActions as number | null,
      usedActions,
      remainingActions: remainingActions as number | null,
      hasCustomerSource,
      spendLimitReached,
      periodStart: parsed.periodStart,
      resetAt: parsed.resetAt,
      allowancePeriod: "lifetime",
    };
  } catch {
    throw new WorkspaceAiPolicyUnavailableError();
  }
}
