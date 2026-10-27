import { readTemplateFlowFacts } from "@/lib/whatsapp/flows/template-flow-facts";
import {
  isWhatsAppFlowGraphId,
  TEMPLATE_FLOW_CHECK_MAX_FLOWS,
} from "@/lib/whatsapp/flows/template-flow-health";
import { getWhatsAppWorkspaceReadiness } from "@/lib/whatsapp/get-workspace-context";
import { NextResponse } from "next/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function parseFlowIds(raw: string | null): string[] | null {
  const ids = Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
    )
  );
  if (
    ids.length === 0 ||
    ids.length > TEMPLATE_FLOW_CHECK_MAX_FLOWS ||
    !ids.every(isWhatsAppFlowGraphId)
  ) {
    return null;
  }
  return ids;
}

/**
 * GET - Status and screen ids of the Flows that template buttons open, so the
 * UI can warn when a button can't open. Any workspace member may read it.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId")?.trim();
  const sourceId = searchParams.get("sourceId")?.trim() || undefined;
  const refresh = searchParams.get("refresh") === "1";

  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspaceId is required" },
      { status: 400, headers: NO_STORE }
    );
  }
  const flowIds = parseFlowIds(searchParams.get("flowIds"));
  if (!flowIds) {
    return NextResponse.json(
      {
        error: `flowIds must list 1-${TEMPLATE_FLOW_CHECK_MAX_FLOWS} numeric Flow ids`,
      },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const readinessResult = await getWhatsAppWorkspaceReadiness(workspaceId, {
      sourceId,
    });
    if (readinessResult.error) return readinessResult.error;
    const { accessToken, wabaId } = readinessResult;
    if (!accessToken || !wabaId) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete" },
        { status: 409, headers: NO_STORE }
      );
    }

    const facts = await readTemplateFlowFacts({
      wabaId,
      accessToken,
      flowIds,
      refresh,
    });
    return NextResponse.json(
      { facts, sourceId: readinessResult.sourceId ?? null },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to check template Flows" },
      { status: 500, headers: NO_STORE }
    );
  }
}
