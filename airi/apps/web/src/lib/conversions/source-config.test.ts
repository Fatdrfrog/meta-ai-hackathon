import {
  readWhatsAppConversionsConfiguration,
  toPublicWhatsAppConversionCredentials,
} from "./source-config";

const config = {
  enabled: true,
  dataset_id: "111222333",
  waba_id: "123456789",
  configured_at: "2026-09-10T00:00:00.000Z",
};

describe("WhatsApp conversion configuration", () => {
  it("reads only the bound configuration without exposing tokens or extra fields", () => {
    expect(
      readWhatsAppConversionsConfiguration({
        waba_id: "123456789",
        access_token: "secret",
        conversions_api: { ...config, access_token: "nested-secret" },
      })
    ).toEqual(config);
  });

  it.each([
    {},
    { waba_id: "987654321", conversions_api: config },
    { waba_id: "123456789", conversions_api: { ...config, enabled: "true" } },
    { waba_id: "123456789", conversions_api: { ...config, dataset_id: "" } },
    {
      waba_id: "123456789",
      conversions_api: { ...config, configured_at: "invalid" },
    },
  ])("fails closed for invalid or rebound configuration", credentials => {
    expect(readWhatsAppConversionsConfiguration(credentials)).toBeNull();
  });

  it("redacts stored tokens and webhook credentials without mutating the source", () => {
    const credentials = {
      waba_id: "123456789",
      display_phone_number: "+77123456789",
      access_token: { ciphertext: "stored-token" },
      accessToken: "legacy-token",
      sales_webhook_secret: { ciphertext: "secret" },
      sales_webhook_enabled: true,
      conversions_api: { ...config, unexpected: "secret" },
    };
    expect(toPublicWhatsAppConversionCredentials(credentials)).toEqual({
      waba_id: "123456789",
      display_phone_number: "+77123456789",
      sales_webhook_enabled: true,
      conversions_api: config,
    });
    expect(credentials.access_token).toEqual({ ciphertext: "stored-token" });
    expect(credentials.accessToken).toBe("legacy-token");
    expect(credentials.sales_webhook_secret).toEqual({ ciphertext: "secret" });
  });

  it.each(["", "invalid code", 123, {}, "x".repeat(129)])(
    "rejects malformed supplied test event code %p",
    test_event_code => {
      expect(
        readWhatsAppConversionsConfiguration({
          waba_id: config.waba_id,
          conversions_api: { ...config, test_event_code },
        })
      ).toBeNull();
    }
  );

  it("keeps the account-change attribution boundary in the validated configuration", () => {
    const bound = {
      ...config,
      attribution_boundary_at: "2026-09-09T00:00:00.000Z",
    };
    expect(
      readWhatsAppConversionsConfiguration({
        waba_id: config.waba_id,
        conversions_api: bound,
      })
    ).toEqual(bound);
    expect(
      readWhatsAppConversionsConfiguration({
        waba_id: config.waba_id,
        conversions_api: { ...bound, attribution_boundary_at: "invalid" },
      })
    ).toBeNull();
  });
});
