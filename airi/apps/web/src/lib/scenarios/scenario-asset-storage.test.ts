import {
  configureCreativeAssetReadUrlPort,
  resetCreativeAssetReadUrlPortForTests,
} from "@icecore/airi-runtime/creative-asset-read-url";
import {
  decryptString,
  encryptString,
  type EncryptedString,
} from "@/lib/crypto";

const mockCanCallMediaApi = jest.fn();
const mockInitiateUpload = jest.fn();
const mockStatObject = jest.fn();
const mockDeleteObject = jest.fn();
const mockStoreBuffer = jest.fn();

jest.mock("@/lib/google/gcp-media-api", () => ({
  canCallGcpMediaApi: () => mockCanCallMediaApi(),
  createRemoteCreativeAssetUpload: (...args: unknown[]) =>
    mockInitiateUpload(...args),
  statRemoteCreativeAssetObject: (...args: unknown[]) =>
    mockStatObject(...args),
  deleteRemoteCreativeAssetObject: (...args: unknown[]) =>
    mockDeleteObject(...args),
  storeRemoteCreativeAssetBuffer: (...args: unknown[]) =>
    mockStoreBuffer(...args),
}));

import {
  completeScenarioAssetUpload,
  initiateScenarioAssetUpload,
  storeScenarioAssetBuffer,
} from "./scenario-asset-storage";

const WORKSPACE_ID = "workspace-1";
const REMOTE_BUCKET = "configured-media-api-bucket";
let REMOTE_PATH =
  "workspaces/workspace-1/creative-assets/video/scenario-aabbccddeeff0011/clip.mp4";
const FILE_SIZE = 4 * 1024 * 1024;
const metadata = {
  fileName: "clip.mp4",
  mimeType: "video/mp4",
  fileSize: FILE_SIZE,
  channel: "whatsapp" as const,
};

function readTicket(token: string): Record<string, unknown> {
  const envelope = JSON.parse(
    Buffer.from(token, "base64url").toString("utf8")
  ) as EncryptedString;
  return JSON.parse(decryptString(envelope)) as Record<string, unknown>;
}

function rewriteTicket(
  token: string,
  mutate: (ticket: Record<string, unknown>) => void
): string {
  const ticket = readTicket(token);
  mutate(ticket);
  return Buffer.from(
    JSON.stringify(encryptString(JSON.stringify(ticket))),
    "utf8"
  ).toString("base64url");
}

async function initiate() {
  return initiateScenarioAssetUpload({
    workspaceId: WORKSPACE_ID,
    ...metadata,
  });
}

describe("scenario direct upload storage", () => {
  const originalSecret = process.env.ENCRYPTION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
    process.env.ENCRYPTION_SECRET = "scenario-direct-upload-test-secret";
    REMOTE_PATH =
      "workspaces/workspace-1/creative-assets/video/scenario-aabbccddeeff0011/clip.mp4";
    mockCanCallMediaApi.mockReturnValue(true);
    mockDeleteObject.mockResolvedValue({
      provider: "gcs",
      bucket: REMOTE_BUCKET,
      path: REMOTE_PATH,
      deleted: true,
    });
    mockInitiateUpload.mockImplementation(async request => {
      REMOTE_PATH = `workspaces/${request.workspaceId}/creative-assets/${request.kind}/${request.assetId}/${request.fileName}`;
      return {
        provider: "gcs",
        method: "PUT",
        uploadUrl: "https://storage.googleapis.com/upload/session-1",
        bucket: REMOTE_BUCKET,
        path: REMOTE_PATH,
        expiresInSeconds: 7200,
        cacheControl: "public, max-age=3600",
      };
    });
    mockStatObject.mockResolvedValue({
      provider: "gcs",
      bucket: REMOTE_BUCKET,
      path: REMOTE_PATH,
      exists: true,
      fileSize: FILE_SIZE,
      mimeType: "video/mp4",
      updatedAt: "2026-10-03T12:00:01.000Z",
    });
    configureCreativeAssetReadUrlPort({
      async createReadUrl(request) {
        return {
          provider: "gcs",
          bucket: request.bucket,
          path: request.path,
          url: "https://signed.example/clip.mp4",
          expiresAt: "2026-10-03T13:00:00.000Z",
        };
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    resetCreativeAssetReadUrlPortForTests();
    if (originalSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = originalSecret;
  });

  it("initiates a video upload using normalized metadata and the remote target", async () => {
    const result = await initiateScenarioAssetUpload({
      workspaceId: WORKSPACE_ID,
      ...metadata,
      mimeType: " VIDEO/MP4; charset=binary ",
      origin: "https://airi.chat",
    });

    expect(result).toMatchObject({
      provider: "gcs",
      method: "PUT",
      uploadUrl: "https://storage.googleapis.com/upload/session-1",
      bucket: REMOTE_BUCKET,
      path: REMOTE_PATH,
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      fileSize: FILE_SIZE,
      mediaType: "video",
      uploadToken: expect.any(String),
    });
    expect(mockInitiateUpload).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      assetId: expect.stringMatching(/^scenario-[a-f0-9]+$/),
      kind: "video",
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      fileSize: FILE_SIZE,
      origin: "https://airi.chat",
    });
    expect(result.uploadToken).not.toContain(REMOTE_BUCKET);
    expect(result.uploadToken).not.toContain("session-1");
  });

  it("returns the initiated durable reference and a signed preview after stat", async () => {
    const upload = await initiate();
    await expect(
      completeScenarioAssetUpload({
        workspaceId: WORKSPACE_ID,
        uploadToken: upload.uploadToken,
      })
    ).resolves.toEqual({
      url: `gcs://${REMOTE_BUCKET}/${REMOTE_PATH}`,
      displayUrl: "https://signed.example/clip.mp4",
      bucket: REMOTE_BUCKET,
      path: REMOTE_PATH,
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      fileSize: FILE_SIZE,
      mediaType: "video",
    });
    expect(mockStatObject).toHaveBeenCalledWith({
      provider: "gcs",
      bucket: REMOTE_BUCKET,
      path: REMOTE_PATH,
      workspaceId: WORKSPACE_ID,
    });
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("rejects an unexpected Media API target before issuing a completion ticket", async () => {
    mockInitiateUpload.mockResolvedValueOnce({
      provider: "gcs",
      method: "PUT",
      uploadUrl: "https://storage.googleapis.com/upload/session-1",
      bucket: REMOTE_BUCKET,
      path: "workspaces/workspace-1/creative-assets/video/generated-a/clip.mp4",
      expiresInSeconds: 7200,
      cacheControl: "public, max-age=3600",
    });
    await expect(initiate()).rejects.toThrow(/target/i);
  });

  it("normalizes the provider MIME without requiring an exact header spelling", async () => {
    const upload = await initiate();
    mockStatObject.mockResolvedValueOnce({
      exists: true,
      fileSize: FILE_SIZE,
      mimeType: " VIDEO/MP4; charset=binary ",
    });
    await expect(
      completeScenarioAssetUpload({
        workspaceId: WORKSPACE_ID,
        uploadToken: upload.uploadToken,
      })
    ).resolves.toMatchObject({ mimeType: "video/mp4" });
  });

  it("rejects another workspace before it can stat the uploaded target", async () => {
    const upload = await initiate();
    await expect(
      completeScenarioAssetUpload({
        workspaceId: "workspace-2",
        uploadToken: upload.uploadToken,
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mockStatObject).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("rejects an expired ticket before stat", async () => {
    const upload = await initiate();
    jest.advanceTimersByTime(7200 * 1000);
    await expect(
      completeScenarioAssetUpload({
        workspaceId: WORKSPACE_ID,
        uploadToken: upload.uploadToken,
      })
    ).rejects.toMatchObject({ code: "scenario_asset_upload_rejected" });
    expect(mockStatObject).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("allows a completion retry within the ticket lifetime", async () => {
    const upload = await initiate();
    const first = await completeScenarioAssetUpload({
      workspaceId: WORKSPACE_ID,
      uploadToken: upload.uploadToken,
    });
    await expect(
      completeScenarioAssetUpload({
        workspaceId: WORKSPACE_ID,
        uploadToken: upload.uploadToken,
      })
    ).resolves.toEqual(first);
  });

  it.each(["iv", "tag", "ciphertext"] as const)(
    "rejects tampered encrypted %s before stat",
    async field => {
      const upload = await initiate();
      const envelope = JSON.parse(
        Buffer.from(upload.uploadToken, "base64url").toString("utf8")
      ) as EncryptedString;
      const bytes = Buffer.from(envelope[field], "base64");
      bytes[0] = bytes[0]! ^ 0xff;
      envelope[field] = bytes.toString("base64");
      const tampered = Buffer.from(JSON.stringify(envelope)).toString(
        "base64url"
      );
      await expect(
        completeScenarioAssetUpload({
          workspaceId: WORKSPACE_ID,
          uploadToken: tampered,
        })
      ).rejects.toMatchObject({ status: 400 });
      expect(mockStatObject).not.toHaveBeenCalled();
      expect(mockDeleteObject).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "wrong purpose",
      (ticket: Record<string, unknown>) => {
        ticket.purpose = "other-use";
      },
    ],
    [
      "wrong version",
      (ticket: Record<string, unknown>) => {
        ticket.v = 2;
      },
    ],
    [
      "missing expiry",
      (ticket: Record<string, unknown>) => {
        delete ticket.exp;
      },
    ],
    [
      "fractional expiry",
      (ticket: Record<string, unknown>) => {
        ticket.exp = Number(ticket.exp) + 0.5;
      },
    ],
    [
      "future issuance",
      (ticket: Record<string, unknown>) => {
        ticket.iat = Number(ticket.exp) + 60;
      },
    ],
    [
      "excessive lifetime",
      (ticket: Record<string, unknown>) => {
        ticket.exp = Number(ticket.iat) + 86400;
      },
    ],
    [
      "outside workspace path",
      (ticket: Record<string, unknown>) => {
        ticket.path =
          "workspaces/workspace-2/creative-assets/video/scenario-a/clip.mp4";
      },
    ],
    [
      "non-scenario creative asset path",
      (ticket: Record<string, unknown>) => {
        ticket.path =
          "workspaces/workspace-1/creative-assets/video/generated-a/clip.mp4";
      },
    ],
    [
      "unexpected metadata",
      (ticket: Record<string, unknown>) => {
        ticket.extra = "unrelated";
      },
    ],
  ])("rejects authenticated but invalid ticket: %s", async (_label, mutate) => {
    const upload = await initiate();
    const invalid = rewriteTicket(
      upload.uploadToken,
      mutate as (ticket: Record<string, unknown>) => void
    );
    await expect(
      completeScenarioAssetUpload({
        workspaceId: WORKSPACE_ID,
        uploadToken: invalid,
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mockStatObject).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it.each(["not-a-token", "a".repeat(16385)])(
    "rejects malformed or oversized token before stat",
    async uploadToken => {
      await expect(
        completeScenarioAssetUpload({ workspaceId: WORKSPACE_ID, uploadToken })
      ).rejects.toMatchObject({ status: 400 });
      expect(mockStatObject).not.toHaveBeenCalled();
      expect(mockDeleteObject).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["not found", { exists: false, fileSize: null, mimeType: null }],
    ["missing size", { exists: true, fileSize: null, mimeType: "video/mp4" }],
    ["missing MIME", { exists: true, fileSize: FILE_SIZE, mimeType: null }],
    ["zero size", { exists: true, fileSize: 0, mimeType: "video/mp4" }],
    [
      "fractional size",
      { exists: true, fileSize: FILE_SIZE + 0.5, mimeType: "video/mp4" },
    ],
    [
      "different size",
      { exists: true, fileSize: FILE_SIZE + 1, mimeType: "video/mp4" },
    ],
    [
      "different MIME",
      { exists: true, fileSize: FILE_SIZE, mimeType: "image/png" },
    ],
    [
      "generic MIME with valid filename",
      {
        exists: true,
        fileSize: FILE_SIZE,
        mimeType: "application/octet-stream",
      },
    ],
  ])("rejects storage object with %s", async (_label, stat) => {
    const upload = await initiate();
    mockStatObject.mockResolvedValueOnce(stat);
    await expect(
      completeScenarioAssetUpload({
        workspaceId: WORKSPACE_ID,
        uploadToken: upload.uploadToken,
      })
    ).rejects.toMatchObject({ status: 400 });
    if (stat.exists) {
      expect(mockDeleteObject).toHaveBeenCalledWith({
        provider: "gcs",
        bucket: upload.bucket,
        path: upload.path,
        workspaceId: WORKSPACE_ID,
      });
    } else {
      expect(mockDeleteObject).not.toHaveBeenCalled();
    }
  });

  it("returns too_large for a stored WhatsApp video above its limit", async () => {
    const upload = await initiate();
    mockStatObject.mockResolvedValueOnce({
      exists: true,
      fileSize: 17 * 1024 * 1024,
      mimeType: "video/mp4",
    });
    await expect(
      completeScenarioAssetUpload({
        workspaceId: WORKSPACE_ID,
        uploadToken: upload.uploadToken,
      })
    ).rejects.toMatchObject({ code: "scenario_asset_upload_too_large" });
    expect(mockDeleteObject).toHaveBeenCalledWith({
      provider: "gcs",
      bucket: upload.bucket,
      path: upload.path,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("does not delete when storage stat fails before confirming the object", async () => {
    const upload = await initiate();
    mockStatObject.mockRejectedValueOnce(new Error("Storage stat unavailable"));
    await expect(
      completeScenarioAssetUpload({
        workspaceId: WORKSPACE_ID,
        uploadToken: upload.uploadToken,
      })
    ).rejects.toThrow("Storage stat unavailable");
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("keeps a valid object when its preview signer fails", async () => {
    const upload = await initiate();
    configureCreativeAssetReadUrlPort({
      async createReadUrl() {
        throw new Error("Preview signer unavailable");
      },
    });
    await expect(
      completeScenarioAssetUpload({
        workspaceId: WORKSPACE_ID,
        uploadToken: upload.uploadToken,
      })
    ).rejects.toThrow("Preview signer unavailable");
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing metadata",
      { exists: true, fileSize: null, mimeType: "video/mp4" },
      400,
      "scenario_asset_upload_rejected",
    ],
    [
      "size mismatch",
      { exists: true, fileSize: FILE_SIZE + 1, mimeType: "video/mp4" },
      400,
      "scenario_asset_upload_rejected",
    ],
    [
      "over-limit size",
      { exists: true, fileSize: 17 * 1024 * 1024, mimeType: "video/mp4" },
      413,
      "scenario_asset_upload_too_large",
    ],
  ])(
    "retains the %s error when rejection cleanup fails",
    async (_label, stat, status, code) => {
      const upload = await initiate();
      mockStatObject.mockResolvedValueOnce(stat);
      mockDeleteObject.mockRejectedValueOnce(
        new Error("Storage cleanup unavailable")
      );
      await expect(
        completeScenarioAssetUpload({
          workspaceId: WORKSPACE_ID,
          uploadToken: upload.uploadToken,
        })
      ).rejects.toMatchObject({ status, code });
      expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    }
  );

  it("preserves the existing buffer upload result through the same preview port", async () => {
    mockStoreBuffer.mockResolvedValueOnce({
      provider: "gcs",
      url: `gcs://${REMOTE_BUCKET}/${REMOTE_PATH}`,
      bucket: REMOTE_BUCKET,
      path: REMOTE_PATH,
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      fileSize: 4,
    });
    await expect(
      storeScenarioAssetBuffer({
        workspaceId: WORKSPACE_ID,
        buffer: Buffer.from("clip"),
        mimeType: "video/mp4",
        fileName: "clip.mp4",
      })
    ).resolves.toEqual({
      url: `gcs://${REMOTE_BUCKET}/${REMOTE_PATH}`,
      displayUrl: "https://signed.example/clip.mp4",
      bucket: REMOTE_BUCKET,
      path: REMOTE_PATH,
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      fileSize: 4,
    });
  });
});
