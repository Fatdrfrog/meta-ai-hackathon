import { shouldAllowEmptyAutoReplyInput } from "@/lib/airi/reply/runtime/auto-reply-input";

describe("auto reply input guard", () => {
  it("allows empty input for no-human-reply timeout triggers", () => {
    expect(shouldAllowEmptyAutoReplyInput("no_human_reply_timeout")).toBe(true);
  });

  it("does not allow empty input for regular inbound triggers", () => {
    expect(shouldAllowEmptyAutoReplyInput("inbound_message")).toBe(false);
    expect(shouldAllowEmptyAutoReplyInput("whatsapp_flow_reply")).toBe(false);
    expect(shouldAllowEmptyAutoReplyInput(undefined)).toBe(false);
  });
});
