import {
  deriveWhatsAppAccountHealth,
  getWhatsAppSendBlockingReason,
  mergeWhatsAppAccountHealthCredentials,
} from "./health";

describe("deriveWhatsAppAccountHealth", () => {
  it("marks offboarded coexistence accounts as reconnecting", () => {
    const health = deriveWhatsAppAccountHealth({
      coexistence_reonboarding_status: "offboarded",
      cloud_api_messaging_suspended: true,
    });

    expect(health.state).toBe("reconnecting");
    expect(health.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "coexistence_offboarded" }),
      ])
    );
  });

  it("marks partner-removed accounts as disconnected and keeps the Meta reason", () => {
    const health = deriveWhatsAppAccountHealth({
      coexistence_reonboarding_status: "removed",
      cloud_api_messaging_suspended: true,
      partner_removed_reason: "PRIMARY_INACTIVITY",
      partner_removed_initiated_by: "SYSTEM",
    });

    expect(health.state).toBe("disconnected");
    expect(health.reasons).toEqual([
      expect.objectContaining({
        code: "partner_removed",
        message: expect.stringContaining("PRIMARY_INACTIVITY"),
      }),
    ]);
  });

  it("prioritizes payment-required state over generic warnings", () => {
    const health = deriveWhatsAppAccountHealth({
      payment_configuration_status: "missing",
      webhook_missing_required_fields: ["account_update"],
    });

    expect(health.state).toBe("payment_required");
    expect(health.reasons[0]).toEqual(
      expect.objectContaining({ code: "payment_required" })
    );
  });

  it("marks inaccessible WABA or phone state as inaccessible", () => {
    const health = deriveWhatsAppAccountHealth({
      phone_number_accessible: false,
      phone_number_access_error: "Unsupported get request",
    });

    expect(health.state).toBe("inaccessible");
    expect(health.reasons[0]).toEqual(
      expect.objectContaining({ code: "phone_inaccessible" })
    );
  });

  it("does not trust stale phone-in-WABA booleans when live WABA phone IDs disagree", () => {
    const health = deriveWhatsAppAccountHealth({
      phone_number_id: "stored-phone-id",
      phone_number_in_waba: true,
      waba_phone_number_ids: ["different-phone-id"],
    });

    expect(health.state).toBe("inaccessible");
    expect(health.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "phone_not_in_waba" }),
      ])
    );
  });

  it("surfaces webhook reconnect requirements even when required field lists are stale", () => {
    const health = deriveWhatsAppAccountHealth({
      webhook_requires_reconnect: true,
      webhook_subscribed: false,
      webhook_error: "Object does not exist or missing permissions",
      webhook_missing_required_fields: [],
    });

    expect(health.state).toBe("warning");
    expect(health.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "webhook_reconnect_required" }),
      ])
    );
  });

  it("warns when phone registration explicitly failed and preserves the provider error", () => {
    const health = deriveWhatsAppAccountHealth({
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      phone_registered: false,
      phone_registration_error: "The phone number is not registered",
    });

    expect(health.state).toBe("warning");
    expect(health.reasons).toEqual([
      expect.objectContaining({
        code: "phone_not_registered",
        message: "The phone number is not registered",
        source: "phone_registration",
      }),
    ]);
  });

  it("keeps current webhook app and coverage proof authoritative over a stale legacy flag", () => {
    const health = deriveWhatsAppAccountHealth({
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      webhook_subscribed: false,
      webhook_requires_reconnect: false,
      waba_selected_app_matches_config: true,
      webhook_missing_required_fields: [],
    });

    expect(health).toMatchObject({ state: "healthy", reasons: [] });
  });

  it.each([
    {},
    { phone_registered: undefined, webhook_subscribed: undefined },
    { phone_registered: null, webhook_subscribed: null },
    { phone_registered: true, webhook_subscribed: true },
  ])(
    "does not infer failed setup from absent, unknown, or successful flags: %j",
    flags => {
      expect(
        deriveWhatsAppAccountHealth({
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          ...flags,
        })
      ).toMatchObject({ state: "healthy", reasons: [] });
    }
  );

  it.each([
    { state: "restricted", account_review_status: "restricted" },
    { state: "disconnected", coexistence_reonboarding_status: "removed" },
  ])(
    "preserves stronger $state health when registration and webhooks fail",
    ({ state, ...input }) => {
      const health = deriveWhatsAppAccountHealth({
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        phone_registered: false,
        webhook_requires_reconnect: true,
        ...input,
      });

      expect(health.state).toBe(state);
      expect(health.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "phone_not_registered" }),
          expect.objectContaining({ code: "webhook_reconnect_required" }),
        ])
      );
    }
  );
});

describe("getWhatsAppSendBlockingReason", () => {
  it("returns the reason for an incomplete phone registration", () => {
    const health = deriveWhatsAppAccountHealth({
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      phone_registered: false,
    });

    expect(getWhatsAppSendBlockingReason(health)).toEqual(
      expect.objectContaining({ code: "phone_not_registered" })
    );
  });

  it("returns null for warn-only reasons that still allow sends", () => {
    const health = deriveWhatsAppAccountHealth({
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      webhook_missing_required_fields: ["messages"],
    });

    expect(health.state).toBe("warning");
    expect(getWhatsAppSendBlockingReason(health)).toBeNull();
  });

  it("returns null when no health is available", () => {
    expect(getWhatsAppSendBlockingReason(null)).toBeNull();
    expect(getWhatsAppSendBlockingReason(undefined)).toBeNull();
  });
});

describe("mergeWhatsAppAccountHealthCredentials", () => {
  it("stores normalized health state on credentials", () => {
    expect(
      mergeWhatsAppAccountHealthCredentials({
        payment_configuration_status: "missing",
      })
    ).toEqual(
      expect.objectContaining({
        payment_configuration_status: "missing",
        waba_health_state: "payment_required",
        waba_health_reasons: expect.arrayContaining([
          expect.objectContaining({ code: "payment_required" }),
        ]),
      })
    );
  });
});

describe("inbound liveness health reason", () => {
  const now = Date.parse("2026-10-13T15:30:00.000Z");
  const silent = {
    phone_number_id: "phone-1",
    waba_id: "waba-1",
    inbound_liveness_status: "silent",
    inbound_liveness_phone_number_id: "phone-1",
    inbound_liveness_silent_since: "2026-10-12T16:09:49.845Z",
    inbound_liveness_checked_at: "2026-10-13T15:25:00.000Z",
  };
  const codes = (input: Record<string, unknown>) =>
    deriveWhatsAppAccountHealth(input, { now }).reasons.map(
      reason => reason.code
    );

  it("warns, without blocking sends, when a connected number stops receiving", () => {
    const health = deriveWhatsAppAccountHealth(silent, { now });

    expect(health.state).toBe("warning");
    expect(health.reasons).toEqual([
      expect.objectContaining({
        code: "inbound_silent",
        message: expect.stringContaining("since 2026-10-12 16:09 UTC"),
      }),
    ]);
    expect(getWhatsAppSendBlockingReason(health)).toBeNull();
  });

  it("leaves a disconnected number to its own reason", () => {
    expect(
      codes({
        ...silent,
        coexistence_reonboarding_status: "removed",
        cloud_api_messaging_suspended: true,
      })
    ).toEqual(["partner_removed"]);
  });

  it.each([
    ["the flag was cleared", { inbound_liveness_status: null }],
    [
      "no run confirmed it for hours",
      { inbound_liveness_checked_at: "2026-10-13T11:00:00.000Z" },
    ],
    ["the source now uses another number", { phone_number_id: "phone-2" }],
  ])("drops the warning when %s", (_label, overrides) => {
    expect(codes({ ...silent, ...overrides })).not.toContain("inbound_silent");
  });
});
