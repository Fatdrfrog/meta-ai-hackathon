import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
  requiredFieldResponse,
} from "@/lib/api/json-body";
import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import { WhatsAppFlowSourceBindingFenceConflictError } from "@/lib/whatsapp/flows/source-binding-fence-store";
import {
  getActivePartnerRemovalIncident,
  getWhatsAppReconnectStatus,
} from "@/lib/whatsapp/reconnect-status";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const REQUEST_MAX_BYTES = 8 * 1_024;
const boundedId = z.string().trim().min(1).max(256);
const DismissPartnerRemovalSchema = z
  .object({
    workspaceId: boundedId,
    sourceId: boundedId,
    removedAt: z.string().datetime({ offset: true }),
  })
  .strict();

function invalidRequestResponse() {
  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}

function staleRemovalResponse() {
  return NextResponse.json(
    {
      error: "WhatsApp connection state changed",
      code: "STALE_PARTNER_REMOVAL",
    },
    { status: 409 }
  );
}

/**
 * GET /api/whatsapp/reconnect-status?workspaceId=...
 *
 * Returns the WhatsApp reconnect warning state for the caller's
 * workspace. Used by the panel-level banner for revalidation and by any
 * client UI that wants to react to token expiry without duplicating the
 * threshold math.
 */
export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");

  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const access = await getAuthenticatedWorkspaceMembership(workspaceId);

  if (access.error) return access.error;

  const status = await getWhatsAppReconnectStatus(workspaceId);
  return NextResponse.json(status);
}

/**
 * PATCH /api/whatsapp/reconnect-status
 *
 * Acknowledges the currently active PARTNER_REMOVED alert for everyone in the
 * workspace. The removal timestamp is an optimistic incident key, so a
 * stale browser cannot dismiss a newer removal or a completed reconnect.
 */
export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await readJsonBodyWithinLimit(request, REQUEST_MAX_BYTES);
  } catch (error) {
    if (
      error instanceof InvalidJsonBodyError ||
      error instanceof JsonBodyTooLargeError
    ) {
      return invalidRequestResponse();
    }
    throw error;
  }

  const parsed = DismissPartnerRemovalSchema.safeParse(body);
  if (!parsed.success) return invalidRequestResponse();

  const { workspaceId, sourceId, removedAt } = parsed.data;
  const access = await getAuthenticatedWorkspaceMembership(workspaceId);
  if (access.error) return access.error;
  if (!isWorkspaceManagerRole(access.membership.role)) {
    return NextResponse.json(
      { error: "Only workspace managers and admins can dismiss this alert" },
      { status: 403 }
    );
  }

  const { data: source, error: sourceError } = await access.supabase
    .from("sources")
    .select("id, workspace_id, type, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp")
    .eq("id", sourceId)
    .maybeSingle();

  if (sourceError) {
    return NextResponse.json(
      { error: "Failed to query WhatsApp source" },
      { status: 500 }
    );
  }
  if (!source) {
    return NextResponse.json(
      { error: "WhatsApp source not found" },
      { status: 404 }
    );
  }

  const credentials =
    source.credentials && typeof source.credentials === "object"
      ? (source.credentials as Record<string, unknown>)
      : {};
  const wabaId = normalizeWhatsAppCredentials(credentials).wabaId;
  const partnerRemovalIncident = getActivePartnerRemovalIncident(credentials);
  if (!wabaId || partnerRemovalIncident?.removedAt !== removedAt) {
    return staleRemovalResponse();
  }

  const dismissedAt = new Date().toISOString();
  try {
    await updateCurrentWhatsAppSourceCredentials({
      workspaceId,
      sourceId,
      expectedWabaId: wabaId,
      expectedCredentials: partnerRemovalIncident.expectedCredentials,
      buildCredentials: current => ({
        ...current,
        partner_removed_alert_dismissed_for: removedAt,
        partner_removed_alert_dismissed_at: dismissedAt,
        partner_removed_alert_dismissed_by: access.user.id,
      }),
    });
  } catch (error) {
    if (error instanceof WhatsAppFlowSourceBindingFenceConflictError) {
      return staleRemovalResponse();
    }
    return NextResponse.json(
      { error: "Failed to dismiss WhatsApp alert" },
      { status: 500 }
    );
  }

  return NextResponse.json({ acknowledged: true, sourceId, removedAt });
}
