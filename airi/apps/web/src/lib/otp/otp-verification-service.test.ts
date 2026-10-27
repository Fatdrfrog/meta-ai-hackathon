const mockConnectDB = jest.fn();
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn(
  (_filter?: unknown, _update?: unknown, _options?: unknown) => ({
    lean: (...args: unknown[]) => mockFindOneAndUpdateLean(...args),
  })
);
const mockFindOneAndUpdateLean = jest.fn();
const mockUpdateOne = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/otp-challenge", () => ({
  OtpChallengeModel: {
    findOne: (filter: unknown) => mockFindOne(filter),
    findOneAndUpdate: (filter: unknown, update: unknown, options?: unknown) =>
      mockFindOneAndUpdate(filter, update, options),
    updateOne: (filter: unknown, update: unknown) =>
      mockUpdateOne(filter, update),
  },
}));

import { hashOtpCode } from "@icecore/otp-runtime";
import { verifyOtpChallenge } from "./otp-verification-service";

function buildChallenge(overrides: Record<string, unknown> = {}) {
  const challenge = {
    _id: "challenge-1",
    workspaceId: "workspace-1",
    recipientPhone: "77001234567",
    purpose: "login",
    expiresAt: new Date(Date.now() + 60_000),
    maxAttempts: 5,
    attempts: 0,
    status: "pending",
    codeHash: "",
    encryptedCode: { iv: "iv", tag: "tag", ciphertext: "ciphertext" },
    idempotencyKey: "request-1",
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  challenge.codeHash = hashOtpCode({
    code: "123456",
    workspaceId: challenge.workspaceId as string,
    recipientPhone: challenge.recipientPhone as string,
    purpose: challenge.purpose as string,
    challengeId: String(challenge._id),
  });
  return challenge;
}

function buildFindOneQuery(value: unknown) {
  const query = Promise.resolve(value) as Promise<unknown> & {
    select: jest.Mock;
  };
  query.select = jest.fn(() => ({
    lean: jest.fn().mockResolvedValue(value),
  }));
  return query;
}

describe("verifyOtpChallenge", () => {
  const previousOtpSecret = process.env.OTP_HASH_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OTP_HASH_SECRET = "12345678901234567890123456789012";
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOneAndUpdateLean.mockResolvedValue(null);
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  afterAll(() => {
    process.env.OTP_HASH_SECRET = previousOtpSecret;
  });

  it("marks a valid code as verified", async () => {
    const challenge = buildChallenge();
    mockFindOne.mockReturnValue(buildFindOneQuery(challenge));
    mockFindOneAndUpdateLean.mockResolvedValue({
      ...challenge,
      status: "verified",
      verifiedAt: new Date(),
    });

    const result = await verifyOtpChallenge({
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
      code: "123456",
    });

    expect(result).toEqual({
      verified: true,
      status: "verified",
      attemptsRemaining: 5,
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "challenge-1",
        workspaceId: "workspace-1",
        status: "pending",
        expiresAt: { $gt: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "verified",
          verifiedAt: expect.any(Date),
        }),
      }),
      expect.objectContaining({ new: true })
    );
    expect(challenge.save).not.toHaveBeenCalled();
  });

  it("increments attempts for a wrong code", async () => {
    const challenge = buildChallenge();
    mockFindOne.mockReturnValue(buildFindOneQuery(challenge));
    mockFindOneAndUpdateLean.mockResolvedValue({
      ...challenge,
      attempts: 1,
      status: "pending",
    });

    const result = await verifyOtpChallenge({
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
      code: "000000",
    });

    expect(result).toEqual({
      verified: false,
      status: "pending",
      attemptsRemaining: 4,
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "challenge-1",
        workspaceId: "workspace-1",
        status: "pending",
        expiresAt: { $gt: expect.any(Date) },
      }),
      expect.any(Array),
      expect.objectContaining({ new: true })
    );
    expect(challenge.save).not.toHaveBeenCalled();
  });

  it("marks the challenge as failed on the final attempt", async () => {
    const challenge = buildChallenge({ attempts: 4, maxAttempts: 5 });
    mockFindOne.mockReturnValue(buildFindOneQuery(challenge));
    mockFindOneAndUpdateLean.mockResolvedValue({
      ...challenge,
      attempts: 5,
      status: "failed",
      idempotencyKey: null,
      encryptedCode: null,
    });

    const result = await verifyOtpChallenge({
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
      code: "000000",
    });

    expect(result).toEqual({
      verified: false,
      status: "failed",
      attemptsRemaining: 0,
    });
    expect(challenge.save).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.arrayContaining([
        expect.objectContaining({
          $set: expect.objectContaining({
            attempts: expect.any(Object),
          }),
        }),
      ]),
      expect.any(Object)
    );
  });

  it("expires old pending challenges", async () => {
    const challenge = buildChallenge({
      expiresAt: new Date(Date.now() - 1_000),
    });
    mockFindOne.mockReturnValue(buildFindOneQuery(challenge));

    const result = await verifyOtpChallenge({
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
      code: "123456",
    });

    expect(result.status).toBe("expired");
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "challenge-1",
        workspaceId: "workspace-1",
        status: "pending",
        expiresAt: { $lte: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "expired",
          idempotencyKey: null,
          encryptedCode: null,
        }),
      })
    );
    expect(challenge.save).not.toHaveBeenCalled();
  });

  it("does not verify challenges from another workspace", async () => {
    mockFindOne.mockReturnValue(buildFindOneQuery(null));

    const result = await verifyOtpChallenge({
      workspaceId: "workspace-2",
      challengeId: "challenge-1",
      code: "123456",
    });

    expect(result).toEqual({
      verified: false,
      status: "not_found",
      attemptsRemaining: 0,
    });
  });

  it("returns not_found for invalid Mongo challenge ids", async () => {
    const error = Object.assign(new Error('Cast to ObjectId failed for value "nope"'), {
      name: "CastError",
    });
    mockFindOne.mockImplementation(() => {
      throw error;
    });

    const result = await verifyOtpChallenge({
      workspaceId: "workspace-1",
      challengeId: "nope",
      code: "123456",
    });

    expect(result).toEqual({
      verified: false,
      status: "not_found",
      attemptsRemaining: 0,
    });
  });

  it("returns verified when a concurrent request already consumed the code", async () => {
    const pending = buildChallenge();
    const verified = {
      ...pending,
      status: "verified",
      verifiedAt: new Date(),
    };
    mockFindOne
      .mockReturnValueOnce(buildFindOneQuery(pending))
      .mockReturnValueOnce(buildFindOneQuery(verified));
    mockFindOneAndUpdateLean.mockResolvedValue(null);

    const result = await verifyOtpChallenge({
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
      code: "123456",
    });

    expect(result).toEqual({
      verified: true,
      status: "verified",
      attemptsRemaining: 5,
    });
  });
});
