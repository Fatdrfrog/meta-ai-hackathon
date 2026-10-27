import { requireAppAdmin } from "@/lib/auth/app-admin";
import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import {
  normalizeFewShotExamples,
  normalizeTaxonomyLabels,
} from "@/lib/classifier/taxonomy";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");

  if (workspaceId) {
    const access = await getAuthenticatedWorkspaceMembership(workspaceId);
    if (access.error) return access.error;
  } else {
    const access = await requireAppAdmin(supabase);
    if (access.response) return access.response;
  }

  let query = supabase
    .from("taxonomies")
    .select(
      "id, workspace_id, vertical, labels, guidelines, few_shots, confidence_threshold, version, updated_at"
    )
    .order("updated_at", { ascending: false });

  if (workspaceId) {
    query = query.eq("workspace_id", workspaceId).limit(1);
  } else {
    query = query.limit(200);
  }

  const { data, error } = await query;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  const normalized = (data || []).map(item => ({
    ...item,
    labels: normalizeTaxonomyLabels(
      Array.isArray(item.labels) ? item.labels : []
    ),
  }));

  return NextResponse.json({ items: normalized });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const body = (await request.json()) as {
    id?: string;
    workspace_id: string;
    vertical?: string;
    labels: string[];
    guidelines?: string;
    few_shots?: Array<{ text: string; label: string }>;
    confidence_threshold?: number;
    version?: string;
  };
  const {
    id,
    workspace_id,
    vertical,
    labels,
    guidelines,
    few_shots,
    confidence_threshold,
    version,
  } = body || ({} as never);
  if (!workspace_id || !Array.isArray(labels) || labels.length === 0) {
    return NextResponse.json(
      { error: "workspace_id and labels[] required" },
      { status: 400 }
    );
  }
  const access = await getAuthenticatedWorkspaceMembership(workspace_id);
  if (access.error) return access.error;

  const normalizedLabels = normalizeTaxonomyLabels(labels);
  const normalizedFewShots = normalizeFewShotExamples(
    few_shots,
    normalizedLabels
  );
  const rawFewShotCount = Array.isArray(few_shots) ? few_shots.length : 0;
  if (rawFewShotCount > 0 && normalizedFewShots.length === 0) {
    return NextResponse.json(
      {
        error:
          "few_shots must reference valid taxonomy labels and include text",
      },
      { status: 400 }
    );
  }

  const payload = {
    workspace_id,
    vertical,
    labels: normalizedLabels,
    guidelines: typeof guidelines === "string" ? guidelines.trim() : undefined,
    few_shots: normalizedFewShots,
    confidence_threshold,
    version,
  };
  const res = id
    ? await supabase
        .from("taxonomies")
        .update(payload)
        .eq("id", id)
        .eq("workspace_id", workspace_id)
        .select("id")
        .single()
    : await supabase.from("taxonomies").insert(payload).select("id").single();
  if (res.error)
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: (res.data as { id: string })?.id });
}
