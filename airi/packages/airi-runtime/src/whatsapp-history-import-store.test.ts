import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeWhatsAppHistoryReceipts,
  expandWhatsAppHistoryChunk,
} from "./whatsapp-history-import-store";
import { attachWhatsAppHistoryImportBinding } from "./whatsapp-history-import";
import { buildWhatsAppWebhookEventEnvelopes } from "./whatsapp-webhook-event-envelopes";
import type { WhatsAppHistorySyncState } from "@icecore/shared/lib/whatsapp/history-sync-state";

const current = {
  session_id: "session-1",
  requested_at: "2026-10-10T00:00:00Z",
};
const completeChunk = {
  role: "chunk",
  status: "completed",
  outcome: null,
  count: 1,
  progress: 100,
  receivedAt: "2026-10-10T00:01:00Z",
  providerErrors: [],
};
test("an unverified history parent cannot create durable children", async () => {
  let writes = 0;
  await assert.rejects(
    expandWhatsAppHistoryChunk(
      {
        parent: {} as Parameters<
          typeof expandWhatsAppHistoryChunk
        >[0]["parent"],
        eventId: "event-1",
        processingLeaseId: "lease-1",
        providerSignatureVerified: false,
      },
      {
        persistChildren: async () => {
          writes++;
        },
        commitExpansion: async () => {
          writes++;
          return true;
        },
      },
    ),
    /verified provider signature/,
  );
  assert.equal(writes, 0);
});

test("provider completion cannot hide dead or pending durable receipts", () => {
  const complete = summarizeWhatsAppHistoryReceipts(current, [
    completeChunk,
    { role: "message", status: "completed", outcome: "synchronized", count: 2 },
  ]);
  assert.equal(complete.status, "completed");
  assert.equal(complete.synchronized_count_total, 2);
  const pending = summarizeWhatsAppHistoryReceipts(complete, [
    completeChunk,
    { role: "message", status: "completed", outcome: "synchronized", count: 2 },
    { role: "message", status: "received", count: 1 },
  ]);
  assert.equal(pending.status, "in_progress");
  assert.equal(pending.completed_at, undefined);
  const dead = summarizeWhatsAppHistoryReceipts(current, [
    completeChunk,
    { role: "message", status: "dead", count: 1 },
  ]);
  assert.equal(dead.status, "error");
  assert.equal(dead.failed_count_total, 1);
});

test("counts durable synchronized receipts once and keeps intentional skips separate", () => {
  const state = summarizeWhatsAppHistoryReceipts(current, [
    completeChunk,
    { role: "message", status: "completed", outcome: "synchronized", count: 1 },
    { role: "message", status: "completed", outcome: "skipped", count: 3 },
  ]);
  assert.equal(state.synchronized_count_total, 1);
  assert.equal(state.received_count_total, 4);
  assert.equal(state.skipped_count_total, 3);
  assert.equal(state.plan_skipped_count_total, 0);
  assert.equal(state.counts_verified, true);
});

test("a completed import still reports history children the plan gate skipped", () => {
  // Plan-skipped children complete their receipts, so the import completes;
  // the projection must still say how many were dropped by the plan.
  const rows = [
    completeChunk,
    { role: "message", status: "completed", outcome: "synchronized", count: 5 },
    // One unsupported skip plus three plan skips share the skipped group.
    {
      role: "message",
      status: "completed",
      outcome: "skipped",
      count: 4,
      planSkipped: 3,
    },
  ];
  const state: WhatsAppHistorySyncState = summarizeWhatsAppHistoryReceipts(
    current,
    rows,
  );
  assert.equal(state.status, "completed");
  assert.equal(state.pending_count_total, 0);
  assert.equal(state.skipped_count_total, 4);
  assert.equal(state.plan_skipped_count_total, 3);
  // Identity counts win, so a later synchronized revision is not counted.
  const deduped = summarizeWhatsAppHistoryReceipts(current, rows, {
    received: 9,
    synchronized: 6,
    skipped: 3,
    planSkipped: 2,
  });
  assert.equal(deduped.plan_skipped_count_total, 2);
  assert.equal(
    summarizeWhatsAppHistoryReceipts(current, []).plan_skipped_count_total,
    0,
  );
});

test("an initialized session does not invent an attempted request", () => {
  const state = summarizeWhatsAppHistoryReceipts(
    { session_id: "session-1" },
    [],
  );
  assert.equal(state.status, undefined);
});

test("revisions of one provider message do not inflate synchronized counts", () => {
  const state = summarizeWhatsAppHistoryReceipts(
    current,
    [
      completeChunk,
      {
        role: "message",
        status: "completed",
        outcome: "synchronized",
        count: 3,
      },
    ],
    { received: 1, synchronized: 1, skipped: 0 },
  );
  assert.equal(state.synchronized_count_total, 1);
  assert.equal(state.received_count_total, 1);
});

test("pending and dead parent chunks prevent completion without pretending to be messages", () => {
  const state = summarizeWhatsAppHistoryReceipts(current, [
    completeChunk,
    { role: "chunk", status: "received", count: 1 },
  ]);
  assert.equal(state.status, "in_progress");
  assert.equal(state.pending_chunk_count_total, 1);
  assert.equal(state.pending_count_total, 0);
});

test("capacity-paused parents remain visible as preserved pending history", () => {
  const state = summarizeWhatsAppHistoryReceipts(current, [completeChunk, { role: "chunk", status: "received", capacityPaused: true, count: 2 }]);
  assert.equal(state.status, "paused");
  assert.equal(state.pause_reason, "history_import_allowance");
  assert.equal(state.pending_chunk_count_total, 2);
  assert.equal(state.failed_chunk_count_total, 0);
});

test("a plan-paused import says it waits for an upgrade, not for capacity", () => {
  const planPaused = {
    role: "chunk",
    status: "received",
    capacityPaused: true,
    planPaused: true,
    count: 2,
  };
  const allowancePaused = {
    role: "chunk",
    status: "received",
    capacityPaused: true,
    count: 1,
  };
  for (const rows of [
    [completeChunk, planPaused],
    // The plan lock is the first blocker even when the allowance is also used.
    [completeChunk, allowancePaused, planPaused],
  ]) {
    const state = summarizeWhatsAppHistoryReceipts(current, rows);
    assert.equal(state.status, "paused");
    assert.equal(state.pause_reason, "company_trial_expired");
  }
  // Completed rows and an unpaused import carry no pause reason.
  const resumed = summarizeWhatsAppHistoryReceipts(
    { ...current, pause_reason: "company_trial_expired" as const },
    [
      completeChunk,
      { ...planPaused, status: "completed", capacityPaused: false },
    ],
  );
  assert.notEqual(resumed.status, "paused");
  assert.equal(resumed.pause_reason, undefined);
});

test("an expansion resumes after a partial write and commits only durable children", async () => {
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "history",
            value: {
              metadata: { phone_number_id: "phone-1" },
              messages: [
                { id: "one", from: "1555001" },
                { id: "two", from: "1555001" },
              ],
            },
          },
        ],
      },
    ],
  };
  const parent = attachWhatsAppHistoryImportBinding(
    buildWhatsAppWebhookEventEnvelopes({
      body,
      rawBody: JSON.stringify(body),
    })[0]!,
    {
      sessionId: "session-1",
      sessionStartedAt: current.requested_at,
      rangeDays: 180,
      sourceId: "source-1",
      workspaceId: "workspace-1",
      phoneNumberId: "phone-1",
    },
  );
  const receipts = new Set<string>();
  let fail = true;
  let committed = 0;
  const dependencies = {
    persistChildren: async (children: (typeof parent)[]) => {
      for (const child of children) {
        receipts.add(child.dedupeKey);
        if (fail) {
          fail = false;
          throw new Error("partial write");
        }
      }
    },
    commitExpansion: async () => {
      committed++;
      return true;
    },
  };
  await assert.rejects(
    expandWhatsAppHistoryChunk(
      {
        parent,
        eventId: "event-1",
        processingLeaseId: "lease-1",
        providerSignatureVerified: true,
      },
      dependencies,
    ),
    /partial write/,
  );
  assert.equal(committed, 0);
  await expandWhatsAppHistoryChunk(
    {
      parent,
      eventId: "event-1",
      processingLeaseId: "lease-1",
      providerSignatureVerified: true,
    },
    dependencies,
  );
  assert.equal(committed, 1);
  assert.equal(receipts.size, 2);
});
