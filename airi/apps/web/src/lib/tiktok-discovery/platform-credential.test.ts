const encrypted = {
  iv: Buffer.alloc(12, 1).toString("base64"),
  tag: Buffer.alloc(16, 2).toString("base64"),
  ciphertext: Buffer.from("secret").toString("base64"),
};
const mockConnectDB = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockUpdateOne = jest.fn();
const mockEncryptString = jest.fn((_value: string) => encrypted);
const mockDecryptString = jest.fn(
  (_value: typeof encrypted) => "decrypted-token"
);

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/models/tiktok-platform-credential", () => ({
  TikTokPlatformCredential: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
  ensureTikTokPlatformCredentialIndexes: jest.fn(),
}));
jest.mock("@/lib/crypto", () => ({
  encryptString: (value: string) => mockEncryptString(value),
  decryptString: (value: typeof encrypted) => mockDecryptString(value),
}));

import {
  loadTikTokPlatformCredentialForGeneration,
  markTikTokPlatformCredentialFailure,
  markTikTokPlatformCredentialValidated,
  readTikTokPlatformCredentialStatus,
  replaceTikTokPlatformCredential,
} from "./platform-credential";

const validRecord = {
  key: "primary",
  generation: "a".repeat(32),
  encryptedAccessToken: encrypted,
  selectedAdvertiserId: "123456789",
  authorizedAdvertiserCount: 1,
  grantedScopes: ["18000000"],
  connectedByUserId: "user-1",
  connectedAt: new Date("2026-08-13T00:00:00.000Z"),
  lastValidatedAt: null,
  status: "connected",
  lastErrorCode: null,
};

function hydratedRecord(change: Record<string, unknown> = {}) {
  const record = { ...validRecord, ...change };
  return { ...record, toObject: () => record };
}

beforeEach(() => {
  mockConnectDB.mockReset().mockResolvedValue(undefined);
  mockFindOneAndUpdate.mockReset();
  mockFindOne.mockReset();
  mockUpdateOne.mockReset();
  mockEncryptString.mockReset().mockReturnValue(encrypted);
  mockDecryptString.mockReset().mockReturnValue("decrypted-token");
});

describe("TikTok platform credential persistence", () => {
  it("encrypts replacements and fences status mutations by generation", async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce(
      hydratedRecord({ generation: "b".repeat(32) })
    );
    mockUpdateOne.mockResolvedValueOnce({ matchedCount: 1 });

    const result = await replaceTikTokPlatformCredential({
      accessToken: "provider-secret",
      selectedAdvertiserId: "123456789",
      authorizedAdvertiserCount: 1,
      grantedScopes: ["18000000"],
      connectedByUserId: "user-1",
      now: new Date("2026-08-13T00:00:00.000Z"),
    });

    expect(mockEncryptString).toHaveBeenCalledWith("provider-secret");
    expect(JSON.stringify(mockFindOneAndUpdate.mock.calls[0])).not.toContain(
      "provider-secret"
    );
    expect(mockFindOneAndUpdate.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true,
      })
    );
    expect(result.generation).toBe("b".repeat(32));

    await markTikTokPlatformCredentialValidated({
      generation: "b".repeat(32),
      validatedAt: new Date("2026-08-13T12:00:00.000Z"),
    });
    expect(mockUpdateOne.mock.calls[0][0]).toEqual({
      key: "primary",
      generation: "b".repeat(32),
    });
    expect(mockUpdateOne.mock.calls[0][2]).toEqual({ runValidators: true });
  });

  it("recovers an upsert duplicate race by updating the canonical singleton", async () => {
    mockFindOneAndUpdate
      .mockRejectedValueOnce(
        Object.assign(new Error("duplicate"), { code: 11000 })
      )
      .mockResolvedValueOnce(hydratedRecord({ generation: "b".repeat(32) }));

    const result = await replaceTikTokPlatformCredential({
      accessToken: "provider-secret",
      selectedAdvertiserId: "123456789",
      authorizedAdvertiserCount: 1,
      grantedScopes: [],
      connectedByUserId: "user-1",
    });

    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockFindOneAndUpdate.mock.calls[1][0]).toEqual({ key: "primary" });
    expect(mockFindOneAndUpdate.mock.calls[1][2]).toEqual(
      expect.objectContaining({ runValidators: true, upsert: false })
    );
    expect(result.generation).toBe("b".repeat(32));
  });

  it("returns a token-free safe status record", async () => {
    mockFindOne.mockResolvedValue(hydratedRecord());

    await expect(readTikTokPlatformCredentialStatus()).resolves.toEqual({
      generation: "a".repeat(32),
      advertiserId: "123456789",
      authorizedAdvertiserCount: 1,
      grantedScopes: ["18000000"],
      connectedByUserId: "user-1",
      connectedAt: new Date("2026-08-13T00:00:00.000Z"),
      lastValidatedAt: null,
      status: "connected",
      lastErrorCode: null,
    });
    expect(
      JSON.stringify(await readTikTokPlatformCredentialStatus())
    ).not.toContain("encryptedAccessToken");
  });

  it("loads only the observed connected generation and decrypts it", async () => {
    mockFindOne.mockResolvedValue(hydratedRecord());

    await expect(
      loadTikTokPlatformCredentialForGeneration({ generation: "a".repeat(32) })
    ).resolves.toEqual({
      status: "ready",
      generation: "a".repeat(32),
      advertiserId: "123456789",
      accessToken: "decrypted-token",
    });
    expect(mockDecryptString).toHaveBeenCalledWith(encrypted);

    await expect(
      loadTikTokPlatformCredentialForGeneration({ generation: "b".repeat(32) })
    ).resolves.toEqual({ status: "changed" });
  });

  it("does not decrypt a reconnect-required credential", async () => {
    mockFindOne.mockResolvedValue(
      hydratedRecord({
        status: "reconnect_required",
        lastErrorCode: "reconnect_required",
      })
    );

    await expect(
      loadTikTokPlatformCredentialForGeneration({ generation: "a".repeat(32) })
    ).resolves.toEqual({ status: "reconnect_required" });
    expect(mockDecryptString).not.toHaveBeenCalled();
  });

  it("fails closed when the encrypted token cannot be decrypted", async () => {
    mockFindOne.mockResolvedValue(hydratedRecord());
    mockDecryptString.mockImplementation(() => {
      throw new Error("bad ciphertext");
    });

    await expect(
      loadTikTokPlatformCredentialForGeneration({ generation: "a".repeat(32) })
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("maps Mongo read failures to infrastructure unavailable", async () => {
    mockFindOne.mockRejectedValue(new Error("mongo offline"));

    await expect(
      loadTikTokPlatformCredentialForGeneration({ generation: "a".repeat(32) })
    ).resolves.toEqual({ status: "infrastructure_unavailable" });
  });

  it("validation clears the prior safe error only for the observed generation", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    const validatedAt = new Date("2026-08-13T12:00:00Z");

    await expect(
      markTikTokPlatformCredentialValidated({
        generation: "a".repeat(32),
        validatedAt,
      })
    ).resolves.toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { key: "primary", generation: "a".repeat(32) },
      {
        $set: {
          lastValidatedAt: validatedAt,
          status: "connected",
          lastErrorCode: null,
        },
      },
      { runValidators: true }
    );
  });

  it("records only a safe failure for the observed generation", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });

    await expect(
      markTikTokPlatformCredentialFailure({
        generation: "a".repeat(32),
        status: "reconnect_required",
        errorCode: "reconnect_required",
      })
    ).resolves.toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { key: "primary", generation: "a".repeat(32) },
      {
        $set: {
          status: "reconnect_required",
          lastErrorCode: "reconnect_required",
        },
      },
      { runValidators: true }
    );
  });
});
