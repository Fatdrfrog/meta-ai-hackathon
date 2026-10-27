const mockFrom = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import {
  getWorkspaceFeatureFlags,
  isWorkspaceFeatureEnabled,
  WORKSPACE_FEATURE_KEYS,
} from "./workspace-feature-flags";

function featureQuery(result: {
  data: Array<{ feature_key: string; enabled: boolean }> | null;
  error: unknown;
}) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn().mockResolvedValue(result),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

describe("workspace feature flags", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps managed WhatsApp Flow provisioning disabled by default", async () => {
    mockFrom.mockReturnValue(featureQuery({ data: [], error: null }));

    const flags = await getWorkspaceFeatureFlags("workspace-1");

    expect(WORKSPACE_FEATURE_KEYS).toContain("whatsapp_flow_managed_endpoint");
    expect(flags.whatsapp_flow_managed_endpoint).toBe(false);
  });

  it("keeps the scenario node settings panel off unless a workspace row enables it", async () => {
    mockFrom.mockReturnValue(featureQuery({ data: [], error: null }));
    const flags = await getWorkspaceFeatureFlags("workspace-1");
    expect(WORKSPACE_FEATURE_KEYS).toContain("scenario_node_settings_panel");
    expect(flags.scenario_node_settings_panel).toBe(false);

    const query = featureQuery({
      data: [{ feature_key: "scenario_node_settings_panel", enabled: true }],
      error: null,
    });
    mockFrom.mockReturnValue(query);
    await expect(
      isWorkspaceFeatureEnabled("workspace-1", "scenario_node_settings_panel")
    ).resolves.toBe(true);
    expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(query.in).toHaveBeenCalledWith("feature_key", [
      "scenario_node_settings_panel",
    ]);

    mockFrom.mockReturnValue(
      featureQuery({ data: null, error: { message: "timeout" } })
    );
    await expect(
      isWorkspaceFeatureEnabled("workspace-1", "scenario_node_settings_panel")
    ).resolves.toBe(false);
  });

  it("keeps Settings → Offices off unless a workspace row enables it", async () => {
    mockFrom.mockReturnValue(featureQuery({ data: [], error: null }));
    const flags = await getWorkspaceFeatureFlags("workspace-1");
    expect(WORKSPACE_FEATURE_KEYS).toContain("scenario_location_routing");
    expect(flags.scenario_location_routing).toBe(false);

    const query = featureQuery({
      data: [{ feature_key: "scenario_location_routing", enabled: true }],
      error: null,
    });
    mockFrom.mockReturnValue(query);
    await expect(
      isWorkspaceFeatureEnabled("workspace-1", "scenario_location_routing")
    ).resolves.toBe(true);
    expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(query.in).toHaveBeenCalledWith("feature_key", [
      "scenario_location_routing",
    ]);

    mockFrom.mockReturnValue(
      featureQuery({ data: null, error: { message: "timeout" } })
    );
    await expect(
      isWorkspaceFeatureEnabled("workspace-1", "scenario_location_routing")
    ).resolves.toBe(false);
  });

  it("enables managed provisioning only for an explicit workspace row", async () => {
    mockFrom.mockReturnValue(
      featureQuery({
        data: [
          {
            feature_key: "whatsapp_flow_managed_endpoint",
            enabled: true,
          },
        ],
        error: null,
      })
    );

    await expect(
      isWorkspaceFeatureEnabled("workspace-1", "whatsapp_flow_managed_endpoint")
    ).resolves.toBe(true);
  });
});
