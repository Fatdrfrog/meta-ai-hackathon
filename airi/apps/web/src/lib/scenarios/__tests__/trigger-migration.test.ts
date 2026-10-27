import { migrateLegacyTriggerNodeData } from "@/lib/scenarios/legacy-trigger-adapter";

const DEFAULT_TRIGGER_CONFIG = {
  enabled: true,
  messageMatchMode: "any",
  keywordMatchMode: "contains",
} as const;

describe("migrateLegacyTriggerNodeData", () => {
  it.each([
    ["exact_incoming_message", "exact"],
    ["customer_message_contains", "contains"],
    ["channel_is", "any"],
  ] as const)("migrates %s roots", (triggerType, messageMatchMode) => {
    expect(
      migrateLegacyTriggerNodeData({
        kind: "trigger",
        triggerType,
        triggerConfig: {
          enabled: true,
          channelFilter: [" whatsapp ", "whatsapp"],
          keywordPattern: "  refund  ",
        },
      }),
    ).toEqual({
      kind: "trigger",
      triggerConfig: {
        enabled: true,
        messageMatchMode,
        keywordMatchMode: "contains",
        channelFilter: ["whatsapp"],
        keywordPattern: "  refund  ",
      },
    });
  });

  it("migrates Telegram quick-reply roots to Telegram client messages", () => {
    expect(
      migrateLegacyTriggerNodeData({
        kind: "trigger",
        triggerType: "telegram_quick_reply",
        triggerConfig: {
          channelFilter: [" whatsapp ", "telegram"],
        },
      }),
    ).toEqual({
      kind: "trigger",
      triggerConfig: {
        ...DEFAULT_TRIGGER_CONFIG,
        channelFilter: ["whatsapp", "telegram"],
      },
    });
  });

  it.each([
    "payment_detected",
    "no_human_reply_timeout",
    "user_replied_after_parent_action",
    "customer_intent_or_classification",
    "business_hours_window",
    "user_inactive_for_period",
    "funnel_stage_changed",
    "checkout_incomplete",
  ])("fails closed for retired %s roots", triggerType => {
    expect(
      migrateLegacyTriggerNodeData({
        kind: "trigger",
        triggerType,
        triggerConfig: { enabled: true },
      }),
    ).toEqual({
      kind: "trigger",
      triggerConfig: {
        ...DEFAULT_TRIGGER_CONFIG,
        enabled: false,
      },
    });
  });

  it("fails closed for unknown roots", () => {
    expect(
      migrateLegacyTriggerNodeData({
        kind: "trigger",
        triggerType: "future_unknown_trigger",
        triggerConfig: { enabled: true },
      }),
    ).toEqual({
      kind: "trigger",
      triggerConfig: {
        ...DEFAULT_TRIGGER_CONFIG,
        enabled: false,
      },
    });
  });

  it("fails closed for an automation-source root with no type", () => {
    expect(
      migrateLegacyTriggerNodeData({
        kind: "trigger",
        source: " Automation ",
        triggerConfig: { enabled: true },
      }),
    ).toEqual({
      kind: "trigger",
      source: " Automation ",
      triggerConfig: {
        ...DEFAULT_TRIGGER_CONFIG,
        enabled: false,
      },
    });
  });

  it("preserves the stored/default eligibility for ordinary roots with no type", () => {
    expect(
      migrateLegacyTriggerNodeData({
        kind: "trigger",
        source: "manual",
        triggerConfig: { enabled: false },
      }),
    ).toEqual({
      kind: "trigger",
      source: "manual",
      triggerConfig: {
        ...DEFAULT_TRIGGER_CONFIG,
        enabled: false,
      },
    });
    expect(
      migrateLegacyTriggerNodeData({
        kind: "trigger",
        source: "manual",
      }),
    ).toEqual({
      kind: "trigger",
      source: "manual",
      triggerConfig: DEFAULT_TRIGGER_CONFIG,
    });
  });

  it("preserves linked-condition child eligibility independently of retired type", () => {
    expect(
      migrateLegacyTriggerNodeData({
        kind: "trigger",
        linkedConditionId: "condition-1",
        triggerType: "no_human_reply_timeout",
        triggerConfig: {
          enabled: true,
          timeoutMinutes: 45,
        },
      }),
    ).toEqual({
      kind: "trigger",
      linkedConditionId: "condition-1",
      triggerConfig: DEFAULT_TRIGGER_CONFIG,
    });
  });

  it("strips arbitrary and retired trigger config fields", () => {
    expect(
      migrateLegacyTriggerNodeData({
        kind: "trigger",
        triggerType: "payment_detected",
        triggerConfig: {
          enabled: true,
          channelFilter: ["whatsapp"],
          paymentDetection: { phrases: ["paid"] },
          timeoutMinutes: 45,
          arbitrary: { nested: true },
        },
      }),
    ).toEqual({
      kind: "trigger",
      triggerConfig: {
        ...DEFAULT_TRIGGER_CONFIG,
        enabled: false,
        channelFilter: ["whatsapp"],
      },
    });
  });

  it("is idempotent", () => {
    const once = migrateLegacyTriggerNodeData({
      kind: "trigger",
      triggerType: "telegram_quick_reply",
      triggerConfig: {
        channelFilter: [" whatsapp "],
        metaReferralSourceIds: [" source-1 "],
      },
    });

    expect(migrateLegacyTriggerNodeData(once)).toEqual(once);
  });

  it("returns fresh objects and arrays without mutating input", () => {
    const raw = {
      kind: "trigger",
      triggerType: "channel_is",
      triggerConfig: {
        channelFilter: [" whatsapp "],
        metaReferralSourceIds: [" source-1 "],
      },
    };

    const migrated = migrateLegacyTriggerNodeData(raw);

    expect(migrated).not.toBe(raw);
    expect(migrated.triggerConfig).not.toBe(raw.triggerConfig);
    expect(migrated.triggerConfig?.channelFilter).not.toBe(
      raw.triggerConfig.channelFilter,
    );
    expect(migrated.triggerConfig?.metaReferralSourceIds).not.toBe(
      raw.triggerConfig.metaReferralSourceIds,
    );
    migrated.triggerConfig?.channelFilter?.push("telegram");
    expect(raw).toEqual({
      kind: "trigger",
      triggerType: "channel_is",
      triggerConfig: {
        channelFilter: [" whatsapp "],
        metaReferralSourceIds: [" source-1 "],
      },
    });
  });
});
