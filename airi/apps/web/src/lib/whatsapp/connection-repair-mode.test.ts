import { isWhatsAppHistorySyncEligible } from "./history-sync/eligibility";
import {
  getWhatsAppReconnectDefaultTab,
  isWhatsAppBusinessAppConnection,
  withoutPartnerRemovalOverrides,
} from "./connection-repair-mode";

describe("WhatsApp connection repair mode", () => {
  it("defaults existing WhatsApp Business app/coexistence sources to the QR repair path", () => {
    expect(
      getWhatsAppReconnectDefaultTab({
        is_on_biz_app: true,
        coexistence_mode: true,
        platform_type: "CLOUD_API",
      })
    ).toBe("qr");
  });

  it("keeps standard Cloud API sources on the SDK embedded signup path", () => {
    expect(
      getWhatsAppReconnectDefaultTab({
        platform_type: "CLOUD_API",
        embedded_signup_flow: "cloud_api",
      })
    ).toBe("embedded");
  });

  it("keeps full Cloud API reconnects on the embedded path when old coexistence flags remain", () => {
    expect(
      getWhatsAppReconnectDefaultTab({
        coexistence_mode: true,
        embedded_signup_flow: "cloud_api",
        is_on_biz_app: false,
        partner_app_installed: true,
        platform_type: "NOT_APPLICABLE",
      })
    ).toBe("embedded");
  });

  describe("after Meta removed partner access", () => {
    // PARTNER_REMOVED forces these two flags regardless of how the number
    // was connected.
    const forcedByRemoval = {
      coexistence_mode: true,
      partner_app_installed: false,
      coexistence_reonboarding_status: "removed",
    };

    it.each([
      [
        "a Business app number",
        {
          ...forcedByRemoval,
          is_on_biz_app: true,
          embedded_signup_flow: "coexistence",
          platform_type: "CLOUD_API",
        },
        "qr",
      ],
      [
        "a Business app number connected before flows were stored",
        { ...forcedByRemoval, is_on_biz_app: true, platform_type: "CLOUD_API" },
        "qr",
      ],
      [
        "a legacy Cloud API number",
        {
          ...forcedByRemoval,
          is_on_biz_app: false,
          platform_type: "CLOUD_API",
        },
        "embedded",
      ],
      [
        "a Cloud API signup",
        {
          ...forcedByRemoval,
          embedded_signup_flow: "cloud_api",
          platform_type: "CLOUD_API",
        },
        "embedded",
      ],
    ] as const)("reconnects %s on its own path", (_label, credentials, tab) => {
      const view = withoutPartnerRemovalOverrides(credentials);

      expect(getWhatsAppReconnectDefaultTab(view)).toBe(tab);
      expect(isWhatsAppBusinessAppConnection(view)).toBe(tab === "qr");
    });

    it("would send a legacy Cloud API number to the Business app path without it", () => {
      expect(
        getWhatsAppReconnectDefaultTab({
          ...forcedByRemoval,
          is_on_biz_app: false,
          platform_type: "CLOUD_API",
        })
      ).toBe("qr");
    });

    it("keeps settings rows consistent with the reconnect path", () => {
      // A Cloud API number with no stored flow or platform, the shape where
      // only the forced flags would say "Business app".
      const legacyCloud = { ...forcedByRemoval };
      const view = withoutPartnerRemovalOverrides(legacyCloud);

      expect(isWhatsAppHistorySyncEligible(legacyCloud)).toBe(true);
      expect(isWhatsAppHistorySyncEligible(view)).toBe(false);
      expect(getWhatsAppReconnectDefaultTab(view)).toBe("embedded");
      expect(
        isWhatsAppHistorySyncEligible(
          withoutPartnerRemovalOverrides({
            ...forcedByRemoval,
            is_on_biz_app: true,
          })
        )
      ).toBe(true);
    });

    it("keeps every other credential field", () => {
      const credentials = {
        ...forcedByRemoval,
        phone_number_id: "phone-1",
        cloud_api_messaging_suspended: true,
      };

      expect(withoutPartnerRemovalOverrides(credentials)).toEqual({
        coexistence_reonboarding_status: "removed",
        phone_number_id: "phone-1",
        cloud_api_messaging_suspended: true,
      });
      expect(credentials.coexistence_mode).toBe(true);
    });
  });

  it("recognizes Meta's WhatsApp Business app finish event as coexistence", () => {
    expect(
      isWhatsAppBusinessAppConnection({
        embedded_signup_event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      })
    ).toBe(true);
  });
});
