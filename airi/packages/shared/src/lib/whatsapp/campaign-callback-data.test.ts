import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isWhatsAppPricingBillable,
  resolveWhatsAppMessageRateUsd,
  WHATSAPP_MESSAGE_RATES_USD,
} from "../../constants/whatsapp-message-rates.js";
import { shouldAdvanceWhatsAppDeliveryStatus } from "../../types/whatsapp-delivery.js";
import {
  buildCampaignCallbackData,
  parseCampaignCallbackData,
} from "./campaign-callback-data.js";

describe("whatsapp campaign shared helpers", () => {
  it("builds and parses campaign callback data", () => {
    const encoded = buildCampaignCallbackData({
      campaignId: "camp-1",
      workspaceId: "ws-1",
      taskId: "task-1",
    });
    assert.ok(encoded);
    assert.deepEqual(parseCampaignCallbackData(encoded), {
      kind: "campaign",
      campaignId: "camp-1",
      workspaceId: "ws-1",
      taskId: "task-1",
    });
  });

  it("does not regress delivery status", () => {
    assert.equal(
      shouldAdvanceWhatsAppDeliveryStatus({
        currentStatus: "delivered",
        incomingStatus: "sent",
      }),
      false,
    );
    assert.equal(
      shouldAdvanceWhatsAppDeliveryStatus({
        currentStatus: "sent",
        incomingStatus: "delivered",
      }),
      true,
    );
    assert.equal(
      shouldAdvanceWhatsAppDeliveryStatus({
        currentStatus: "read",
        incomingStatus: "played",
      }),
      true,
    );
    assert.equal(
      shouldAdvanceWhatsAppDeliveryStatus({
        currentStatus: "delivered",
        incomingStatus: "failed",
      }),
      false,
    );
    assert.equal(
      shouldAdvanceWhatsAppDeliveryStatus({
        currentStatus: "read",
        incomingStatus: "failed",
      }),
      false,
    );
    assert.equal(
      shouldAdvanceWhatsAppDeliveryStatus({
        currentStatus: "failed",
        incomingStatus: "read",
      }),
      false,
    );
    assert.equal(
      shouldAdvanceWhatsAppDeliveryStatus({
        currentStatus: "sent",
        incomingStatus: "failed",
      }),
      true,
    );
  });

  it("maps Meta pricing categories to KZ rate card", () => {
    assert.equal(
      resolveWhatsAppMessageRateUsd("marketing"),
      WHATSAPP_MESSAGE_RATES_USD.marketing,
    );
    assert.equal(
      resolveWhatsAppMessageRateUsd("marketing_lite"),
      WHATSAPP_MESSAGE_RATES_USD.marketing,
    );
    assert.equal(resolveWhatsAppMessageRateUsd("utility"), 0.018);
    assert.equal(resolveWhatsAppMessageRateUsd("authentication"), 0.025);
    assert.equal(
      isWhatsAppPricingBillable({
        pricingType: "free_customer_service",
        pricingBillable: true,
      }),
      false,
    );
    assert.equal(
      isWhatsAppPricingBillable({
        pricingType: "regular",
        pricingBillable: false,
      }),
      true,
    );
  });
});
