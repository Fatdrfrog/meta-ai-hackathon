import {
  isActiveBulkCampaignDispatchStatus,
  isTerminalBulkCampaignDispatchStatus,
} from "./campaign-operations-contracts";

describe("bulk campaign dispatch status helpers", () => {
  it("splits every lifecycle state into active or terminal", () => {
    const active = ["queued", "scheduled", "running"] as const;
    const terminal = ["completed", "failed", "expired", "cancelled"] as const;

    for (const status of active) {
      expect(isActiveBulkCampaignDispatchStatus(status)).toBe(true);
      expect(isTerminalBulkCampaignDispatchStatus(status)).toBe(false);
    }
    for (const status of terminal) {
      expect(isActiveBulkCampaignDispatchStatus(status)).toBe(false);
      expect(isTerminalBulkCampaignDispatchStatus(status)).toBe(true);
    }
  });

  it("treats a missing status as neither active nor terminal", () => {
    for (const status of [null, undefined]) {
      expect(isActiveBulkCampaignDispatchStatus(status)).toBe(false);
      expect(isTerminalBulkCampaignDispatchStatus(status)).toBe(false);
    }
  });
});
