import {
  buildWhatsAppTokenMetadataPatch,
  getWhatsAppConnectionMaintenanceStatus,
} from "./token-lifecycle";

const now = Date.parse("2026-09-17T12:00:00Z");
const day = 86400000;
const verified = {
  token_verified_at: new Date(now).toISOString(),
  token_is_valid: true,
};

describe("WhatsApp token lifecycle projection", () => {
  it("keeps routine renewal silent even inside the old fourteen-day warning window", () => {
    for (const days of [14, 7, 1]) {
      expect(
        getWhatsAppConnectionMaintenanceStatus(
          {
            ...verified,
            token_expires_at: new Date(now + days * day).toISOString(),
            token_maintenance_status: "healthy",
          },
          now
        ).state
      ).toBe("maintaining");
    }
  });
  it("does not treat a legacy unverified expiry as proof of disconnected messaging", () => {
    expect(
      getWhatsAppConnectionMaintenanceStatus(
        { token_expires_at: new Date(now - day).toISOString() },
        now
      ).state
    ).toBe("maintaining");
  });
  it("makes confirmed revocation or expiry actionable, regardless of maintenance success history", () => {
    expect(
      getWhatsAppConnectionMaintenanceStatus(
        { ...verified, token_is_valid: false },
        now
      ).state
    ).toBe("action_required");
    expect(
      getWhatsAppConnectionMaintenanceStatus(
        {
          ...verified,
          token_expires_at: new Date(now - 1).toISOString(),
          token_maintenance_status: "renewed",
        },
        now
      ).state
    ).toBe("expired");
    expect(
      getWhatsAppConnectionMaintenanceStatus(
        {
          webhook_requires_reconnect: true,
          meta_diagnostics_reconnect_reason: "meta_authorization",
        },
        now
      ).state
    ).toBe("action_required");
  });
  it("only warns for a verified inability to renew when the deadline is near", () => {
    for (const [days, state] of [
      [14, "maintaining"],
      [7, "action_required"],
    ] as const) {
      expect(
        getWhatsAppConnectionMaintenanceStatus(
          {
            ...verified,
            token_expires_at: new Date(now + days * day).toISOString(),
            token_maintenance_status: "reconnect_required",
          },
          now
        ).state
      ).toBe(state);
    }
  });
  it("keeps temporary maintenance failures silent while the connection remains valid", () => {
    expect(
      getWhatsAppConnectionMaintenanceStatus(
        {
          ...verified,
          token_expires_at: new Date(now + day).toISOString(),
          token_maintenance_status: "retrying",
        },
        now
      ).state
    ).toBe("maintaining");
  });
  it("keeps unknown metadata distinct from a verified non-expiring token", () => {
    expect(getWhatsAppConnectionMaintenanceStatus({}, now).state).toBe(
      "unknown"
    );
    expect(
      getWhatsAppConnectionMaintenanceStatus(
        { ...verified, token_never_expires: true },
        now
      ).state
    ).toBe("healthy");
  });
  it("clears stale dates only from authoritative debugger metadata", () => {
    expect(
      buildWhatsAppTokenMetadataPatch(
        {
          app_id: "app",
          is_valid: true,
          type: "SYSTEM_USER",
          expires_at: 0,
          data_access_expires_at: 0,
        },
        { appId: "app", nowMs: now }
      )
    ).toMatchObject({
      token_type: "SYSTEM_USER",
      token_is_valid: true,
      token_never_expires: true,
      token_expires_at: null,
      token_maintenance_status: "healthy",
    });
  });
  it("retains the earlier data-access deadline and identifies invalid app binding", () => {
    expect(
      buildWhatsAppTokenMetadataPatch(
        {
          app_id: "app",
          is_valid: true,
          type: "SYSTEM_USER",
          expires_at: (now + 60 * day) / 1000,
          data_access_expires_at: (now + day) / 1000,
        },
        { appId: "app", nowMs: now }
      ).token_expires_at
    ).toBe(new Date(now + day).toISOString());
    expect(
      buildWhatsAppTokenMetadataPatch(
        { app_id: "another-app", is_valid: true },
        { appId: "app", nowMs: now }
      )
    ).toMatchObject({
      token_is_valid: false,
      token_maintenance_status: "reconnect_required",
    });
  });
  it("does not promote an incomplete debugger response into verified revocation", () => {
    expect(
      buildWhatsAppTokenMetadataPatch(
        { app_id: "app" },
        { appId: "app", nowMs: now }
      )
    ).toMatchObject({
      token_is_valid: undefined,
      token_maintenance_status: "retrying",
      token_never_expires: false,
    });
    expect(
      buildWhatsAppTokenMetadataPatch(
        { is_valid: true },
        { appId: "app", nowMs: now }
      )
    ).toMatchObject({
      token_is_valid: undefined,
      token_maintenance_status: "retrying",
    });
  });
});
