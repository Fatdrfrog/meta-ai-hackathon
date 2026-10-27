import { isReplyComposerDisabled } from "./window-status-utils";

describe("isReplyComposerDisabled", () => {
  it("keeps resolved conversations disabled", () => {
    expect(
      isReplyComposerDisabled({
        isConversationResolved: true,
        channel: "instagram",
        requiresWindowCheck: true,
        isWithinWindow: true,
        humanAgent: { supported: true, enabled: true },
      })
    ).toBe(true);
  });

  it("does not disable channels that do not require a Meta window check", () => {
    expect(
      isReplyComposerDisabled({
        isConversationResolved: false,
        channel: "telegram",
        requiresWindowCheck: false,
      })
    ).toBe(false);
  });

  it("keeps the composer enabled while the window status is unknown", () => {
    expect(
      isReplyComposerDisabled({
        isConversationResolved: false,
        channel: "instagram",
        requiresWindowCheck: true,
      })
    ).toBe(false);
  });

  it("disables WhatsApp replies when the 24-hour window is expired", () => {
    expect(
      isReplyComposerDisabled({
        isConversationResolved: false,
        channel: "whatsapp",
        requiresWindowCheck: true,
        isWithinWindow: false,
      })
    ).toBe(true);
  });

  it("disables Instagram DM replies when Human Agent is unavailable", () => {
    expect(
      isReplyComposerDisabled({
        isConversationResolved: false,
        channel: "instagram",
        requiresWindowCheck: true,
        isWithinWindow: false,
        humanAgent: {
          supported: true,
          enabled: false,
          reason: "human_agent_not_approved",
        },
      })
    ).toBe(true);
  });

  it("keeps expired Instagram DM replies enabled when Human Agent is available", () => {
    expect(
      isReplyComposerDisabled({
        isConversationResolved: false,
        channel: "instagram",
        requiresWindowCheck: true,
        isWithinWindow: false,
        humanAgent: { supported: true, enabled: true },
      })
    ).toBe(false);
  });

  it("disables the composer when the messaging account cannot send", () => {
    expect(
      isReplyComposerDisabled({
        isConversationResolved: false,
        channel: "whatsapp",
        requiresWindowCheck: true,
        isWithinWindow: true,
        accountCannotSend: true,
      })
    ).toBe(true);
  });
});
