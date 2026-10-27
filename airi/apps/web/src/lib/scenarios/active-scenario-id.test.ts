import { pickActiveScenarioId } from "./active-scenario-id";

const summaries = [{ _id: "first" }, { _id: "second" }, { _id: "third" }];

describe("pickActiveScenarioId", () => {
  it("opens the requested scenario when the workspace still has it", () => {
    expect(pickActiveScenarioId(summaries, "second")).toBe("second");
  });

  it.each([
    ["missing", "deleted-elsewhere"],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
  ])(
    "falls back to the first scenario when the request is %s",
    (_label, requested) => {
      expect(pickActiveScenarioId(summaries, requested)).toBe("first");
    }
  );

  it("opens nothing when the workspace has no scenarios", () => {
    expect(pickActiveScenarioId([], "second")).toBeNull();
    expect(pickActiveScenarioId([])).toBeNull();
  });
});
