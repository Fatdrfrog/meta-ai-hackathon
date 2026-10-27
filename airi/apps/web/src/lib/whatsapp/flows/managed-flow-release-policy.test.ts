describe("managed WhatsApp Flow release policy", () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
    jest.resetModules();
  });

  it("is checked in dark with null dates and cannot be activated from environment variables", async () => {
    process.env.WHATSAPP_FLOW_MANAGED_RELEASE_POLICY = "active";
    process.env.WHATSAPP_FLOW_MANAGED_ACTIVATED_AT = "2026-07-30T10:00:00.000Z";
    process.env.WHATSAPP_FLOW_LEGACY_CUTOFF_AT = "2026-08-06T10:00:00.000Z";
    jest.resetModules();

    const { MANAGED_FLOW_RELEASE_POLICY, evaluateManagedFlowReleasePolicy } =
      await import("@/lib/whatsapp/flows/managed-flow-release-policy");

    expect(Object.isFrozen(MANAGED_FLOW_RELEASE_POLICY)).toBe(true);
    expect(MANAGED_FLOW_RELEASE_POLICY).toEqual({
      state: "dark",
      activatedAt: null,
      legacyCutoffAt: null,
    });
    expect(
      evaluateManagedFlowReleasePolicy(new Date("2026-08-07T10:00:00.000Z"))
    ).toEqual({
      valid: true,
      managedFlowEnabled: false,
      legacyFlowAllowed: true,
    });
  });

  it("enables managed traffic at activation and closes legacy traffic exactly at the seven-day cutoff", async () => {
    const { evaluateManagedFlowReleasePolicy } = await import(
      "@/lib/whatsapp/flows/managed-flow-release-policy"
    );
    const policy = {
      state: "active" as const,
      activatedAt: "2026-07-30T10:00:00.000Z",
      legacyCutoffAt: "2026-08-06T10:00:00.000Z",
    };

    expect(
      evaluateManagedFlowReleasePolicy(
        new Date("2026-07-30T09:59:59.999Z"),
        policy
      )
    ).toEqual({
      valid: true,
      managedFlowEnabled: false,
      legacyFlowAllowed: true,
    });
    expect(
      evaluateManagedFlowReleasePolicy(
        new Date("2026-07-30T10:00:00.000Z"),
        policy
      )
    ).toEqual({
      valid: true,
      managedFlowEnabled: true,
      legacyFlowAllowed: true,
    });
    expect(
      evaluateManagedFlowReleasePolicy(
        new Date("2026-08-06T09:59:59.999Z"),
        policy
      )
    ).toEqual({
      valid: true,
      managedFlowEnabled: true,
      legacyFlowAllowed: true,
    });
    expect(
      evaluateManagedFlowReleasePolicy(
        new Date("2026-08-06T10:00:00.000Z"),
        policy
      )
    ).toEqual({
      valid: true,
      managedFlowEnabled: true,
      legacyFlowAllowed: false,
    });
    expect(
      evaluateManagedFlowReleasePolicy(
        new Date("2026-08-06T10:00:00.001Z"),
        policy
      )
    ).toEqual({
      valid: true,
      managedFlowEnabled: true,
      legacyFlowAllowed: false,
    });
  });

  it("accepts calendar-valid absolute timestamps with timezone offsets", async () => {
    const { evaluateManagedFlowReleasePolicy } = await import(
      "@/lib/whatsapp/flows/managed-flow-release-policy"
    );
    const policy = {
      state: "active" as const,
      activatedAt: "2026-07-30T15:00:00+05:00",
      legacyCutoffAt: "2026-08-06T15:00:00+05:00",
    };

    expect(
      evaluateManagedFlowReleasePolicy(
        new Date("2026-07-30T10:00:00.000Z"),
        policy
      )
    ).toEqual({
      valid: true,
      managedFlowEnabled: true,
      legacyFlowAllowed: true,
    });
  });

  it.each([
    {
      state: "active",
      activatedAt: "not-an-instant",
      legacyCutoffAt: "2026-08-06T10:00:00.000Z",
    },
    {
      state: "active",
      activatedAt: "2026-07-30T10:00:00.000Z",
      legacyCutoffAt: "2026-07-29T10:00:00.000Z",
    },
    {
      state: "active",
      activatedAt: "2026-07-30T10:00:00.000Z",
      legacyCutoffAt: "2026-08-05T10:00:00.000Z",
    },
    {
      state: "dark",
      activatedAt: "2026-07-30T10:00:00.000Z",
      legacyCutoffAt: null,
    },
    {
      state: "active",
      activatedAt: "2026-02-30T10:00:00.000Z",
      legacyCutoffAt: "2026-03-09T10:00:00.000Z",
    },
    null,
  ])("fails closed for malformed policy %#", async policy => {
    const { evaluateManagedFlowReleasePolicy } = await import(
      "@/lib/whatsapp/flows/managed-flow-release-policy"
    );

    expect(
      evaluateManagedFlowReleasePolicy(
        new Date("2026-07-31T10:00:00.000Z"),
        policy as never
      )
    ).toEqual({
      valid: false,
      managedFlowEnabled: false,
      legacyFlowAllowed: false,
    });
  });
});
