import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  buildFlowBranchOptionKey,
  buildFlowBranchSourceHandleId,
  parseFlowBranchOptionKey,
  parseFlowBranchSourceHandleId,
} from "@icecore/scenario-contracts";

describe("flow branch handles", () => {
  it("round-trips flow branch option keys", () => {
    const key = buildFlowBranchOptionKey(" field:1 ", " option/2 ");

    expect(parseFlowBranchOptionKey(key)).toEqual({
      fieldId: "field:1",
      optionId: "option/2",
    });
  });

  it("round-trips option-specific source handle ids", () => {
    const handleId = buildFlowBranchSourceHandleId("field:1", "option/2");

    expect(handleId).toMatch(
      new RegExp(`^${ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID}`)
    );
    expect(parseFlowBranchSourceHandleId(handleId)).toEqual({
      fieldId: "field:1",
      optionId: "option/2",
    });
  });

  it("rejects non-option flow branch source handle ids", () => {
    expect(
      parseFlowBranchSourceHandleId(ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID)
    ).toBeNull();
    expect(parseFlowBranchSourceHandleId("right-source")).toBeNull();
  });
});
