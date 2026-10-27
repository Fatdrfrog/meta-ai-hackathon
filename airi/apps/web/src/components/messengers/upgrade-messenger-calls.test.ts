import { isCallsSetupReady } from "./upgrade-messenger-calls";

describe("isCallsSetupReady", () => {
  it("requires Meta calling status and platform runtime readiness", () => {
    expect(
      isCallsSetupReady({
        calls_webhook_subscribed: true,
        calls_enabled: true,
        calls_callback_permission_status: "ENABLED",
        calls_operational_readiness: {
          ready: false,
          checks: [
            {
              id: "livekit_configured",
              ready: false,
              label: "LiveKit",
              value: "Missing",
              actionable: "Configure LiveKit before enabling call media.",
            },
          ],
        },
      })
    ).toBe(false);

    expect(
      isCallsSetupReady({
        calls_webhook_subscribed: true,
        calls_enabled: true,
        calls_callback_permission_status: "ENABLED",
        calls_operational_readiness: {
          ready: true,
          checks: [],
        },
      })
    ).toBe(true);
  });
});
