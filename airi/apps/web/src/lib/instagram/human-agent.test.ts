import {
  applyInstagramHumanAgentWindow,
  parseBooleanFlag,
  parseGrantedPermissions,
  resolveInstagramHumanAgentCapability,
  resolveInstagramHumanAgentWindow,
} from "@/lib/instagram/human-agent";

describe("Instagram Human Agent capability", () => {
  it("parses comma and whitespace separated granted permissions", () => {
    expect(
      Array.from(
        parseGrantedPermissions(
          "instagram_business_basic, instagram_business_manage_messages pages_read_engagement"
        )
      ).sort()
    ).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_messages",
      "pages_read_engagement",
    ]);
  });

  it.each([
    ["true", true],
    ["approved", true],
    ["1", true],
    ["false", false],
    ["not_approved", false],
    ["0", false],
    ["unknown", undefined],
  ] as const)("parses %s as %s", (raw, expected) => {
    expect(parseBooleanFlag(raw)).toBe(expected);
  });

  it("does not support Human Agent outside Instagram", () => {
    expect(
      resolveInstagramHumanAgentCapability({
        channel: "whatsapp",
        hasInstagramSource: true,
      })
    ).toEqual({ supported: false, enabled: false });
  });

  it("keeps Human Agent disabled when Instagram is not connected", () => {
    expect(
      resolveInstagramHumanAgentCapability({
        channel: "instagram",
        hasInstagramSource: false,
      })
    ).toEqual({
      supported: true,
      enabled: false,
      reason: "instagram_not_connected",
    });
  });

  it("does not treat normal Instagram message scopes as Human Agent approval", () => {
    expect(
      resolveInstagramHumanAgentCapability({
        channel: "instagram",
        hasInstagramSource: true,
        grantedPermissionsRaw:
          "instagram_business_basic,instagram_business_manage_messages",
      })
    ).toEqual({
      supported: true,
      enabled: false,
      reason: "human_agent_not_approved",
    });
  });

  it("keeps Human Agent disabled when OAuth scope data is missing", () => {
    expect(
      resolveInstagramHumanAgentCapability({
        channel: "instagram",
        hasInstagramSource: true,
      })
    ).toEqual({
      supported: true,
      enabled: false,
      reason: "human_agent_not_approved",
    });
  });

  it("enables Human Agent only with an explicit approval flag", () => {
    expect(
      resolveInstagramHumanAgentCapability({
        channel: "instagram",
        hasInstagramSource: true,
        humanAgentEnabledRaw: true,
      })
    ).toEqual({ supported: true, enabled: true });
  });

  it("surfaces missing Instagram message scopes separately", () => {
    expect(
      resolveInstagramHumanAgentCapability({
        channel: "instagram",
        hasInstagramSource: true,
        grantedPermissionsRaw: "instagram_business_basic",
      })
    ).toEqual({
      supported: true,
      enabled: false,
      reason: "missing_manage_messages_permission",
    });
  });
});

describe("Instagram Human Agent 7-day window", () => {
  const lastInbound = "2026-10-01T10:00:00.000Z";
  const at = (iso: string) => new Date(iso).getTime();

  it("expires 7 days after the customer's last message", () => {
    expect(
      resolveInstagramHumanAgentWindow(
        lastInbound,
        at("2026-10-08T09:59:00.000Z")
      )
    ).toEqual({ isWithinWindow: true, expiresAt: "2026-10-08T10:00:00.000Z" });
    expect(
      resolveInstagramHumanAgentWindow(
        lastInbound,
        at("2026-10-08T10:00:00.000Z")
      ).isWithinWindow
    ).toBe(false);
  });

  it("has no window before the customer has written", () => {
    expect(resolveInstagramHumanAgentWindow(null)).toEqual({
      isWithinWindow: false,
      expiresAt: null,
    });
  });

  it("keeps an approved capability inside the window and adds its end", () => {
    expect(
      applyInstagramHumanAgentWindow(
        { supported: true, enabled: true },
        lastInbound,
        at("2026-10-05T00:00:00.000Z")
      )
    ).toEqual({
      supported: true,
      enabled: true,
      expiresAt: "2026-10-08T10:00:00.000Z",
    });
  });

  it("disables an approved capability once the window has passed", () => {
    expect(
      applyInstagramHumanAgentWindow(
        { supported: true, enabled: true },
        lastInbound,
        at("2026-10-09T00:00:00.000Z")
      )
    ).toEqual({
      supported: true,
      enabled: false,
      reason: "human_agent_window_expired",
      expiresAt: "2026-10-08T10:00:00.000Z",
    });
  });

  it("leaves an unapproved capability and its reason alone", () => {
    const capability = {
      supported: true,
      enabled: false,
      reason: "human_agent_not_approved",
    };
    expect(applyInstagramHumanAgentWindow(capability, lastInbound)).toBe(
      capability
    );
  });
});
