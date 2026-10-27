import {
  normalizeScenarioTriggerConfig,
  resolveScenarioTrigger,
} from "../trigger-utils";
import { isScenarioInteractiveReplyEventKind, isScenarioMessageIngressEventKind, isScenarioQuickReplyEventKind } from "@icecore/scenario-contracts";

describe("scenario trigger compatibility boundary", () => {
  it("preserves message matcher configuration through an Any round trip", () => {
    const configuredMatcher = {
      enabled: true,
      keywordPattern: "refund\\s+request",
      keywordMatchMode: "regex" as const,
    };
    const anyConfig = normalizeScenarioTriggerConfig({
      nodeData: {
        kind: "trigger",
        triggerConfig: {
          ...configuredMatcher,
          messageMatchMode: "any",
        },
      },
    });
    const restoredConfig = normalizeScenarioTriggerConfig({
      nodeData: {
        kind: "trigger",
        triggerConfig: {
          ...anyConfig,
          messageMatchMode: "contains",
        },
      },
    });

    expect(anyConfig).toEqual(expect.objectContaining(configuredMatcher));
    expect(restoredConfig).toEqual(expect.objectContaining(configuredMatcher));
  });

  it("re-exports the contract-owned ingress and interactive event guards", () => {
    expect(isScenarioMessageIngressEventKind("inbound_message")).toBe(true);
    expect(isScenarioMessageIngressEventKind("payment_detected")).toBe(false);
    expect(isScenarioInteractiveReplyEventKind("whatsapp_flow_reply")).toBe(
      true
    );
    expect(isScenarioQuickReplyEventKind("whatsapp_flow_reply")).toBe(false);
  });

  it.each([
    "payment_detected",
    "customer_intent_or_classification",
    "business_hours_window",
    "user_inactive_for_period",
    "funnel_stage_changed",
    "checkout_incomplete",
    "no_human_reply_timeout",
  ])(
    "collapses an unlinked legacy %s trigger to a client message",
    legacyType => {
      const resolved = resolveScenarioTrigger({
        kind: "trigger",
        triggerType: legacyType as never,
        triggerConfig: {
          enabled: true,
          channelFilter: ["whatsapp"],
          keywordPattern: "keep me",
          keywordMatchMode: "contains",
          paymentDetection: {
            phrases: ["paid"],
            analyzePaymentImages: true,
          },
          classificationCategories: ["sales"],
          intentSignals: ["price_inquiry"],
          internalLabels: ["vip"],
          stopIfInternalLabels: ["paid"],
          stopIfFunnelStages: ["customer"],
          stopIfHasPurchaseHistory: true,
          businessHoursTimezone: "Asia/Almaty",
          businessHoursDays: [1, 2, 3],
          businessHoursStartMinute: 540,
          businessHoursEndMinute: 1080,
          inactivityPeriodDays: 14,
          targetFunnelStages: ["qualified"],
        } as never,
      });

      expect(resolved).toEqual(
        expect.objectContaining({
          enabled: false,
          channelFilter: ["whatsapp"],
          keywordPattern: "keep me",
          keywordMatchMode: "contains",
        })
      );
      expect(resolved).not.toHaveProperty("paymentDetection");
      expect(resolved).not.toHaveProperty("classificationCategories");
      expect(resolved).not.toHaveProperty("intentSignals");
      expect(resolved).not.toHaveProperty("internalLabels");
      expect(resolved).not.toHaveProperty("stopIfInternalLabels");
      expect(resolved).not.toHaveProperty("stopIfFunnelStages");
      expect(resolved).not.toHaveProperty("stopIfHasPurchaseHistory");
      expect(resolved).not.toHaveProperty("businessHoursTimezone");
      expect(resolved).not.toHaveProperty("businessHoursDays");
      expect(resolved).not.toHaveProperty("businessHoursStartMinute");
      expect(resolved).not.toHaveProperty("businessHoursEndMinute");
      expect(resolved).not.toHaveProperty("inactivityPeriodDays");
      expect(resolved).not.toHaveProperty("targetFunnelStages");
    }
  );

  it("decouples linked no-reply conditions from the child trigger type", () => {
    expect(
      resolveScenarioTrigger({
        kind: "trigger",
        linkedConditionId: "linked-condition-1",
        triggerType: "no_human_reply_timeout" as never,
        triggerConfig: {
          enabled: true,
          timeoutMinutes: 45,
          missingTextPhrases: ["stop"],
        } as never,
      })
    ).toEqual(
      expect.objectContaining({
        enabled: true,
      })
    );
  });

  it.each([
    ["exact_incoming_message", "exact"],
    ["customer_message_contains", "contains"],
    ["channel_is", "any"],
  ] as const)(
    "migrates legacy %s behavior into client-message configuration",
    (legacyType, messageMatchMode) => {
      expect(
        resolveScenarioTrigger({
          kind: "trigger",
          triggerType: legacyType as never,
          triggerConfig: {
            enabled: true,
            channelFilter: ["whatsapp"],
            keywordPattern: "refund",
          },
        })
      ).toEqual(
        expect.objectContaining({
          enabled: true,
          channelFilter: ["whatsapp"],
          keywordPattern: "refund",
          messageMatchMode,
        })
      );
    }
  );
});
