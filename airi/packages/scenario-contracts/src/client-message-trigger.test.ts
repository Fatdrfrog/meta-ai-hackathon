import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createClientMessageTriggerData,
  normalizeClientMessageTriggerConfig,
} from "./client-message-trigger.ts";

describe("normalizeClientMessageTriggerConfig", () => {
  it("preserves incomplete business event drafts without turning them into message entries", () => {
    const businessEvent = {
      integrationId: "forte-market",
      integrationName: "Forte Market",
      eventId: "order.status_changed",
      eventName: "Order status changed",
      filters: [{ field: "status", operator: "equals", value: "" }],
    };
    const normalized = normalizeClientMessageTriggerConfig({
      entryPointType: "business_event",
      businessEvent,
    });
    assert.equal(normalized.entryPointType, "business_event");
    assert.deepEqual(normalized.businessEvent, businessEvent);
    assert.notStrictEqual(normalized.businessEvent, businessEvent);
    assert.notStrictEqual(
      normalized.businessEvent?.filters,
      businessEvent.filters,
    );
    assert.equal(
      normalizeClientMessageTriggerConfig({ entryPointType: "business_event" })
        .entryPointType,
      "business_event",
    );
    assert.equal(
      normalizeClientMessageTriggerConfig({
        entryPointType: "message",
        businessEvent,
      }).businessEvent,
      undefined,
    );
  });
  it("returns canonical defaults for absent or invalid values", () => {
    assert.deepEqual(normalizeClientMessageTriggerConfig(null), {
      enabled: true,
      messageMatchMode: "any",
      keywordMatchMode: "contains",
    });
    assert.deepEqual(
      normalizeClientMessageTriggerConfig({
        enabled: undefined,
        messageMatchMode: undefined,
        keywordMatchMode: undefined,
      }),
      {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
      },
    );
  });

  it("allowlists fields and normalizes string arrays", () => {
    assert.deepEqual(
      normalizeClientMessageTriggerConfig({
        enabled: false,
        messageMatchMode: "contains",
        channelFilter: [" whatsapp ", "telegram", "whatsapp", "", 42],
        keywordPattern: "  keep this spacing  ",
        keywordMatchMode: "regex",
        whatsappReferralSourceTypes: [" ad ", "ad"],
        whatsappReferralSourcePlatforms: [" instagram "],
        metaReferralSourceIds: [" source-1 "],
        metaReferralCampaignIds: [" campaign-1 "],
        metaReferralAdSetIds: [" adset-1 "],
        onlyNewCustomers: true,
        retiredField: "remove me",
      }),
      {
        enabled: false,
        messageMatchMode: "contains",
        keywordMatchMode: "regex",
        channelFilter: ["whatsapp", "telegram"],
        keywordPattern: "  keep this spacing  ",
        whatsappReferralSourceTypes: ["ad"],
        whatsappReferralSourcePlatforms: ["instagram"],
        metaReferralSourceIds: ["source-1"],
        metaReferralCampaignIds: ["campaign-1"],
        metaReferralAdSetIds: ["adset-1"],
        onlyNewCustomers: true,
      },
    );
  });

  it("omits blank strings and empty normalized arrays", () => {
    assert.deepEqual(
      normalizeClientMessageTriggerConfig({
        channelFilter: [" ", 1],
        keywordPattern: " \n ",
      }),
      {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
      },
    );
  });

  it("keeps the WhatsApp QR entry-point type while preserving absent legacy message triggers", () => {
    assert.deepEqual(normalizeClientMessageTriggerConfig({}), {
      enabled: true,
      messageMatchMode: "any",
      keywordMatchMode: "contains",
    });
    assert.deepEqual(
      normalizeClientMessageTriggerConfig({ entryPointType: "whatsapp_qr" }),
      {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
        entryPointType: "whatsapp_qr",
      },
    );
    assert.deepEqual(
      normalizeClientMessageTriggerConfig({ entryPointType: "unknown" }),
      {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
      },
    );
    assert.deepEqual(
      normalizeClientMessageTriggerConfig({ entryPointType: "message" }),
      {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
        entryPointType: "message",
      },
    );
  });

  it("retains a bounded canonical pointer only for WhatsApp QR entry points", () => {
    assert.deepEqual(
      normalizeClientMessageTriggerConfig({
        entryPointType: "whatsapp_qr",
        entryPointId: " entry-1 ",
      }),
      {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
        entryPointType: "whatsapp_qr",
        entryPointId: "entry-1",
      },
    );
    assert.equal(
      normalizeClientMessageTriggerConfig({
        entryPointType: "message",
        entryPointId: "entry-1",
      }).entryPointId,
      undefined,
    );
    assert.equal(
      normalizeClientMessageTriggerConfig({
        entryPointType: "whatsapp_qr",
        entryPointId: "x".repeat(257),
      }).entryPointId,
      undefined,
    );
  });

  it("keeps an ad account selection before any campaign label is chosen", () => {
    assert.deepEqual(
      normalizeClientMessageTriggerConfig({
        metaCampaignAdAccountId: "act_42",
        metaCampaignLabels: undefined,
      }),
      {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
        metaCampaignAdAccountId: "act_42",
      },
    );
  });

  it("returns fresh objects and arrays without mutating input", () => {
    const input = {
      channelFilter: [" whatsapp "],
      metaReferralSourceIds: [" source-1 "],
    };

    const first = normalizeClientMessageTriggerConfig(input);
    const second = normalizeClientMessageTriggerConfig(input);

    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.channelFilter, input.channelFilter);
    assert.notStrictEqual(first.channelFilter, second.channelFilter);
    assert.notStrictEqual(
      first.metaReferralSourceIds,
      second.metaReferralSourceIds,
    );
    first.channelFilter?.push("telegram");
    assert.deepEqual(input, {
      channelFilter: [" whatsapp "],
      metaReferralSourceIds: [" source-1 "],
    });
    assert.deepEqual(second.channelFilter, ["whatsapp"]);
  });
});

describe("createClientMessageTriggerData", () => {
  it("creates canonical trigger data without allowing undefined to erase defaults", () => {
    assert.deepEqual(
      createClientMessageTriggerData({
        source: "manual",
        triggerConfig: {
          enabled: undefined,
          messageMatchMode: undefined,
          keywordMatchMode: undefined,
          channelFilter: [" whatsapp "],
        },
      }),
      {
        kind: "trigger",
        source: "manual",
        triggerConfig: {
          enabled: true,
          messageMatchMode: "any",
          keywordMatchMode: "contains",
          channelFilter: ["whatsapp"],
        },
      },
    );
  });

  it("does not share mutable state between factory calls", () => {
    const first = createClientMessageTriggerData({
      triggerConfig: { channelFilter: ["whatsapp"] },
    });
    const second = createClientMessageTriggerData({
      triggerConfig: { channelFilter: ["whatsapp"] },
    });

    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.triggerConfig, second.triggerConfig);
    assert.notStrictEqual(
      first.triggerConfig?.channelFilter,
      second.triggerConfig?.channelFilter,
    );
    first.triggerConfig?.channelFilter?.push("telegram");
    assert.deepEqual(second.triggerConfig?.channelFilter, ["whatsapp"]);
  });

  it("does not leak a raw compatibility trigger type into canonical data", () => {
    const raw = {
      triggerType: "customer_message_contains",
      triggerConfig: { keywordPattern: "refund" },
    } as unknown as Parameters<typeof createClientMessageTriggerData>[0];

    assert.deepEqual(createClientMessageTriggerData(raw), {
      kind: "trigger",
      triggerConfig: {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
        keywordPattern: "refund",
      },
    });
  });

  it("creates canonical WhatsApp QR trigger data without changing its trigger kind", () => {
    assert.deepEqual(
      createClientMessageTriggerData({
        triggerConfig: { entryPointType: "whatsapp_qr" },
      }),
      {
        kind: "trigger",
        triggerConfig: {
          enabled: true,
          messageMatchMode: "any",
          keywordMatchMode: "contains",
          entryPointType: "whatsapp_qr",
        },
      },
    );
  });
});
