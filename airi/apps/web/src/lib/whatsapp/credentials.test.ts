import {
  buildWhatsAppReconnectedCredentialPatch,
  normalizeWhatsAppCredentials,
  resetWhatsAppPhoneScopedState,
} from "./credentials";

describe("buildWhatsAppReconnectedCredentialPatch", () => {
  it("clears the suspension and stale failure diagnostics after a proven reconnect", () => {
    expect(buildWhatsAppReconnectedCredentialPatch()).toEqual(
      expect.objectContaining({
        cloud_api_messaging_suspended: false,
        coexistence_reonboarding_status: null,
        partner_removed_alert_dismissed_at: null,
        partner_removed_alert_dismissed_by: null,
        partner_removed_alert_dismissed_for: null,
        partner_removed_reason: null,
        phone_number_access_error: null,
        phone_number_accessible: null,
        waba_subscription_consecutive_failures: 0,
        waba_subscription_permanently_failed: false,
        webhook_error: null,
        webhook_requires_reconnect: false,
        webhook_subscribed: null,
      })
    );
  });
});

describe("normalizeWhatsAppCredentials", () => {
  it("preserves catalog asset IDs captured from Embedded Signup", () => {
    expect(
      normalizeWhatsAppCredentials({
        waba_id: "waba-1",
        catalog_ids: ["catalog-1", "catalog-2"],
      })
    ).toMatchObject({
      catalogIds: ["catalog-1", "catalog-2"],
    });
  });

  it("normalizes 2026 account model identifiers while preserving legacy WABA aliases", () => {
    expect(
      normalizeWhatsAppCredentials({
        waba_id: "legacy-waba-1",
        messaging_account_id: "messaging-1",
        waac_id: "waac-1",
        cs_id: "cs-1",
        phone_number_id: "phone-1",
      })
    ).toMatchObject({
      wabaId: "legacy-waba-1",
      messagingAccountId: "messaging-1",
      waacId: "waac-1",
      csId: "cs-1",
      phoneNumberId: "phone-1",
    });
    expect(
      normalizeWhatsAppCredentials({
        waba_id: "legacy-waba-1",
        messaging_account_id: "messaging-1",
        paid_messaging_account_id: "paid-ignored",
      })
    ).not.toHaveProperty("paidMessagingAccountId");

    expect(
      normalizeWhatsAppCredentials({
        messagingAccountId: "messaging-camel",
        csId: "cs-camel",
      })
    ).toMatchObject({
      wabaId: "messaging-camel",
      messagingAccountId: "messaging-camel",
      phoneNumberId: "cs-camel",
      csId: "cs-camel",
    });
  });

  it("ignores stale coexistence flags after a full Cloud API reconnect", () => {
    expect(
      normalizeWhatsAppCredentials({
        waba_id: "waba-1",
        embedded_signup_flow: "cloud_api",
        coexistence_mode: true,
        partner_app_installed: true,
        is_on_biz_app: false,
        platform_type: "NOT_APPLICABLE",
      })
    ).toMatchObject({
      coexistenceMode: false,
      platformType: "NOT_APPLICABLE",
    });
  });

  it("keeps coexistence mode when Meta reports a WhatsApp Business app number", () => {
    expect(
      normalizeWhatsAppCredentials({
        waba_id: "waba-1",
        embedded_signup_flow: "cloud_api",
        coexistence_mode: false,
        is_on_biz_app: true,
        platform_type: "CLOUD_API",
      })
    ).toMatchObject({
      coexistenceMode: true,
    });
  });

  it("normalizes Marketing Messages onboarding into an enabled flag", () => {
    expect(
      normalizeWhatsAppCredentials({
        waba_id: "waba-1",
        marketing_messages_onboarding_status: "ONBOARDED",
      })
    ).toMatchObject({
      marketingMessagesEnabled: true,
    });

    expect(
      normalizeWhatsAppCredentials({
        waba_id: "waba-1",
        marketing_messages_api_status: "PENDING",
      })
    ).toMatchObject({
      marketingMessagesEnabled: false,
    });
  });

  it.each([
    { marketing_messages_onboarding_status: "PENDING" },
    { marketingMessagesOnboardingStatus: " pending " },
    { marketing_messages_api_status: "NOT_ONBOARDED" },
    { marketingMessagesApiStatus: "not_onboarded" },
  ])(
    "lets explicit Marketing Messages status override stale enabled aliases: %j",
    status => {
      expect(
        normalizeWhatsAppCredentials({
          waba_id: "waba-1",
          marketing_messages_enabled: true,
          marketingMessagesEnabled: true,
          ...status,
        })
      ).toMatchObject({ marketingMessagesEnabled: false });
    }
  );

  it.each([
    { marketing_messages_enabled: true },
    { marketingMessagesEnabled: true },
  ])(
    "preserves legacy Marketing Messages enabled aliases when status is absent: %j",
    enabled => {
      expect(
        normalizeWhatsAppCredentials({ waba_id: "waba-1", ...enabled })
      ).toMatchObject({ marketingMessagesEnabled: true });
    }
  );
});

describe("resetWhatsAppPhoneScopedState", () => {
  const phoneScopedState = {
    phone_registered: true,
    phone_registered_at: "2026-09-01T00:00:00.000Z",
    phone_registration_status: "REGISTERED",
    phone_registration_error: "previous error",
    contact_sync: { requested_at: "2026-09-01T00:00:00.000Z" },
    history_sync: { requested_at: "2026-09-01T00:00:00.000Z" },
  };
  const clearedState = Object.fromEntries(
    Object.keys(phoneScopedState).map(key => [key, null])
  );

  it("clears only phone-scoped proof and imports without mutating the input", () => {
    const retainedCredentials = {
      phone_number_id: "phone-old",
      waba_id: "waba-1",
      access_token: "token-1",
      token_expires_at: null,
      waba_subscribed_fields: ["messages"],
    };
    const credentials = Object.freeze({
      ...retainedCredentials,
      ...phoneScopedState,
    });

    const reset = resetWhatsAppPhoneScopedState(credentials, "phone-new");

    expect(reset).toEqual({ ...retainedCredentials, ...clearedState });
    expect(credentials).toMatchObject(phoneScopedState);
    expect(reset).not.toBe(credentials);
  });

  it("stays cleared when the source-binding store merges it onto the stored row", () => {
    const stored = { phone_number_id: "phone-old", ...phoneScopedState };

    expect({
      ...stored,
      ...resetWhatsAppPhoneScopedState(stored, "phone-new"),
    }).toEqual({ phone_number_id: "phone-old", ...clearedState });
  });

  it("adds no keys when the old number had no phone-scoped state", () => {
    expect(
      resetWhatsAppPhoneScopedState(
        { phone_number_id: "phone-old" },
        "phone-new"
      )
    ).toEqual({ phone_number_id: "phone-old" });
  });

  it.each([
    { phone_number_id: "phone-1" },
    { phoneNumberId: " phone-1 " },
    { cs_id: "phone-1" },
  ])("preserves existing state for the same normalized phone: %p", identity => {
    const credentials = Object.freeze({ ...identity, ...phoneScopedState });

    const reset = resetWhatsAppPhoneScopedState(credentials, " phone-1 ");

    expect(reset).toEqual(credentials);
    expect(reset).not.toBe(credentials);
  });

  it("clears unverifiable state when there is no previous phone identity", () => {
    expect(
      resetWhatsAppPhoneScopedState({ ...phoneScopedState }, "phone-new")
    ).toEqual(clearedState);
  });
});
