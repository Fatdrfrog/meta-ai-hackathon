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
  createUnassignedWhatsAppQrDraftEntryPoint,
  listWhatsAppQrEntryPoints,
  WhatsAppQrManagerError,
} from "@/lib/whatsapp/qr-entry-points/manager";
import { normalizeWhatsAppQrEntryPointUuid } from "@/lib/whatsapp/qr-entry-points/normalization";
import { getWhatsAppQrEntryPointDetail } from "@/lib/whatsapp/qr-entry-points/queries";

export const runtime = "nodejs";

const REQUEST_MAX_BYTES = 32 * 1_024;
const boundedId = z.string().trim().min(1).max(256);
const QuerySchema = z
  .object({
    workspaceId: boundedId,
    query: z.string().max(512).optional(),
    facet: z.enum(["source", "status", "assignment"]).optional(),
    value: z.string().trim().min(1).max(256).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.facet === undefined) !== (value.value === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Facet and value must be paired",
      });
      return;
    }
    if (
      value.facet === "status" &&
      !(["DRAFT", "ACTIVE", "DETACHED"] as const).includes(
        value.value as "DRAFT"
      )
    ) {
      context.addIssue({ code: "custom", message: "Status is invalid" });
    }
    if (
      value.facet === "assignment" &&
      value.value !== "assigned" &&
      value.value !== "unassigned"
    ) {
      context.addIssue({ code: "custom", message: "Assignment is invalid" });
    }
  });

const CreateSchema = z
  .object({
    workspaceId: boundedId,
    entryPointId: z
      .string()
      .refine(value => normalizeWhatsAppQrEntryPointUuid(value) !== undefined),
    placementName: z.string().trim().min(1).max(120),
    desiredMessage: z
      .string()
      .min(1)
      .max(WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH)
      .refine(value => value.trim() === value)
      .optional(),
  })
  .strict();

function invalidResponse() {
  return NextResponse.json(
    { error: "Invalid request", code: "INVALID_INPUT" },
    { status: 400 }
  );
}

function hasOnlySingleKnownParams(
  searchParams: URLSearchParams,
  allowed: ReadonlySet<string>
) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1)
      return false;
  }
  return true;
}

function managerErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof WhatsAppQrManagerError) {
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
  if (
    error instanceof Error &&
    error.message === "WHATSAPP_QR_ENTRY_POINT_INDEX_MIGRATION_REQUIRED"
  ) {
    return NextResponse.json(
      {
        error: "WhatsApp QR index migration is required",
        code: "WHATSAPP_QR_INDEX_MIGRATION_REQUIRED",
      },
      { status: 503 }
    );
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const searchParams = new URL(request.url).searchParams;
    if (
      !hasOnlySingleKnownParams(
        searchParams,
        new Set(["workspaceId", "query", "facet", "value", "cursor", "limit"])
      )
    ) {
      return invalidResponse();
    }
    const parsed = QuerySchema.safeParse({
      workspaceId: searchParams.get("workspaceId") ?? "",
      ...(searchParams.has("query")
        ? { query: searchParams.get("query") ?? "" }
        : {}),
      ...(searchParams.has("facet")
        ? { facet: searchParams.get("facet") ?? "" }
        : {}),
      ...(searchParams.has("value")
        ? { value: searchParams.get("value") ?? "" }
        : {}),
      ...(searchParams.has("cursor")
        ? { cursor: searchParams.get("cursor") ?? "" }
        : {}),
      ...(searchParams.has("limit")
        ? { limit: searchParams.get("limit") ?? "" }
        : {}),
    });
    if (!parsed.success) return invalidResponse();
    const access = await getAuthenticatedWorkspaceMembership(
      parsed.data.workspaceId
    );
    if (access.error) return access.error;

    const facet =
      parsed.data.facet === "source"
        ? { sourceId: parsed.data.value! }
        : parsed.data.facet === "status"
          ? {
              status: parsed.data.value as "DRAFT" | "ACTIVE" | "DETACHED",
            }
          : parsed.data.facet === "assignment"
            ? {
                assignment: parsed.data.value as "assigned" | "unassigned",
              }
            : {};
    return NextResponse.json(
      await listWhatsAppQrEntryPoints({
        workspaceId: parsed.data.workspaceId,
        ...(parsed.data.query !== undefined
          ? { query: parsed.data.query }
          : {}),
        ...facet,
        ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        ...(parsed.data.limit !== undefined
          ? { limit: parsed.data.limit }
          : {}),
      })
    );
  } catch (error) {
    return (
      managerErrorResponse(error) ??
      NextResponse.json(
        { error: "Failed to load WhatsApp QR entry points" },
        { status: 500 }
      )
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
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
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return invalidResponse();
    const access = await getAuthenticatedWorkspaceMembership(
      parsed.data.workspaceId
    );
    if (access.error) return access.error;
    if (!isWorkspaceManagerRole(access.membership.role)) {
      return NextResponse.json(
        { error: "Only managers and admins can create WhatsApp QR codes" },
        { status: 403 }
      );
    }
    const entryPoint = await createUnassignedWhatsAppQrDraftEntryPoint(
      parsed.data
    );
    const detail = await getWhatsAppQrEntryPointDetail({
      workspaceId: parsed.data.workspaceId,
      entryPointId: entryPoint.entryPointId,
    });
    if (!detail) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    return (
      managerErrorResponse(error) ??
      NextResponse.json(
        { error: "Failed to create WhatsApp QR entry point" },
        { status: 500 }
      )
    );
  }
}
