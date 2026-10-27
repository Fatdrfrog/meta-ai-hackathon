import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCampaignContactDeliveryKey,
  buildCampaignTaskContactDeliveryKey,
} from "./campaign-contact-key";

test("builds the same campaign key from a dispatch phone and a status recipient", () => {
  assert.equal(
    buildCampaignContactDeliveryKey("campaign-1", "+7 (701) 000-00-01"),
    "campaign:campaign-1:77010000001",
  );
  assert.equal(
    buildCampaignContactDeliveryKey("campaign-1", "77010000001"),
    "campaign:campaign-1:77010000001",
  );
});

test("has no campaign key without a campaign or a phone", () => {
  assert.equal(buildCampaignContactDeliveryKey(null, "77010000001"), null);
  assert.equal(buildCampaignContactDeliveryKey(" ", "77010000001"), null);
  assert.equal(
    buildCampaignContactDeliveryKey("campaign-1", "KZ.abc123"),
    null,
  );
});

test("keeps the existing task key format", () => {
  assert.equal(
    buildCampaignTaskContactDeliveryKey("task-1"),
    "campaign-task:task-1",
  );
});
