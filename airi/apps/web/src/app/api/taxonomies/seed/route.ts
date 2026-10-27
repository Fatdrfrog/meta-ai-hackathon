import { NextRequest, NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/app-admin";
import { DEFAULT_TAXONOMY } from "@/lib/classifier/taxonomy";

export async function POST(request: NextRequest) {
  const access = await requireAppAdmin();
  if (access.response) return access.response;

  const supabase = access.supabase;
  const { workspace_ids } = await request.json().catch(() => ({}));
  if (!Array.isArray(workspace_ids) || workspace_ids.length === 0) {
    return NextResponse.json(
      { error: "workspace_ids required" },
      { status: 400 }
    );
  }
  const rows = workspace_ids.map((wid: string) => ({
    workspace_id: wid,
    vertical: null,
    labels: DEFAULT_TAXONOMY.labels,
    guidelines: DEFAULT_TAXONOMY.guidelines,
    few_shots: DEFAULT_TAXONOMY.fewShots,
    confidence_threshold: DEFAULT_TAXONOMY.confidenceThreshold,
    version: DEFAULT_TAXONOMY.version,
  }));
  const { error } = await supabase.from("taxonomies").insert(rows);
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, inserted: rows.length });
}
