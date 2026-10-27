import { BulkAnalyticsAudienceFilterSchema } from "@/lib/campaign/bulk-campaign-contracts";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ workspaceId: string }>;

const SaveFilterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filters: BulkAnalyticsAudienceFilterSchema,
});

function serializeFilter(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
  };
}

async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const { data, error } = await access.supabase
    .from("bulk_campaign_saved_filters")
    .select("id,name,filters,created_at,updated_at,created_by")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: "Failed to load saved filters" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    filters: Array.isArray(data)
      ? data.map(row => serializeFilter(row as Record<string, unknown>))
      : [],
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const body = await readJson(request);
  const parsed = SaveFilterSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  const filters = parsed.data.filters;
  if (
    String(filters.recipientSearch || "").trim() ||
    (filters.deliveryStatus && filters.deliveryStatus !== "all") ||
    String(filters.deliveryErrorCode || "").trim()
  ) {
    return NextResponse.json(
      {
        error:
          "Recipient search and delivery filters cannot be saved as campaign audiences.",
        code: "DIAGNOSTIC_AUDIENCE_FILTER_UNSUPPORTED",
      },
      { status: 400 }
    );
  }

  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const now = new Date().toISOString();
  const { data, error } = await access.supabase
    .from("bulk_campaign_saved_filters")
    .upsert(
      {
        workspace_id: workspaceId,
        name: parsed.data.name,
        filters: parsed.data.filters,
        created_by: access.userId,
        updated_at: now,
      },
      { onConflict: "workspace_id,name" }
    )
    .select("id,name,filters,created_at,updated_at,created_by")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to save filter" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    filter: serializeFilter(data as Record<string, unknown>),
  });
}
