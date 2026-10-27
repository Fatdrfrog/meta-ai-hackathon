const mockConnectDB = jest.fn();
const mockSendWhatsappTemplate = jest.fn();
const mockGetActiveOtpTemplateBinding = jest.fn();
const mockPublishWhatsAppOtpDeliveryToPubSub = jest.fn();
const mockAssertWhatsAppOtpRequestAllowed = jest.fn();
const mockSupabaseMaybeSingle = jest.fn();
const mockTemplateLean = jest.fn();
const mockChallengeSave = jest.fn();
const mockChallengeFindOne = jest.fn((_filter?: unknown) => ({
  lean: (...args: unknown[]) => mockChallengeFindOneLean(...args),
}));
const mockChallengeFindOneLean = jest.fn();
const mockChallengeUpdateMany = jest.fn();
let lastChallengeInstance: Record<string, unknown> | null = null;

type MockSupabaseQuery = {
  select: jest.Mock<MockSupabaseQuery, unknown[]>;
  eq: jest.Mock<MockSupabaseQuery, unknown[]>;
  order: jest.Mock<MockSupabaseQuery, unknown[]>;
  limit: jest.Mock<MockSupabaseQuery, unknown[]>;
  maybeSingle: jest.Mock<Promise<unknown>, unknown[]>;
};

const mockSupabaseQuery = {} as MockSupabaseQuery;
mockSupabaseQuery.select = jest.fn(() => mockSupabaseQuery);
mockSupabaseQuery.eq = jest.fn(() => mockSupabaseQuery);
mockSupabaseQuery.order = jest.fn(() => mockSupabaseQuery);
mockSupabaseQuery.limit = jest.fn(() => mockSupabaseQuery);
mockSupabaseQuery.maybeSingle = jest.fn((...args: unknown[]) =>
  mockSupabaseMaybeSingle(...args)
);

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappTemplate: (...args: unknown[]) =>
    mockSendWhatsappTemplate(...args),
}));

jest.mock("@/lib/otp/otp-template-binding-service", () => ({
  getActiveOtpTemplateBinding: (...args: unknown[]) =>
    mockGetActiveOtpTemplateBinding(...args),
}));

jest.mock("@/lib/otp/whatsapp-otp-delivery-pubsub", () => ({
  publishWhatsAppOtpDeliveryToPubSub: (...args: unknown[]) =>
    mockPublishWhatsAppOtpDeliveryToPubSub(...args),
}));

jest.mock("@/lib/otp/otp-rate-limit", () => ({
  assertWhatsAppOtpRequestAllowed: (...args: unknown[]) =>
    mockAssertWhatsAppOtpRequestAllowed(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(() => mockSupabaseQuery),
  },
}));

jest.mock("@/models/otp-challenge", () => ({
  ACTIVE_IDEMPOTENT_OTP_STATUSES: ["pending", "verified"],
  REUSABLE_TERMINAL_OTP_STATUSES: ["expired", "failed", "cancelled"],
  OtpChallengeModel: Object.assign(
    class {
      _id = "challenge-1";
      workspaceId?: string;
      recipientPhone?: string;
      purpose?: string;
      codeHash?: string;
      encryptedCode?: unknown;
      providerMessageId?: string | null;
      status?: string;
      deliveryStatus?: string;
      deliveryQueuedAt?: Date;
      idempotencyKey?: string | null;
      lastError?: string | null;

      constructor(data: Record<string, unknown>) {
        Object.assign(this, data);
        lastChallengeInstance = this as unknown as Record<string, unknown>;
      }

      save(...args: unknown[]) {
        return mockChallengeSave(...args);
      }
    },
    {
      findOne: (filter: unknown) => mockChallengeFindOne(filter),
      updateMany: (filter: unknown, update: unknown) =>
        mockChallengeUpdateMany(filter, update),
    }
  ),
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    findOne: jest.fn(() => ({
      lean: (...args: unknown[]) => mockTemplateLean(...args),
    })),
  },
}));

import { requestWhatsAppOtp } from "./whatsapp-otp-service";

describe("requestWhatsAppOtp", () => {
  const previousOtpSecret = process.env.OTP_HASH_SECRET;
  const previousEncryptionSecret = process.env.ENCRYPTION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChallengeFindOneLean.mockReset();
    mockChallengeSave.mockReset();
    process.env.OTP_HASH_SECRET = "12345678901234567890123456789012";
    process.env.ENCRYPTION_SECRET = "12345678901234567890123456789012";
    mockConnectDB.mockResolvedValue(undefined);
    mockAssertWhatsAppOtpRequestAllowed.mockResolvedValue(undefined);
    mockChallengeUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockPublishWhatsAppOtpDeliveryToPubSub.mockResolvedValue({
      ok: true,
      messageId: "pubsub-1",
    });
    mockChallengeFindOneLean.mockResolvedValue(null);
    lastChallengeInstance = null;
    mockChallengeSave.mockResolvedValue(undefined);
    mockGetActiveOtpTemplateBinding.mockResolvedValue({
      _id: "binding-1",
      workspaceId: "workspace-1",
      purpose: "login",
      templateId: "template-1",
      templateName: "login_code",
      languageCode: "ru",
      sourceId: "source-1",
      ttlSeconds: 300,
      maxAttempts: 5,
      enabled: true,
    });
    mockTemplateLean.mockResolvedValue({
      workspaceId: "workspace-1",
      templateId: "template-1",
      name: "login_code",
      language: "ru",
      status: "APPROVED",
      category: "AUTHENTICATION",
    });
    mockSupabaseMaybeSingle.mockResolvedValue({
      data: {
        id: "source-1",
        credentials: {
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          access_token: "access-token",
        },
      },
      error: null,
    });
    mockSendWhatsappTemplate.mockResolvedValue({
      messageId: "wamid.otp",
      date: 1711100000,
      deliveryProduct: "cloud_api",
    });
  });

  afterAll(() => {
    process.env.OTP_HASH_SECRET = previousOtpSecret;
    process.env.ENCRYPTION_SECRET = previousEncryptionSecret;
  });

  it("queues OTP delivery through Pub/Sub without returning or synchronously sending the code", async () => {
    const result = await requestWhatsAppOtp({
      workspaceId: "workspace-1",
      recipientPhone: "+7 700 123 45 67",
      purpose: "login",
      idempotencyKey: "request-1",
    });

    expect(result).toEqual({
      challengeId: "challenge-1",
      expiresAt: expect.any(String),
      deliveryStatus: "queued",
    });
    expect(JSON.stringify(result)).not.toMatch(/\d{6}/);
    expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
    expect(mockPublishWhatsAppOtpDeliveryToPubSub).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: "challenge-1",
        workspaceId: "workspace-1",
        correlationId: expect.any(String),
      })
    );
    expect(mockAssertWhatsAppOtpRequestAllowed).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      recipientPhone: "77001234567",
      purpose: "login",
    });
  });

  it("returns an existing active challenge for the same idempotency key", async () => {
    mockChallengeFindOneLean.mockResolvedValue({
      _id: "challenge-existing",
      expiresAt: new Date("2026-06-02T10:05:00.000Z"),
      status: "pending",
      deliveryStatus: "queued",
      providerMessageId: null,
    });

    const result = await requestWhatsAppOtp({
      workspaceId: "workspace-1",
      recipientPhone: "+77001234567",
      purpose: "login",
      idempotencyKey: "request-1",
    });

    expect(result).toEqual({
      challengeId: "challenge-existing",
      expiresAt: "2026-06-02T10:05:00.000Z",
      deliveryStatus: "queued",
    });
    expect(mockChallengeSave).not.toHaveBeenCalled();
    expect(mockPublishWhatsAppOtpDeliveryToPubSub).not.toHaveBeenCalled();
  });

  it("returns the existing challenge when a concurrent idempotent insert hits the unique index", async () => {
    mockChallengeSave.mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key error"), { code: 11000 })
    );
    mockChallengeFindOneLean.mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: "challenge-existing",
      expiresAt: new Date("2026-06-02T10:05:00.000Z"),
      status: "pending",
      deliveryStatus: "queued",
      providerMessageId: null,
    });

    const result = await requestWhatsAppOtp({
      workspaceId: "workspace-1",
      recipientPhone: "+77001234567",
      purpose: "login",
      idempotencyKey: "request-1",
    });

    expect(result).toEqual({
      challengeId: "challenge-existing",
      expiresAt: "2026-06-02T10:05:00.000Z",
      deliveryStatus: "queued",
    });
    expect(mockPublishWhatsAppOtpDeliveryToPubSub).not.toHaveBeenCalled();
  });

  it("expires stale active idempotency keys before creating a replacement challenge", async () => {
    await requestWhatsAppOtp({
      workspaceId: "workspace-1",
      recipientPhone: "+77001234567",
      purpose: "login",
      idempotencyKey: "request-1",
    });

    expect(mockChallengeUpdateMany).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: "workspace-1",
        channel: "whatsapp",
        recipientPhone: "77001234567",
        purpose: "login",
        idempotencyKey: "request-1",
        expiresAt: { $lte: expect.any(Date) },
        status: "pending",
        $or: [
          { deliveryStatus: { $ne: "sending" } },
          { deliveryLeaseExpiresAt: { $lte: expect.any(Date) } },
          { deliveryLeaseExpiresAt: null },
          { deliveryLeaseExpiresAt: { $exists: false } },
        ],
      },
      {
        $set: {
          status: "expired",
          idempotencyKey: null,
          encryptedCode: null,
          lastError: "OTP challenge expired before idempotent retry",
          updatedAt: expect.any(Date),
        },
        $unset: {
          deliveryLeaseId: "",
          deliveryLeaseExpiresAt: "",
        },
      }
    );
    expect(mockChallengeUpdateMany).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId: "workspace-1",
        channel: "whatsapp",
        recipientPhone: "77001234567",
        purpose: "login",
        idempotencyKey: "request-1",
        $or: [
          { status: "verified", expiresAt: { $lte: expect.any(Date) } },
          { status: { $in: ["expired", "failed", "cancelled"] } },
        ],
      },
      {
        $set: {
          idempotencyKey: null,
          encryptedCode: null,
          updatedAt: expect.any(Date),
        },
        $unset: {
          deliveryLeaseId: "",
          deliveryLeaseExpiresAt: "",
        },
      }
    );
    expect(mockChallengeUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockChallengeFindOne.mock.invocationCallOrder[0]
    );
    expect(mockChallengeUpdateMany.mock.invocationCallOrder[1]).toBeLessThan(
      mockChallengeFindOne.mock.invocationCallOrder[0]
    );
    expect(mockChallengeSave).toHaveBeenCalled();
  });

  it("applies OTP-specific rate limits before creating a challenge", async () => {
    mockAssertWhatsAppOtpRequestAllowed.mockRejectedValue(
      new Error("Please wait before requesting another OTP")
    );

    await expect(
      requestWhatsAppOtp({
        workspaceId: "workspace-1",
        recipientPhone: "+77001234567",
        purpose: "login",
      })
    ).rejects.toThrow("Please wait before requesting another OTP");

    expect(mockChallengeSave).not.toHaveBeenCalled();
    expect(mockPublishWhatsAppOtpDeliveryToPubSub).not.toHaveBeenCalled();
  });

  it("marks enqueue failures failed and releases the idempotency key for retry", async () => {
    mockPublishWhatsAppOtpDeliveryToPubSub.mockResolvedValue({
      ok: false,
      errorMessage: "Pub/Sub unavailable",
    });

    await expect(
      requestWhatsAppOtp({
        workspaceId: "workspace-1",
        recipientPhone: "+77001234567",
        purpose: "login",
        idempotencyKey: "request-1",
      })
    ).rejects.toThrow("Pub/Sub unavailable");

    expect(lastChallengeInstance).toEqual(
      expect.objectContaining({
        status: "failed",
        deliveryStatus: "failed",
        idempotencyKey: null,
        lastError: "Pub/Sub unavailable",
      })
    );
    expect(mockChallengeSave).toHaveBeenCalledTimes(2);
  });

  it("requires an active binding", async () => {
    mockGetActiveOtpTemplateBinding.mockResolvedValue(null);

    await expect(
      requestWhatsAppOtp({
        workspaceId: "workspace-1",
        recipientPhone: "+77001234567",
        purpose: "login",
      })
    ).rejects.toThrow("No active WhatsApp OTP template binding found");
  });
});
