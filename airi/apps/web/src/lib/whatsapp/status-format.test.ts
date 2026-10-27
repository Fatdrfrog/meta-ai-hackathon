import { getWhatsAppMetaRefreshFeedback } from "./status-format";

describe("Meta status refresh feedback", () => {
  it.each(["fresh", "minimum_interval", "in_progress"] as const)(
    "keeps %s refreshes informational when cached status is returned",
    outcome => {
      expect(getWhatsAppMetaRefreshFeedback(outcome)).toEqual({
        level: "info",
        messageKey: "accountHealthCheckDeferred",
      });
    }
  );

  it.each(["cooldown", "rate_limited"] as const)(
    "warns about %s without reporting a failed status check",
    outcome => {
      expect(getWhatsAppMetaRefreshFeedback(outcome)).toEqual({
        level: "warning",
        messageKey: "accountHealthCheckRateLimited",
      });
    }
  );

  it.each(["failed", "not_configured"] as const)(
    "keeps %s separate from controlled refresh deferrals",
    outcome => {
      expect(getWhatsAppMetaRefreshFeedback(outcome)).toEqual({
        level: "error",
        messageKey: "accountHealthCheckFailed",
      });
    }
  );

  it.each([undefined, "succeeded"] as const)(
    "preserves successful feedback for %s refresh metadata",
    outcome => {
      expect(getWhatsAppMetaRefreshFeedback(outcome)).toEqual({
        level: "success",
        messageKey: "accountHealthCheckSuccess",
      });
    }
  );
});
