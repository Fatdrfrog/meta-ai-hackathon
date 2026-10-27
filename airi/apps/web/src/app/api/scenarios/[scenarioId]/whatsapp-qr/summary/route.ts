import { NextResponse } from "next/server";

import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { listWhatsAppQrScenarioSummaries } from "@/lib/whatsapp/qr-entry-points/http";

export const runtime = "nodejs";

type Params = Promise<{ scenarioId: string }>;

export async function GET(
  request: Request,
  { params }: { params: Params }
): Promise<Response> {
  try {
    const { scenarioId } = await params;
    const workspaceId = new URL(request.url).searchParams.get("workspaceId");
    if (!workspaceId?.trim()) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      );
    }
    if (!scenarioId?.trim()) {
      return NextResponse.json(
        { error: "scenarioId is required" },
        { status: 400 }
      );
    }

    const access = await requireWorkspaceApiAccess(workspaceId.trim());
    if (!access.ok) return access.response;

    const summaries = await listWhatsAppQrScenarioSummaries({
      workspaceId: workspaceId.trim(),
      scenarioId: scenarioId.trim(),
    });
    return NextResponse.json({ summaries });
  } catch {
    return NextResponse.json(
      { error: "Failed to load WhatsApp QR summaries" },
      { status: 500 }
    );
  }
}
