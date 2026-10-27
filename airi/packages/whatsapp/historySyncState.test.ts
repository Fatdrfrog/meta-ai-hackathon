import assert from "node:assert/strict";
import test from "node:test";

import { buildHistorySyncWebhookState } from "./historySyncState";
import * as historySync from "./historySyncState";

test("offers a one-shot request only for a current connection session", () => {
  assert.equal(
    typeof historySync.getWhatsAppHistoryRequestAvailability,
    "function",
  );
  const now = Date.parse("2026-10-10T12:00:00Z");
  const session = {
    session_id: "session-1",
    session_started_at: "2026-10-10T11:00:00Z",
  };
  assert.deepEqual(
    historySync.getWhatsAppHistoryRequestAvailability(session, now),
    {
      canRequest: true,
      reason: "ready",
    },
  );
  assert.deepEqual(
    historySync.getWhatsAppHistoryRequestAvailability(null, now),
    {
      canRequest: false,
      reason: "onboarding_required",
    },
  );
  assert.deepEqual(
    historySync.getWhatsAppHistoryRequestAvailability(
      {
        ...session,
        session_started_at: "2026-10-09T12:00:00Z",
      },
      now,
    ),
    { canRequest: false, reason: "request_window_expired" },
  );
  assert.deepEqual(
    historySync.getWhatsAppHistoryRequestAvailability(
      {
        ...session,
        session_started_at: "invalid",
      },
      now,
    ),
    { canRequest: false, reason: "onboarding_required" },
  );
});

test("never resends accepted, in-flight or uncertain provider requests", () => {
  assert.equal(
    typeof historySync.getWhatsAppHistoryRequestAvailability,
    "function",
  );
  const now = Date.parse("2026-10-10T12:00:00Z");
  const session = {
    session_id: "session-1",
    session_started_at: "2026-10-10T11:00:00Z",
  };
  for (const [request_state, reason] of [
    ["accepted", "already_requested"],
    ["requesting", "request_in_flight"],
    ["unknown", "request_outcome_unknown"],
  ] as const) {
    assert.deepEqual(
      historySync.getWhatsAppHistoryRequestAvailability(
        {
          ...session,
          request_state,
        },
        now,
      ),
      { canRequest: false, reason },
    );
  }
  assert.deepEqual(
    historySync.getWhatsAppHistoryRequestAvailability(
      {
        ...session,
        request_state: "rejected",
        request_attempt_id: "failed-attempt",
      },
      now,
    ),
    { canRequest: true, reason: "ready" },
  );
  for (const evidence of [
    { requested_at: "2026-10-10T11:00:01Z" },
    { last_webhook_at: "2026-10-10T11:00:02Z" },
  ]) {
    assert.deepEqual(
      historySync.getWhatsAppHistoryRequestAvailability(
        {
          ...session,
          ...evidence,
        },
        now,
      ),
      { canRequest: false, reason: "already_requested" },
    );
  }
  assert.deepEqual(
    historySync.getWhatsAppHistoryRequestAvailability(
      {
        ...session,
        request_attempt_id: "ambiguous-attempt",
      },
      now,
    ),
    { canRequest: false, reason: "request_outcome_unknown" },
  );
});

test("a stale request reservation becomes uncertain without allowing another request", () => {
  const state = {
    session_id: "session-1",
    session_started_at: "2026-10-10T11:00:00Z",
    request_state: "requesting" as const,
    request_attempted_at: "2026-10-10T12:00:00Z",
  };
  assert.deepEqual(
    historySync.getWhatsAppHistoryRequestAvailability(
      state,
      Date.parse("2026-10-10T12:04:59Z"),
    ),
    { canRequest: false, reason: "request_in_flight" },
  );
  assert.deepEqual(
    historySync.getWhatsAppHistoryRequestAvailability(
      state,
      Date.parse("2026-10-10T12:05:00Z"),
    ),
    { canRequest: false, reason: "request_outcome_unknown" },
  );
  assert.deepEqual(
    historySync.getWhatsAppHistoryRequestAvailability(
      { ...state, request_state: "accepted" },
      Date.parse("2026-10-10T12:05:00Z"),
    ),
    { canRequest: false, reason: "already_requested" },
  );
});

test("marks history sync in progress and accumulates processed counts", () => {
  const state = buildHistorySyncWebhookState({
    current: {
      requested_at: "2026-05-02T15:59:47.000Z",
      request_id: "request-1",
      processed_count_total: 3,
    },
    metadata: [{ phase: 1, chunk_order: 2, progress: 45 }],
    processedCount: 7,
    skippedCount: 1,
    receivedAt: "2026-05-03T10:00:00.000Z",
  });

  assert.equal(state.status, "in_progress");
  assert.equal(state.requested_at, "2026-05-02T15:59:47.000Z");
  assert.equal(state.request_id, "request-1");
  assert.equal(state.last_phase, 1);
  assert.equal(state.last_chunk_order, 2);
  assert.equal(state.last_progress, 45);
  assert.equal(state.last_webhook_at, "2026-05-03T10:00:00.000Z");
  assert.equal(state.processed_count_total, 10);
  assert.equal(state.skipped_count_total, 1);
  assert.equal(state.webhook_count, 1);
});

test("marks history sync complete when progress reaches 100", () => {
  const state = buildHistorySyncWebhookState({
    current: {
      status: "in_progress",
      requested_at: "2026-05-02T15:59:47.000Z",
      last_progress: 90,
      webhook_count: 4,
    },
    metadata: [{ phase: 2, chunk_order: 9, progress: 100 }],
    processedCount: 2,
    skippedCount: 0,
    receivedAt: "2026-05-03T10:05:00.000Z",
  });

  assert.equal(state.status, "completed");
  assert.equal(state.last_phase, 2);
  assert.equal(state.last_chunk_order, 9);
  assert.equal(state.last_progress, 100);
  assert.equal(state.completed_at, "2026-05-03T10:05:00.000Z");
  assert.equal(state.webhook_count, 5);
});

test("marks history sync declined when the business turned sharing off", () => {
  const state = buildHistorySyncWebhookState({
    current: {
      requested_at: "2026-05-02T15:59:47.000Z",
    },
    metadata: [],
    processedCount: 0,
    skippedCount: 0,
    receivedAt: "2026-05-03T10:10:00.000Z",
    errors: [
      {
        code: 2593109,
        title:
          "History sync is turned off by the business from the WhatsApp Business App",
        message:
          "History sync is turned off by the business from the WhatsApp Business App",
        error_data: {
          details: "History sharing is turned off by the business",
        },
      },
    ],
  });

  assert.equal(state.status, "declined");
  assert.equal(state.last_webhook_at, "2026-05-03T10:10:00.000Z");
  assert.equal(state.error_code, 2593109);
  assert.equal(
    state.error,
    "History sync is turned off by the business from the WhatsApp Business App",
  );
  assert.equal(
    state.error_details,
    "History sharing is turned off by the business",
  );
  assert.equal(state.webhook_count, 1);
});
