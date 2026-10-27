import { WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH } from "@icecore/scenario-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import {
  patchManagedWhatsAppQrEntryPoint,
  WhatsAppQrManagerError,
} from "@/lib/whatsapp/qr-entry-points/manager";
import { normalizeWhatsAppQrEntryPointUuid } from "@/lib/whatsapp/qr-entry-points/normalization";
import { getWhatsAppQrEntryPointDetail } from "@/lib/whatsapp/qr-entry-points/queries";

export const runtime = "nodejs";

const REQUEST_MAX_BYTES = 32 * 1_024;
const boundedId = z.string().trim().min(1).max(256);
const PatchSchema = z
  .object({
    workspaceId: boundedId,
    expectedVersion: z.number().int().nonnegative(),
    placementName: z.string().trim().min(1).max(120).optional(),
    desiredMessage: z
      .string()
      .min(1)
      .max(WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH)
      .refine(value => value.trim() === value)
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    value =>
      value.placementName !== undefined || value.desiredMessage !== undefined,
    { message: "At least one field is required" }
  );

type RouteContext = { params: Promise<{ entryPointId: string }> };

function invalidResponse() {
  return NextResponse.json(
    { error: "Invalid request", code: "INVALID_INPUT" },
    { status: 400 }
  );
}

function managerErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof WhatsAppQrManagerError)) return null;
  const status =
    error.code === "INVALID_INPUT"
      ? 400
      : error.code === "NOT_FOUND"
        ? 404
        : 409;
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status }
  );
}

async function parseReadScope(request: Request, context: RouteContext) {
  const { entryPointId: rawEntryPointId } = await context.params;
  const entryPointId = normalizeWhatsAppQrEntryPointUuid(rawEntryPointId);
  const searchParams = new URL(request.url).searchParams;
  const keys = Array.from(searchParams.keys());
  const workspaceIds = searchParams.getAll("workspaceId");
  const workspaceId = workspaceIds[0]?.trim();
  if (
    !entryPointId ||
    !workspaceId ||
    workspaceId.length > 256 ||
    keys.some(key => key !== "workspaceId") ||
    workspaceIds.length !== 1
  ) {
    return null;
  }
  return { entryPointId, workspaceId };
}

export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  try {
    const scope = await parseReadScope(request, context);
    if (!scope) return invalidResponse();
    const access = await getAuthenticatedWorkspaceMembership(scope.workspaceId);
    if (access.error) return access.error;
    const detail = await getWhatsAppQrEntryPointDetail(scope);
    if (!detail) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch {
    return NextResponse.json(
      { error: "Failed to load WhatsApp QR entry point" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext
): Promise<Response> {
  try {
    const { entryPointId: rawEntryPointId } = await context.params;
    const entryPointId = normalizeWhatsAppQrEntryPointUuid(rawEntryPointId);
    if (!entryPointId) return invalidResponse();
    let body: unknown;
    try {
      body = await readJsonBodyWithinLimit(request, REQUEST_MAX_BYTES);
    } catch (error) {
      if (
        error instanceof InvalidJsonBodyError ||
        error instanceof JsonBodyTooLargeError
      ) {
        return invalidResponse();
      }
      throw error;
    }
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return invalidResponse();
    const access = await getAuthenticatedWorkspaceMembership(
      parsed.data.workspaceId
    );
    if (access.error) return access.error;
    if (!isWorkspaceManagerRole(access.membership.role)) {
      return NextResponse.json(
        { error: "Only managers and admins can update WhatsApp QR codes" },
        { status: 403 }
      );
    }
    await patchManagedWhatsAppQrEntryPoint({
      workspaceId: parsed.data.workspaceId,
      entryPointId,
      expectedVersion: parsed.data.expectedVersion,
      ...(parsed.data.placementName !== undefined
        ? { placementName: parsed.data.placementName }
        : {}),
      ...(parsed.data.desiredMessage !== undefined
        ? { desiredMessage: parsed.data.desiredMessage }
        : {}),
    });
    const detail = await getWhatsAppQrEntryPointDetail({
      workspaceId: parsed.data.workspaceId,
      entryPointId,
    });
    if (!detail) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    return (
      managerErrorResponse(error) ??
      NextResponse.json(
        { error: "Failed to update WhatsApp QR entry point" },
        { status: 500 }
      )
    );
  }
}
