import { isCrmRealtimeCacheKey } from "./board-realtime-cache";

describe("isCrmRealtimeCacheKey", () => {
  it("matches the current workspace board and customers list keys", () => {
    expect(
      isCrmRealtimeCacheKey(
        "/api/workspaces/workspace-1/crm/board?status=active",
        "workspace-1"
      )
    ).toBe(true);
    expect(
      isCrmRealtimeCacheKey(
        `/api/workspaces/${encodeURIComponent("workspace 1")}/crm/board`,
        "workspace 1"
      )
    ).toBe(true);
    expect(
      isCrmRealtimeCacheKey(
        "/api/customers?workspaceId=workspace-1&page=1&limit=50",
        "workspace-1"
      )
    ).toBe(true);
  });

  it("ignores other workspaces and unrelated endpoints", () => {
    expect(
      isCrmRealtimeCacheKey(
        "/api/workspaces/workspace-2/crm/board?status=active",
        "workspace-1"
      )
    ).toBe(false);
    expect(
      isCrmRealtimeCacheKey(
        "/api/customers?workspaceId=workspace-2&page=1",
        "workspace-1"
      )
    ).toBe(false);
    expect(
      isCrmRealtimeCacheKey("/api/requests?workspaceId=workspace-1", "workspace-1")
    ).toBe(false);
  });
});
