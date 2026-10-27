import {
  isCatchAllCustomerMessageTriggerNodeData,
  resolveEffectiveScenarioMatchingRole,
  resolveEffectiveScenarioMatchingRoleForCriteria,
  resolveEffectiveScenarioMatchingRoleForTriggerNodes,
} from "../matching-role";
import { projectActiveClientMessageFilters } from "../client-message-trigger-criteria";

describe("scenario matching role helpers", () => {
  it("recognizes an unfiltered incoming customer trigger as catch-all", () => {
    expect(
      isCatchAllCustomerMessageTriggerNodeData({
        kind: "trigger",
        triggerConfig: { enabled: true },
      })
    ).toBe(true);
  });

  it("treats dormant Any matcher fields and onlyNewCustomers false as inert", () => {
    expect(
      isCatchAllCustomerMessageTriggerNodeData({
        kind: "trigger",
        triggerConfig: {
          enabled: true,
          messageMatchMode: "any",
          keywordPattern: "[",
          keywordMatchMode: "regex",
          onlyNewCustomers: false,
        },
      })
    ).toBe(true);
  });

  it.each([
    {
      messageMatchMode: "exact" as const,
      keywordPattern: " \n ",
    },
    {
      messageMatchMode: "contains" as const,
      keywordPattern: ", ;\r\n",
      keywordMatchMode: "contains" as const,
    },
    {
      messageMatchMode: "contains" as const,
      keywordPattern: "[",
      keywordMatchMode: "regex" as const,
    },
  ])("never treats an unmatchable selected matcher as catch-all", config => {
    expect(
      isCatchAllCustomerMessageTriggerNodeData({
        kind: "trigger",
        triggerConfig: {
          enabled: true,
          ...config,
        },
      })
    ).toBe(false);
  });

  it("rejects narrowed customer triggers as catch-all", () => {
    expect(
      isCatchAllCustomerMessageTriggerNodeData({
        kind: "trigger",
        triggerConfig: {
          enabled: true,
          messageMatchMode: "contains",
          keywordPattern: "medal",
        },
      })
    ).toBe(false);

    expect(
      isCatchAllCustomerMessageTriggerNodeData({
        kind: "trigger",
        triggerConfig: {
          enabled: true,
          keywordPattern: "medal",
        },
      })
    ).toBe(true);

    expect(
      isCatchAllCustomerMessageTriggerNodeData({
        kind: "trigger",
        triggerConfig: { enabled: true },
        audienceMode: "classification",
        classificationCategory: "sales",
      })
    ).toBe(true);

    expect(
      isCatchAllCustomerMessageTriggerNodeData({
        kind: "trigger",
        triggerConfig: {
          enabled: true,
          onlyNewCustomers: true,
        },
      })
    ).toBe(false);

    expect(
      isCatchAllCustomerMessageTriggerNodeData({
        kind: "trigger",
        triggerConfig: {
          enabled: true,
          metaReferralSourceIds: ["ig-ad-123"],
        },
      })
    ).toBe(false);
  });

  it("only keeps fallback role for valid catch-all triggers", () => {
    expect(
      resolveEffectiveScenarioMatchingRole({
        matchingRole: "fallback",
        triggerNodeData: {
          kind: "trigger",
          triggerConfig: { enabled: true },
        },
      })
    ).toBe("fallback");

    expect(
      resolveEffectiveScenarioMatchingRole({
        matchingRole: "fallback",
        triggerNodeData: {
          kind: "trigger",
          triggerConfig: {
            enabled: true,
            messageMatchMode: "contains",
            keywordPattern: "medal",
          },
        },
      })
    ).toBe("default");

    expect(
      resolveEffectiveScenarioMatchingRole({
        matchingRole: "default",
        triggerNodeData: {
          kind: "trigger",
          triggerConfig: { enabled: true },
        },
      })
    ).toBe("default");
  });

  it("only keeps fallback role for multi-trigger scenarios when every trigger is catch-all compatible", () => {
    expect(
      resolveEffectiveScenarioMatchingRoleForTriggerNodes({
        matchingRole: "fallback",
        triggerNodeData: [
          {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
          {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        ],
      })
    ).toBe("fallback");

    expect(
      resolveEffectiveScenarioMatchingRoleForTriggerNodes({
        matchingRole: "fallback",
        triggerNodeData: [
          {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
          {
            kind: "trigger",
            triggerConfig: {
              enabled: true,
              messageMatchMode: "contains",
              keywordPattern: "price",
            },
          },
        ],
      })
    ).toBe("default");
  });

  it("ignores disabled roots when classifying a multi-trigger fallback", () => {
    expect(
      resolveEffectiveScenarioMatchingRoleForTriggerNodes({
        matchingRole: "fallback",
        triggerNodeData: [
          {
            kind: "trigger",
            triggerConfig: {
              enabled: false,
              messageMatchMode: "exact",
              keywordPattern: "refund",
            },
          },
          {
            kind: "trigger",
            triggerConfig: {
              enabled: true,
              messageMatchMode: "any",
            },
          },
        ],
      })
    ).toBe("fallback");
  });

  it("requires at least one enabled root for a multi-trigger fallback", () => {
    expect(
      resolveEffectiveScenarioMatchingRoleForTriggerNodes({
        matchingRole: "fallback",
        triggerNodeData: [
          {
            kind: "trigger",
            triggerConfig: { enabled: false },
          },
        ],
      })
    ).toBe("default");
  });

  it("resolves fallback role from already projected criteria without re-reading node data", () => {
    expect(
      resolveEffectiveScenarioMatchingRoleForCriteria({
        matchingRole: "fallback",
        criteria: [
          projectActiveClientMessageFilters({
            enabled: false,
            messageMatchMode: "exact",
            keywordPattern: "refund",
          }),
          projectActiveClientMessageFilters({
            enabled: true,
            messageMatchMode: "any",
            keywordPattern: "[",
            keywordMatchMode: "regex",
          }),
        ],
      })
    ).toBe("fallback");

    expect(
      resolveEffectiveScenarioMatchingRoleForCriteria({
        matchingRole: "fallback",
        criteria: [
          projectActiveClientMessageFilters({
            enabled: true,
            messageMatchMode: "exact",
            keywordPattern: "refund",
          }),
        ],
      })
    ).toBe("default");
  });
});
