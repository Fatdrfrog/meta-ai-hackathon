import { NextRequest, NextResponse } from "next/server";
import { DashboardPreferencesConflictError } from "@/lib/analytics/dashboard-preferences";
import { GET, PUT } from "./route";

const mockRequireAccess = jest.fn();
const mockGetPreferences = jest.fn();
const mockSavePreferences = jest.fn();
const mockRecommendation = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockRequireAccess(...args),
}));
jest.mock("@/lib/analytics/dashboard-preferences", () => {
  class DashboardPreferencesConflictError extends Error {}
  return {
    DashboardPreferencesConflictError,
    getDashboardPreferences: (...args: unknown[]) =>
      mockGetPreferences(...args),
    saveDashboardPreferences: (...args: unknown[]) =>
      mockSavePreferences(...args),
  };
});
jest.mock("@/lib/analytics/dashboard-recommendation-signals", () => ({
  getDashboardRecommendation: (...args: unknown[]) =>
    mockRecommendation(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));

const state = {
  version: 1,
  activeViewId: "one",
  views: [
    { id: "one", name: "My dashboard", templateId: "starter", cards: [] },
  ],
};
const context = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

function request(body?: unknown) {
  return new NextRequest(
    "http://localhost/api/workspaces/workspace-1/analytics/dashboards",
    {
      method: body === undefined ? "GET" : "PUT",
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    }
  );
}

describe("personal analytics dashboards route", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRequireAccess.mockResolvedValue({
      ok: true,
      userId: "signed-in-member",
      supabase: {},
    });
    mockGetPreferences.mockResolvedValue({ state: null, revision: null });
    mockSavePreferences.mockResolvedValue({ state, revision: 1 });
    mockRecommendation.mockResolvedValue(null);
  });

  it("returns absent configuration explicitly with private no-store headers", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: null,
      revision: null,
      recommendation: null,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockGetPreferences).toHaveBeenCalledWith(
      "workspace-1",
      "signed-in-member"
    );
  });

  it("returns the personal saved dashboard and revision", async () => {
    mockGetPreferences.mockResolvedValue({ state, revision: 4 });
    const response = await GET(request(), context);
    expect(await response.json()).toEqual({
      state,
      revision: 4,
      recommendation: null,
    });
  });

  it("adds the workspace recommendation read with the member's own client", async () => {
    const supabase = { scoped: "member" };
    mockRequireAccess.mockResolvedValue({
      ok: true,
      userId: "signed-in-member",
      supabase,
    });
    mockRecommendation.mockResolvedValue({
      templateId: "sales",
      reason: "ads_connected",
    });
    const response = await GET(request(), context);
    expect(await response.json()).toEqual({
      state: null,
      revision: null,
      recommendation: { templateId: "sales", reason: "ads_connected" },
    });
    expect(mockRecommendation).toHaveBeenCalledWith({
      supabase,
      workspaceId: "workspace-1",
    });
  });

  it("returns an unreadable stored layout with its revision so a save can replace it", async () => {
    mockGetPreferences.mockResolvedValue({
      state: null,
      revision: 7,
      unreadable: true,
    });
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: null,
      revision: 7,
      unreadable: true,
      recommendation: null,
    });
    mockSavePreferences.mockResolvedValue({ state, revision: 8 });
    const saved = await PUT(request({ state, revision: 7 }), context);
    expect(await saved.json()).toEqual({ state, revision: 8 });
  });

  it.each([401, 403])(
    "denies reads and saves when access is denied with status %i",
    async status => {
      mockRequireAccess.mockImplementation(async () => ({
        ok: false,
        response: NextResponse.json({ error: "Denied" }, { status }),
      }));
      expect((await GET(request(), context)).status).toBe(status);
      const saveResponse = await PUT(
        request({ state, revision: null }),
        context
      );
      expect(saveResponse.status).toBe(status);
      expect(saveResponse.headers.get("Cache-Control")).toBe(
        "private, no-store"
      );
      expect(mockGetPreferences).not.toHaveBeenCalled();
      expect(mockRecommendation).not.toHaveBeenCalled();
      expect(mockSavePreferences).not.toHaveBeenCalled();
    }
  );

  it("saves with the member from authentication", async () => {
    const response = await PUT(request({ state, revision: null }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state, revision: 1 });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockSavePreferences).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "signed-in-member",
      state,
      revision: null,
    });
  });

  it("accepts a bounded Outcomes layout while preserving dashboard state and the authenticated owner", async () => {
    const extended = {
      ...state,
      outcomes: {
        cards: [
          { id: "acquisition", width: 4, height: 1 },
          { id: "health", width: 2, height: 2 },
        ],
      },
    };
    mockSavePreferences.mockResolvedValue({ state: extended, revision: 4 });
    const response = await PUT(
      request({ state: extended, revision: 3 }),
      context
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: extended, revision: 4 });
    expect(mockSavePreferences).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "signed-in-member",
      state: extended,
      revision: 3,
    });
  });

  it.each([
    { state, revision: null, userId: "another-member" },
    { state, revision: -1 },
    { state, revision: 0 },
    { state, revision: 1.5 },
    { state, revision: Number.MAX_SAFE_INTEGER },
    { state },
    { state: { ...state, activeViewId: "missing" }, revision: null },
    {
      state: {
        ...state,
        outcomes: { cards: [{ id: "total", width: 4, height: 1 }] },
      },
      revision: 3,
    },
    {
      state: {
        ...state,
        outcomes: {
          cards: [
            { id: "health", width: 4, height: 1 },
            { id: "health", width: 2, height: 1 },
          ],
        },
      },
      revision: 3,
    },
    {
      state: {
        ...state,
        views: [
          { ...state.views[0], cards: [{ id: "total", width: 0, height: 1 }] },
        ],
      },
      revision: null,
    },
  ])("rejects invalid saves without writing %j", async body => {
    const response = await PUT(request(body), context);
    expect(response.status).toBe(400);
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await PUT(
      new NextRequest("http://localhost/test", { method: "PUT", body: "{" }),
      context
    );
    expect(response.status).toBe(400);
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it("bounds the request body before parsing it", async () => {
    const response = await PUT(
      new NextRequest("http://localhost/test", {
        method: "PUT",
        body: " ".repeat(65_537),
      }),
      context
    );
    expect(response.status).toBe(413);
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it("reports revision conflicts requiring a reload", async () => {
    mockSavePreferences.mockRejectedValue(
      new DashboardPreferencesConflictError()
    );
    const response = await PUT(request({ state, revision: 2 }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Dashboard preferences changed. Reload before saving.",
      code: "revision_conflict",
    });
  });

  it.each(["GET", "PUT"])(
    "contains %s failures without exposing database details",
    async method => {
      mockGetPreferences.mockRejectedValue(
        new Error("secret internal database hostname")
      );
      mockSavePreferences.mockRejectedValue(
        new Error("secret internal database hostname")
      );
      const response =
        method === "GET"
          ? await GET(request(), context)
          : await PUT(request({ state, revision: null }), context);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret internal");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mockLoggerError).toHaveBeenCalled();
    }
  );
});
