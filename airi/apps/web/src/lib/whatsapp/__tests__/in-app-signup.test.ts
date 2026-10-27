import { WHATSAPP_IN_APP_SIGNUP_POLICY_TOS_URL } from "../docs";
import {
  buildWhatsAppInAppSignupDeepLink,
  normalizeWhatsAppInAppSignupPayload,
  validateWhatsAppInAppSignupPayload,
} from "../in-app-signup";

describe("WhatsApp In-App Signup helpers", () => {
  it("forces the Meta-approved TOS URL while preserving other signup payload fields", () => {
    const payload = {
      name: "Summer restock alerts",
      locale: "en_US",
      policy: {
        tos: "https://airi.chat/terms",
        privacy_policy_url: "https://airi.chat/privacy",
      },
    };

    const normalized = normalizeWhatsAppInAppSignupPayload(payload);

    expect(normalized).toEqual({
      name: "Summer restock alerts",
      locale: "en_US",
      policy: {
        tos: WHATSAPP_IN_APP_SIGNUP_POLICY_TOS_URL,
        privacy_policy_url: "https://airi.chat/privacy",
      },
    });
    expect(payload.policy.tos).toBe("https://airi.chat/terms");
  });

  it("adds the approved TOS URL when the signup payload has no policy object", () => {
    expect(
      normalizeWhatsAppInAppSignupPayload({
        name: "Back in stock alerts",
      })
    ).toEqual({
      name: "Back in stock alerts",
      policy: {
        tos: WHATSAPP_IN_APP_SIGNUP_POLICY_TOS_URL,
      },
    });
  });

  it("builds official wa.me signup deep links from display phone numbers", () => {
    expect(
      buildWhatsAppInAppSignupDeepLink({
        businessPhoneNumber: "+1 (555) 123-4567",
        signupId: "signup-123",
      })
    ).toBe("https://wa.me/15551234567/signup/signup-123");
  });

  it("validates promo code placeholders before calling Meta", () => {
    expect(
      validateWhatsAppInAppSignupPayload({
        signup_message: "Get weekly drops on WhatsApp.",
        confirmation_message: "You are subscribed. Code: {{promo_code}}",
        privacy_policy_url: "https://airi.chat/privacy",
      })
    ).toEqual([
      {
        field: "promo_code",
        code: "promo_code_required",
        message:
          "Promo code is required when confirmation message uses {{promo_code}}.",
      },
    ]);

    expect(
      validateWhatsAppInAppSignupPayload({
        signup_message: "Get weekly drops on WhatsApp.",
        confirmation_message: "You are subscribed. Code: {{promo_code}}",
        promo_code: "FLASH30",
        privacy_policy_url: "https://airi.chat/privacy",
      })
    ).toEqual([]);
  });

  it("rejects unknown confirmation placeholders and invalid promo codes", () => {
    expect(
      validateWhatsAppInAppSignupPayload({
        signup_message: "Get weekly drops on WhatsApp.",
        confirmation_message: "Hi {{first_name}}, use {{promo_code}}",
        promo_code: "FLASH-30",
        privacy_policy_url: "https://airi.chat/privacy",
      })
    ).toEqual([
      {
        field: "confirmation_message",
        code: "unknown_placeholder",
        message:
          "Only {{promo_code}} is supported in WhatsApp In-App Signup confirmation messages.",
      },
      {
        field: "promo_code",
        code: "promo_code_alphanumeric",
        message: "Promo code must contain only letters and numbers.",
      },
    ]);
  });
});
