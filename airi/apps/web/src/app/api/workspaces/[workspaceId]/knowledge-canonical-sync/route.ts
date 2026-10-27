import { isTemporalConfigured } from "@/lib/temporal/client";
import {
  startKnowledgeCanonicalSyncWorkflow,
  type StartKnowledgeCanonicalSyncWorkflowParams,
} from "@/lib/temporal/knowledge-canonical-sync-client";
import {
  KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS,
  type KnowledgeCanonicalSyncSourceKind,
} from "@icecore/temporal";
import { NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

export const runtime = "nodejs";

const SOURCE_KINDS: ReadonlySet<KnowledgeCanonicalSyncSourceKind> = new Set([
  ...KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS,
]);

function normalizeSourceKinds(
  raw: unknown,
  provided: boolean
):
  | { ok: true; sourceKinds: KnowledgeCanonicalSyncSourceKind[] | undefined }
  | { ok: false } {
  if (!provided) return { ok: true, sourceKinds: undefined };
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false };

  const out: KnowledgeCanonicalSyncSourceKind[] = [];
  for (const item of raw) {
    if (
      typeof item !== "string" ||
      !SOURCE_KINDS.has(item as KnowledgeCanonicalSyncSourceKind)
    ) {
      return { ok: false };
    }
    if (!out.includes(item as KnowledgeCanonicalSyncSourceKind)) {
      out.push(item as KnowledgeCanonicalSyncSourceKind);
    }
  }
  return { ok: true, sourceKinds: out };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await context.params;
    if (!workspaceId?.trim()) {
      return NextResponse.json(
        { error: "workspaceId required" },
        { status: 400 }
      );
    }

    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be valid JSON" },
        { status: 400 }
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Request body must be a JSON object" },
        { status: 400 }
      );
    }
    const bodyRecord = body as Record<string, unknown>;
    const normalizedSourceKinds = normalizeSourceKinds(
      bodyRecord.sourceKinds,
      Object.prototype.hasOwnProperty.call(bodyRecord, "sourceKinds")
    );
    if (!normalizedSourceKinds.ok) {
      return NextResponse.json(
        { error: "sourceKinds must contain only supported source kinds" },
        { status: 400 }
      );
    }

    const sourceKinds = normalizedSourceKinds.sourceKinds;
    const dryRun = bodyRecord.dryRun === true;

    if (!isTemporalConfigured()) {
      return NextResponse.json(
        {
          error:
            "Knowledge sync is unavailable: Temporal is not configured for this environment.",
        },
        { status: 503 }
      );
    }

    const params: StartKnowledgeCanonicalSyncWorkflowParams = {
      workspaceId,
      sourceKinds,
      dryRun,
    };

    const handle = await startKnowledgeCanonicalSyncWorkflow(params);

    return NextResponse.json({
      ok: true,
      workflowId: handle.workflowId,
      workspaceId,
      sourceKinds: sourceKinds ?? null,
      dryRun,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[API] knowledge-canonical-sync POST failed:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
