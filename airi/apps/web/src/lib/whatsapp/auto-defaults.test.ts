const mockSubscribeToWABAWebhooks = jest.fn();
const mockGetWabaWebhookSubscriptionStatus = jest.fn();
const mockGetPhoneNumberDetails = jest.fn();
const mockRegisterPhoneNumberWithPin = jest.fn();
const mockEnablePhoneCallingDefaults = jest.fn();
const mockGetPhoneCallingSettings = jest.fn();

jest.mock("@/lib/whatsapp/waba-service", () => ({
  getWabaWebhookSubscriptionStatus: (...args: unknown[]) =>
    mockGetWabaWebhookSubscriptionStatus(...args),
  extractSubscribedFieldsForApp: jest.fn(() => ({ subscribedFields: [] })),
  subscribeToWABAWebhooks: (...args: unknown[]) =>
    mockSubscribeToWABAWebhooks(...args),
}));

jest.mock("@/lib/whatsapp/qr-code-service", () => ({
  getPhoneNumberDetails: (...args: unknown[]) =>
    mockGetPhoneNumberDetails(...args),
  registerPhoneNumberWithPin: (...args: unknown[]) =>
    mockRegisterPhoneNumberWithPin(...args),
}));

jest.mock("@icecore/airi-runtime/whatsapp-calling-service", () => ({
  DEFAULT_PHONE_CALLING_VOICEMAIL_TIMEOUT_SECONDS: 20,
  DEFAULT_PHONE_CALLING_VOICEMAIL_TRIGGERS: ["REJECT", "TIMEOUT"],
  enablePhoneCallingDefaults: (...args: unknown[]) =>
    mockEnablePhoneCallingDefaults(...args),
  getPhoneCallingSettings: (...args: unknown[]) =>
    mockGetPhoneCallingSettings(...args),
}));

jest.mock("@icecore/shared/lib/meta/api", () => ({
  MetaGraphRequestError: class MetaGraphRequestError extends Error {},
  getWhatsAppGraphClient: jest.fn(() => ({
    getJson: jest.fn(),
  })),
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: jest.fn((value: unknown) =>
    typeof value === "string" ? value : null
  ),
}));

import {
  buildWhatsAppCallingOperationalReadiness,
  runWhatsAppAutoDefaults,
} from "./auto-defaults";

describe("runWhatsAppAutoDefaults", () => {
  function buildWebhookCoverage(fields: string[], coexistenceMode = false) {
    return {
      profileVersion: "test",
      coexistenceMode,
      requiredFields: ["messages", "account_update", "calls"],
      optionalFields: [],
      subscribedFields: fields,
      missingRequiredFields: fields.includes("calls") ? [] : ["calls"],
      missingOptionalFields: [],
      coverageOk: fields.includes("calls"),
      actionable: fields.includes("calls") ? null : "Enable calls.",
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscribeToWABAWebhooks.mockResolvedValue({
      success: true,
      subscribedFields: ["messages", "account_update"],
      coverage: buildWebhookCoverage(["messages", "account_update"], true),
    });
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValue({
      subscribed: true,
      fields: ["messages", "account_update"],
      missingRequiredFields: ["calls"],
      missingOptionalFields: [],
      coverageOk: false,
      actionable: "Enable calls.",
      coverage: buildWebhookCoverage(["messages", "account_update"], true),
    });
    mockGetPhoneNumberDetails.mockResolvedValue({
      code_verification_status: "NOT_VERIFIED",
      platform_type: "SMB",
      display_phone_number: "+1 555 0100",
      verified_name: "Preview number",
      name_status: "APPROVED",
      quality_rating: "GREEN",
    });
    mockGetPhoneCallingSettings.mockResolvedValue({
      success: false,
      error: { message: "Calling settings unavailable", actionable: null },
    });
  });

  describe("phone registration", () => {
    const originalPin = process.env.WHATSAPP_DEFAULT_PIN;

    beforeEach(() => {
      process.env.WHATSAPP_DEFAULT_PIN = "123456";
      mockRegisterPhoneNumberWithPin.mockReset();
      mockRegisterPhoneNumberWithPin.mockResolvedValue({ success: true });
      mockGetPhoneNumberDetails.mockResolvedValue({
        id: "phone-1",
        code_verification_status: "VERIFIED",
        platform_type: "CLOUD_API",
      });
    });

    afterEach(() => {
      if (originalPin === undefined) delete process.env.WHATSAPP_DEFAULT_PIN;
      else process.env.WHATSAPP_DEFAULT_PIN = originalPin;
    });

    async function runRegistrationDefaults(
      credentials: Record<string, unknown> = {}
    ) {
      const saveCredentials = jest.fn().mockResolvedValue(undefined);
      const result = await runWhatsAppAutoDefaults({
        sourceId: "source-1",
        trigger: "embedded_signup_connect",
        credentials: {
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          access_token: "token-1",
          embedded_signup_flow: "cloud_api",
          ...credentials,
        },
        saveCredentials,
      });
      expect(saveCredentials).toHaveBeenLastCalledWith(result.credentials);
      return result;
    }

    it("registers an OTP-verified Cloud API number and records confirmed success", async () => {
      const result = await runRegistrationDefaults();

      expect(mockRegisterPhoneNumberWithPin).toHaveBeenCalledWith({
        phoneNumberId: "phone-1",
        accessToken: "token-1",
        pin: "123456",
      });
      expect(result.credentials).toEqual(
        expect.objectContaining({
          phone_registered: true,
          phone_registration_status: "REGISTERED",
          phone_registration_error: null,
        })
      );
    });

    it("keeps a failed registration actionable despite VERIFIED and CLOUD_API details", async () => {
      mockRegisterPhoneNumberWithPin.mockRejectedValueOnce(
        new Error("Incorrect two-step PIN")
      );
      const result = await runRegistrationDefaults({
        phone_registered: true,
        phone_registration_status: "VERIFIED",
        phone_registration_error: "Incorrect two-step PIN",
      });

      expect(mockRegisterPhoneNumberWithPin).toHaveBeenCalledTimes(1);
      expect(result.credentials).toEqual(
        expect.objectContaining({
          phone_registered: false,
          phone_registration_error: "Incorrect two-step PIN",
        })
      );
      expect(result.warnings).toContain("Incorrect two-step PIN");
    });

    it("leaves registration pending when no PIN is configured", async () => {
      delete process.env.WHATSAPP_DEFAULT_PIN;
      const result = await runRegistrationDefaults();

      expect(mockRegisterPhoneNumberWithPin).not.toHaveBeenCalled();
      expect(result.credentials.phone_registered).toBe(false);
      expect(result.credentials.phone_registration_error).toContain(
        "PIN is not configured"
      );
    });

    it("reconciles a failed attempt when Meta reports CONNECTED", async () => {
      mockGetPhoneNumberDetails.mockResolvedValueOnce({
        id: "phone-1",
        status: "CONNECTED",
      });
      const result = await runRegistrationDefaults({
        phone_registered: false,
        phone_registration_error: "Registration request timed out",
      });

      expect(mockRegisterPhoneNumberWithPin).not.toHaveBeenCalled();
      expect(result.credentials).toEqual(
        expect.objectContaining({
          phone_registered: true,
          phone_registration_status: "CONNECTED",
          phone_registration_error: null,
        })
      );
    });

    it.each([false, true])(
      "preserves confirmed registration when connection status is unavailable (lookup fails: %s)",
      async lookupFails => {
        if (lookupFails)
          mockGetPhoneNumberDetails.mockRejectedValueOnce(
            new Error("Meta unavailable")
          );
        const result = await runRegistrationDefaults({
          phone_registered: true,
          phone_registered_at: "2026-09-01T00:00:00.000Z",
          phone_registration_status: "REGISTERED",
        });

        expect(mockRegisterPhoneNumberWithPin).not.toHaveBeenCalled();
        expect(result.credentials).toEqual(
          expect.objectContaining({
            phone_registered: true,
            phone_registered_at: "2026-09-01T00:00:00.000Z",
            phone_registration_status: "REGISTERED",
          })
        );
      }
    );

    it("keeps coexistence registration managed by Meta when the details lookup fails", async () => {
      mockGetPhoneNumberDetails.mockRejectedValueOnce(
        new Error("Meta unavailable")
      );
      const result = await runRegistrationDefaults({
        embedded_signup_flow: "coexistence",
        coexistence_mode: true,
      });

      expect(mockRegisterPhoneNumberWithPin).not.toHaveBeenCalled();
      expect(result.credentials.phone_registration_error).toContain(
        "SMB/coexistence"
      );
    });

    it("skips registration when live details identify a Business App number", async () => {
      mockGetPhoneNumberDetails.mockResolvedValueOnce({
        id: "phone-1",
        is_on_biz_app: true,
        platform_type: "CLOUD_API",
        code_verification_status: "VERIFIED",
      });
      const result = await runRegistrationDefaults();

      expect(mockRegisterPhoneNumberWithPin).not.toHaveBeenCalled();
      expect(result.credentials.coexistence_mode).toBe(true);
      expect(result.credentials.phone_registered).toBe(true);
      expect(result.credentials.phone_registration_status).toBe("REGISTERED");
    });

    it("does not mark an offboarded Business App number connected again", async () => {
      mockGetPhoneNumberDetails.mockResolvedValueOnce({
        id: "phone-1",
        is_on_biz_app: true,
        platform_type: "CLOUD_API",
        code_verification_status: "VERIFIED",
      });
      const result = await runRegistrationDefaults({
        embedded_signup_flow: "coexistence",
        coexistence_mode: true,
        partner_app_installed: false,
        cloud_api_messaging_suspended: true,
        coexistence_reonboarding_status: "offboarded",
      });

      expect(result.credentials.coexistence_mode).toBe(true);
      expect(result.credentials.partner_app_installed).toBe(false);
      expect(result.credentials.partner_app_installed_at).toBeUndefined();
    });
  });

  it("keeps WABA webhook maintenance authoritative for coexistence credentials", async () => {
    const persistedCredentials: Record<string, unknown>[] = [];

    await runWhatsAppAutoDefaults({
      sourceId: "source-1",
      trigger: "embedded_signup_connect",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "coexistence",
        coexistence_mode: true,
        platform_type: "SMB",
      },
      saveCredentials: async nextCredentials => {
        persistedCredentials.push(nextCredentials);
      },
    });

    expect(mockSubscribeToWABAWebhooks).toHaveBeenCalledWith(
      "waba-1",
      "token-1",
      {
        coexistenceMode: true,
      }
    );
    expect(persistedCredentials[persistedCredentials.length - 1]).toEqual(
      expect.objectContaining({
        phone_registration_error:
          "Phone registration API is not available for SMB/coexistence numbers.",
      })
    );
  });

  it("enables and verifies calling defaults for Full Cloud Embedded Signup credentials", async () => {
    const subscribedFields = ["messages", "account_update", "calls"];
    const persistedCredentials: Record<string, unknown>[] = [];

    mockSubscribeToWABAWebhooks.mockResolvedValueOnce({
      success: true,
      subscribedFields,
      coverage: buildWebhookCoverage(subscribedFields, false),
    });
    mockGetPhoneNumberDetails.mockResolvedValueOnce({
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
      display_phone_number: "+1 555 0200",
      status: "CONNECTED",
      verified_name: "Full Cloud number",
      name_status: "APPROVED",
      quality_rating: "GREEN",
    });
    mockEnablePhoneCallingDefaults.mockResolvedValueOnce({
      success: true,
      data: { success: true },
    });
    mockGetPhoneCallingSettings.mockResolvedValueOnce({
      success: true,
      data: {
        calling: {
          status: "ENABLED",
          call_icon_visibility: "DEFAULT",
          callback_permission_status: "ENABLED",
          restrictions: {
            restrictions_list: [
              {
                type: "COUNTRY",
                reason: "preview",
                expiration: 1800000000,
              },
            ],
          },
        },
      },
    });

    const result = await runWhatsAppAutoDefaults({
      sourceId: "source-1",
      trigger: "embedded_signup_connect",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "cloud_api",
        coexistence_mode: false,
        platform_type: "CLOUD_API",
      },
      saveCredentials: async nextCredentials => {
        persistedCredentials.push(nextCredentials);
      },
    });

    expect(mockSubscribeToWABAWebhooks).toHaveBeenCalledWith(
      "waba-1",
      "token-1",
      { coexistenceMode: false }
    );
    expect(mockEnablePhoneCallingDefaults).toHaveBeenCalledWith(
      "phone-1",
      "token-1",
      {
        voicemail: null,
      }
    );
    expect(mockGetPhoneCallingSettings).toHaveBeenCalledWith(
      "phone-1",
      "token-1"
    );
    expect(mockRegisterPhoneNumberWithPin).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.stepResults.step8_enable_calling_defaults.status).toBe(
      "success"
    );
    expect(result.stepResults.step9_verify_calling_settings.status).toBe(
      "success"
    );
    expect(persistedCredentials[persistedCredentials.length - 1]).toEqual(
      expect.objectContaining({
        calls_webhook_subscribed: true,
        calls_enabled: true,
        calls_status: "ENABLED",
        calls_icon_visibility: "DEFAULT",
        calls_callback_permission_status: "ENABLED",
        calls_voicemail_enabled: false,
        calls_voicemail_status: undefined,
        calls_enablement_error: null,
        calls_enablement_actionable: null,
        whatsapp_calls_media_enabled: true,
        phone_registered: true,
        platform_type: "CLOUD_API",
        waba_subscribed_fields: subscribedFields,
      })
    );
    expect(
      persistedCredentials[persistedCredentials.length - 1].calls_restrictions
    ).toEqual([
      {
        type: "COUNTRY",
        reason: "preview",
        expiration: 1800000000,
      },
    ]);
    expect(
      persistedCredentials[persistedCredentials.length - 1].calls_enabled_at
    ).toEqual(expect.any(String));
  });

  it("passes voicemail defaults when an announcement media id is stored on the source", async () => {
    const subscribedFields = ["messages", "account_update", "calls"];
    const persistedCredentials: Record<string, unknown>[] = [];

    mockSubscribeToWABAWebhooks.mockResolvedValueOnce({
      success: true,
      subscribedFields,
      coverage: buildWebhookCoverage(subscribedFields, false),
    });
    mockGetPhoneNumberDetails.mockResolvedValueOnce({
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
      display_phone_number: "+1 555 0200",
      status: "CONNECTED",
      verified_name: "Full Cloud number",
      name_status: "APPROVED",
      quality_rating: "GREEN",
    });
    mockEnablePhoneCallingDefaults.mockResolvedValueOnce({
      success: true,
      data: { success: true },
    });
    mockGetPhoneCallingSettings.mockResolvedValueOnce({
      success: true,
      data: {
        calling: {
          status: "ENABLED",
          call_icon_visibility: "DEFAULT",
          callback_permission_status: "ENABLED",
          voicemail: {
            status: "ENABLED",
            triggers: ["REJECT", "TIMEOUT"],
            audio: {
              default: {
                announcement_media_id: "media-vm-1",
                timeout_seconds: 30,
              },
            },
          },
        },
      },
    });

    const result = await runWhatsAppAutoDefaults({
      sourceId: "source-1",
      trigger: "embedded_signup_connect",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "cloud_api",
        coexistence_mode: false,
        platform_type: "CLOUD_API",
        calls_voicemail_announcement_media_id: "media-vm-1",
      },
      saveCredentials: async nextCredentials => {
        persistedCredentials.push(nextCredentials);
      },
    });

    expect(mockEnablePhoneCallingDefaults).toHaveBeenCalledWith(
      "phone-1",
      "token-1",
      {
        voicemail: {
          announcementMediaId: "media-vm-1",
          timeoutSeconds: 20,
          triggers: ["REJECT", "TIMEOUT"],
        },
      }
    );
    expect(result.stepResults.step8_enable_calling_defaults.message).toContain(
      "voicemail"
    );
    expect(persistedCredentials[persistedCredentials.length - 1]).toEqual(
      expect.objectContaining({
        calls_voicemail_enabled: true,
        calls_voicemail_status: "ENABLED",
        calls_voicemail_triggers: ["REJECT", "TIMEOUT"],
        calls_voicemail_announcement_media_id: "media-vm-1",
        calls_voicemail_timeout_seconds: 30,
      })
    );
  });

  it("keeps the missing calls webhook field as the actionable Full Cloud blocker", async () => {
    const persistedCredentials: Record<string, unknown>[] = [];

    mockGetPhoneNumberDetails.mockResolvedValueOnce({
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
      display_phone_number: "+1 555 0200",
      status: "CONNECTED",
      verified_name: "Full Cloud number",
      name_status: "APPROVED",
      quality_rating: "GREEN",
    });

    const result = await runWhatsAppAutoDefaults({
      sourceId: "source-1",
      trigger: "embedded_signup_connect",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "cloud_api",
        coexistence_mode: false,
        platform_type: "CLOUD_API",
      },
      saveCredentials: async nextCredentials => {
        persistedCredentials.push(nextCredentials);
      },
    });

    expect(mockSubscribeToWABAWebhooks).toHaveBeenCalledWith(
      "waba-1",
      "token-1",
      { coexistenceMode: false }
    );
    expect(mockEnablePhoneCallingDefaults).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.stepResults.step8_enable_calling_defaults.status).toBe(
      "skipped"
    );
    expect(result.stepResults.step9_verify_calling_settings.status).toBe(
      "failed"
    );
    expect(persistedCredentials[persistedCredentials.length - 1]).toEqual(
      expect.objectContaining({
        calls_webhook_subscribed: false,
        calls_enablement_error:
          "Calls webhook field is not subscribed for this WABA. Calls enablement was skipped.",
        calls_enablement_actionable: "Enable calls.",
        auto_defaults_last_error:
          "Calls webhook field is not subscribed for this WABA. Calls enablement was skipped.",
      })
    );
  });
});

describe("buildWhatsAppCallingOperationalReadiness", () => {
  it("treats Full Cloud source defaults and LiveKit credentials as media bridge ready", () => {
    const readiness = buildWhatsAppCallingOperationalReadiness(
      {
        calls_webhook_subscribed: true,
        calls_enabled: true,
        calls_callback_permission_status: "ENABLED",
        embedded_signup_flow: "cloud_api",
        coexistence_mode: false,
      },
      {
        NODE_ENV: "test",
        LIVEKIT_URL: "wss://livekit.example.com",
        LIVEKIT_API_KEY: "livekit-key",
        LIVEKIT_API_SECRET: "livekit-secret",
        TEMPORAL_ADDRESS: "temporal.example.com:7233",
        TEMPORAL_NAMESPACE: "production",
        WHATSAPP_CALL_PUBSUB_PROJECT_ID: "gcp-project",
      } as NodeJS.ProcessEnv
    );

    expect(readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "source_media_enabled",
          ready: true,
          label: "Full Cloud media",
          actionable: expect.not.stringContaining(
            "whatsapp_calls_media_enabled"
          ),
        }),
        expect.objectContaining({
          id: "livekit_configured",
          ready: true,
          actionable:
            "Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
        }),
      ])
    );
    expect(readiness.ready).toBe(true);
  });
});
