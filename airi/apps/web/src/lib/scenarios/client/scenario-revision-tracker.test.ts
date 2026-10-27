import {
  hasScenarioWriteSince,
  isBehindConfirmedScenarioRevision,
  noteConfirmedScenarioRevision,
  readSettledScenarioWriteEpoch,
  trackScenarioWrite,
} from "./scenario-revision-tracker";

describe("scenario revision tracker", () => {
  it("remembers the newest confirmed revision per scenario", () => {
    expect(
      isBehindConfirmedScenarioRevision("s-1", "2026-01-01T00:00:00Z")
    ).toBe(false);
    noteConfirmedScenarioRevision("s-1", "2026-01-02T00:00:00.000Z");
    noteConfirmedScenarioRevision("s-1", "2026-01-01T12:00:00.000Z");
    noteConfirmedScenarioRevision(null, "2026-01-05T00:00:00.000Z");
    noteConfirmedScenarioRevision("s-1", "not a date");

    expect(
      isBehindConfirmedScenarioRevision("s-1", "2026-01-01T23:59:59.000Z")
    ).toBe(true);
    expect(
      isBehindConfirmedScenarioRevision("s-1", "2026-01-02T00:00:00.000Z")
    ).toBe(false);
    expect(isBehindConfirmedScenarioRevision("s-1", null)).toBe(true);
    expect(
      isBehindConfirmedScenarioRevision("s-2", "2020-01-01T00:00:00.000Z")
    ).toBe(false);
  });

  it("has no settled epoch while a write runs, and a new one after it", async () => {
    const before = readSettledScenarioWriteEpoch();
    expect(before).not.toBeNull();
    let finish!: (value: string) => void;
    const write = trackScenarioWrite(
      new Promise<string>(resolve => {
        finish = resolve;
      })
    );
    expect(readSettledScenarioWriteEpoch()).toBeNull();
    finish("done");
    await expect(write).resolves.toBe("done");
    const after = readSettledScenarioWriteEpoch();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("reports a write running, or settled at or after a time", async () => {
    jest.useFakeTimers({ now: new Date("2021-06-01T00:00:00.000Z") });
    try {
      const start = Date.now();
      let finish!: () => void;
      const write = trackScenarioWrite(
        new Promise<void>(resolve => {
          finish = resolve;
        })
      );
      expect(hasScenarioWriteSince(start + 60_000)).toBe(true);

      jest.setSystemTime(start + 5000);
      finish();
      await write;
      expect(hasScenarioWriteSince(start + 5000)).toBe(true);
      expect(hasScenarioWriteSince(start + 5001)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("settles a failed write too", async () => {
    await expect(
      trackScenarioWrite(Promise.reject(new Error("offline")))
    ).rejects.toThrow("offline");
    expect(readSettledScenarioWriteEpoch()).not.toBeNull();
  });
});
