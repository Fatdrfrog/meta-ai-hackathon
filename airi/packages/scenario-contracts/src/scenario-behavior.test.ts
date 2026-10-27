import assert from "node:assert/strict";
import { test } from "node:test";
import {
  behaviorDueAt,
  isScenarioBehaviorConfig,
  isPurchaseSegment,
  matchesPurchaseSegment,
} from "./scenario-behavior";
import { normalizeClientMessageTriggerConfig } from "./client-message-trigger";

test("cart recovery delays stay within cart retention without shortening other journeys", () => {
  for (const preset of ["abandoned_cart", "abandoned_checkout"]) {
    assert.equal(isScenarioBehaviorConfig({ preset, delayMinutes: 30 * 1440 }), true);
    assert.equal(isScenarioBehaviorConfig({ preset, delayMinutes: 30 * 1440 + 1 }), false);
  }
  assert.equal(isScenarioBehaviorConfig({ preset: "upcoming_renewal", delayMinutes: 730 * 1440 }), true);
});

test("behavior timing uses the actual event or supplied due date", () => {
  const occurred = "2026-09-01T00:00:00Z";
  const due = "2026-10-01T00:00:00Z";
  assert.equal(
    behaviorDueAt(
      { preset: "abandoned_checkout", delayMinutes: 60 },
      occurred,
    )?.toISOString(),
    "2026-09-01T01:00:00.000Z",
  );
  assert.equal(
    behaviorDueAt(
      { preset: "upcoming_renewal", delayMinutes: 1440 },
      occurred,
      due,
    )?.toISOString(),
    "2026-09-30T00:00:00.000Z",
  );
  assert.equal(
    behaviorDueAt(
      { preset: "overdue_service", delayMinutes: 1440 },
      occurred,
      due,
    )?.toISOString(),
    "2026-10-02T00:00:00.000Z",
  );
  assert.equal(
    behaviorDueAt({ preset: "upcoming_renewal", delayMinutes: 1440 }, occurred),
    null,
  );
});

test("segments keep currency totals separate and use precise recency boundaries", () => {
  const facts = {
    purchaseCount: 2,
    lastPurchaseAt: "2026-09-01T00:00:00Z",
    netSpend: { KZT: 9000, USD: 50 },
  };
  const now = new Date("2026-09-11T00:00:00Z");
  assert.equal(
    matchesPurchaseSegment(
      {
        minDaysSincePurchase: 10,
        minPurchases: 2,
        minNetSpend: 9000,
        currency: "KZT",
      },
      facts,
      now,
    ),
    true,
  );
  assert.equal(
    matchesPurchaseSegment({ minNetSpend: 100, currency: "USD" }, facts, now),
    false,
  );
  assert.equal(
    matchesPurchaseSegment({ maxDaysSincePurchase: 9 }, facts, now),
    false,
  );
  assert.equal(
    matchesPurchaseSegment(
      { minDaysSincePurchase: 0 },
      { ...facts, lastPurchaseAt: null },
      now,
    ),
    false,
  );
  assert.equal(isPurchaseSegment({ minNetSpend: 10 }), false);
  assert.equal(isPurchaseSegment({ minPurchases: 2, maxPurchases: 1 }), false);
  assert.equal(
    isPurchaseSegment({ minNetSpend: Infinity, currency: "KZT" }),
    false,
  );
});

test("invalid behavior drafts remain distinct from message triggers", () => {
  const draft = {
    entryPointType: "customer_behavior",
    behavior: { preset: "win_back", delayMinutes: -1 },
  };
  const normalized = normalizeClientMessageTriggerConfig(draft);
  assert.equal(normalized.entryPointType, "customer_behavior");
  assert.deepEqual(normalized.behavior, draft.behavior);
  assert.equal(isScenarioBehaviorConfig(normalized.behavior), false);
  assert.equal(
    isScenarioBehaviorConfig({ preset: "unknown", delayMinutes: 1 }),
    false,
  );
});
