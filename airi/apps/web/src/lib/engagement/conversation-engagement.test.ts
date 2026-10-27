import {
  ENGAGEMENT_MESSAGE_SELECT,
  computeConversationEngagementMetrics,
} from "./conversation-engagement";

import {
  buildLegacyEngagementFixture,
  LEGACY_ENGAGEMENT_METRICS,
} from "./conversation-engagement.fixtures";

describe("conversation engagement", () => {
  it("preserves the frozen legacy calculator result for mixed, out-of-order history", () => {
    expect(
      computeConversationEngagementMetrics(
        buildLegacyEngagementFixture(),
        LEGACY_ENGAGEMENT_METRICS.computedAt
      )
    ).toEqual(LEGACY_ENGAGEMENT_METRICS);
  });
  it("projects canonical service-message previews", () => {
    expect(ENGAGEMENT_MESSAGE_SELECT.split(/\s+/)).toEqual(
      expect.arrayContaining(["whatsappServiceMessage"])
    );
  });

  it("uses canonical service-message body and labels as structured message text", () => {
    const metrics = computeConversationEngagementMetrics([
      {
        direction: "inbound",
        date: "2026-07-29T10:00:00.000Z",
        text: "",
        whatsappServiceMessage: {
          version: 1,
          kind: "reply_buttons",
          command: {
            kind: "reply_buttons",
            body: "Which plan do you need?",
            options: [{ id: "premium", label: "Premium" }],
          },
        },
      },
    ]);

    expect(metrics.customerQuestionCount).toBe(1);
  });

  it("counts actual template sends without treating service campaigns or stale template metadata as templates", () => {
    const campaignServiceMetrics = computeConversationEngagementMetrics([
      {
        direction: "outbound",
        date: "2026-07-29T10:00:00.000Z",
        text: "Campaign service text",
        origin: { kind: "campaign", campaignId: "service-bulk" },
      },
    ]);
    const templateMetrics = computeConversationEngagementMetrics([
      {
        direction: "outbound",
        date: "2026-07-29T10:00:00.000Z",
        text: "Template",
        whatsappTemplate: { name: "real_template" },
      },
    ]);
    const canonicalMetrics = computeConversationEngagementMetrics([
      {
        direction: "outbound",
        date: "2026-07-29T10:00:00.000Z",
        text: "Canonical service",
        whatsappServiceMessage: {
          version: 1,
          kind: "text",
          command: { kind: "text", body: "Canonical service" },
        },
        whatsappTemplate: { name: "stale_template" },
      },
    ]);

    expect(campaignServiceMetrics.templateOutboundCount).toBe(0);
    expect(templateMetrics.templateOutboundCount).toBe(1);
    expect(canonicalMetrics.templateOutboundCount).toBe(0);
  });
});
