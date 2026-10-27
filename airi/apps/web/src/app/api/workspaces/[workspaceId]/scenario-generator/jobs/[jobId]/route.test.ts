const mockConnectDB = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockJobFindOne = jest.fn();
const mockJobFindByIdAndUpdate = jest.fn();
const mockMediaFind = jest.fn();
const mockMediaFindByIdAndUpdate = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockScenarioFindOneAndUpdate = jest.fn();
const mockScenarioUpdateOne = jest.fn();
const mockPollVertexVideoOperation = jest.fn();
const mockDownloadVertexVideoResult = jest.fn();
const mockStorageFrom = jest.fn();
const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockReserveStorage = jest.fn();

jest.mock("@icecore/airi-runtime/storage-quota", () => {
  const actual = jest.requireActual("@icecore/airi-runtime/storage-quota");
  return {
    ...actual,
    storeSupabaseWorkspaceBuffer: (params: object) =>
      actual.storeSupabaseWorkspaceBuffer({
        ...params,
        quota: {
          reserve: (...args: unknown[]) => mockReserveStorage(...args),
          settle: async () => {},
        },
      }),
  };
});

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/ai/vertex-video", () => ({
  pollVertexVideoOperation: (...args: unknown[]) =>
    mockPollVertexVideoOperation(...args),
  extractVertexVideoResults: (response: {
    generatedVideos?: Array<{ video?: Record<string, unknown> }>;
  }) =>
    (response.generatedVideos || [])
      .map(item => item.video)
      .filter(Boolean)
      .map(video => ({
        videoBytes: video?.videoBytes,
        uri: video?.uri,
        mimeType: video?.mimeType || "video/mp4",
      })),
  downloadVertexVideoResult: (...args: unknown[]) =>
    mockDownloadVertexVideoResult(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      getBucket: async () => ({ data: { id: "business-media" }, error: null }),
      from: (...args: unknown[]) => mockStorageFrom(...args),
    },
  },
}));

jest.mock("@/models/scenario-generated-media-asset", () => ({
  ScenarioGeneratedMediaAsset: {
    find: (...args: unknown[]) => mockMediaFind(...args),
    findByIdAndUpdate: (...args: unknown[]) =>
      mockMediaFindByIdAndUpdate(...args),
  },
}));

jest.mock("@/models/scenario-generation-job", () => ({
  ScenarioGenerationJob: {
    findOne: (...args: unknown[]) => mockJobFindOne(...args),
    findByIdAndUpdate: (...args: unknown[]) =>
      mockJobFindByIdAndUpdate(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) =>
      mockScenarioFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockScenarioUpdateOne(...args),
  },
}));

import { GET } from "./route";

function leanResult<T>(value: T) {
  const query = {
    select: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  return query;
}

function sortedLeanResult<T>(value: T) {
  return {
    sort: jest.fn().mockReturnValue(leanResult(value)),
  };
}

describe("GET /api/workspaces/[workspaceId]/scenario-generator/jobs/[jobId]", () => {
  const jobId = "65f000000000000000000001";
  const scenarioId = "65f000000000000000000002";
  const assetId = "65f000000000000000000003";

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mockStorageFrom.mockReturnValue({
      upload: (...args: unknown[]) => mockUpload(...args),
      getPublicUrl: (...args: unknown[]) => mockGetPublicUrl(...args),
    });
    mockUpload.mockResolvedValue({ error: null });
    mockReserveStorage.mockResolvedValue({
      _id: "reservation-1",
      status: "reserved",
    });
    mockGetPublicUrl.mockReturnValue({
      data: {
        publicUrl:
          "https://cdn.example.com/scenarios/workspace/generated-video.mp4",
      },
    });
    mockDownloadVertexVideoResult.mockResolvedValue({
      buffer: Buffer.from("fake-mp4"),
      mimeType: "video/mp4",
    });
    mockScenarioUpdateOne.mockResolvedValue({ matchedCount: 1 });
  });

  it("polls completed Vertex operations, uploads videos, and patches scenario action nodes", async () => {
    const queuedAsset = {
      _id: assetId,
      workspaceId: "workspace-1",
      scenarioId,
      jobId,
      branchId: "vip",
      kind: "video",
      source: "vertex",
      url: "",
      mimeType: "video/mp4",
      fileName: "vip-video.mp4",
      durationSeconds: 6,
      providerOperationId: "operations/video-1",
      status: "queued",
    };
    const completeAsset = {
      ...queuedAsset,
      url: "https://cdn.example.com/scenarios/workspace/generated-video.mp4",
      status: "complete",
    };

    mockJobFindOne.mockReturnValue(
      leanResult({
        _id: jobId,
        workspaceId: "workspace-1",
        scenarioId,
        status: "generating_media",
        mediaProvider: "vertex",
        updatedAt: new Date("2026-05-03T00:00:00.000Z"),
      })
    );
    mockMediaFind
      .mockReturnValueOnce(sortedLeanResult([queuedAsset]))
      .mockReturnValueOnce(sortedLeanResult([completeAsset]));
    mockPollVertexVideoOperation.mockResolvedValue({
      name: "operations/video-1",
      done: true,
      response: {
        generatedVideos: [
          {
            video: {
              videoBytes: Buffer.from("fake-mp4").toString("base64"),
              mimeType: "video/mp4",
            },
          },
        ],
      },
    });
    mockScenarioFindOne.mockReturnValue(
      leanResult({
        updatedAt: new Date("2026-05-03T00:00:00.000Z"),
        nodes: [
          {
            id: "node-bulk-root",
            type: "bulkNode",
            position: { x: 0, y: 0 },
            data: {
              kind: "bulk",
              bulkRootConfig: {
                workflowKind: "bulk_campaign",
                sendMode: "immediate",
                channels: ["whatsapp"],
                campaignName: "VIP",
                recipientSourceSummary: "1 recipient",
                generationStatus: "generating_media",
                generationJobId: jobId,
              },
            },
          },
          {
            id: "action-vip",
            type: "actionNode",
            position: { x: 240, y: 0 },
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionReplyText: "Hello",
              actionWhatsAppTemplateName: "vip_reactivation",
              actionWhatsAppTemplateLanguage: "en",
              actionWhatsAppTemplateComponents: [
                {
                  type: "BODY",
                  text: "Hi {{1}}, {{2}}",
                  example: { body_text: [["Aibek", "Generated message"]] },
                },
              ],
              generatedTemplateDraft: {
                id: "draft-1",
                name: "vip_reactivation",
                language: "en",
                category: "MARKETING",
                status: "draft",
                components: [
                  {
                    type: "BODY",
                    text: "Hi {{1}}, {{2}}",
                    example: { body_text: [["Aibek", "Generated message"]] },
                  },
                ],
              },
              bulkRecipientBranchId: "vip",
            },
          },
        ],
      })
    );

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockPollVertexVideoOperation).toHaveBeenCalledWith(
      "operations/video-1"
    );
    expect(mockReserveStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "supabase",
        bytes: Buffer.from("fake-mp4").byteLength,
      })
    );
    expect(mockUpload).toHaveBeenCalledWith(
      expect.stringContaining(
        "scenarios/workspace-1/generated-videos/65f000000000000000000002/"
      ),
      Buffer.from("fake-mp4"),
      expect.objectContaining({ contentType: "video/mp4" })
    );
    expect(mockMediaFindByIdAndUpdate).toHaveBeenCalledWith(
      assetId,
      expect.objectContaining({
        url: "https://cdn.example.com/scenarios/workspace/generated-video.mp4",
        mimeType: "video/mp4",
        status: "complete",
        error: null,
      })
    );
    expect(mockJobFindByIdAndUpdate).toHaveBeenCalledWith(jobId, {
      status: "complete",
      error: null,
    });
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        updatedAt: new Date("2026-05-03T00:00:00.000Z"),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          graphSchemaVersion: 1,
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: "action-vip",
              data: expect.objectContaining({
                actionImageUrls: [
                  "https://cdn.example.com/scenarios/workspace/generated-video.mp4",
                ],
                actionMediaAssets: [
                  expect.objectContaining({
                    id: assetId,
                    source: "vertex",
                    kind: "video",
                    status: "complete",
                  }),
                ],
                actionWhatsAppTemplateComponents: [
                  expect.objectContaining({
                    type: "HEADER",
                    format: "VIDEO",
                    example: {
                      header_handle: [
                        "https://cdn.example.com/scenarios/workspace/generated-video.mp4",
                      ],
                    },
                  }),
                  expect.objectContaining({ type: "BODY" }),
                ],
                generatedTemplateDraft: expect.objectContaining({
                  headerMediaUrl:
                    "https://cdn.example.com/scenarios/workspace/generated-video.mp4",
                  headerMediaFormat: "VIDEO",
                  components: [
                    expect.objectContaining({
                      type: "HEADER",
                      format: "VIDEO",
                    }),
                    expect.objectContaining({ type: "BODY" }),
                  ],
                }),
              }),
            }),
          ]),
          updatedAt: expect.any(Date),
        }),
      }),
      { timestamps: false }
    );
    expect(payload.job.status).toBe("complete");
    expect(payload.mediaAssets[0]).toEqual(
      expect.objectContaining({
        id: assetId,
        status: "complete",
        url: "https://cdn.example.com/scenarios/workspace/generated-video.mp4",
      })
    );
    expect(payload.nodeUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "action-vip",
          data: expect.objectContaining({
            actionMediaAssets: [
              expect.objectContaining({
                url: "https://cdn.example.com/scenarios/workspace/generated-video.mp4",
              }),
            ],
            generatedTemplateDraft: expect.objectContaining({
              headerMediaUrl:
                "https://cdn.example.com/scenarios/workspace/generated-video.mp4",
              headerMediaFormat: "VIDEO",
            }),
          }),
        }),
      ])
    );
    expect(payload).toEqual(
      expect.objectContaining({
        previousScenarioUpdatedAt: "2026-05-03T00:00:00.000Z",
        scenarioUpdatedAt: expect.any(String),
        scenarioRevisionConflict: false,
      })
    );
  });

  it("recomputes completed media once after a concurrent scenario update", async () => {
    const previousUpdatedAt = new Date("2026-05-03T00:00:00.000Z");
    const concurrentUpdatedAt = new Date("2026-05-03T00:02:00.000Z");
    const completeAsset = {
      _id: assetId,
      workspaceId: "workspace-1",
      scenarioId,
      jobId,
      branchId: "vip",
      kind: "video",
      source: "vertex",
      url: "https://cdn.example.com/generated-vip.mp4",
      mimeType: "video/mp4",
      fileName: "vip-video.mp4",
      status: "complete",
    };
    const originalNodes = [
      {
        id: "node-bulk-root",
        type: "bulkNode",
        position: { x: 0, y: 0 },
        data: {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
            campaignName: "VIP",
            recipientSourceSummary: "1 recipient",
            generationStatus: "generating_media",
            generationJobId: jobId,
          },
        },
      },
      {
        id: "action-vip",
        type: "actionNode",
        position: { x: 240, y: 0 },
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyText: "Original text",
          bulkRecipientBranchId: "vip",
        },
      },
    ];
    const concurrentlyUpdatedNodes = originalNodes.map(node =>
      node.id === "action-vip"
        ? {
            ...node,
            data: {
              ...node.data,
              actionReplyText: "Concurrent edit",
            },
          }
        : node
    );

    mockJobFindOne.mockReturnValue(
      leanResult({
        _id: jobId,
        workspaceId: "workspace-1",
        scenarioId,
        status: "complete",
        updatedAt: previousUpdatedAt,
      })
    );
    mockMediaFind.mockReturnValue(sortedLeanResult([completeAsset]));
    mockScenarioFindOne
      .mockReturnValueOnce(
        leanResult({
          nodes: originalNodes,
          updatedAt: previousUpdatedAt,
        })
      )
      .mockReturnValueOnce(
        leanResult({
          nodes: concurrentlyUpdatedNodes,
          updatedAt: concurrentUpdatedAt,
        })
      );
    mockScenarioUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockScenarioUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockScenarioUpdateOne).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ updatedAt: concurrentUpdatedAt }),
      expect.objectContaining({
        $set: expect.objectContaining({
          graphSchemaVersion: 1,
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: "action-vip",
              data: expect.objectContaining({
                actionReplyText: "Concurrent edit",
                actionMediaAssets: [
                  expect.objectContaining({
                    url: "https://cdn.example.com/generated-vip.mp4",
                  }),
                ],
              }),
            }),
          ]),
        }),
      }),
      { timestamps: false }
    );
    expect(payload).toEqual(
      expect.objectContaining({
        nodeUpdates: expect.arrayContaining([
          expect.objectContaining({
            id: "action-vip",
            data: expect.objectContaining({
              actionReplyText: "Concurrent edit",
              actionMediaAssets: [
                expect.objectContaining({
                  url: "https://cdn.example.com/generated-vip.mp4",
                }),
              ],
            }),
          }),
        ]),
        previousScenarioUpdatedAt: concurrentUpdatedAt.toISOString(),
        scenarioUpdatedAt: expect.any(String),
        scenarioRevisionConflict: false,
      })
    );
  });

  it("keeps the reply-button ids of a draft template when it adds the video header", async () => {
    const updatedAt = new Date("2026-05-03T00:00:00.000Z");
    const buttonIds = {
      version: 1,
      nextId: 10,
      buttons: [{ id: 1, index: 0, text: "Premium" }],
    };
    const components = [
      { type: "BODY", text: "Which plan?" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Premium" }] },
    ];
    mockJobFindOne.mockReturnValue(
      leanResult({
        _id: jobId,
        workspaceId: "workspace-1",
        scenarioId,
        status: "complete",
        updatedAt,
      })
    );
    mockMediaFind.mockReturnValue(
      sortedLeanResult([
        {
          _id: assetId,
          workspaceId: "workspace-1",
          scenarioId,
          jobId,
          branchId: "vip",
          kind: "video",
          source: "vertex",
          url: "https://cdn.example.com/generated-vip.mp4",
          mimeType: "video/mp4",
          status: "complete",
        },
      ])
    );
    mockScenarioFindOne.mockReturnValue(
      leanResult({
        updatedAt,
        nodes: [
          {
            id: "node-bulk-root",
            type: "bulkNode",
            position: { x: 0, y: 0 },
            data: {
              kind: "bulk",
              bulkRootConfig: {
                workflowKind: "bulk_campaign",
                sendMode: "immediate",
                channels: ["whatsapp"],
                campaignName: "VIP",
                recipientSourceSummary: "1 recipient",
                generationStatus: "generating_media",
                generationJobId: jobId,
              },
            },
          },
          {
            id: "action-vip",
            type: "actionNode",
            position: { x: 240, y: 0 },
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: "vip_plans",
              actionWhatsAppTemplateLanguage: "en",
              actionWhatsAppTemplateComponents: components,
              actionWhatsAppTemplateButtonIds: buttonIds,
              generatedTemplateDraft: {
                id: "draft-1",
                name: "vip_plans",
                language: "en",
                status: "draft",
                components,
              },
              bulkRecipientBranchId: "vip",
            },
          },
        ],
      })
    );

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId }),
    });

    expect(response.status).toBe(200);
    expect(mockScenarioUpdateOne.mock.calls[0]?.[1]?.$set?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "action-vip",
          data: expect.objectContaining({
            actionWhatsAppTemplateComponents: [
              expect.objectContaining({ type: "HEADER", format: "VIDEO" }),
              ...components,
            ],
            actionWhatsAppTemplateButtonIds: buttonIds,
          }),
        }),
      ])
    );
  });
});
