export type NormalizedBulkSendSchedule =
  | {
      ok: true;
      scheduledAt: Date | null;
      scheduledAtIso: string | null;
      scheduled: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export function normalizeBulkSendScheduledAt(
  value: unknown,
  options?: { now?: Date; requireFuture?: boolean }
): NormalizedBulkSendSchedule {
  if (value === null || value === undefined || value === "") {
    return {
      ok: true,
      scheduledAt: null,
      scheduledAtIso: null,
      scheduled: false,
    };
  }

  if (typeof value !== "string") {
    return { ok: false, error: "scheduledAt must be an ISO date string" };
  }

  const scheduledAt = new Date(value);
  if (!Number.isFinite(scheduledAt.getTime())) {
    return { ok: false, error: "scheduledAt must be a valid date" };
  }

  const now = options?.now || new Date();
  if (
    options?.requireFuture !== false &&
    scheduledAt.getTime() <= now.getTime()
  ) {
    return { ok: false, error: "scheduledAt must be in the future" };
  }

  return {
    ok: true,
    scheduledAt,
    scheduledAtIso: scheduledAt.toISOString(),
    scheduled: true,
  };
}
