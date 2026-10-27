import { isScenarioTimeoutMessageId } from "@/lib/airi/reply/runtime/scenario-followup-handoff";

describe("scenario timeout message ids", () => {
  it("detects synthetic scenario timeout message ids", () => {
    expect(
      isScenarioTimeoutMessageId(
        "scenario-timeout:post_action_no_reply_timeout:scenario-1:2026-05-01T00:00:00.000Z"
      )
    ).toBe(true);
    expect(
      isScenarioTimeoutMessageId(
        "scenario-timeout:no_human_reply_timeout:scenario-1:2026-05-01T00:00:00.000Z"
      )
    ).toBe(true);
    expect(isScenarioTimeoutMessageId("686e1d1886d736854c12a250")).toBe(false);
  });
});
