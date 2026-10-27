import {
  getDefaultChannelEnvelopeLine,
  resolveChannelContextForPrompt,
} from "@/lib/airi/reply/prompting/channel-prompt";

const NEVER_ASK_FOR_PHONE = /Never ask for the customer's phone number/;

describe("WhatsApp channel prompt", () => {
  it("tells the main reply never to ask for the phone number", () => {
    expect(getDefaultChannelEnvelopeLine("whatsapp")).toMatch(
      NEVER_ASK_FOR_PHONE
    );
  });

  // 2026-10-15: a workspace's "До 200 символов" instruction replaced the
  // default line, so a saved "send us your number" answer was repeated.
  it("keeps the rule when the workspace has its own WhatsApp instruction", () => {
    const line = resolveChannelContextForPrompt("whatsapp", {
      whatsapp: "До 200 символов",
    });

    expect(line).toContain("До 200 символов");
    expect(line).toMatch(NEVER_ASK_FOR_PHONE);
  });

  it("keeps the rule in the default recovery line", () => {
    expect(resolveChannelContextForPrompt("whatsapp")).toMatch(
      NEVER_ASK_FOR_PHONE
    );
  });

  it("leaves other channels free to ask for contact details", () => {
    expect(
      resolveChannelContextForPrompt("web_widget", {
        webWidget: "Ask for an email before handoff",
      })
    ).toBe("Ask for an email before handoff");
    expect(getDefaultChannelEnvelopeLine("web_widget")).not.toMatch(
      NEVER_ASK_FOR_PHONE
    );
    expect(getDefaultChannelEnvelopeLine("telegram")).not.toMatch(
      NEVER_ASK_FOR_PHONE
    );
  });
});
