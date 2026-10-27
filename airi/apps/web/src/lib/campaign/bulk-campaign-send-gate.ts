import { panelSettingsHref } from "@/features/panel/shared/routing/hrefs";
import {
  META_PAYMENT_URL,
  META_WHATSAPP_MANAGER_URL,
} from "@/lib/whatsapp/account/health";
import type { BulkCampaignReadiness } from "@icecore/scenario-contracts";

export type BulkCampaignSharedSendGateInput = {
  isSubmitting: boolean;
  hasActiveDispatch: boolean;
  recipientParsing: boolean;
  emptyAudience: boolean;
  eligibilityCanSubmit: boolean;
  recurring?: boolean;
};

export type BulkCampaignSharedSendGate = {
  blocked: boolean;
  eligibilityBlocksSend: boolean;
};

export function bulkCampaignEligibilityBlocksSend(input: {
  eligibilityCanSubmit: boolean;
  recurring?: boolean;
}): boolean {
  return Boolean(!input.recurring && !input.eligibilityCanSubmit);
}

export function resolveBulkCampaignSharedSendGate(
  input: BulkCampaignSharedSendGateInput
): BulkCampaignSharedSendGate {
  const eligibilityBlocksSend = bulkCampaignEligibilityBlocksSend(input);
  return {
    eligibilityBlocksSend,
    blocked:
      input.isSubmitting ||
      input.hasActiveDispatch ||
      input.recipientParsing ||
      input.emptyAudience ||
      eligibilityBlocksSend,
  };
}

/** Failed-check codes with their own `readiness.errors.*` line. */
const READINESS_ERROR_CODES = new Set([
  "meta_rate_limited",
  "template_lookup_unavailable",
  "template_unavailable",
  "plan_unavailable",
]);

/**
 * The `CampaignDispatchPlanCard` message key for a check or send failure
 * code, or null when the code has no translated line.
 */
export function bulkCampaignReadinessErrorKey(
  code: string | null | undefined
): string | null {
  return code && READINESS_ERROR_CODES.has(code)
    ? `readiness.errors.${code}`
    : null;
}

/** Integrations with WhatsApp selected, where a number is connected. */
export function bulkCampaignWhatsAppSettingsHref(workspaceId: string): string {
  return `${panelSettingsHref(workspaceId)}?integration=whatsapp`;
}

/** Where a readiness reason or failed check can be fixed. */
export type BulkCampaignReadinessFix = {
  /** `CampaignDispatchPlanCard.readiness.fix.*` label. */
  kind: "integrations" | "whatsappManager";
  href: string;
  external: boolean;
};

const READINESS_FIX_TARGETS = new Map<
  string,
  { kind: BulkCampaignReadinessFix["kind"]; url?: string }
>([
  ["plan_unavailable", { kind: "integrations" }],
  ["meta_disconnected", { kind: "integrations" }],
  ["meta_billing", { kind: "whatsappManager", url: META_PAYMENT_URL }],
  [
    "meta_sender_restricted",
    { kind: "whatsappManager", url: META_WHATSAPP_MANAGER_URL },
  ],
  [
    "meta_business_limit",
    { kind: "whatsappManager", url: META_WHATSAPP_MANAGER_URL },
  ],
]);

/**
 * The page that fixes a readiness reason or failed-check code, or null when
 * nothing the user opens can fix it (a rate limit, a recipient cooldown).
 * Our own settings links need the workspace.
 */
export function bulkCampaignReadinessFix(
  code: string | null | undefined,
  workspaceId: string | null | undefined
): BulkCampaignReadinessFix | null {
  const target = code ? READINESS_FIX_TARGETS.get(code) : undefined;
  if (!target) return null;
  if (target.url) {
    return { kind: target.kind, href: target.url, external: true };
  }
  return workspaceId
    ? {
        kind: target.kind,
        href: bulkCampaignWhatsAppSettingsHref(workspaceId),
        external: false,
      }
    : null;
}

/**
 * The send refusal for a used-up bulk recipient allowance. Mirrors the
 * server-only `COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE` in
 * `lib/limits/company-limits`.
 */
export const BULK_CAMPAIGN_PLAN_LIMIT_CODE =
  "company_bulk_campaign_limit_exceeded";

/**
 * Plan restrictions shared by campaign sending. Unknown limits never block:
 * the server stays the authority.
 */
export type BulkCampaignPlanLimit = {
  subscriptionType?: "free" | "pro" | "enterprise";
  trialExpired?: boolean;
  conversationExhausted?: boolean;
  bulkRecipientExhausted?: boolean;
  bulkRecipientCount?: number | null;
  bulkRecipientLimit?: number | null;
  conversationCount?: number;
  conversationLimit?: number | null;
};

export type BulkCampaignPlanBlockReason =
  | "trial_expired"
  | "campaign_limit"
  | "conversation_limit";

export function getBulkCampaignPlanBlockReason(
  limit: BulkCampaignPlanLimit | null | undefined
): BulkCampaignPlanBlockReason | null {
  if (limit?.trialExpired) return "trial_expired";
  if (limit?.bulkRecipientExhausted) return "campaign_limit";
  if (limit?.conversationExhausted) return "conversation_limit";
  return null;
}

export function bulkCampaignPlanLimitBlocksSend(
  limit: BulkCampaignPlanLimit | null | undefined
): boolean {
  return getBulkCampaignPlanBlockReason(limit) !== null;
}

export type BulkCampaignSendStatus = {
  state:
    | "sending"
    | "active_dispatch"
    | "plan_blocked"
    | "checking"
    | "unavailable"
    | "awaitingAudience"
    | "noRecipients"
    | "blocked"
    | "ready";
  blocked: boolean;
  planReason: BulkCampaignPlanBlockReason | null;
};

/** One presentation and action decision; surface-specific guards remain inputs. */
export function resolveBulkCampaignSendStatus(input: {
  limit?: BulkCampaignPlanLimit | null;
  isSubmitting?: boolean;
  hasActiveDispatch?: boolean;
  checkingReadiness?: boolean;
  readinessError?: boolean;
  awaitingAudience?: boolean;
  allExcluded?: boolean;
  readiness?: BulkCampaignReadiness | null;
  sendBlockedElsewhere?: boolean;
}): BulkCampaignSendStatus {
  const result = (
    state: BulkCampaignSendStatus["state"]
  ): BulkCampaignSendStatus => ({
    state,
    blocked: state !== "ready",
    planReason: null,
  });
  if (input.isSubmitting) return result("sending");
  if (input.hasActiveDispatch) return result("active_dispatch");
  const planReason = getBulkCampaignPlanBlockReason(input.limit);
  if (planReason) return { state: "plan_blocked", blocked: true, planReason };
  if (input.checkingReadiness) return result("checking");
  if (input.readinessError || input.readiness?.state === "unavailable")
    return result("unavailable");
  if (input.readiness?.state === "blocked") return result("blocked");
  if (input.allExcluded) return result("noRecipients");
  if (input.awaitingAudience) return result("awaitingAudience");
  if (
    input.sendBlockedElsewhere ||
    (input.readiness && input.readiness.state !== "ready")
  ) {
    return result("blocked");
  }
  return result("ready");
}

/** What the WhatsApp number lookup (batch-plan) means for sending. */
export type BulkCampaignPlanCheck = {
  /** The lookup is still running. */
  checking: boolean;
  /** No WhatsApp number is set up, so Refresh won't help until it is. */
  planUnavailable: boolean;
  /** The lookup itself failed (session, network, server); Refresh can fix it. */
  failed: boolean;
};

const CLEAR_PLAN_CHECK: BulkCampaignPlanCheck = {
  checking: false,
  planUnavailable: false,
  failed: false,
};

export function resolveBulkCampaignPlanCheck(input: {
  applies: boolean;
  loading: boolean;
  error: unknown;
  preview: { configured: boolean } | null | undefined;
}): BulkCampaignPlanCheck {
  if (!input.applies) return CLEAR_PLAN_CHECK;
  if (input.loading) return { ...CLEAR_PLAN_CHECK, checking: true };
  if (input.error) return { ...CLEAR_PLAN_CHECK, failed: true };
  return {
    ...CLEAR_PLAN_CHECK,
    planUnavailable: input.preview?.configured === false,
  };
}

/**
 * Whether the readiness notice shows a failed check, and its reason code and
 * retry time: the WhatsApp number first, then the recipient check.
 */
export function resolveBulkCampaignReadinessFailure(input: {
  plan: BulkCampaignPlanCheck;
  eligibility: { state: string; code?: string; retryAt?: number } | null;
}): { failed: boolean; code?: string; retryAt?: number } {
  if (input.plan.planUnavailable) {
    return { failed: true, code: "plan_unavailable" };
  }
  if (input.plan.failed) return { failed: true };
  if (input.eligibility?.state === "error") {
    return {
      failed: true,
      code: input.eligibility.code,
      retryAt: input.eligibility.retryAt,
    };
  }
  return { failed: false };
}

/**
 * Why the send check keeps Send disabled. Copy is
 * `CampaignDispatchPlanCard.sendBlocked.*`, except `plan_unavailable`: the
 * readiness notice's reason line already says it.
 */
export type BulkCampaignReadinessBlockedReason =
  | "checking"
  | "plan_unavailable"
  | "check_failed"
  | "all_excluded"
  | "blocked";

export function resolveBulkCampaignReadinessBlockedReason(input: {
  checking: boolean;
  planUnavailable: boolean;
  failed: boolean;
  allExcluded: boolean;
  readinessState?: BulkCampaignReadiness["state"] | null;
}): BulkCampaignReadinessBlockedReason | null {
  if (input.checking) return "checking";
  if (input.planUnavailable) return "plan_unavailable";
  if (input.failed) return "check_failed";
  if (input.allExcluded) return "all_excluded";
  if (input.readinessState && input.readinessState !== "ready") {
    return "blocked";
  }
  return null;
}
