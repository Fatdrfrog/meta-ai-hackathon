import { resolveScenarioFlowNodeType } from "./node-type";

describe("resolveScenarioFlowNodeType", () => {
  it.each([
    ["bulk", "bulkNode"],
    ["trigger", "triggerNode"],
    ["action", "actionNode"],
    ["scenario_link", "scenarioLinkNode"],
    ["logic", "scenarioNode"],
    ["context", "scenarioNode"],
  ] as const)("maps %s to %s", (kind, expected) => {
    expect(resolveScenarioFlowNodeType(kind)).toBe(expected);
  });

  it.each(["legacy_node", "__proto__", "constructor"])(
    "keeps the renderer fallback for unrecognized persisted kind %s",
    kind => {
      // Exercise malformed persisted input at the runtime boundary.
      // @ts-expect-error Unknown kinds are deliberately outside the typed contract.
      expect(resolveScenarioFlowNodeType(kind)).toBe("scenarioNode");
    }
  );
});
