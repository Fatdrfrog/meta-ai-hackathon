import {
  getWorkspaceFeatureFlags,
  type WorkspaceFeatureKey,
  WORKSPACE_FEATURE_KEYS,
} from "@/lib/workspace-feature-flags";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

type Params = Promise<{ workspaceId: string }>;

function parseRequestedKeys(raw: string | null): WorkspaceFeatureKey[] {
  if (!raw || !raw.trim()) {
    return [...WORKSPACE_FEATURE_KEYS];
  }

  const known = new Set<string>(WORKSPACE_FEATURE_KEYS);
  const keys = raw
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)
    .filter(key => known.has(key));

  return (
    keys.length > 0 ? keys : [...WORKSPACE_FEATURE_KEYS]
  ) as WorkspaceFeatureKey[];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const keysParam = new URL(request.url).searchParams.get("keys");
    const keys = parseRequestedKeys(keysParam);
    const flags = await getWorkspaceFeatureFlags(workspaceId, keys);

    return NextResponse.json({ flags });
  } catch (error) {
    console.error("[Workspace Feature Flags] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load workspace feature flags" },
      { status: 500 }
    );
  }
}
