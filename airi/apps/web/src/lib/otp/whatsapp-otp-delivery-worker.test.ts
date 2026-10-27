const mockConnectDB = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockUpdateOne = jest.fn();
const mockSendWhatsappTemplate = jest.fn();
const mockSupabaseMaybeSingle = jest.fn();
const mockDecryptString = jest.fn();

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

jest.mock("@/models/otp-challenge", () => ({
  OtpChallengeModel: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(() => mockSupabaseQuery),
  },
}));

jest.mock("@/lib/crypto", () => ({
  decryptString: (...args: unknown[]) => mockDecryptString(...args),
  decryptMaybeString: (value: unknown) => String(value || ""),
}));

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappTemplate: (...args: unknown[]) =>
    mockSendWhatsappTemplate(...args),
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    findOne: () => ({
      lean: async () => ({
        templateId: "template-1",
        name: "login_code",
        language: "ru",
      }),
    }),
  },
}));

import "./install-web-otp-runtime";
import { deliverWhatsAppOtpChallenge } from "@icecore/otp-runtime";

function buildChallenge(overrides: Record<string, unknown> = {}) {
  return {
    _id: "challenge-1",
    workspaceId: "workspace-1",
    recipientPhone: "77001234567",
    purpose: "login",
    templateName: "login_code",
    languageCode: "ru",
    sourceId: "source-1",
    expiresAt: new Date(Date.now() + 60_000),
    status: "pending",
    deliveryStatus: "queued",
    deliveryAttempts: 0,
    encryptedCode: { iv: "iv", tag: "tag", ciphertext: "ciphertext" },
    idempotencyKey: "request-1",
    deliveryLeaseId: "lease-1",
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("deliverWhatsAppOtpChallenge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOneAndUpdate.mockResolvedValue(buildChallenge());
    mockFindOne.mockResolvedValue(null);
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockDecryptString.mockReturnValue("123456");
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

  it("claims a queued challenge, sends the auth template, and marks delivery sent", async () => {
    const result = await deliverWhatsAppOtpChallenge({
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
    });

    expect(result).toEqual({
      status: "sent",
      challengeId: "challenge-1",
      providerMessageId: "wamid.otp",
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "challenge-1",
        workspaceId: "workspace-1",
        status: "pending",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ deliveryStatus: "sending" }),
        $inc: { deliveryAttempts: 1 },
      }),
      expect.objectContaining({ new: true })
    );
    expect(mockSendWhatsappTemplate).toHaveBeenCalledWith(
      "phone-1",
      "access-token",
      { kind: "phone", value: "77001234567" },
      "login_code",
      "ru",
      expect.arrayContaining([
        expect.objectContaining({ type: "body" }),
        expect.objectContaining({ type: "button", sub_type: "url" }),
      ]),
      expect.objectContaining({
        requirePhoneRecipient: true,
        deliveryProduct: "cloud_api",
        bizOpaqueCallbackData: "otp:challenge-1",
        redactTemplatePayloadInLogs: true,
      })
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "challenge-1",
        workspaceId: "workspace-1",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          deliveryStatus: "sent",
          providerMessageId: "wamid.otp",
        }),
        $unset: expect.objectContaining({
          encryptedCode: "",
          deliveryLeaseId: "",
          deliveryLeaseExpiresAt: "",
        }),
      })
    );
  });

  it("marks expired challenges expired when no active challenge can be claimed", async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindOne.mockResolvedValue(
      buildChallenge({ expiresAt: new Date(Date.now() - 1_000) })
    );

    const result = await deliverWhatsAppOtpChallenge({
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
    });

    expect(result).toEqual({
      status: "expired",
      challengeId: "challenge-1",
    });
    expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        _id: "challenge-1",
        workspaceId: "workspace-1",
        status: "pending",
        deliveryStatus: { $ne: "sent" },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "expired",
          deliveryStatus: "failed",
          idempotencyKey: null,
        }),
        $unset: expect.objectContaining({
          encryptedCode: "",
          deliveryLeaseId: "",
          deliveryLeaseExpiresAt: "",
        }),
      })
    );
  });
});
