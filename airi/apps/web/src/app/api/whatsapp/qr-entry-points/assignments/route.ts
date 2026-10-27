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
  assignWhatsAppQrEntryPoint,
  recoverDetachedWhatsAppQrEntryPoint,
  unassignWhatsAppQrEntryPoint,
  WhatsAppQrAssignmentError,
} from "@/lib/whatsapp/qr-entry-points/assignment";

export const runtime = "nodejs";

const REQUEST_MAX_BYTES = 64 * 1_024;
const boundedId = z.string().trim().min(1).max(256);
const version = z.number().int().nonnegative();
const revision = z.string().datetime({ offset: true });

const AssignmentCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("assign"),
      workspaceId: boundedId,
      entryPointId: boundedId,
      expectedEntryPointVersion: version,
      target: z
        .object({
          scenarioId: boundedId,
          nodeId: boundedId,
          expectedUpdatedAt: revision,
          expectedCurrentEntryPointId: boundedId.nullable(),
          expectedCurrentEntryPointVersion: version.optional(),
        })
        .strict(),
      acknowledgeMove: z.boolean(),
      acknowledgeReplacement: z.boolean(),
      sourceExpectedUpdatedAt: revision.optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("unassign"),
      workspaceId: boundedId,
      entryPointId: boundedId,
      expectedEntryPointVersion: version,
      sourceExpectedUpdatedAt: revision,
    })
    .strict(),
  z
    .object({
      command: z.literal("recover"),
      workspaceId: boundedId,
      entryPointId: boundedId,
      expectedEntryPointVersion: version,
    })
    .strict(),
]);

function invalidResponse() {
  return NextResponse.json(
    { error: "Invalid request", code: "INVALID_INPUT" },
    { status: 400 }
  );
}

function assignmentErrorResponse(error: WhatsAppQrAssignmentError) {
  const status =
    error.code === "INVALID_INPUT"
      ? 400
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "STORAGE_FAILED"
          ? 500
          : 409;
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      ...(error.currentAssignment !== undefined
        ? { currentAssignment: error.currentAssignment }
        : {}),
    },
    { status }
  );
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
    const parsed = AssignmentCommandSchema.safeParse(body);
    if (!parsed.success) return invalidResponse();

    const input = parsed.data;
    const access = await getAuthenticatedWorkspaceMembership(input.workspaceId);
    if (access.error) return access.error;
    if (!isWorkspaceManagerRole(access.membership.role)) {
      return NextResponse.json(
        {
          error: "Only managers and admins can assign WhatsApp QR entry points",
        },
        { status: 403 }
      );
    }

    try {
      switch (input.command) {
        case "assign": {
          const { command: _command, ...assignmentInput } = input;
          void _command;
          return NextResponse.json(
            await assignWhatsAppQrEntryPoint(assignmentInput)
          );
        }
        case "unassign": {
          const { command: _command, ...assignmentInput } = input;
          void _command;
          return NextResponse.json(
            await unassignWhatsAppQrEntryPoint(assignmentInput)
          );
        }
        case "recover": {
          const { command: _command, ...assignmentInput } = input;
          void _command;
          return NextResponse.json(
            await recoverDetachedWhatsAppQrEntryPoint(assignmentInput)
          );
        }
        default: {
          const _exhaustive: never = input;
          return _exhaustive;
        }
      }
    } catch (error) {
      if (error instanceof WhatsAppQrAssignmentError) {
        return assignmentErrorResponse(error);
      }
      throw error;
    }
  } catch {
    return NextResponse.json(
      { error: "WhatsApp QR assignment failed", code: "STORAGE_FAILED" },
      { status: 500 }
    );
  }
}
