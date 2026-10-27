import { airiWorkerLogger, describeLogError } from "./logging";

/**
 * WhatsApp message intake plan gate (owner decision 2026-10-18).
 *
 * - A free company whose trial expired (the company-limits snapshot's
 *   `trialExpired`) ingests no WhatsApp messages. Live messages, echoes and
 *   history children complete their receipt as a skip; history chunks pause.
 * - A company that may not open new conversations
 *   (`ensureCompanyConversationCapacity` denied: trial expired or the free
 *   conversation cap) still appends to existing conversations but creates no
 *   new ones, like Telegram, Instagram, widget and email.
 *
 * The plan read is injected: the worker binds it to company-limits, so this
 * module never imports web code. A plan read failure FAILS OPEN: the item is
 * processed normally and a warning is logged. An infra error must never drop,
 * defer or dead-letter a message.
 *
 * Recovery after an upgrade. A skipped receipt completes with its payload
 * intact and with `planSkipReason` set (see readWhatsAppIntakePlanSkipReason),
 * so the operator replay tool can restore it while the payload is retained
 * (30 days after completion, WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DEFAULT_DAYS).
 * Select by that marker, not by a lock-to-upgrade time window: the gate decides
 * at processing time (late retries, history children expanded before the lock
 * and up to a minute of cached plan after the upgrade all fall outside such a
 * window), and --missing-only never selects edits, revokes or reactions. Run
 * only after the company is unlocked, dry run first, then add --execute:
 *
 *   pnpm --filter @icecore/temporal-worker replay:whatsapp-webhook-events -- \
 *     --phone-number-id=<id> --plan-skipped \
 *     --from=<ISO, at least 31 days ago> --to=<ISO, now> --limit=500
 *
 * The wide window is safe because the marker does the selecting. This covers
 * live messages (including edits, revokes and reactions), echoes, history
 * children and legacy history receipts, in createdAt order. A replay that
 * imports a receipt clears its marker, so repeat the command until the dry run
 * reports eventCount 0. --fast-import never selects or claims a marked
 * receipt, so only this processor replay restores one. History chunks paused
 * for the plan are not completed; they resume on their own hourly retry once
 * the company is no longer locked.
 */

export const WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON = "company_trial_expired";
export const WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON =
  "company_conversation_limit_exceeded";

export type WhatsAppIntakePlanSkipReason =
  | typeof WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON
  | typeof WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON;

const WHATSAPP_INTAKE_PLAN_SKIP_REASONS: readonly WhatsAppIntakePlanSkipReason[] =
  [
    WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
    WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
  ];

/** The plan reason carried by a completed runtime result, if it was a skip. */
export function readWhatsAppIntakePlanSkipReason(
  details: unknown,
): WhatsAppIntakePlanSkipReason | null {
  const reason =
    details && typeof details === "object"
      ? (details as { reason?: unknown }).reason
      : null;
  return (
    WHATSAPP_INTAKE_PLAN_SKIP_REASONS.find((known) => known === reason) ?? null
  );
}

/** Receipt filter for plan-skipped receipts (the replay tool's --plan-skipped). */
export function buildWhatsAppPlanSkippedReceiptFilter(): {
  planSkipReason: { $in: WhatsAppIntakePlanSkipReason[] };
} {
  return { planSkipReason: { $in: [...WHATSAPP_INTAKE_PLAN_SKIP_REASONS] } };
}

/**
 * The complement: receipts without a plan-skip marker. The replay tool's
 * --fast-import selects and claims only these, because fast import cannot
 * restore edits, revokes, reactions or history children and would complete
 * them without importing anything.
 */
export function buildWhatsAppNotPlanSkippedReceiptFilter(): {
  planSkipReason: { $nin: WhatsAppIntakePlanSkipReason[] };
} {
  return { planSkipReason: { $nin: [...WHATSAPP_INTAKE_PLAN_SKIP_REASONS] } };
}

// The webhook processor retries any result whose text mentions "source not
// found", "history skipped" or "state_sync skipped"; these must not.
export const WHATSAPP_INTAKE_PLAN_LOCKED_MESSAGE =
  "WhatsApp intake skipped: company plan locked";
export const WHATSAPP_NEW_CONVERSATION_LIMIT_MESSAGE =
  "WhatsApp new conversation skipped: company conversation limit reached";

export type WhatsAppIntakePlanSkip = {
  reason: WhatsAppIntakePlanSkipReason;
  message: string;
};

/** The two plan facts the gate needs, read once from company-limits. */
export type WhatsAppIntakeCompanyPlan = {
  trialExpired: boolean;
  newConversationsAllowed: boolean;
};

export type WhatsAppIntakeItemKind =
  | "message"
  | "echo"
  | "history_message"
  | "history_chunk"
  | "new_conversation";

export type WhatsAppIntakePlanCheckInput = {
  workspaceId: string;
  sourceId?: string | null;
  itemKind: WhatsAppIntakeItemKind;
};

export type WhatsAppIntakePlanCheck = (
  input: WhatsAppIntakePlanCheckInput,
) => Promise<WhatsAppIntakePlanSkip | null>;

const TRIAL_EXPIRED_SKIP: WhatsAppIntakePlanSkip = Object.freeze({
  reason: WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
  message: WHATSAPP_INTAKE_PLAN_LOCKED_MESSAGE,
});
const CONVERSATION_LIMIT_SKIP: WhatsAppIntakePlanSkip = Object.freeze({
  reason: WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
  message: WHATSAPP_NEW_CONVERSATION_LIMIT_MESSAGE,
});

/** Whole-item skip: only a trial-expired company is locked out of intake. */
export function resolveWhatsAppIntakePlanSkip(
  plan: WhatsAppIntakeCompanyPlan,
): WhatsAppIntakePlanSkip | null {
  return plan.trialExpired === true ? TRIAL_EXPIRED_SKIP : null;
}

/** New-conversation skip, mirroring ensureCompanyConversationCapacity. */
export function resolveWhatsAppNewConversationPlanSkip(
  plan: WhatsAppIntakeCompanyPlan,
): WhatsAppIntakePlanSkip | null {
  if (plan.newConversationsAllowed !== false) return null;
  return plan.trialExpired === true
    ? TRIAL_EXPIRED_SKIP
    : CONVERSATION_LIMIT_SKIP;
}

/** Completed-receipt body for a skipped item (status ok, never retried). */
export function buildWhatsAppIntakePlanSkipBody(skip: WhatsAppIntakePlanSkip): {
  status: "ok";
  message: string;
  reason: WhatsAppIntakePlanSkipReason;
} {
  return { status: "ok", message: skip.message, reason: skip.reason };
}

export const WHATSAPP_PLAN_SKIPPED_PROCESSED_AS = "plan_skipped";

export type WhatsAppPlanSkippedProcessResult = {
  conversationId: "";
  isNewConversation: false;
  messageWasNew: false;
  processedAs: typeof WHATSAPP_PLAN_SKIPPED_PROCESSED_AS;
  planSkip: WhatsAppIntakePlanSkip;
};

/** processWhatsAppMessage result when the plan refused a new conversation. */
export function buildWhatsAppPlanSkippedProcessResult(
  skip: WhatsAppIntakePlanSkip,
): WhatsAppPlanSkippedProcessResult {
  return {
    conversationId: "",
    isNewConversation: false,
    messageWasNew: false,
    processedAs: WHATSAPP_PLAN_SKIPPED_PROCESSED_AS,
    planSkip: skip,
  };
}

export function readWhatsAppPlanSkippedProcessResult(
  result: unknown,
): WhatsAppIntakePlanSkip | null {
  if (!result || typeof result !== "object") return null;
  const row = result as { processedAs?: unknown; planSkip?: unknown };
  if (row.processedAs !== WHATSAPP_PLAN_SKIPPED_PROCESSED_AS) return null;
  const skip = row.planSkip as { reason?: unknown } | undefined;
  return skip?.reason === WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON
    ? CONVERSATION_LIMIT_SKIP
    : TRIAL_EXPIRED_SKIP;
}

type OwnerResult<T> = { conversation: T; created: boolean };

/**
 * Get-or-create with the new-conversation gate inside the create callback, as
 * the WhatsApp call linker does: an existing owner is returned without a plan
 * read, and a refused create yields a typed skip instead of a thrown error.
 */
export async function getOrCreateWhatsAppConversationWithPlanGate<T>(params: {
  workspaceId: string;
  sourceId: string;
  itemKind: WhatsAppIntakeItemKind;
  getNewConversationSkip?: WhatsAppIntakePlanCheck;
  getOrCreate: (
    create: (ownershipKey: string, identityKeys: string[]) => Promise<T | null>,
  ) => Promise<OwnerResult<T> | null>;
  create: (ownershipKey: string, identityKeys: string[]) => Promise<T>;
}): Promise<
  | { owner: OwnerResult<T>; skip: null }
  | { owner: null; skip: WhatsAppIntakePlanSkip }
> {
  const gate: { skip: WhatsAppIntakePlanSkip | null } = { skip: null };
  const owner = await params.getOrCreate(async (ownershipKey, identityKeys) => {
    gate.skip =
      (await params.getNewConversationSkip?.({
        workspaceId: params.workspaceId,
        sourceId: params.sourceId,
        itemKind: params.itemKind,
      })) ?? null;
    if (gate.skip) return null;
    return params.create(ownershipKey, identityKeys);
  });
  if (owner) return { owner, skip: null };
  if (gate.skip) return { owner: null, skip: gate.skip };
  throw new Error("WhatsApp conversation owner was not created");
}

export const WHATSAPP_INTAKE_PLAN_CACHE_TTL_MS = 60_000;
const WHATSAPP_INTAKE_PLAN_CACHE_MAX_ENTRIES = 5_000;

type IntakePlanGateLogger = {
  warn: (event: string, context?: Record<string, unknown>) => void;
};

export type WhatsAppIntakePlanGate = {
  /** Whole-item check (trial expired). Cached per workspace; fails open. */
  getIntakeSkip: WhatsAppIntakePlanCheck;
  /**
   * New-conversation check. A cached refusal is reused; otherwise the plan is
   * read fresh so the conversation cap stays as tight as the other channels'.
   * Fails open.
   */
  getNewConversationSkip: WhatsAppIntakePlanCheck;
};

/**
 * Process-local plan cache keyed by workspaceId. Only successful reads are
 * cached; concurrent reads for one workspace share a single request.
 */
export function createWhatsAppIntakePlanGate(deps: {
  readPlan: (workspaceId: string) => Promise<WhatsAppIntakeCompanyPlan>;
  logger?: IntakePlanGateLogger;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): WhatsAppIntakePlanGate {
  const ttlMs = deps.ttlMs ?? WHATSAPP_INTAKE_PLAN_CACHE_TTL_MS;
  const maxEntries = deps.maxEntries ?? WHATSAPP_INTAKE_PLAN_CACHE_MAX_ENTRIES;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? airiWorkerLogger;
  const cache = new Map<
    string,
    { plan: WhatsAppIntakeCompanyPlan; expiresAt: number }
  >();
  const inflight = new Map<string, Promise<WhatsAppIntakeCompanyPlan>>();

  const readCached = (workspaceId: string) => {
    const entry = cache.get(workspaceId);
    if (!entry) return null;
    if (entry.expiresAt > now()) return entry.plan;
    cache.delete(workspaceId);
    return null;
  };

  const readFresh = (workspaceId: string) => {
    const pending = inflight.get(workspaceId);
    if (pending) return pending;
    const request = (async () => {
      try {
        const raw = await deps.readPlan(workspaceId);
        const plan: WhatsAppIntakeCompanyPlan = {
          trialExpired: raw?.trialExpired === true,
          newConversationsAllowed: raw?.newConversationsAllowed !== false,
        };
        cache.delete(workspaceId);
        cache.set(workspaceId, { plan, expiresAt: now() + ttlMs });
        while (cache.size > maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        return plan;
      } finally {
        inflight.delete(workspaceId);
      }
    })();
    inflight.set(workspaceId, request);
    return request;
  };

  const readFailOpen = async (
    input: WhatsAppIntakePlanCheckInput,
    useCache: boolean,
  ): Promise<WhatsAppIntakeCompanyPlan | null> => {
    try {
      return (
        (useCache ? readCached(input.workspaceId) : null) ??
        (await readFresh(input.workspaceId))
      );
    } catch (error) {
      logger.warn("whatsapp.intake_plan_gate.read_failed", {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId ?? null,
        itemKind: input.itemKind,
        failurePolicy: "fail_open",
        error: describeLogError(error),
      });
      return null;
    }
  };

  return {
    async getIntakeSkip(input) {
      const plan = await readFailOpen(input, true);
      return plan ? resolveWhatsAppIntakePlanSkip(plan) : null;
    },
    async getNewConversationSkip(input) {
      const cached = readCached(input.workspaceId);
      if (cached && !cached.newConversationsAllowed)
        return resolveWhatsAppNewConversationPlanSkip(cached);
      const plan = await readFailOpen(input, false);
      return plan ? resolveWhatsAppNewConversationPlanSkip(plan) : null;
    },
  };
}
