import { randomUUID } from "node:crypto";

import { buildCacheKey, cache } from "@/lib/cache";
import { createLogger } from "@icecore/shared/lib/logger";
import { NextResponse } from "next/server";

const TELEGRAM_UPDATE_COMPLETED_TTL_SECONDS = 60 * 60 * 24;
const TELEGRAM_UPDATE_IN_PROGRESS_TTL_SECONDS = 60 * 5;
const COMPLETED_MARKER = "1";

const logger = createLogger("telegram-update-dedupe");

type TrackedTelegramUpdateClaim = {
  state: "claimed";
  tracked: true;
  completionKey: string;
  inProgressKey: string;
  token: string;
};

type UntrackedTelegramUpdateClaim = {
  state: "claimed";
  tracked: false;
};

type ClaimedTelegramUpdate =
  | TrackedTelegramUpdateClaim
  | UntrackedTelegramUpdateClaim;

type TelegramUpdateClaim =
  | ClaimedTelegramUpdate
  | { state: "in_progress" }
  | { state: "completed" };

type TelegramUpdateCompletion =
  | "completed"
  | "untracked"
  | "not_owner"
  | "unavailable";

type ProcessTelegramUpdateWithDedupeOptions = {
  scope: string;
  updateId?: number;
  process: () => Promise<NextResponse>;
};

function buildTelegramUpdateKeys(scope: string, updateId: number) {
  return {
    completionKey: buildCacheKey("telegram:update:completed:v2", [
      scope,
      updateId,
    ]),
    inProgressKey: buildCacheKey("telegram:update:in-progress:v2", [
      scope,
      updateId,
    ]),
  };
}

async function releaseTrackedTelegramUpdate(
  claim: TrackedTelegramUpdateClaim
): Promise<boolean> {
  return cache.compareAndDelete(claim.inProgressKey, claim.token);
}

async function claimTelegramUpdate(
  scope: string,
  updateId?: number
): Promise<TelegramUpdateClaim> {
  if (!Number.isFinite(updateId)) {
    return { state: "claimed", tracked: false };
  }

  const finiteUpdateId = updateId as number;
  const { completionKey, inProgressKey } = buildTelegramUpdateKeys(
    scope,
    finiteUpdateId
  );
  const token = randomUUID();
  const acquisition = await cache.claimCompletionLock({
    completionKey,
    lockKey: inProgressKey,
    token,
    lockTtlSeconds: TELEGRAM_UPDATE_IN_PROGRESS_TTL_SECONDS,
  });

  if (acquisition === "unavailable") {
    logger.warn("Telegram dedupe unavailable; processing update untracked", {
      scope,
      updateId: finiteUpdateId,
    });
    return { state: "claimed", tracked: false };
  }

  if (acquisition === "completed") {
    return { state: "completed" };
  }

  if (acquisition === "contended") {
    return { state: "in_progress" };
  }

  const claim: TrackedTelegramUpdateClaim = {
    state: "claimed",
    tracked: true,
    completionKey,
    inProgressKey,
    token,
  };

  return claim;
}

async function completeTelegramUpdate(
  claim: ClaimedTelegramUpdate
): Promise<TelegramUpdateCompletion> {
  if (!claim.tracked) return "untracked";

  const result = await cache.finalizeCompletionLock({
    completionKey: claim.completionKey,
    completionValue: COMPLETED_MARKER,
    completionTtlSeconds: TELEGRAM_UPDATE_COMPLETED_TTL_SECONDS,
    lockKey: claim.inProgressKey,
    token: claim.token,
  });
  if (result === "finalized") return "completed";
  return result;
}

async function releaseTelegramUpdate(
  claim: ClaimedTelegramUpdate
): Promise<boolean> {
  if (!claim.tracked) return true;
  return releaseTrackedTelegramUpdate(claim);
}

export async function processTelegramUpdateWithDedupe({
  scope,
  updateId,
  process,
}: ProcessTelegramUpdateWithDedupeOptions): Promise<NextResponse> {
  const claim = await claimTelegramUpdate(scope, updateId);
  if (claim.state === "completed") {
    return NextResponse.json({
      ok: true,
      duplicate_update: true,
      dedupe_state: "completed",
    });
  }
  if (claim.state === "in_progress") {
    return NextResponse.json(
      { ok: false, dedupe_state: "in_progress" },
      { status: 503, headers: { "Retry-After": "1" } }
    );
  }

  let response: NextResponse;
  try {
    response = await process();
  } catch (error) {
    const released = await releaseTelegramUpdate(claim);
    if (!released && claim.tracked) {
      logger.warn("Failed to release Telegram update after handler failure", {
        scope,
        updateId,
      });
    }
    throw error;
  }

  if (!response.ok) {
    await releaseTelegramUpdate(claim);
    return response;
  }

  let completion: TelegramUpdateCompletion;
  try {
    completion = await completeTelegramUpdate(claim);
  } catch (error) {
    logger.error("Telegram update completion threw unexpectedly", error, {
      scope,
      updateId,
    });
    return NextResponse.json(
      { ok: false, dedupe_state: "completion_unavailable" },
      { status: 503, headers: { "Retry-After": "1" } }
    );
  }

  if (completion === "not_owner" || completion === "unavailable") {
    logger.error(
      "Telegram update completion could not be durably recorded",
      new Error(`Completion result: ${completion}`),
      { scope, updateId, completion }
    );
    return NextResponse.json(
      { ok: false, dedupe_state: "completion_unavailable" },
      { status: 503, headers: { "Retry-After": "1" } }
    );
  }

  return response;
}
