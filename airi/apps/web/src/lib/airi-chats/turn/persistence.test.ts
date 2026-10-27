jest.mock("@/models/airi-chat-message", () => ({
  AIRI_CHAT_MESSAGE_CONTENT_MAX_LENGTH: 12000,
  AiriChatMessage: {},
}));
jest.mock("@/models/airi-chat-thread", () => ({ AiriChatThread: {} }));

import { isAiriChatCancelledReply } from "./persistence";

describe("isAiriChatCancelledReply", () => {
  it("is true only for a stopped reply, whatever the abort reason was", () => {
    expect(isAiriChatCancelledReply({ cancelled: true })).toBe(true);
    // A Meta Ads turn's own partial report when stopped.
    expect(
      isAiriChatCancelledReply({
        intent: "meta_ads_mcp",
        airiMetaAdsMcpCoverage: { complete: false, reasons: ["cancelled"] },
      })
    ).toBe(true);
    // A complete answer saved before a late Stop stays an answer.
    expect(isAiriChatCancelledReply({ intent: "general_answer" })).toBe(false);
    expect(
      isAiriChatCancelledReply({
        intent: "meta_ads_mcp",
        airiMetaAdsMcpCoverage: { complete: false, reasons: ["deadline"] },
      })
    ).toBe(false);
    expect(isAiriChatCancelledReply(null)).toBe(false);
  });
});
