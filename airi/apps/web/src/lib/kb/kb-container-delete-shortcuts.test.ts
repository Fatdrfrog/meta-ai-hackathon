import {
  KB_CONTAINER_NODE_NAMES,
  isKBContainerNodeName,
} from "./kb-container-delete-shortcuts";

describe("KB container delete shortcuts", () => {
  it("treats selected tables and grids as whole deletable containers", () => {
    expect(KB_CONTAINER_NODE_NAMES).toEqual(["table", "kbGrid"]);
    expect(isKBContainerNodeName("table")).toBe(true);
    expect(isKBContainerNodeName("kbGrid")).toBe(true);
    expect(isKBContainerNodeName("paragraph")).toBe(false);
  });
});
