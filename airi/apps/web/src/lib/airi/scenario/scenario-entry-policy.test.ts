import {
  evaluateScenarioEntryPolicy,
  resolveScenarioEntryPolicy,
} from "./scenario-entry-policy";

describe("resolveScenarioEntryPolicy", () => {
  it.each([
    {
      label: "repeatable",
      raw: { entryPolicy: "repeatable", loopScenario: false },
      expected: "repeatable",
    },
    {
      label: "once per conversation",
      raw: { entryPolicy: "once_per_conversation", loopScenario: true },
      expected: "once_per_conversation",
    },
  ])("prefers a valid $label policy over the legacy loop flag", ({ raw, expected }) => {
    expect(resolveScenarioEntryPolicy(raw)).toBe(expected);
  });

  it("maps a legacy loop-only scenario to repeatable", () => {
    expect(resolveScenarioEntryPolicy({ loopScenario: true })).toBe(
      "repeatable"
    );
  });

  it.each([
    { label: "missing", raw: {} },
    { label: "invalid", raw: { entryPolicy: "future_policy", loopScenario: true } },
    {
      label: "present but undefined",
      raw: { entryPolicy: undefined, loopScenario: true },
    },
  ])("defaults a $label policy to once per conversation", ({ raw }) => {
    expect(resolveScenarioEntryPolicy(raw)).toBe("once_per_conversation");
  });
});

describe("evaluateScenarioEntryPolicy", () => {
  const scenarioId = "scenario-1";

  it("keeps repeatable scenarios eligible after starts and completions", () => {
    expect(
      evaluateScenarioEntryPolicy({
        scenarioId,
        entryPolicy: "repeatable",
        state: {
          startedScenarios: [
            {
              scenarioId,
              startedAt: "2026-07-30T10:00:00.000Z",
            },
          ],
          completedScenarios: [
            {
              scenarioId,
              completedAt: "2026-07-30T10:05:00.000Z",
            },
          ],
        },
      })
    ).toEqual({ eligible: true });
  });

  it.each([
    {
      label: "started",
      state: {
        startedScenarios: [
          {
            scenarioId,
            startedAt: "2026-07-30T10:00:00.000Z",
          },
        ],
      },
    },
    {
      label: "completed",
      state: {
        completedScenarios: [
          {
            scenarioId,
            completedAt: "2026-07-30T10:05:00.000Z",
          },
        ],
      },
    },
  ])("blocks a once-per-conversation scenario after it has $label", ({ state }) => {
    expect(
      evaluateScenarioEntryPolicy({
        scenarioId,
        entryPolicy: "once_per_conversation",
        state,
      })
    ).toEqual({
      eligible: false,
      reason: "blocked_by_once_per_conversation",
    });
  });

  it("keeps the current locked scenario eligible for continuation", () => {
    expect(
      evaluateScenarioEntryPolicy({
        scenarioId,
        entryPolicy: "once_per_conversation",
        state: {
          lockedScenarioId: scenarioId,
          startedScenarios: [
            {
              scenarioId,
              startedAt: "2026-07-30T10:00:00.000Z",
            },
          ],
        },
        allowCurrentLockedScenario: true,
      })
    ).toEqual({ eligible: true });
  });
});
