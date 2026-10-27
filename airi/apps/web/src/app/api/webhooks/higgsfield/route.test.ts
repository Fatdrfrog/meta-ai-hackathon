const mockConnectDB = jest.fn();
const mockFindOne = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();
const mockUpdateMany = jest.fn();
const mockRecordVideoGenerationNsfwVerdict = jest.fn();
const mockMarkVideoGenerationNsfwVerdictSweepCompleted = jest.fn();
const mockSignalHiggsfieldAssetGenerationWorkflow = jest.fn();
const mockSignalVideoGenerationWorkflow = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/temporal/higgsfield-assets", () => ({
  signalHiggsfieldAssetGenerationWorkflow: (...args: unknown[]) =>
    mockSignalHiggsfieldAssetGenerationWorkflow(...args),
}));

jest.mock("@/lib/temporal/video-generation", () => ({
  signalVideoGenerationWorkflow: (...args: unknown[]) =>
    mockSignalVideoGenerationWorkflow(...args),
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
  },
}));

jest.mock("@/lib/creative-assets/video-generation-nsfw-verdict-store", () => ({
  markVideoGenerationNsfwVerdictSweepCompleted: (...args: unknown[]) =>
    mockMarkVideoGenerationNsfwVerdictSweepCompleted(...args),
  recordVideoGenerationNsfwVerdict: (...args: unknown[]) =>
    mockRecordVideoGenerationNsfwVerdict(...args),
}));

import { signHiggsfieldWebhookToken } from "@/lib/higgsfield/higgsfield-webhook";
import { POST } from "./route";

function leanResult<T>(value: T) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

function contractV1Asset(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    _id: assetIdForFixture,
    workspaceId: "workspace-1",
    kind: "video",
    status: "queued",
    providerRequestId: "request-1",
    generation: {
      contractVersion: 1,
      webhookSignalKeys: [],
      spec: { provider: "higgsfield" },
      orchestration: { workflowId: `video-generation:${assetIdForFixture}` },
      submission: {
        attemptToken: "attempt-1",
        providerRequestId: "request-1",
      },
    },
    ...overrides,
  };
}

const assetIdForFixture = "64c13ab08edf48a008793cab";

describe("POST /api/webhooks/higgsfield", () => {
  const originalEnv = process.env;
  const assetId = "64c13ab08edf48a008793cab";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      HIGGSFIELD_WEBHOOK_SECRET: "webhook-secret",
      NEXT_PUBLIC_APP_URL: "https://app.airi.chat",
    };
    mockConnectDB.mockResolvedValue(undefined);
    mockSignalHiggsfieldAssetGenerationWorkflow.mockResolvedValue({
      workflowId: "higgsfield-asset:asset-1",
    });
    mockSignalVideoGenerationWorkflow.mockResolvedValue(undefined);
    mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockUpdateMany.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockRecordVideoGenerationNsfwVerdict.mockResolvedValue({
      _id: "marker-1",
      providerRequestId: "request-1",
      sourceAssetId: assetId,
      sourceAttemptToken: "attempt-1",
      firstReceivedAt: new Date("2026-07-23T12:00:00.000Z"),
    });
    mockMarkVideoGenerationNsfwVerdictSweepCompleted.mockResolvedValue(
      undefined
    );
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects oversized authenticated payloads before opening Mongo", async () => {
    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          headers: { "Content-Length": String(256 * 1024 + 1) },
          body: "{}",
        }
      ) as never
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Higgsfield webhook payload is too large",
    });
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it("signals completed Higgsfield video output to the Temporal workflow", async () => {
    mockFindOne.mockReturnValue(
      leanResult({
        _id: "asset-1",
        workspaceId: "workspace-1",
        kind: "video",
        status: "queued",
        providerRequestId: "request-1",
      })
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "completed",
            request_id: "request-1",
            video: { url: "https://higgsfield.example.com/output.mp4" },
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mockSignalHiggsfieldAssetGenerationWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId,
        webhook: expect.objectContaining({
          requestId: "request-1",
          status: "completed",
          payload: expect.objectContaining({
            video: { url: "https://higgsfield.example.com/output.mp4" },
          }),
        }),
      })
    );
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("persists a sanitized contract-v1 diagnostic before signaling bounded status", async () => {
    mockFindOne.mockReturnValue(leanResult(contractV1Asset()));

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "completed",
            request_id: "request-1",
            authorization: "Bearer secret",
            video: {
              url: "https://cdn.higgsfield.ai/output.mp4?token=secret",
            },
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        _id: assetId,
        workspaceId: "workspace-1",
        status: { $in: ["queued", "in_progress"] },
        "generation.contractVersion": 1,
        "generation.webhookSignalKeys": {
          $nin: ["request-1:completed"],
        },
        "generation.webhookSignalKeys.6": { $exists: false },
        "generation.submission.attemptToken": "attempt-1",
        "generation.submission.providerRequestId": "request-1",
      },
      {
        $set: expect.objectContaining({
          providerPayload: {
            status: "completed",
            request_id: "request-1",
          },
        }),
        $addToSet: {
          "generation.webhookSignalKeys": "request-1:completed",
        },
      }
    );
    expect(mockSignalVideoGenerationWorkflow).toHaveBeenCalledWith({
      workflowId: `video-generation:${assetId}`,
      signal: {
        contractVersion: 1,
        assetId,
        providerRequestId: "request-1",
        status: "completed",
        receivedAt: expect.any(String),
      },
    });
    expect(mockUpdateOne.mock.invocationCallOrder[0]).toBeLessThan(
      mockSignalVideoGenerationWorkflow.mock.invocationCallOrder[0]
    );
    expect(mockSignalHiggsfieldAssetGenerationWorkflow).not.toHaveBeenCalled();
  });

  it.each(["dispatching", "unknown"] as const)(
    "CAS-adopts an authenticated late request from an ambiguous %s submission",
    async submissionState => {
      mockFindOne.mockReturnValue(
        leanResult(
          contractV1Asset({
            status: submissionState === "unknown" ? "failed" : "queued",
            providerRequestId: null,
            providerStatusUrl: null,
            generation: {
              contractVersion: 1,
              webhookSignalKeys: [],
              spec: { provider: "higgsfield" },
              orchestration: {
                workflowId: `video-generation:${assetId}`,
              },
              submission: {
                state: submissionState,
                attemptToken: "attempt-1",
                providerRequestId: null,
                submittedAt: null,
              },
              failure:
                submissionState === "unknown"
                  ? {
                      phase: "submit",
                      code: "provider_submission_uncertain",
                      providerCode: null,
                      message: "Submission outcome is unknown",
                      retryable: true,
                      submissionUncertain: true,
                      failedAt: new Date("2026-07-23T09:00:00.000Z"),
                    }
                  : null,
            },
          })
        )
      );

      const token = signHiggsfieldWebhookToken(assetId);
      const response = await POST(
        new Request(
          `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
          {
            method: "POST",
            body: JSON.stringify({
              status: "completed",
              request_id: "late-request-1",
            }),
          }
        ) as never
      );

      expect(response.status).toBe(200);
      expect(mockUpdateOne).toHaveBeenCalledWith(
        {
          _id: assetId,
          workspaceId: "workspace-1",
          status: submissionState === "unknown" ? "failed" : "queued",
          providerRequestId: null,
          providerStatusUrl: null,
          "generation.contractVersion": 1,
          "generation.spec.provider": "higgsfield",
          "generation.submission.state": submissionState,
          "generation.submission.attemptToken": "attempt-1",
          "generation.submission.providerRequestId": null,
        },
        [
          {
            $set: expect.objectContaining({
              providerRequestId: "late-request-1",
              providerStatusUrl: "late-request-1",
              "generation.submission.state": "submitted",
              "generation.submission.providerRequestId": "late-request-1",
              "generation.submission.submittedAt": expect.any(Date),
              "generation.webhookSignalKeys": expect.any(Object),
            }),
          },
        ]
      );
      const adoption = mockUpdateOne.mock.calls[0]?.[1] as Array<{
        $set?: Record<string, unknown>;
      }>;
      if (submissionState === "unknown") {
        expect(adoption[0]?.$set?.status).toBe("failed");
        expect(adoption[0]?.$set?.["generation.failure"]).toEqual(
          expect.objectContaining({
            phase: "poll",
            code: "provider_result_recovery_required",
            retryable: true,
            submissionUncertain: false,
          })
        );
      } else {
        expect(adoption[0]?.$set?.status).toBe("in_progress");
        expect(adoption[0]?.$set?.["generation.failure"]).toBeNull();
      }
      expect(mockSignalVideoGenerationWorkflow).toHaveBeenCalledWith({
        workflowId: `video-generation:${assetId}`,
        signal: {
          contractVersion: 1,
          assetId,
          providerRequestId: "late-request-1",
          status: "completed",
          receivedAt: expect.any(String),
        },
      });
      expect(mockRecordVideoGenerationNsfwVerdict).not.toHaveBeenCalled();
    }
  );

  it("rejects late request adoption when the top-level provider identity differs", async () => {
    mockFindOne.mockReturnValue(
      leanResult(
        contractV1Asset({
          status: "failed",
          providerRequestId: "different-request",
          providerStatusUrl: "different-request",
          generation: {
            contractVersion: 1,
            webhookSignalKeys: [],
            spec: { provider: "higgsfield" },
            orchestration: { workflowId: `video-generation:${assetId}` },
            submission: {
              state: "unknown",
              attemptToken: "attempt-1",
              providerRequestId: null,
            },
          },
        })
      )
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "completed",
            request_id: "late-request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(409);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockSignalVideoGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("does not mutate or signal terminal contract-v1 assets", async () => {
    mockFindOne.mockReturnValue(
      leanResult(contractV1Asset({ status: "complete" }))
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "completed",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", duplicate: true });
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockSignalVideoGenerationWorkflow).not.toHaveBeenCalled();
  });

  it.each(["queued", "in_progress", "complete", "failed"])(
    "atomically persists an nsfw safety override from %s",
    async status => {
      mockFindOne.mockReturnValue(
        leanResult(
          contractV1Asset({
            status,
            url: "gcs://creative-assets/generated/output.mp4",
            storageProvider: "gcs",
            bucket: "creative-assets",
            path: "generated/output.mp4",
            mimeType: "video/mp4",
            fileName: "output.mp4",
            fileSize: 1234,
            completedAt: new Date("2026-07-23T10:00:00.000Z"),
            generation: {
              contractVersion: 1,
              webhookSignalKeys: ["request-1:queued", "request-1:in_progress"],
              spec: { provider: "higgsfield" },
              orchestration: {
                workflowId: `video-generation:${assetId}`,
              },
              submission: {
                attemptToken: "attempt-1",
                providerRequestId: "request-1",
              },
              result: {
                durationSeconds: 5,
                width: 720,
                height: 1280,
                mimeType: "video/mp4",
                fileSize: 1234,
                sha256: "a".repeat(64),
                providerUsage: null,
                warnings: [],
                startedAt: null,
                completedAt: new Date("2026-07-23T10:00:00.000Z"),
              },
            },
          })
        )
      );

      const token = signHiggsfieldWebhookToken(assetId);
      const response = await POST(
        new Request(
          `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
          {
            method: "POST",
            body: JSON.stringify({
              status: "nsfw",
              request_id: "request-1",
              authorization: "Bearer secret",
              video: {
                url: "https://cdn.higgsfield.ai/output.mp4?token=secret",
              },
            }),
          }
        ) as never
      );

      expect(response.status).toBe(200);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        {
          workspaceId: "workspace-1",
          status: { $in: ["queued", "in_progress", "complete", "failed"] },
          "generation.contractVersion": 1,
          "generation.spec.provider": "higgsfield",
          $or: [
            {
              providerRequestId: "request-1",
              "generation.submission.providerRequestId": "request-1",
            },
            {
              "generation.safetyProviderRequestIds": "request-1",
            },
            {
              "generation.safetyAncestors": {
                $elemMatch: {
                  assetId,
                  attemptToken: "attempt-1",
                },
              },
            },
          ],
        },
        [
          {
            $set: expect.objectContaining({
              status: "nsfw",
              providerPayload: {
                $literal: {
                  status: "nsfw",
                  request_id: "request-1",
                },
              },
              "generation.result": null,
              "generation.failure": expect.objectContaining({
                phase: "poll",
                code: "provider_nsfw",
                providerCode: "nsfw",
                message:
                  "Provider rejected the video because of its safety policy",
                retryable: false,
                submissionUncertain: false,
                failedAt: expect.any(Date),
              }),
              error: "Provider rejected the video because of its safety policy",
              url: null,
              mimeType: null,
              fileName: null,
              fileSize: null,
              completedAt: null,
              updatedAt: expect.any(Date),
              "generation.webhookSignalKeys": expect.any(Object),
            }),
          },
        ]
      );
      const updatePipeline = mockUpdateMany.mock.calls[0]?.[1] as Array<{
        $set?: Record<string, unknown>;
      }>;
      expect(updatePipeline[0]?.$set).not.toHaveProperty("storageProvider");
      expect(updatePipeline[0]?.$set).not.toHaveProperty("bucket");
      expect(updatePipeline[0]?.$set).not.toHaveProperty("path");
      expect(mockSignalVideoGenerationWorkflow).toHaveBeenCalledWith({
        workflowId: `video-generation:${assetId}`,
        signal: {
          contractVersion: 1,
          assetId,
          providerRequestId: "request-1",
          status: "nsfw",
          receivedAt: expect.any(String),
        },
      });
      expect(mockRecordVideoGenerationNsfwVerdict).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        providerRequestId: "request-1",
        sourceAssetId: assetId,
        sourceAttemptToken: "attempt-1",
        receivedAt: expect.any(Date),
      });
      expect(
        mockRecordVideoGenerationNsfwVerdict.mock.invocationCallOrder[0]
      ).toBeLessThan(mockUpdateMany.mock.invocationCallOrder[0]!);
    }
  );

  it("propagates a late nsfw verdict from an already-nsfw target to every request alias", async () => {
    mockFindOne.mockReturnValue(
      leanResult(contractV1Asset({ status: "nsfw" }))
    );
    mockUpdateMany.mockResolvedValueOnce({ matchedCount: 2, modifiedCount: 2 });

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "nsfw",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        status: { $in: ["queued", "in_progress", "complete", "failed"] },
        "generation.contractVersion": 1,
        "generation.spec.provider": "higgsfield",
        $or: [
          {
            providerRequestId: "request-1",
            "generation.submission.providerRequestId": "request-1",
          },
          {
            "generation.safetyProviderRequestIds": "request-1",
          },
          {
            "generation.safetyAncestors": {
              $elemMatch: {
                assetId,
                attemptToken: "attempt-1",
              },
            },
          },
        ],
      },
      expect.any(Array)
    );
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("records an ambiguous late nsfw identity before adopting and sweeping descendants", async () => {
    mockFindOne.mockReturnValue(
      leanResult(
        contractV1Asset({
          status: "failed",
          providerRequestId: null,
          providerStatusUrl: null,
          generation: {
            contractVersion: 1,
            webhookSignalKeys: [],
            spec: { provider: "higgsfield" },
            orchestration: {
              workflowId: `video-generation:${assetId}`,
            },
            submission: {
              state: "unknown",
              attemptToken: "attempt-1",
              providerRequestId: null,
              submittedAt: null,
            },
            failure: {
              phase: "submit",
              code: "provider_submission_uncertain",
              providerCode: null,
              message: "Submission outcome is unknown",
              retryable: true,
              submissionUncertain: true,
              failedAt: new Date("2026-07-23T09:00:00.000Z"),
            },
          },
        })
      )
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "nsfw",
            request_id: "late-request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mockRecordVideoGenerationNsfwVerdict).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      providerRequestId: "late-request-1",
      sourceAssetId: assetId,
      sourceAttemptToken: "attempt-1",
      receivedAt: expect.any(Date),
    });
    expect(
      mockRecordVideoGenerationNsfwVerdict.mock.invocationCallOrder[0]
    ).toBeLessThan(mockUpdateOne.mock.invocationCallOrder[0]!);
    expect(mockUpdateOne.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateMany.mock.invocationCallOrder[0]!
    );
    expect(
      mockMarkVideoGenerationNsfwVerdictSweepCompleted
    ).toHaveBeenCalledWith({
      markerId: "marker-1",
      workspaceId: "workspace-1",
      providerRequestId: "late-request-1",
      completedAt: expect.any(Date),
    });
    expect(mockUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockMarkVideoGenerationNsfwVerdictSweepCompleted.mock
        .invocationCallOrder[0]!
    );
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        $or: expect.arrayContaining([
          {
            "generation.safetyAncestors": {
              $elemMatch: {
                assetId,
                attemptToken: "attempt-1",
              },
            },
          },
        ]),
      }),
      expect.any(Array)
    );
  });

  it("leaves a pre-adoption nsfw marker pending when identity adoption loses its CAS", async () => {
    mockFindOne
      .mockReturnValueOnce(
        leanResult(
          contractV1Asset({
            status: "failed",
            providerRequestId: null,
            providerStatusUrl: null,
            generation: {
              contractVersion: 1,
              webhookSignalKeys: [],
              spec: { provider: "higgsfield" },
              orchestration: {
                workflowId: `video-generation:${assetId}`,
              },
              submission: {
                state: "unknown",
                attemptToken: "attempt-1",
                providerRequestId: null,
                submittedAt: null,
              },
            },
          })
        )
      )
      .mockReturnValueOnce(leanResult(null));
    mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "nsfw",
            request_id: "late-request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(409);
    expect(mockRecordVideoGenerationNsfwVerdict).toHaveBeenCalledTimes(1);
    expect(
      mockRecordVideoGenerationNsfwVerdict.mock.invocationCallOrder[0]
    ).toBeLessThan(mockUpdateOne.mock.invocationCallOrder[0]!);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(
      mockMarkVideoGenerationNsfwVerdictSweepCompleted
    ).not.toHaveBeenCalled();
  });

  it("keeps the durable verdict when the descendant sweep must be retried", async () => {
    mockFindOne.mockReturnValue(leanResult(contractV1Asset()));
    mockUpdateMany.mockRejectedValueOnce(new Error("mongo unavailable"));

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "nsfw",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(500);
    expect(mockRecordVideoGenerationNsfwVerdict).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(
      mockMarkVideoGenerationNsfwVerdictSweepCompleted
    ).not.toHaveBeenCalled();
    expect(mockSignalVideoGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("keeps a bounded durable nsfw override when Temporal signaling is deferred", async () => {
    mockFindOne.mockReturnValue(
      leanResult(
        contractV1Asset({
          status: "complete",
          generation: {
            contractVersion: 1,
            webhookSignalKeys: [
              "request-1:queued",
              "request-1:in_progress",
              "request-1:completed",
              "old-1",
              "old-2",
              "old-3",
            ],
            spec: { provider: "higgsfield" },
            orchestration: { workflowId: `video-generation:${assetId}` },
            submission: {
              attemptToken: "attempt-1",
              providerRequestId: "request-1",
            },
          },
        })
      )
    );
    mockSignalVideoGenerationWorkflow.mockRejectedValueOnce(
      new Error("Temporal unavailable")
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "nsfw",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      deferred: true,
    });
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const update = mockUpdateMany.mock.calls[0]?.[1] as Array<{
      $set?: Record<string, unknown>;
    }>;
    expect(update[0]?.$set?.status).toBe("nsfw");
    expect(update[0]?.$set?.["generation.webhookSignalKeys"]).toEqual({
      $let: {
        vars: {
          keys: { $ifNull: ["$generation.webhookSignalKeys", []] },
        },
        in: {
          $slice: [
            {
              $cond: [
                { $in: [{ $literal: "request-1:nsfw" }, "$$keys"] },
                "$$keys",
                {
                  $concatArrays: ["$$keys", { $literal: ["request-1:nsfw"] }],
                },
              ],
            },
            -6,
          ],
        },
      },
    });
  });

  it("dedupes a previously seen status after provider statuses alternate", async () => {
    mockFindOne.mockReturnValue(
      leanResult(
        contractV1Asset({
          generation: {
            contractVersion: 1,
            webhookSignalKeys: ["request-1:in_progress", "request-1:queued"],
            spec: { provider: "higgsfield" },
            orchestration: { workflowId: `video-generation:${assetId}` },
            submission: {
              attemptToken: "attempt-1",
              providerRequestId: "request-1",
            },
          },
        })
      )
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "in_progress",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", duplicate: true });
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockSignalVideoGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("accepts a claimed status when Temporal signaling is deferred", async () => {
    mockFindOne.mockReturnValue(leanResult(contractV1Asset()));
    mockSignalVideoGenerationWorkflow.mockRejectedValueOnce(
      new Error("Temporal unavailable")
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "in_progress",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      deferred: true,
    });
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("treats a terminal CAS winner as a duplicate without signaling", async () => {
    mockFindOne
      .mockReturnValueOnce(leanResult(contractV1Asset()))
      .mockReturnValueOnce(leanResult(contractV1Asset({ status: "complete" })));
    mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "completed",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", duplicate: true });
    expect(mockFindOne).toHaveBeenCalledTimes(2);
    expect(mockSignalVideoGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("treats an already-claimed CAS winner as a duplicate", async () => {
    const claimedAsset = contractV1Asset({
      generation: {
        contractVersion: 1,
        webhookSignalKeys: ["request-1:completed"],
        spec: { provider: "higgsfield" },
        orchestration: { workflowId: `video-generation:${assetId}` },
        submission: {
          attemptToken: "attempt-1",
          providerRequestId: "request-1",
        },
      },
    });
    mockFindOne
      .mockReturnValueOnce(leanResult(contractV1Asset()))
      .mockReturnValueOnce(leanResult(claimedAsset));
    mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "completed",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", duplicate: true });
    expect(mockSignalVideoGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("returns a conflict when a different nonterminal state wins the CAS", async () => {
    const changedAsset = contractV1Asset({
      generation: {
        contractVersion: 1,
        webhookSignalKeys: ["request-1:in_progress"],
        spec: { provider: "higgsfield" },
        orchestration: { workflowId: `video-generation:${assetId}` },
        submission: {
          attemptToken: "attempt-1",
          providerRequestId: "request-1",
        },
      },
    });
    mockFindOne
      .mockReturnValueOnce(leanResult(contractV1Asset()))
      .mockReturnValueOnce(leanResult(changedAsset));
    mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "completed",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(409);
    expect(mockFindOne).toHaveBeenCalledTimes(2);
    expect(mockSignalVideoGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("strictly rejects unknown contract-v1 statuses without signaling", async () => {
    mockFindOne.mockReturnValue(
      leanResult({
        _id: assetId,
        workspaceId: "workspace-1",
        kind: "video",
        status: "queued",
        providerRequestId: "request-1",
        generation: {
          contractVersion: 1,
          spec: { provider: "higgsfield" },
          orchestration: { workflowId: `video-generation:${assetId}` },
          submission: {
            attemptToken: "attempt-1",
            providerRequestId: "request-1",
          },
        },
      })
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "surprisingly_done",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(400);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockSignalVideoGenerationWorkflow).not.toHaveBeenCalled();
    expect(mockSignalHiggsfieldAssetGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("rejects callbacks whose request id does not match the queued asset", async () => {
    mockFindOne.mockReturnValue(
      leanResult({
        _id: "asset-1",
        workspaceId: "workspace-1",
        kind: "image",
        status: "queued",
        providerRequestId: "request-1",
      })
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "completed",
            request_id: "request-2",
            images: [{ url: "https://higgsfield.example.com/output.jpg" }],
          }),
        }
      ) as never
    );

    expect(response.status).toBe(409);
    expect(mockSignalHiggsfieldAssetGenerationWorkflow).not.toHaveBeenCalled();
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("signals nsfw callbacks to Temporal without storing media in the route", async () => {
    mockFindOne.mockReturnValue(
      leanResult({
        _id: "asset-1",
        workspaceId: "workspace-1",
        kind: "image",
        status: "queued",
        providerRequestId: "request-1",
      })
    );

    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "nsfw",
            request_id: "request-1",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mockSignalHiggsfieldAssetGenerationWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId,
        webhook: expect.objectContaining({
          requestId: "request-1",
          status: "nsfw",
        }),
      })
    );
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const token = signHiggsfieldWebhookToken(assetId);
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=${token}`,
        {
          method: "POST",
          body: "{",
        }
      ) as never
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it("returns 503 when webhook signing config is missing", async () => {
    delete process.env.HIGGSFIELD_WEBHOOK_SECRET;
    const response = await POST(
      new Request(
        `http://localhost/api/webhooks/higgsfield?assetId=${assetId}&token=bad`,
        {
          method: "POST",
          body: "{}",
        }
      ) as never
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Higgsfield webhook is not configured",
    });
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed asset ids before querying Mongo", async () => {
    const response = await POST(
      new Request(
        "http://localhost/api/webhooks/higgsfield?assetId=asset-1&token=bad",
        {
          method: "POST",
          body: "{}",
        }
      ) as never
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid asset id" });
    expect(mockConnectDB).not.toHaveBeenCalled();
  });
});
