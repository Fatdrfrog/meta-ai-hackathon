import { supabaseAdmin } from "@/lib/supabase/admin";

export const WORKSPACE_FEATURE_KEYS = [
  "instagram_studio",
  "customer_identity",
  "customer_timeline",
  "customer_behavioral_profile",
  "whatsapp_service_bulk",
  "whatsapp_flow_managed_endpoint",
  "scenario_node_settings_panel",
  "scenario_location_routing",
  "products",
] as const;

export type WorkspaceFeatureKey = (typeof WORKSPACE_FEATURE_KEYS)[number];

export type WorkspaceFeatureFlags = Record<WorkspaceFeatureKey, boolean>;

function createDefaultFlags(): WorkspaceFeatureFlags {
  return {
    instagram_studio: false,
    customer_identity: true,
    customer_timeline: true,
    customer_behavioral_profile: true,
    whatsapp_service_bulk: false,
    whatsapp_flow_managed_endpoint: false,
    scenario_node_settings_panel: false,
    scenario_location_routing: false,
    products: false,
  };
}

function isWorkspaceFeatureKey(value: string): value is WorkspaceFeatureKey {
  return (WORKSPACE_FEATURE_KEYS as readonly string[]).includes(value);
}

function isMissingFeatureFlagsTable(error: unknown): boolean {
  const message = String(
    (error as { message?: string } | null)?.message || ""
  ).toLowerCase();
  return (
    message.includes("workspace_feature_flags") &&
    (message.includes("does not exist") ||
      message.includes("relation") ||
      message.includes("table"))
  );
}

export async function getWorkspaceFeatureFlags(
  workspaceId: string,
  keys?: WorkspaceFeatureKey[]
): Promise<WorkspaceFeatureFlags> {
  const flags = createDefaultFlags();
  const requestedKeys =
    keys && keys.length > 0 ? keys : [...WORKSPACE_FEATURE_KEYS];

  const { data, error } = await supabaseAdmin
    .from("workspace_feature_flags")
    .select("feature_key, enabled")
    .eq("workspace_id", workspaceId)
    .in("feature_key", requestedKeys);

  if (error) {
    if (isMissingFeatureFlagsTable(error)) {
      return flags;
    }
    return flags;
  }

  for (const row of (data || []) as Array<{
    feature_key?: string | null;
    enabled?: boolean | null;
  }>) {
    const key = String(row.feature_key || "").trim();
    if (!isWorkspaceFeatureKey(key)) continue;
    flags[key] = row.enabled === true;
  }

  return flags;
}

export async function isWorkspaceFeatureEnabled(
  workspaceId: string,
  feature: WorkspaceFeatureKey
): Promise<boolean> {
  const flags = await getWorkspaceFeatureFlags(workspaceId, [feature]);
  return flags[feature] === true;
}
