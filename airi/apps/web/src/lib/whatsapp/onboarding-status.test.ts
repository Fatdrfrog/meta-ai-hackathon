import {
  buildWhatsAppBusinessAppConnectionSignalInput,
  buildWhatsAppOnboardingStatusFromCredentials,
} from "./onboarding-status";
import { readBusinessUsernameState } from "@icecore/whatsapp/businessUsernameState";

describe("readBusinessUsernameState", () => {
  it("returns only sanitized business username fields", () => {
    expect(
      readBusinessUsernameState({
        username: " airi_support ",
        requested_username: "airi_support",
        status: "approved",
        rejection_reason: "",
        last_webhook_at: "2026-06-12T10:00:00.000Z",
        phone_number_id: "phone-1",
        display_phone_number: "+15551234567",
        raw: { should_not_leak: true },
      })
    ).toEqual({
      username: "airi_support",
      requested_username: "airi_support",
      status: "approved",
      rejection_reason: undefined,
      last_webhook_at: "2026-06-12T10:00:00.000Z",
      phone_number_id: "phone-1",
      display_phone_number: "+15551234567",
    });
  });

  it("normalizes provider username aliases used by API and webhook payloads", () => {
    expect(
      readBusinessUsernameState({
        current_username: " @airi_support ",
        username_review_status: "approved",
      })
    ).toMatchObject({ username: "@airi_support", status: "approved" });
  });

  it("keeps a requested username separate from the current username", () => {
    expect(
      readBusinessUsernameState({
        requested_username: " pending_airi_support ",
        status: "pending",
      })
    ).toEqual({
      username: undefined,
      requested_username: "pending_airi_support",
      status: "pending",
      rejection_reason: undefined,
      last_webhook_at: undefined,
      phone_number_id: undefined,
      display_phone_number: undefined,
    });
  });
});

describe("buildWhatsAppOnboardingStatusFromCredentials", () => {
  it("normalizes raw stored credential fields once at the WhatsApp boundary", () => {
    expect(
      buildWhatsAppOnboardingStatusFromCredentials({
        phone_registered: true,
        calls_voicemail_timeout_seconds: "45",
        calls_voicemail_triggers: ["BUSY", "", "NO_ANSWER"],
        phone_registration_error: null,
        business_username: {
          username: " airi_support ",
          raw: { should_not_leak: true },
        },
        waba_health_reasons: [
          {
            code: "payment_required",
            title: "Payment required",
            message: "Add a payment method",
            source: "meta",
            actionUrl: " https://business.facebook.com/wa/manage/home/ ",
          },
          { code: "bad" },
        ],
      })
    ).toMatchObject({
      phone_registered: true,
      calls_voicemail_timeout_seconds: 45,
      calls_voicemail_triggers: ["BUSY", "NO_ANSWER"],
      phone_registration_error: null,
      business_username: { username: "airi_support" },
      waba_health_reasons: [
        {
          code: "payment_required",
          title: "Payment required",
          message: "Add a payment method",
          source: "meta",
          actionUrl: "https://business.facebook.com/wa/manage/home/",
        },
      ],
    });
  });
});

describe("buildWhatsAppBusinessAppConnectionSignalInput", () => {
  it("extracts the fields consumed by Business App connection detection", () => {
    expect(
      buildWhatsAppBusinessAppConnectionSignalInput(
        {
          embedded_signup_flow: "cloud_api",
          embedded_signup_event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
          is_on_biz_app: false,
          coexistence_mode: true,
          partner_app_installed: true,
          qr_registered: false,
          platform_type: "SMB",
        },
        { isOnBizApp: true }
      )
    ).toEqual({
      embeddedSignupFlow: "cloud_api",
      embeddedSignupEvent: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      isOnBizApp: true,
      coexistenceMode: true,
      partnerAppInstalled: true,
      qrRegistered: false,
      platformType: "SMB",
    });
  });
});
