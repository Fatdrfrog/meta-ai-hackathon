import {
  buildWhatsAppHistorySyncSummary,
  isWhatsAppHistorySyncActive,
} from "./status";

describe("WhatsApp history sync status view", () => {
  it("shows a capacity pause without declaring received history failed or complete", () => {
    expect(buildWhatsAppHistorySyncSummary({ status: "paused", counts_verified: true, pending_chunk_count_total: 2 })).toMatchObject({ status: "paused", titleKey: "pausedTitle", active: false, terminal: false });
  });
  it("tells a plan-locked import to upgrade instead of asking support for capacity", () => {
    expect(
      buildWhatsAppHistorySyncSummary({
        status: "paused",
        pause_reason: "history_import_allowance",
      }).descriptionKey
    ).toBe("pausedDescription");
    expect(
      buildWhatsAppHistorySyncSummary({
        status: "paused",
        pause_reason: "company_trial_expired",
        counts_verified: true,
        pending_chunk_count_total: 2,
      })
    ).toMatchObject({
      status: "paused",
      titleKey: "pausedTitle",
      descriptionKey: "pausedPlanDescription",
      active: false,
      terminal: false,
    });
  });
  it("does not call an import saved when the plan gate skipped history chats", () => {
    const completed = {
      requested_at: new Date().toISOString(),
      status: "completed" as const,
      last_progress: 100,
      counts_verified: true,
      synchronized_count_total: 500,
      skipped_count_total: 300,
      pending_count_total: 0,
      failed_count_total: 0,
    };
    expect(
      buildWhatsAppHistorySyncSummary({
        ...completed,
        plan_skipped_count_total: 300,
      })
    ).toMatchObject({
      status: "plan_skipped",
      titleKey: "planSkippedTitle",
      descriptionKey: "planSkippedDescription",
      planSkippedCount: 300,
      synchronizedCount: 500,
      active: false,
      terminal: true,
    });
    // Other skips (unsupported messages) still complete normally.
    expect(buildWhatsAppHistorySyncSummary(completed)).toMatchObject({
      status: "completed",
      titleKey: "completedTitle",
      planSkippedCount: 0,
    });
    // Pending or paused work keeps its own state until it settles.
    expect(
      buildWhatsAppHistorySyncSummary({
        ...completed,
        plan_skipped_count_total: 300,
        pending_count_total: 2,
      }).status
    ).toBe("unverified");
    expect(
      buildWhatsAppHistorySyncSummary({
        ...completed,
        status: "paused",
        pause_reason: "company_trial_expired",
        plan_skipped_count_total: 300,
      }).descriptionKey
    ).toBe("pausedPlanDescription");
    // Unverified legacy counters never claim a plan skip.
    expect(
      buildWhatsAppHistorySyncSummary({
        ...completed,
        counts_verified: false,
        plan_skipped_count_total: 300,
      })
    ).toMatchObject({ status: "unverified", planSkippedCount: null });
  });
  it("keeps an uncertain request active even when the request transport records an error", () => {
    expect(
      buildWhatsAppHistorySyncSummary({
        session_id: "session",
        request_state: "unknown",
        status: "error",
        request_attempted_at: new Date().toISOString(),
      })
    ).toMatchObject({
      status: "request_unknown",
      active: true,
      terminal: false,
    });
  });
  it("turns an abandoned requesting state into uncertainty after five minutes", () => {
    const attemptedAt = Date.parse("2026-10-10T10:00:00Z");
    expect(
      buildWhatsAppHistorySyncSummary(
        {
          session_id: "session",
          request_state: "requesting",
          request_attempted_at: new Date(attemptedAt).toISOString(),
        },
        { now: attemptedAt + 6 * 60_000 }
      )
    ).toMatchObject({ status: "request_unknown", active: true });
  });
  it("keeps retryable receipt failures active while the projected import is in progress", () => {
    expect(
      buildWhatsAppHistorySyncSummary({
        requested_at: new Date().toISOString(),
        last_webhook_at: new Date().toISOString(),
        status: "in_progress",
        last_progress: 100,
        counts_verified: true,
        synchronized_count_total: 3,
        pending_count_total: 2,
        failed_count_total: 2,
      })
    ).toMatchObject({
      status: "saving",
      active: true,
      terminal: false,
      failedCount: 2,
    });
  });
  it("keeps pending chunks visible even before they produce message receipts", () => {
    expect(
      buildWhatsAppHistorySyncSummary({
        requested_at: new Date().toISOString(),
        status: "in_progress",
        last_progress: 100,
        counts_verified: true,
        synchronized_count_total: 3,
        pending_count_total: 0,
        pending_chunk_count_total: 1,
      })
    ).toMatchObject({ status: "saving", active: true, synchronizedCount: 3 });
  });
  it("keeps provider completion separate from durable local completion", () => {
    expect(
      buildWhatsAppHistorySyncSummary({
        requested_at: new Date().toISOString(),
        status: "in_progress",
        last_progress: 100,
        counts_verified: true,
        received_count_total: 20,
        synchronized_count_total: 12,
        pending_count_total: 8,
        failed_count_total: 0,
      })
    ).toMatchObject({
      status: "saving",
      active: true,
      providerProgress: 100,
      synchronizedCount: 12,
      pendingCount: 8,
      descriptionKey: "savingDescription",
    });
  });

  it("does not advertise legacy counters as verified imported messages", () => {
    expect(
      buildWhatsAppHistorySyncSummary({
        requested_at: "2026-01-01T00:00:00Z",
        status: "completed",
        processed_count_total: 900,
      })
    ).toMatchObject({
      countsVerified: false,
      synchronizedCount: null,
      status: "unverified",
      descriptionKey: "unverifiedDescription",
    });
  });

  it("keeps an unknown request outcome guarded while status can settle", () => {
    expect(
      buildWhatsAppHistorySyncSummary({
        session_id: "new-session",
        session_started_at: new Date().toISOString(),
        request_attempted_at: new Date().toISOString(),
        request_state: "unknown",
      })
    ).toMatchObject({
      status: "request_unknown",
      active: true,
      descriptionKey: "requestUnknownDescription",
    });
  });
  it("treats requested history sync as an active navbar state", () => {
    const state = {
      requested_at: "2026-06-06T10:00:00.000Z",
      status: "requested" as const,
    };
    const now = Date.parse("2026-06-06T10:30:00.000Z");

    expect(isWhatsAppHistorySyncActive(state, { now })).toBe(true);
    expect(buildWhatsAppHistorySyncSummary(state, { now })).toMatchObject({
      active: true,
      titleKey: "requestedTitle",
    });
  });

  it("does not keep stale requested history sync active forever", () => {
    const state = {
      requested_at: "2026-05-02T15:59:47.701Z",
      request_id: "782F6722D44E038636",
      range_days: 180,
    };
    const now = Date.parse("2026-06-07T00:00:00.000Z");

    expect(isWhatsAppHistorySyncActive(state, { now })).toBe(false);
    expect(buildWhatsAppHistorySyncSummary(state, { now })).toMatchObject({
      active: false,
      terminal: false,
      titleKey: "staleTitle",
      descriptionKey: "staleDescription",
    });
  });

  it("does not keep stalled in-progress history sync active forever", () => {
    const state = {
      requested_at: "2026-06-01T10:00:00.000Z",
      last_webhook_at: "2026-06-01T10:05:00.000Z",
      status: "in_progress" as const,
      last_progress: 42,
    };
    const now = Date.parse("2026-06-03T10:00:00.000Z");

    expect(isWhatsAppHistorySyncActive(state, { now })).toBe(false);
    expect(buildWhatsAppHistorySyncSummary(state, { now })).toMatchObject({
      active: false,
      terminal: false,
      titleKey: "staleTitle",
      descriptionKey: "staleDescription",
      providerProgress: 42,
    });
  });

  it("hides completed history sync from transient surfaces while preserving result details", () => {
    const state = {
      requested_at: "2026-06-06T10:00:00.000Z",
      completed_at: "2026-06-06T10:05:00.000Z",
      status: "completed" as const,
      processed_count_total: 13,
      skipped_count_total: 2,
      webhook_count: 4,
      counts_verified: true,
      synchronized_count_total: 13,
      pending_count_total: 0,
      failed_count_total: 0,
      last_progress: 100,
    };

    expect(isWhatsAppHistorySyncActive(state)).toBe(false);
    expect(buildWhatsAppHistorySyncSummary(state)).toMatchObject({
      active: false,
      terminal: true,
      titleKey: "completedTitle",
      descriptionKey: "completedDescription",
      providerProgress: 100,
      synchronizedCount: 13,
      countsVerified: true,
    });
  });
});
