const mockAccess = jest.fn(),
  mockMembership = jest.fn(),
  mockStages = jest.fn(),
  mockConnect = jest.fn(),
  mockFind = jest.fn(),
  mockUpdate = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/crm/board", () => ({
  loadCrmPipelineStages: (...args: unknown[]) => mockStages(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnect(),
}));
jest.mock("@/models/analytics-policy", () => ({
  AnalyticsPolicy: {
    findOne: (...args: unknown[]) => mockFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mockUpdate(...args),
  },
}));
import { GET, PUT } from "./route";
import { DEFAULT_CRM_PIPELINE_STAGES } from "@/lib/crm/stages";
const context = {
  params: Promise.resolve({ workspaceId: "authorized-workspace" }),
};
const request = (
  body: unknown = { revision: 3, qualifiedStageKeys: ["qualified"] }
) =>
  new Request("https://local.test/api", {
    method: "PUT",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({
    ok: true,
    userId: "member",
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: () => mockMembership() }) }),
        }),
      }),
    },
  });
  mockMembership.mockResolvedValue({ data: { role: "admin" }, error: null });
  mockStages.mockResolvedValue(DEFAULT_CRM_PIPELINE_STAGES);
  mockConnect.mockResolvedValue(undefined);
  mockFind.mockReturnValue({
    lean: () =>
      Promise.resolve({ qualifiedStageKeys: ["proposal"], revision: 3 }),
  });
  mockUpdate.mockReturnValue({
    lean: () =>
      Promise.resolve({
        workspaceId: "authorized-workspace",
        _id: "private-mongo-id",
        qualifiedStageKeys: ["qualified"],
        revision: 4,
      }),
  });
});

test.each([401, 403])(
  "preserves denied access %s before any policy read or write",
  async status => {
    mockAccess.mockResolvedValue({
      ok: false,
      response: new Response(null, { status }),
    });
    expect(
      (await GET(new Request("https://local.test/api"), context)).status
    ).toBe(status);
    expect((await PUT(request(), context)).status).toBe(status);
    expect(mockMembership).not.toHaveBeenCalled();
    expect(mockStages).not.toHaveBeenCalled();
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  }
);

test.each(["member", "owner", "manager", "viewer"])(
  "role %s can read but cannot mutate qualification",
  async role => {
    mockMembership.mockResolvedValue({ data: { role }, error: null });
    const read = await GET(new Request("https://local.test/api"), context);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(
      expect.objectContaining({ canEdit: false })
    );
    expect((await PUT(request(), context)).status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  }
);

test.each(["admin"])(
  "role %s can update with the supplied revision and only returns policy fields",
  async role => {
    mockMembership.mockResolvedValue({ data: { role }, error: null });
    const response = await PUT(
      request({ revision: 3, qualifiedStageKeys: ["qualified", "qualified"] }),
      context
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      qualifiedStageKeys: ["qualified"],
      revision: 4,
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      { workspaceId: "authorized-workspace", revision: 3 },
      { $set: { qualifiedStageKeys: ["qualified"] }, $inc: { revision: 1 } },
      { new: true, upsert: false }
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  }
);

test("only active stages can be selected and inactive stages are omitted from the editor", async () => {
  mockStages.mockResolvedValue(
    DEFAULT_CRM_PIPELINE_STAGES.map(stage => ({
      ...stage,
      isActive: stage.key !== "qualified",
    }))
  );
  const read = await GET(new Request("https://local.test/api"), context);
  expect((await read.json()).stages).not.toContainEqual(
    expect.objectContaining({ key: "qualified" })
  );
  expect((await PUT(request(), context)).status).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});

test.each([
  { revision: -1, qualifiedStageKeys: ["qualified"] },
  { revision: 3, qualifiedStageKeys: [] },
  { revision: 3, qualifiedStageKeys: ["unknown"] },
  { revision: 3, qualifiedStageKeys: ["Qualified"] },
  { revision: 3, qualifiedStageKeys: ["qualified"], workspaceId: "other" },
])("rejects invalid policy %j before persistence", async body => {
  expect((await PUT(request(body), context)).status).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});

test("oversized JSON is bounded and receives 413", async () => {
  const response = await PUT(
    request({
      revision: 3,
      qualifiedStageKeys: ["qualified"],
      padding: "x".repeat(4096),
    }),
    context
  );
  expect(response.status).toBe(413);
  expect(mockUpdate).not.toHaveBeenCalled();
});

test.each([null, { code: 11000 }])(
  "stale revision returns a reloadable conflict %j",
  async result => {
    mockUpdate.mockReturnValue({
      lean: () => (result ? Promise.reject(result) : Promise.resolve(null)),
    });
    const response = await PUT(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Qualification policy changed; reload",
      code: "revision_conflict",
    });
  }
);

test.each(["membership", "stages", "mongo", "policy"])(
  "GET and PUT hide unavailable %s storage details",
  async source => {
    const failure = new Error("private provider credential detail");
    if (source === "membership")
      mockMembership.mockResolvedValue({ data: null, error: failure });
    if (source === "stages") mockStages.mockRejectedValue(failure);
    if (source === "mongo") mockConnect.mockRejectedValue(failure);
    if (source === "policy") {
      mockFind.mockReturnValue({ lean: () => Promise.reject(failure) });
      mockUpdate.mockReturnValue({ lean: () => Promise.reject(failure) });
    }
    for (const response of [
      await GET(new Request("https://local.test/api"), context),
      await PUT(request(), context),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Analytics qualification policy unavailable",
      });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  }
);

test("read uses canonical default before a workspace policy exists", async () => {
  mockFind.mockReturnValue({ lean: () => Promise.resolve(null) });
  const response = await GET(new Request("https://local.test/api"), context);
  expect(await response.json()).toEqual(
    expect.objectContaining({
      qualifiedStageKeys: ["qualified"],
      revision: 0,
      canEdit: true,
    })
  );
  expect(mockFind).toHaveBeenCalledWith({
    workspaceId: "authorized-workspace",
  });
});
