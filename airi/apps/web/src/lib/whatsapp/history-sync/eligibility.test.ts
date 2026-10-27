import { isWhatsAppHistorySyncEligible } from "./eligibility";

describe("isWhatsAppHistorySyncEligible", () => {
  it("allows WhatsApp Business app coexistence credentials", () => {
    expect(
      isWhatsAppHistorySyncEligible({
        coexistence_mode: true,
        phone_number_id: "phone-1",
      })
    ).toBe(true);
  });

  it("allows explicit coexistence Embedded Signup flow credentials", () => {
    expect(
      isWhatsAppHistorySyncEligible({
        embedded_signup_flow: "coexistence",
      })
    ).toBe(true);
  });

  it("allows phone details that identify a WhatsApp Business app number", () => {
    expect(
      isWhatsAppHistorySyncEligible({
        is_on_biz_app: true,
      })
    ).toBe(true);
  });

  it("allows legacy QR coexistence credentials", () => {
    expect(
      isWhatsAppHistorySyncEligible({
        qr_registered: true,
      })
    ).toBe(true);
  });

  it("does not allow plain Cloud API credentials", () => {
    expect(
      isWhatsAppHistorySyncEligible({
        embedded_signup_flow: "cloud_api",
        platform_type: "CLOUD_API",
      })
    ).toBe(false);
  });

  it("prefers explicit provider Cloud API state over stale QR and coexistence flags", () => {
    expect(
      isWhatsAppHistorySyncEligible({
        qr_registered: true,
        coexistence_mode: true,
        embedded_signup_flow: "coexistence",
        platform_type: "CLOUD_API",
        is_on_biz_app: false,
      })
    ).toBe(false);
  });

  it("ignores stale coexistence flags after a full Cloud API reconnect", () => {
    expect(
      isWhatsAppHistorySyncEligible({
        embedded_signup_flow: "cloud_api",
        coexistence_mode: true,
        partner_app_installed: true,
        is_on_biz_app: false,
        platform_type: "NOT_APPLICABLE",
      })
    ).toBe(false);
  });
});
