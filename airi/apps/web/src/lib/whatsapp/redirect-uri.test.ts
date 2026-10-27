import { parseEmbeddedSignupState } from "./redirect-uri";

describe("Embedded Signup OAuth state", () => {
  it("keeps legacy plain workspace IDs parseable", () => {
    expect(parseEmbeddedSignupState("workspace-1")).toEqual({
      workspaceId: "workspace-1",
    });
  });
});
