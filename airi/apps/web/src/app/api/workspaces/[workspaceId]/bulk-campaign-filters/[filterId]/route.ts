import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ workspaceId: string; filterId: string }>;

const FilterIdSchema = z.string().uuid();

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId, filterId } = await params;
  const parsedFilterId = FilterIdSchema.safeParse(filterId);
  if (!parsedFilterId.success) {
    return NextResponse.json({ error: "Invalid filter id" }, { status: 400 });
  }

  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const { error } = await access.supabase
    .from("bulk_campaign_saved_filters")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", parsedFilterId.data);

  if (error) {
    return NextResponse.json(
      { error: "Failed to delete saved filter" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
