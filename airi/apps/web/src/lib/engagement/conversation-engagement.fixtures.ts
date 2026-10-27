/** Mixed history and result captured from the pre-incremental calculator. */
export function buildLegacyEngagementFixture() {
  return Array.from({ length: 64 }, (_, i) => ({
    direction: i % 3 === 0 ? "outbound" : "inbound",
    date: new Date(Date.UTC(2026, 8, 1) + ((i * 17) % 64) * 10137),
    text: i % 5 === 0 ? "Price?" : "Hello",
    mediaType: i % 7 === 0 ? "audio" : i % 11 === 0 ? "image" : null,
    reactions: i % 13 === 0 ? [{}, {}] : [],
    whatsappFlowReply: i % 9 === 0 ? { body: "response" } : null,
    whatsappTemplate: i % 4 === 0 ? { name: "template" } : null,
    origin: i % 6 === 0 ? { kind: "campaign" } : null,
    delivery: {
      status: i % 8 === 0 ? "played" : i % 4 === 0 ? "delivered" : "sent",
    },
  }));
}

export const LEGACY_ENGAGEMENT_METRICS = {
  version: 1,
  computedAt: new Date("2026-09-01T00:00:00Z"),
  messageCount: 64,
  inboundCount: 42,
  outboundCount: 22,
  customerQuestionCount: 8,
  firstMessageAt: new Date("2026-09-01T00:00:00Z"),
  lastMessageAt: new Date("2026-09-01T00:10:38.631Z"),
  activeDurationMinutes: 10.6,
  hasTwoWayConversation: true,
  turnSwitchCount: 10,
  customerRepliesAfterOutbound: 5,
  firstCustomerReplyDelayMinutes: 0.2,
  avgCustomerReplyDelayMinutes: 0.2,
  inboundMediaCount: 10,
  inboundVoiceCount: 6,
  flowSubmitCount: 0,
  reactionCount: 10,
  templateOutboundCount: 6,
  campaignReplyCount: 3,
  deliveredCount: 6,
  readCount: 3,
  score: 83.2,
  scoreParts: {
    depth: 100,
    reciprocity: 100,
    intent: 65,
    richness: 100,
    delivery: 19.1,
  },
};
