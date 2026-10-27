import type { DashboardBoardState } from "@/lib/analytics/dashboard-board-schema";
import {
  DashboardPreferencesConflictError,
  getDashboardPreferences,
  saveDashboardPreferences,
} from "./dashboard-preferences";

const mockLoggerWarn = jest.fn();
const mockConnectDB = jest.fn();
const mockEnsureIndexes = jest.fn();
const mockFindOne = jest.fn();
const mockCreate = jest.fn();
const mockFindOneAndUpdate = jest.fn();

jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/models/analytics-dashboard-preference", () => ({
  ensureAnalyticsDashboardPreferenceIndexes: (...args: unknown[]) =>
    mockEnsureIndexes(...args),
  AnalyticsDashboardPreference: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
}));

const state: DashboardBoardState = {
  version: 1,
  activeViewId: "one",
  views: [
    { id: "one", name: "My dashboard", templateId: "starter", cards: [] },
  ],
};

describe("personal dashboard preference persistence", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureIndexes.mockResolvedValue(undefined);
    mockFindOne.mockReturnValue({ lean: async () => null });
  });

  it("returns an explicit missing preference and scopes reads by member and workspace", async () => {
    await expect(
      getDashboardPreferences("workspace-1", "member-1")
    ).resolves.toEqual({ state: null, revision: null });
    expect(mockFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "member-1",
    });
  });

  it("returns validated saved state without storage fields", async () => {
    mockFindOne.mockReturnValue({
      lean: async () => ({
        _id: "private-id",
        workspaceId: "workspace-1",
        userId: "member-1",
        state,
        revision: 3,
      }),
    });
    await expect(
      getDashboardPreferences("workspace-1", "member-1")
    ).resolves.toEqual({ state, revision: 3 });
  });

  it("round-trips the Outcomes layout through the same scoped preference and revision CAS", async () => {
    const extended: DashboardBoardState = {
      ...state,
      outcomes: { cards: [{ id: "flows", width: 4, height: 1 }] },
    };
    mockFindOne.mockReturnValue({
      lean: async () => ({ state: extended, revision: 3 }),
    });
    await expect(
      getDashboardPreferences("workspace-1", "member-1")
    ).resolves.toEqual({ state: extended, revision: 3 });
    mockFindOneAndUpdate.mockReturnValue({
      lean: async () => ({ state: extended, revision: 4 }),
    });
    await expect(
      saveDashboardPreferences({
        workspaceId: "workspace-1",
        userId: "member-1",
        state: extended,
        revision: 3,
      })
    ).resolves.toEqual({ state: extended, revision: 4 });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", userId: "member-1", revision: 3 },
      { $set: { state: extended }, $inc: { revision: 1 } },
      { new: true, runValidators: true }
    );
  });

  it.each([
    [
      "an unknown card id",
      {
        ...state,
        views: [
          {
            ...state.views[0],
            cards: [
              { id: "revenue", width: 2, height: 1 },
              { id: "total", width: 1, height: 1 },
            ],
          },
        ],
      },
      [{ id: "total", width: 1, height: 1 }],
    ],
    [
      "an extra field",
      {
        ...state,
        pinnedFilters: ["whatsapp"],
        views: [
          {
            ...state.views[0],
            cards: [{ id: "total", width: 1, height: 1, color: "rose" }],
          },
        ],
      },
      [{ id: "total", width: 1, height: 1 }],
    ],
  ])(
    "reads a stored layout with %s leniently",
    async (_label, stored, cards) => {
      mockFindOne.mockReturnValue({
        lean: async () => ({ state: stored, revision: 3 }),
      });
      await expect(
        getDashboardPreferences("workspace-1", "member-1")
      ).resolves.toEqual({
        state: { ...state, views: [{ ...state.views[0], cards }] },
        revision: 3,
      });
    }
  );

  it("keeps a rollback-shaped layout readable with a missing active view", async () => {
    mockFindOne.mockReturnValue({
      lean: async () => ({
        state: {
          ...state,
          activeViewId: "missing",
          outcomes: { cards: [{ id: "flows", width: 4, height: 1 }] },
          comparisons: { enabled: true },
        },
        revision: 3,
      }),
    });
    await expect(
      getDashboardPreferences("workspace-1", "member-1")
    ).resolves.toEqual({
      state: {
        ...state,
        outcomes: { cards: [{ id: "flows", width: 4, height: 1 }] },
      },
      revision: 3,
    });
  });

  it("returns an unreadable layout with its revision instead of failing or defaulting", async () => {
    mockFindOne.mockReturnValue({
      lean: async () => ({ state: { ...state, version: 2 }, revision: 3 }),
    });
    await expect(
      getDashboardPreferences("workspace-1", "member-1")
    ).resolves.toEqual({ state: null, revision: 3, unreadable: true });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Analytics dashboard preference is unreadable",
      { workspaceId: "workspace-1", revision: 3 }
    );
  });

  it("replaces an unreadable layout through the normal revision compare-and-swap", async () => {
    mockFindOneAndUpdate.mockReturnValue({
      lean: async () => ({ state, revision: 4 }),
    });
    await expect(
      saveDashboardPreferences({
        workspaceId: "workspace-1",
        userId: "member-1",
        state,
        revision: 3,
      })
    ).resolves.toEqual({ state, revision: 4 });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", userId: "member-1", revision: 3 },
      { $set: { state }, $inc: { revision: 1 } },
      { new: true, runValidators: true }
    );
  });

  it("still fails on a stored revision that cannot be compared", async () => {
    mockFindOne.mockReturnValue({
      lean: async () => ({ state, revision: 0 }),
    });
    await expect(
      getDashboardPreferences("workspace-1", "member-1")
    ).rejects.toThrow("Invalid stored dashboard revision");
  });

  it("enforces the unique index before an initial save", async () => {
    mockEnsureIndexes.mockImplementation(async () => {
      expect(mockCreate).not.toHaveBeenCalled();
    });
    mockCreate.mockResolvedValue({ state, revision: 1 });
    await expect(
      saveDashboardPreferences({
        workspaceId: "workspace-1",
        userId: "member-1",
        state,
        revision: null,
      })
    ).resolves.toEqual({ state, revision: 1 });
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "member-1",
      state,
      revision: 1,
    });
  });

  it("does not save when the unique index could not be created", async () => {
    mockEnsureIndexes.mockRejectedValue(new Error("index unavailable"));
    await expect(
      saveDashboardPreferences({
        workspaceId: "workspace-1",
        userId: "member-1",
        state,
        revision: null,
      })
    ).rejects.toThrow("index unavailable");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("reports a first-save race as a revision conflict", async () => {
    mockCreate.mockRejectedValue({ code: 11000 });
    await expect(
      saveDashboardPreferences({
        workspaceId: "workspace-1",
        userId: "member-1",
        state,
        revision: null,
      })
    ).rejects.toBeInstanceOf(DashboardPreferencesConflictError);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("updates an existing layout atomically with the expected revision", async () => {
    mockFindOneAndUpdate.mockReturnValue({
      lean: async () => ({ state, revision: 4 }),
    });
    await expect(
      saveDashboardPreferences({
        workspaceId: "workspace-1",
        userId: "member-1",
        state,
        revision: 3,
      })
    ).resolves.toEqual({ state, revision: 4 });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", userId: "member-1", revision: 3 },
      { $set: { state }, $inc: { revision: 1 } },
      { new: true, runValidators: true }
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a stale or missing revision rather than upserting", async () => {
    mockFindOneAndUpdate.mockReturnValue({ lean: async () => null });
    await expect(
      saveDashboardPreferences({
        workspaceId: "workspace-1",
        userId: "member-1",
        state,
        revision: 3,
      })
    ).rejects.toBeInstanceOf(DashboardPreferencesConflictError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("propagates an unrelated database failure", async () => {
    mockCreate.mockRejectedValue(new Error("write unavailable"));
    await expect(
      saveDashboardPreferences({
        workspaceId: "workspace-1",
        userId: "member-1",
        state,
        revision: null,
      })
    ).rejects.toThrow("write unavailable");
  });
});
