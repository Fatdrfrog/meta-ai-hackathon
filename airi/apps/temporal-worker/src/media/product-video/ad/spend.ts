import {
  isElevenLabsSttAcceptedRequest,
  isElevenLabsSttRefusedRequest,
} from "@icecore/airi-runtime/elevenlabs-stt";
import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";

// An ad's AI spend: every paid call of every run books to the ad's one AI
// action (product-ad:<adId>), reserving before the call and settling what it
// cost after, the way the import books its photos. The first reservation
// admits the action; a refusal after that leaves the rest of the ad to code
// (exact photos, the code's words), so the ad still finishes.

export type AdSpendProvider = "meta" | "elevenlabs";

/** The workspace's AI allowance, as the import reads it. */
export type AdSpendAllowance = {
  includedActions: number | null;
  remainingActions: number | null;
  spendLimitReached: boolean;
  spendRemainingMicros: number | null;
  trialEnded: boolean;
};

export type AdSpendPort = {
  allowance(): Promise<AdSpendAllowance>;
  /** Throws the ledger's refusal when the action can't spend `maxCostMicros`. */
  reserve(
    operationId: string,
    provider: AdSpendProvider,
    maxCostMicros: number,
  ): Promise<unknown>;
  /** null when the cost is unknown: the reservation is then kept. */
  settle(reservation: unknown, actualCostMicros: number | null): Promise<void>;
};

const SPEND_ERROR_CODES = [
  "workspace_ai_spend_limit",
  "own_ai_source_required",
  "workspace_ai_policy_unavailable",
  "workspace_ai_operation_replayed",
] as const;
export type AdSpendErrorCode = (typeof SPEND_ERROR_CODES)[number];

/** The ledger's code for an error; null for any other error. */
export function spendCodeOf(error: unknown): AdSpendErrorCode | null {
  const code = error instanceof Error && "code" in error ? error.code : null;
  return (SPEND_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as AdSpendErrorCode)
    : null;
}

/**
 * The ledger refused a reservation: it would pass the company's spending
 * limit or the action's cap, or the action can't be admitted.
 */
export class AdSpendRefusal extends Error {
  constructor(
    readonly code: "workspace_ai_spend_limit" | "own_ai_source_required",
  ) {
    super(`The AI spend ledger refused a reservation (${code})`);
    this.name = "AdSpendRefusal";
  }
}

/** What stops the workspace paying for AI now; null when nothing does. */
export function blockedBy(
  allowance: AdSpendAllowance,
): "spend_limit" | "trial_ended" | "ai_actions_used" | null {
  if (allowance.spendLimitReached) return "spend_limit";
  if (allowance.trialEnded) return "trial_ended";
  if (allowance.includedActions !== null && allowance.remainingActions === 0)
    return "ai_actions_used";
  return null;
}

type ProviderErrorInfo = {
  kind?: string;
  code?: string;
  status?: number;
  transient: boolean;
};

function providerErrorInfo(error: unknown): ProviderErrorInfo | null {
  if (error instanceof MetaModelApiError) return error.info;
  const info = error instanceof Error && "info" in error ? error.info : null;
  return info !== null &&
    typeof info === "object" &&
    typeof (info as { transient?: unknown }).transient === "boolean"
    ? (info as ProviderErrorInfo)
    : null;
}

/**
 * Whether a failed call may have been billed for more than it reported, as
 * the import rules it: a request the provider refused (4xx), a missing key
 * or an answer that wasn't JSON billed what was reported; an outage, a
 * timeout or a lost answer may have billed the whole call.
 */
export function mayHaveUnreportedCost(error: unknown): boolean {
  if (
    isElevenLabsSttRefusedRequest(error) ||
    isElevenLabsSttAcceptedRequest(error)
  )
    return false;
  const info = providerErrorInfo(error);
  if (info === null || info.code === "invalid_json" || info.kind === "config")
    return false;
  return !(
    typeof info.status === "number" &&
    info.status >= 400 &&
    info.status < 500
  );
}

const microsOf = (usd: number) => Math.round(usd * 1_000_000);

/** A paid step: it reports what its calls cost, or names its own cost. */
export type PaidStep<T> = (
  onCost: (usd: number, what: string) => void,
) => Promise<{ value: T; costMicros?: number }>;

/** Runs one paid call under the ad's action; see adSpender. */
export type PaidCall = <T>(
  operation: string,
  provider: AdSpendProvider,
  maxCostMicros: number,
  step: PaidStep<T>,
) => Promise<T>;

/**
 * The ad's paid calls for one attempt of one run: each reserves under an
 * operation id unique to the run and the attempt (`<operation>:r<n>:t<n>`),
 * runs, and settles what it cost; a call that failed after it may have been
 * billed keeps its whole reservation. A refused reservation throws an
 * AdSpendRefusal. `onSettled` hears every settled cost, for the ad's total.
 */
export function adSpender(
  port: AdSpendPort,
  ids: { renderNo: number; attempt: number },
  onSettled: (costMicros: number) => Promise<void> | void,
): PaidCall {
  return async <T>(
    operation: string,
    provider: AdSpendProvider,
    maxCostMicros: number,
    step: PaidStep<T>,
  ): Promise<T> => {
    let reservation: unknown;
    try {
      reservation = await port.reserve(
        `${operation}:r${ids.renderNo}:t${ids.attempt}`,
        provider,
        maxCostMicros,
      );
    } catch (error) {
      const code = spendCodeOf(error);
      if (
        code === "workspace_ai_spend_limit" ||
        code === "own_ai_source_required"
      )
        throw new AdSpendRefusal(code);
      throw error;
    }
    let spentUsd = 0;
    let result: { value: T; costMicros?: number };
    try {
      result = await step((usd) => {
        spentUsd += usd;
      });
    } catch (error) {
      await port.settle(
        reservation,
        mayHaveUnreportedCost(error) ? null : microsOf(spentUsd),
      );
      // The ad's own total counts what was reported; the ledger keeps the
      // rest of an uncertain call's reservation until it's reconciled.
      await onSettled(microsOf(spentUsd));
      throw error;
    }
    const costMicros = result.costMicros ?? microsOf(spentUsd);
    await port.settle(reservation, costMicros);
    await onSettled(costMicros);
    return result.value;
  };
}
