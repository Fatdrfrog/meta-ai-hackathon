const mockGetJson = jest.fn();
const mockPostJson = jest.fn();

jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: jest.fn(() => ({
    getJson: mockGetJson,
    postJson: mockPostJson,
  })),
}));

const { getPhoneNumberDetails, registerPhoneNumberWithPin } =
  jest.requireActual(
    "../qr-code-service"
  ) as typeof import("../qr-code-service");
const { MetaGraphRequestError } = jest.requireActual(
  "@icecore/shared/lib/meta/api"
) as typeof import("@icecore/shared/lib/meta/api");

describe("getPhoneNumberDetails", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("requests the current portfolio messaging limit field from Meta", async () => {
    mockGetJson.mockResolvedValueOnce({
      id: "phone-1",
      verified_name: "Airi",
      display_phone_number: "+15551234567",
      quality_rating: "GREEN",
      code_verification_status: "VERIFIED",
      status: "CONNECTED",
      platform_type: "CLOUD_API",
      throughput: { level: "STANDARD" },
      name_status: "APPROVED",
      whatsapp_business_manager_messaging_limit: "TIER_2K",
    });

    const details = await getPhoneNumberDetails("phone-1", "token-1");

    expect(mockGetJson).toHaveBeenCalledWith("phone-1", {
      token: "token-1",
      query: {
        fields: expect.stringContaining(
          "whatsapp_business_manager_messaging_limit"
        ),
      },
    });
    expect(mockGetJson).toHaveBeenCalledWith("phone-1", {
      token: "token-1",
      query: {
        fields: expect.stringContaining("is_on_biz_app"),
      },
    });
    expect(mockGetJson).toHaveBeenCalledWith("phone-1", {
      token: "token-1",
      query: {
        fields: expect.stringContaining("is_pin_enabled"),
      },
    });
    expect(details.whatsapp_business_manager_messaging_limit).toBe("TIER_2K");
    expect(mockGetJson.mock.calls[0][1].query.fields.split(",")).toContain(
      "status"
    );
    expect(details.status).toBe("CONNECTED");
  });

  it("preserves typed Meta error metadata for callers that apply provider cooldowns", async () => {
    const rateLimit = new MetaGraphRequestError({
      message: "OAuthException (80008): Too many calls",
      status: 400,
      statusText: "Bad Request",
      url: "https://graph.facebook.com/v25.0/phone-1",
      details: {
        error: {
          message: "Too many calls",
          type: "OAuthException",
          code: 80008,
        },
      },
      metaError: {
        message: "Too many calls",
        type: "OAuthException",
        code: 80008,
      },
    });
    mockGetJson.mockRejectedValueOnce(rateLimit);

    await expect(getPhoneNumberDetails("phone-1", "token-1")).rejects.toBe(
      rateLimit
    );
  });
});

describe("registerPhoneNumberWithPin", () => {
  it.each([{ success: false }, {}])(
    "rejects an unconfirmed registration response: %j",
    async response => {
      mockPostJson.mockResolvedValueOnce(response);

      await expect(
        registerPhoneNumberWithPin({
          phoneNumberId: "phone-1",
          accessToken: "token-1",
          pin: "123456",
        })
      ).rejects.toThrow("Meta did not confirm phone number registration");
    }
  );

  it("accepts Meta's successful registration response", async () => {
    mockPostJson.mockResolvedValueOnce({ success: true });
    await expect(
      registerPhoneNumberWithPin({
        phoneNumberId: "phone-1",
        accessToken: "token-1",
        pin: "123456",
      })
    ).resolves.toEqual({ success: true });
  });
});

export {};
