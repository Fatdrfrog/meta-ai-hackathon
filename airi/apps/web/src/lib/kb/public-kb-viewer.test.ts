import { buildPublicKBHeaderViewer } from "./public-kb-viewer";

describe("buildPublicKBHeaderViewer", () => {
  it("returns an anonymous viewer when no user is present", () => {
    expect(buildPublicKBHeaderViewer(null, [], "workspace-1")).toEqual({
      isAuthenticated: false,
    });
  });

  it("prefers the current article workspace for authenticated viewers", () => {
    expect(
      buildPublicKBHeaderViewer(
        { id: "user-1" },
        [{ workspace_id: "workspace-1" }, { workspace_id: "workspace-2" }],
        "workspace-2"
      )
    ).toEqual({
      isAuthenticated: true,
      panelHref: "/panel/w/workspace-2/airi",
    });
  });

  it("falls back to the first membership or panel root for authenticated viewers", () => {
    expect(
      buildPublicKBHeaderViewer(
        { id: "user-1" },
        [{ workspace_id: "workspace-1" }],
        "workspace-2"
      )
    ).toEqual({
      isAuthenticated: true,
      panelHref: "/panel/w/workspace-1/airi",
    });

    expect(
      buildPublicKBHeaderViewer({ id: "user-1" }, [], "workspace-2")
    ).toEqual({
      isAuthenticated: true,
      panelHref: "/panel",
    });
  });
});
