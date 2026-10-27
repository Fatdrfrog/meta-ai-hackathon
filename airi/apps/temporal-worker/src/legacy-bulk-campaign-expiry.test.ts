import assert from "node:assert/strict";
import test from "node:test";

import {
  isLegacyBulkCampaignActivityExpired,
  LEGACY_BULK_CAMPAIGN_DISPATCH_START_GRACE_MS,
} from "./legacy-bulk-campaign-expiry";

test("expires a legacy activity that waited beyond the dispatch start grace", () => {
  assert.equal(
    isLegacyBulkCampaignActivityExpired({
      scheduledTimestampMs: 1_000,
      nowMs: 1_000 + LEGACY_BULK_CAMPAIGN_DISPATCH_START_GRACE_MS + 1,
    }),
    true,
  );
});

test("does not turn the v3 start deadline into an activity retry deadline", () => {
  assert.equal(
    isLegacyBulkCampaignActivityExpired({
      lifecycleManaged: true,
      scheduledTimestampMs: 1_000,
      nowMs: 1_000 + LEGACY_BULK_CAMPAIGN_DISPATCH_START_GRACE_MS * 10,
    }),
    false,
  );
});
