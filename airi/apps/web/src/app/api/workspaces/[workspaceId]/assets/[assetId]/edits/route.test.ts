const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockCreate = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockStartCreativeAssetEditWorkflow = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/temporal/creative-asset-edits", () => ({
  isTemporalConfigured: () => true,
  startCreativeAssetEditWorkflow: (...args: unknown[]) =>
    mockStartCreativeAssetEditWorkflow(...args),
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    find: (...args: unknown[]) => mockFind(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
}));

import { POST } from "./route";
import { timelineSchema } from "@/lib/creative-assets/timeline/schema";

const SOURCE_ASSET_ID = "64c13ab08edf48a008793cab";

function leanResult<T>(value: T) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

/** The completed talking-head.mp4 video that edits derive from. */
function sourceVideoAsset(overrides: Record<string, unknown> = {}) {
  return {
    _id: SOURCE_ASSET_ID,
    workspaceId: "workspace-1",
    kind: "video",
    status: "complete",
    url: "https://storage.example.com/source.mp4",
    fileName: "talking-head.mp4",
    ...overrides,
  };
}

function postEdit(
  body: unknown,
  {
    json = false,
    assetId = SOURCE_ASSET_ID,
  }: { json?: boolean; assetId?: string } = {}
) {
  return POST(
    new Request(
      `http://localhost/api/workspaces/workspace-1/assets/${assetId}/edits`,
      {
        method: "POST",
        ...(json ? { headers: { "Content-Type": "application/json" } } : {}),
        body: JSON.stringify(body),
      }
    ) as never,
    { params: Promise.resolve({ workspaceId: "workspace-1", assetId }) }
  );
}

function workspaceQuery(workspace: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: workspace, error: null }),
  };
}

function createAccessSupabase(
  workspace: unknown = {
    id: "workspace-1",
    company_id: "d81123b4-b2fa-49d3-86af-25b4482b8269",
    companies: { id: "d81123b4-b2fa-49d3-86af-25b4482b8269" },
  }
) {
  return {
    from: jest.fn((table: string) => {
      if (table === "workspaces") return workspaceQuery(workspace);
      throw new Error(`Unexpected table ${table}`);
    }),
  };
}

describe("POST /api/workspaces/[workspaceId]/assets/[assetId]/edits", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      supabase: createAccessSupabase(),
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockFind.mockImplementation(
      (query: { _id: { $in: string[] }; workspaceId: string }) => ({
        select: () => ({
          lean: async () =>
            Promise.all(
              query._id.$in.map(id =>
                mockFindOne({ _id: id, workspaceId: query.workspaceId }).lean()
              )
            ).then(assets => assets.filter(Boolean)),
        }),
      })
    );
    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query.source === "edited") {
        return leanResult(null);
      }
      return leanResult(sourceVideoAsset());
    });
    mockCreate.mockResolvedValue({
      _id: "64c13ab08edf48a008793cad",
      workspaceId: "workspace-1",
      kind: "video",
      source: "edited",
      provider: "airi",
      status: "queued",
      storageProvider: "gcs",
      sourceAssetId: "64c13ab08edf48a008793cab",
      prompt: "Green-screen derivative of talking-head.mp4",
      modelId: "airi-green-screen-bria-v1",
      createdAt: new Date("2026-06-28T00:00:00.000Z"),
    });
    mockStartCreativeAssetEditWorkflow.mockResolvedValue({
      workflowId: "creative-asset-edit:64c13ab08edf48a008793cad",
      taskQueue: "airi-media",
      duplicate: false,
    });
  });

  it("queues a timeline render for a non-platform company", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-2",
      supabase: createAccessSupabase({
        id: "workspace-1",
        company_id: "11111111-1111-4111-8111-111111111111",
        companies: { id: "11111111-1111-4111-8111-111111111111" },
      }),
    });
    mockCreate.mockResolvedValue({
      _id: "64c13ab08edf48a008793caf",
      workspaceId: "workspace-1",
      kind: "video",
      source: "edited",
      provider: "airi",
      status: "queued",
      storageProvider: "gcs",
      sourceAssetId: "64c13ab08edf48a008793cab",
      prompt: "Timeline export of talking-head.mp4",
      modelId: "airi-timeline-render-v1",
      createdAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    const timeline = {
      duration: 10,
      clips: [
        {
          id: "clip-1",
          assetId: "64c13ab08edf48a008793cab",
          trackId: "V1",
          timelineStart: 0,
          sourceStart: 2,
          duration: 10,
        },
      ],
    };

    const response = await postEdit(
      { operation: "timeline_render", timeline },
      { json: true }
    );

    expect(response.status).toBe(202);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "airi-timeline-render-v1",
        prompt: "Timeline export of talking-head.mp4",
        providerPayload: expect.objectContaining({
          operation: "timeline_render",
          timeline,
          timelineFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      })
    );
    expect(mockStartCreativeAssetEditWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceAssetId: "64c13ab08edf48a008793cab",
        outputAssetId: "64c13ab08edf48a008793caf",
        operation: "timeline_render",
        timeline,
      })
    );
  });

  it.each([
    {
      name: "clip end exceeds the rounded render duration",
      duration: 1.00049,
      timelineStart: 0.50051,
      sourceStart: 0,
      clipDuration: 0.50051,
    },
    {
      name: "source offset becomes infinite",
      duration: 1,
      timelineStart: 0,
      sourceStart: 1e307,
      clipDuration: 1,
    },
  ])("returns HTTP 400 after normalization: $name", async input => {
    const timeline = {
      duration: input.duration,
      clips: [
        {
          id: "clip-1",
          assetId: "64c13ab08edf48a008793cab",
          trackId: "V1",
          timelineStart: input.timelineStart,
          sourceStart: input.sourceStart,
          duration: input.clipDuration,
        },
      ],
    };
    expect(timelineSchema.safeParse(timeline).success).toBe(true);

    const response = await postEdit(
      { operation: "timeline_render", timeline },
      { json: true }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartCreativeAssetEditWorkflow).not.toHaveBeenCalled();
  });

  it("rejects timeline clips that reference an unavailable workspace asset", async () => {
    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query.source === "edited") return leanResult(null);
      if (query._id === "64c13ab08edf48a008793cab") {
        return leanResult(sourceVideoAsset({ _id: query._id }));
      }
      return leanResult(null);
    });

    const response = await postEdit(
      {
        operation: "timeline_render",
        timeline: {
          duration: 5,
          clips: [
            {
              id: "clip-missing",
              assetId: "64c13ab08edf48a008793caa",
              trackId: "V2",
              timelineStart: 0,
              sourceStart: 0,
              duration: 5,
            },
          ],
        },
      },
      { json: true }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error:
        "Timeline clips require completed image or video assets in this workspace",
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartCreativeAssetEditWorkflow).not.toHaveBeenCalled();
  });

  it("reuses an identical queued timeline render", async () => {
    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query.modelId === "airi-timeline-render-v1") {
        return leanResult({
          _id: "64c13ab08edf48a008793caa",
          workspaceId: "workspace-1",
          kind: "video",
          source: "edited",
          provider: "airi",
          status: "queued",
          storageProvider: "gcs",
          sourceAssetId: "64c13ab08edf48a008793cab",
          modelId: "airi-timeline-render-v1",
          providerPayload: {
            timelineFingerprint: query["providerPayload.timelineFingerprint"],
          },
        });
      }
      return leanResult(
        sourceVideoAsset({ _id: query._id || "64c13ab08edf48a008793cab" })
      );
    });

    const response = await postEdit(
      {
        operation: "timeline_render",
        timeline: {
          duration: 5,
          clips: [
            {
              id: "clip-1",
              assetId: "64c13ab08edf48a008793cab",
              trackId: "V1",
              timelineStart: 0,
              sourceStart: 0,
              duration: 5,
            },
          ],
        },
      },
      { json: true }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      duplicate: true,
      asset: { id: "64c13ab08edf48a008793caa", status: "queued" },
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartCreativeAssetEditWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ outputAssetId: "64c13ab08edf48a008793caa" })
    );
  });

  it("returns the winning timeline asset after a concurrent create race", async () => {
    let fingerprintLookups = 0;
    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query.editFingerprint) {
        fingerprintLookups += 1;
        if (fingerprintLookups === 1) return leanResult(null);
        return leanResult({
          _id: "64c13ab08edf48a008793caa",
          workspaceId: "workspace-1",
          kind: "video",
          source: "edited",
          provider: "airi",
          status: "queued",
          storageProvider: "gcs",
          sourceAssetId: "64c13ab08edf48a008793cab",
          modelId: "airi-timeline-render-v1",
          editFingerprint: query.editFingerprint,
        });
      }
      return leanResult(
        sourceVideoAsset({ _id: query._id || "64c13ab08edf48a008793cab" })
      );
    });
    const duplicateError = Object.assign(new Error("E11000 duplicate key"), {
      code: 11000,
    });
    mockCreate.mockRejectedValue(duplicateError);

    const response = await postEdit(
      {
        operation: "timeline_render",
        timeline: {
          duration: 5,
          audioTrack: "V1",
          clips: [
            {
              id: "clip-1",
              assetId: "64c13ab08edf48a008793cab",
              trackId: "V1",
              timelineStart: 0,
              sourceStart: 0,
              duration: 5,
            },
          ],
        },
      },
      { json: true }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      duplicate: true,
      asset: { id: "64c13ab08edf48a008793caa" },
    });
    expect(mockStartCreativeAssetEditWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ outputAssetId: "64c13ab08edf48a008793caa" })
    );
  });

  it("creates a queued green-screen derivative and starts the edit workflow", async () => {
    const response = await postEdit({ operation: "green_screen" });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.asset).toMatchObject({
      id: "64c13ab08edf48a008793cad",
      kind: "video",
      source: "edited",
      provider: "airi",
      status: "queued",
      storageProvider: "gcs",
      sourceAssetId: "64c13ab08edf48a008793cab",
      modelId: "airi-green-screen-bria-v1",
    });
    expect(mockFindOne).toHaveBeenCalledWith({
      _id: "64c13ab08edf48a008793cab",
      workspaceId: "workspace-1",
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        kind: "video",
        source: "edited",
        provider: "airi",
        status: "queued",
        storageProvider: "gcs",
        sourceAssetId: "64c13ab08edf48a008793cab",
        modelId: "airi-green-screen-bria-v1",
        providerPayload: expect.objectContaining({
          operation: "green_screen",
          provider: "bria",
          processor: "bria-video-green-screen-api",
          modelId: "airi-green-screen-bria-v1",
          greenShade: "chroma_green",
          backgroundColor: "#00ff00",
          outputContainerAndCodec: "mp4_h264",
          preserveAudio: true,
        }),
        createdBy: "user-1",
        updatedBy: "user-1",
      })
    );
    expect(mockStartCreativeAssetEditWorkflow).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceAssetId: "64c13ab08edf48a008793cab",
      outputAssetId: "64c13ab08edf48a008793cad",
      operation: "green_screen",
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("blocks green-screen edits outside the Airi.chat company", async () => {
    const supabase = createAccessSupabase({
      id: "workspace-1",
      company_id: "customer-company",
      companies: { id: "customer-company" },
    });
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      supabase,
    });

    const response = await postEdit({ operation: "green_screen" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error:
        "Green-screen generation is currently available only for the Airi.chat company.",
    });
    expect(supabase.from).toHaveBeenCalledWith("workspaces");
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartCreativeAssetEditWorkflow).not.toHaveBeenCalled();
  });

  it("rejects invalid source asset ids before querying Mongo", async () => {
    const response = await postEdit(
      { operation: "green_screen" },
      { assetId: "not-an-id" }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid asset id" });
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects non-video assets", async () => {
    mockFindOne.mockReturnValue(
      leanResult({
        _id: "64c13ab08edf48a008793cab",
        workspaceId: "workspace-1",
        kind: "image",
        status: "complete",
        url: "https://storage.example.com/source.png",
      })
    );

    const response = await postEdit({ operation: "green_screen" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Green-screen edits require a completed video asset",
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects incomplete video assets", async () => {
    mockFindOne.mockReturnValue(
      leanResult({
        _id: "64c13ab08edf48a008793cab",
        workspaceId: "workspace-1",
        kind: "video",
        status: "in_progress",
        url: null,
      })
    );

    const response = await postEdit({ operation: "green_screen" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Green-screen edits require a completed video asset",
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("marks the derivative failed if the workflow cannot start", async () => {
    mockStartCreativeAssetEditWorkflow.mockRejectedValue(
      new Error("Temporal is not configured")
    );
    mockFindOneAndUpdate.mockResolvedValue({
      _id: "64c13ab08edf48a008793cad",
      workspaceId: "workspace-1",
      kind: "video",
      source: "edited",
      provider: "airi",
      status: "failed",
      error: "Temporal is not configured",
    });

    const response = await postEdit({ operation: "green_screen" });
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.asset.status).toBe("failed");
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "64c13ab08edf48a008793cad",
        workspaceId: "workspace-1",
        status: { $in: ["queued", "in_progress"] },
      },
      expect.objectContaining({
        status: "failed",
        error: "Temporal is not configured",
      }),
      { new: true }
    );
  });

  it("returns the existing green-screen derivative instead of creating a duplicate", async () => {
    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query.source === "edited") {
        return leanResult({
          _id: "64c13ab08edf48a008793cae",
          workspaceId: "workspace-1",
          kind: "video",
          source: "edited",
          provider: "airi",
          status: "failed",
          storageProvider: "gcs",
          sourceAssetId: "64c13ab08edf48a008793cab",
          modelId: "airi-green-screen-bria-v1",
          prompt: "Green-screen derivative of talking-head.mp4",
        });
      }
      return leanResult(sourceVideoAsset());
    });

    const response = await postEdit({ operation: "green_screen" });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.duplicate).toBe(true);
    expect(payload.asset).toMatchObject({
      id: "64c13ab08edf48a008793cae",
      source: "edited",
      status: "failed",
      sourceAssetId: "64c13ab08edf48a008793cab",
      modelId: "airi-green-screen-bria-v1",
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartCreativeAssetEditWorkflow).not.toHaveBeenCalled();
  });

  it("allows replacing the failed green-screen derivative through retry", async () => {
    mockFindOne.mockImplementation((query: Record<string, unknown>) => {
      if (query._id === "64c13ab08edf48a008793cae") {
        return leanResult({
          _id: "64c13ab08edf48a008793cae",
          workspaceId: "workspace-1",
          kind: "video",
          source: "edited",
          provider: "airi",
          status: "failed",
          sourceAssetId: "64c13ab08edf48a008793cab",
          modelId: "airi-green-screen-v1",
        });
      }
      if (query.source === "edited") {
        return leanResult(null);
      }
      return leanResult(sourceVideoAsset());
    });

    const response = await postEdit({
      operation: "green_screen",
      retryAssetId: "64c13ab08edf48a008793cae",
    });

    expect(response.status).toBe(202);
    expect(mockCreate).toHaveBeenCalled();
    expect(mockStartCreativeAssetEditWorkflow).toHaveBeenCalled();
  });
});
