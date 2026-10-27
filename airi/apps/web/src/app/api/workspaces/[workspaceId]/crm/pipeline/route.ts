import { loadCrmPipelineStages, saveCrmPipeline } from "@/lib/crm/board";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import type { CrmPipelineStageInput } from "@/lib/crm/stages";
import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceMemberRole } from "@/lib/supabase/queries";

type Params = Promise<{ workspaceId: string }>;

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const hasAccess = isWorkspaceManagerRole(
      await getWorkspaceMemberRole(supabase, user.id, workspaceId)
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const stages = await loadCrmPipelineStages({
      supabase,
      workspaceId,
      activeOnly: false,
    });

    return NextResponse.json({ stages });
  } catch (error) {
    logger.error("[CRM Pipeline API] GET failed", error, {
      event: "crm.pipeline.get_failed",
      workspaceId,
    });
    return NextResponse.json(
      { error: "Failed to load CRM pipeline" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const hasAccess = isWorkspaceManagerRole(
      await getWorkspaceMemberRole(supabase, user.id, workspaceId)
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      stages?: CrmPipelineStageInput[];
    };
    if (!Array.isArray(body.stages)) {
      return NextResponse.json(
        { error: "stages must be an array" },
        { status: 400 }
      );
    }

    const result = await saveCrmPipeline({
      supabase,
      workspaceId,
      stages: body.stages,
    });

    return NextResponse.json(result);
  } catch (error) {
    logger.error("[CRM Pipeline API] PUT failed", error, {
      event: "crm.pipeline.put_failed",
      workspaceId,
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to save CRM pipeline",
      },
      { status: 500 }
    );
  }
}
