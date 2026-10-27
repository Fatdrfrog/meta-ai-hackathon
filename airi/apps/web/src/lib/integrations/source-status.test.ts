import type { MetaAdsAdAccount, Source } from "@icecore/shared/types/sources";
import {
  isConfiguredIntegrationSource,
  isConfiguredTelegramSource,
  isConfiguredWhatsAppSource,
} from "./source-status";

const hasConfiguredIntegrationSource = (
  sources: Parameters<typeof isConfiguredIntegrationSource>[0][]
) => sources.some(isConfiguredIntegrationSource);

function source(overrides: Partial<Source>): Source {
  return {
    id: "source-1",
    created_at: "2026-01-01T00:00:00.000Z",
    company_id: "company-1",
    workspace_id: "workspace-1",
    name: "Source",
    type: "telegram",
    credentials: {},
    ...overrides,
  } as Source;
}

describe("source status", () => {
  it("requires a verified Google AI credential before showing connected", () => {
    expect(
      isConfiguredIntegrationSource(
        source({ type: "google_ai" as Source["type"], credentials: {} })
      )
    ).toBe(false);
    expect(
      isConfiguredIntegrationSource(
        source({
          type: "google_ai" as Source["type"],
          credentials: {
            has_api_key: true,
            validated_at: "2026-09-17T00:00:00.000Z",
          } as Source["credentials"],
        })
      )
    ).toBe(true);
  });
  it.each([
    {},
    { ad_accounts: [] },
    { ad_accounts: [{ name: "Missing account ID" } as MetaAdsAdAccount] },
    { ad_accounts: [{ id: "act_111" }], ad_accounts_error: "Discovery failed" },
  ])(
    "does not mark unusable Meta Ads discovery as connected (%j)",
    credentials => {
      expect(
        isConfiguredIntegrationSource(
          source({
            type: "meta_ads",
            credentials: { access_token: "test-token", ...credentials },
          })
        )
      ).toBe(false);
    }
  );

  it("marks successfully discovered Meta Ads accounts as connected", () => {
    expect(
      isConfiguredIntegrationSource(
        source({
          type: "meta_ads",
          credentials: {
            access_token: "test-token",
            ad_accounts: [{ id: "act_111" }],
            ad_accounts_error: "  ",
          },
        })
      )
    ).toBe(true);
  });

  it("does not treat Telegram placeholder sources as configured", () => {
    expect(
      isConfiguredTelegramSource(source({ type: "telegram", credentials: {} }))
    ).toBe(false);

    expect(
      hasConfiguredIntegrationSource([
        source({ type: "telegram", credentials: {} }),
      ])
    ).toBe(false);
  });

  it("treats Telegram sources with bot tokens as configured", () => {
    expect(
      isConfiguredTelegramSource(
        source({
          type: "telegram",
          credentials: { bot_token: "123:abc" },
        })
      )
    ).toBe(true);
  });

  it.each([
    [
      "an encrypted token",
      { bot_token: { iv: "aXY=", tag: "dGFn", ciphertext: "c2VjcmV0" } },
    ],
    ["the public flag the browser gets", { has_bot_token: true }],
  ])("treats Telegram sources with %s as configured", (_label, credentials) => {
    expect(
      isConfiguredTelegramSource(source({ type: "telegram", credentials }))
    ).toBe(true);
  });

  it.each([
    ["a partial envelope", { bot_token: { ciphertext: "c2VjcmV0" } }],
    ["a blank token", { bot_token: "  " }],
    ["the public flag set to false", { has_bot_token: false }],
  ])(
    "treats Telegram sources with %s as not configured",
    (_label, credentials) => {
      expect(
        isConfiguredTelegramSource(source({ type: "telegram", credentials }))
      ).toBe(false);
    }
  );

  it("preserves existing source-presence semantics for other integrations", () => {
    expect(
      hasConfiguredIntegrationSource([
        source({
          type: "web_widget",
          credentials: {
            client_key: "widget_1",
            allowed_domains: [],
            status: "active",
          },
        }),
      ])
    ).toBe(true);
  });

  it("does not treat offboarded WhatsApp coexistence sources as configured", () => {
    expect(
      isConfiguredWhatsAppSource(
        source({
          type: "whatsapp",
          credentials: {
            access_token: "token-1",
            waba_id: "waba-1",
            phone_number_id: "phone-1",
            coexistence_mode: true,
            partner_app_installed: false,
            cloud_api_messaging_suspended: true,
            coexistence_reonboarding_status: "offboarded",
          },
        })
      )
    ).toBe(false);

    expect(
      hasConfiguredIntegrationSource([
        source({
          type: "whatsapp",
          credentials: {
            access_token: "token-1",
            waba_id: "waba-1",
            phone_number_id: "phone-1",
            coexistence_mode: true,
            partner_app_installed: false,
            cloud_api_messaging_suspended: true,
            coexistence_reonboarding_status: "offboarded",
          },
        }),
      ])
    ).toBe(false);
  });

  it("does not treat explicitly removed WhatsApp coexistence sources as configured", () => {
    expect(
      isConfiguredWhatsAppSource(
        source({
          type: "whatsapp",
          credentials: {
            access_token: "token-1",
            waba_id: "waba-1",
            phone_number_id: "phone-1",
            coexistence_mode: true,
            partner_app_installed: false,
            coexistence_reonboarding_status: "removed",
          },
        })
      )
    ).toBe(false);
  });

  it("treats active WhatsApp sources as configured", () => {
    expect(
      isConfiguredWhatsAppSource(
        source({
          type: "whatsapp",
          credentials: {
            access_token: "token-1",
            waba_id: "waba-1",
            phone_number_id: "phone-1",
            coexistence_mode: true,
            partner_app_installed: true,
          },
        })
      )
    ).toBe(true);
  });

  it("ignores the implicit onboarding test-chat web_widget source", () => {
    expect(
      hasConfiguredIntegrationSource([
        source({
          type: "web_widget",
          credentials: {
            client_key: "widget_onboarding_1",
            allowed_domains: [],
            status: "active",
            onboarding_test: true,
          },
        }),
      ])
    ).toBe(false);

    // A real widget alongside the test source still counts as connected.
    expect(
      hasConfiguredIntegrationSource([
        source({
          type: "web_widget",
          credentials: {
            client_key: "widget_onboarding_1",
            allowed_domains: [],
            status: "active",
            onboarding_test: true,
          },
        }),
        source({
          type: "web_widget",
          credentials: {
            client_key: "widget_real",
            allowed_domains: [],
            status: "active",
          },
        }),
      ])
    ).toBe(true);
  });
});
