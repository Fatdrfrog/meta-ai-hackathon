import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAiriTemporalDispatch,
  isAiriDeliveryCompatiblySkipped,
  resolveAiriOutboundDate,
  shouldApplyAiriPostDeliveryEffects,
} from "./job-runner-delivery-result";

test("maps durable strict dispatch states to the public delivery classification", () => {
  assert.equal(classifyAiriTemporalDispatch("sent"), "sent");
  assert.equal(classifyAiriTemporalDispatch("not_attempted"), "not_attempted");
  assert.equal(classifyAiriTemporalDispatch("dispatching"), "outcome_unknown");
  assert.equal(
    classifyAiriTemporalDispatch("outcome_unknown"),
    "outcome_unknown",
  );
});

test("runs accepted effects only for sent delivery", () => {
  for (const classification of [
    "skipped",
    "not_attempted",
    "outcome_unknown",
  ] as const) {
    assert.equal(
      shouldApplyAiriPostDeliveryEffects({
        deliveryKey: "delivery-1",
        outboundMessageId: "message-1",
        outboundDate: null,
        classification,
      }),
      false,
    );
  }

  assert.equal(
    shouldApplyAiriPostDeliveryEffects({
      deliveryKey: "delivery-1",
      outboundMessageId: "message-1",
      outboundDate: "2026-07-30T10:00:00.000Z",
      classification: "sent",
    }),
    true,
  );
});

test("non-sent classifications expose neither a delivered date nor legacy acceptance", () => {
  for (const classification of [
    "skipped",
    "not_attempted",
    "outcome_unknown",
  ] as const) {
    assert.equal(
      resolveAiriOutboundDate(classification, "2026-07-30T10:00:00.000Z"),
      null,
    );
    assert.equal(isAiriDeliveryCompatiblySkipped(classification), true);
  }

  assert.equal(
    resolveAiriOutboundDate("sent", "2026-07-30T10:00:00.000Z"),
    "2026-07-30T10:00:00.000Z",
  );
  assert.equal(isAiriDeliveryCompatiblySkipped("sent"), false);
});
