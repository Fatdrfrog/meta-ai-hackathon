import { prepareWhatsAppHistorySyncSession } from "./lifecycle";

const next = {
  phone_number_id: "phone-1",
  embedded_signup_flow: "coexistence",
};
const params = {
  sessionId: "session-new",
  startedAt: "2026-10-10T10:00:00.000Z",
};

describe("future WhatsApp history onboarding sessions", () => {
  it("prepares a session for a new coexistence connection before provider setup", () => {
    expect(
      prepareWhatsAppHistorySyncSession({ ...params, current: {}, next })
    ).toMatchObject({
      history_sync: {
        session_id: "session-new",
        session_started_at: params.startedAt,
      },
    });
  });

  it("does not enroll an existing sessionless company on an ordinary reconnect", () => {
    const current = {
      ...next,
      history_sync: { requested_at: "2026-05-01T00:00:00Z" },
    };
    expect(
      prepareWhatsAppHistorySyncSession({ ...params, current, next: current })
        .history_sync
    ).toEqual(current.history_sync);
  });

  it("starts a fresh session after confirmed offboarding and fresh Embedded Signup", () => {
    const current = {
      ...next,
      history_sync: {
        requested_at: "2026-05-01T00:00:00Z",
        status: "completed",
      },
      coexistence_reonboarding_status: "removed",
      coexistence_reonboarding_last_event_at: "2026-10-10T09:00:00Z",
    };
    const result = prepareWhatsAppHistorySyncSession({
      ...params,
      current,
      next: { ...current, ...next },
      embeddedSignupCompleted: true,
    });
    expect(result.history_sync).toEqual({
      session_id: "session-new",
      session_started_at: params.startedAt,
    });
    expect(
      prepareWhatsAppHistorySyncSession({
        ...params,
        sessionId: "duplicate",
        current: result,
        next: result,
        embeddedSignupCompleted: true,
      }).history_sync
    ).toEqual(result.history_sync);
  });

  it("does not reset for automatic device reconnection or token refresh", () => {
    const current = {
      ...next,
      coexistence_reonboarding_status: "offboarded",
      history_sync: { requested_at: "2026-05-01T00:00:00Z" },
    };
    expect(
      prepareWhatsAppHistorySyncSession({ ...params, current, next: current })
        .history_sync
    ).toEqual(current.history_sync);
  });

  it("replaces prior phone history on changed phone and does not enable full Cloud API", () => {
    const current = {
      ...next,
      phone_number_id: "phone-old",
      history_sync: { status: "completed" },
    };
    expect(
      prepareWhatsAppHistorySyncSession({ ...params, current, next })
    ).toMatchObject({ history_sync: { session_id: "session-new" } });
    expect(
      prepareWhatsAppHistorySyncSession({
        ...params,
        current: {},
        next: { ...next, embedded_signup_flow: "cloud_api" },
      })
    ).not.toHaveProperty("history_sync");
  });

  it("does not initialize history for QR metadata explicitly verified as plain Cloud API", () => {
    const verifiedCloud = { phone_number_id: "phone-1", qr_registered: true, platform_type: "CLOUD_API", is_on_biz_app: false };
    expect(prepareWhatsAppHistorySyncSession({ ...params, current: {}, next: verifiedCloud })).not.toHaveProperty("history_sync");
  });
});
