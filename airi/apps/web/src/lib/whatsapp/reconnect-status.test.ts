jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWhatsAppReconnectStatus } from "./reconnect-status";

function mockWhatsAppSource(source: unknown) {
  const maybeSingle = jest
    .fn()
    .mockResolvedValue({ data: source, error: null });
  const eqType = jest.fn().mockReturnValue({ maybeSingle });
  const eqWorkspace = jest.fn().mockReturnValue({ eq: eqType });
  const select = jest.fn().mockReturnValue({ eq: eqWorkspace });
  (supabaseAdmin.from as jest.Mock).mockReturnValue({ select });
}

describe("getWhatsAppReconnectStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("prioritizes an active partner removal over token expiry", async () => {
    mockWhatsAppSource({
      id: "source-1",
      credentials: {
        waba_id: "waba-1",
        display_phone_number: "+7 701 000 00 00",
        embedded_signup: true,
        token_expires_at: "2099-01-01T00:00:00.000Z",
        coexistence_reonboarding_status: "removed",
        coexistence_reonboarding_event: "PARTNER_REMOVED",
        coexistence_reonboarding_removed_at: "2026-08-20T08:00:00.000Z",
        partner_removed_reason: "BUSINESS_DOWNGRADE",
        partner_removed_initiated_by: "USER",
      },
    });

    await expect(getWhatsAppReconnectStatus("workspace-1")).resolves.toEqual({
      state: "removed",
      daysUntilExpiry: null,
      wabaId: "waba-1",
      displayPhoneNumber: "+7 701 000 00 00",
      reconnectMethod: "embedded",
      partnerRemoval: {
        sourceId: "source-1",
        removedAt: "2026-08-20T08:00:00.000Z",
        alertDismissed: false,
        reason: "BUSINESS_DOWNGRADE",
        initiatedBy: "USER",
      },
    });
  });

  it("treats an alert dismissal as valid only for the current removal", async () => {
    mockWhatsAppSource({
      id: "source-1",
      credentials: {
        waba_id: "waba-1",
        coexistence_reonboarding_status: "removed",
        coexistence_reonboarding_event: "PARTNER_REMOVED",
        coexistence_reonboarding_removed_at: "2026-08-20T08:00:00.000Z",
        partner_removed_alert_dismissed_for: "2026-08-20T08:00:00.000Z",
      },
    });

    const status = await getWhatsAppReconnectStatus("workspace-1");

    expect(status.partnerRemoval?.alertDismissed).toBe(true);
  });

  it("keeps routine finite expiry under automatic maintenance", async () => {
    mockWhatsAppSource({
      id: "source-1",
      credentials: {
        embedded_signup: true,
        token_expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      },
    });

    expect(await getWhatsAppReconnectStatus("workspace-1")).toMatchObject({
      state: "maintaining",
      daysUntilExpiry: 5,
    });
  });

  it("surfaces verified lost access even without an expiry", async () => {
    mockWhatsAppSource({
      id: "source-1",
      credentials: {
        embedded_signup: true,
        meta_diagnostics_reconnect_reason: "meta_authorization",
        webhook_requires_reconnect: true,
      },
    });

    expect(await getWhatsAppReconnectStatus("workspace-1")).toMatchObject({
      state: "action_required",
      daysUntilExpiry: null,
    });
  });

  it("keeps verified expired access actionable", async () => {
    mockWhatsAppSource({
      id: "source-1",
      credentials: {
        token_expires_at: "2026-01-01T00:00:00.000Z",
        token_verified_at: "2026-01-02T00:00:00.000Z",
        token_is_valid: false,
      },
    });

    expect(await getWhatsAppReconnectStatus("workspace-1")).toMatchObject({
      state: "expired",
    });
  });
});
