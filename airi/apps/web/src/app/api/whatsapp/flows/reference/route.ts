import { NextResponse } from "next/server";
import { z } from "zod";

import { readJsonBodyWithinLimit } from "@/lib/api/json-body";
import { getMetaServerAppConfig } from "@/lib/meta/app-config";
import type {
  WhatsAppFlowProviderReferenceFailureCode,
  WhatsAppFlowProviderReferenceResult,
} from "@/lib/whatsapp/flows/provider-reference-contract";
import { attachWhatsAppFlowProviderReference } from "@/lib/whatsapp/flows/provider-reference-service";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";

const REQUEST_MAX_BYTES = 16 * 1_024;
const boundedId = z.string().trim().min(1).max(256);
const ReferenceRequestSchema = z
  .object({
    workspaceId: boundedId,
    sourceId: boundedId,
    scenarioId: boundedId,
    nodeId: boundedId,
    flowId: boundedId,
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

function failure(
  code: WhatsAppFlowProviderReferenceFailureCode,
  message: string,
  retryable = false
): Extract<WhatsAppFlowProviderReferenceResult, { ok: false }> {
  return { ok: false, error: { code, message, retryable } };
}

function httpStatus(result: WhatsAppFlowProviderReferenceResult): number {
  if (result.ok) return 200;
  switch (result.error.code) {
    case "INVALID_INPUT":
      return 400;
    case "ACCESS_DENIED":
      return 403;
    case "FLOW_NOT_OWNED":
    case "SCENARIO_NOT_FOUND":
      return 404;
    case "FLOW_INVALID":
      return 422;
    case "SOURCE_BINDING_CHANGED":
    case "MANAGED_ENDPOINT_INCOMPATIBLE":
    case "FLOW_BRANCHES_CONNECTED":
    case "TARGET_INVALID":
    case "ACTIVE_SCENARIO_REQUIRES_PUBLISHED_FLOW":
    case "SCENARIO_REVISION_CONFLICT":
      return 409;
    case "PROVIDER_UNAVAILABLE":
    case "FLOW_JSON_UNAVAILABLE":
      return 502;
    case "ATTACH_FAILED":
      return 500;
  }
}

async function accessFailure(response: NextResponse) {
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  return NextResponse.json(
    failure(
      "ACCESS_DENIED",
      typeof payload?.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : "WhatsApp Flow access was denied"
    ),
    { status: response.status }
  );
}

export async function POST(
  request: Request
): Promise<NextResponse<WhatsAppFlowProviderReferenceResult>> {
  let body: unknown;
  try {
    body = await readJsonBodyWithinLimit(request, REQUEST_MAX_BYTES);
  } catch {
    return NextResponse.json(
      failure(
        "INVALID_INPUT",
        "Request must contain one strict provider Flow reference"
      ),
      { status: 400 }
    );
  }
  const parsed = ReferenceRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      failure(
        "INVALID_INPUT",
        "Request must contain one strict provider Flow reference"
      ),
      { status: 400 }
    );
  }

  const access = await getWhatsAppWorkspaceContext(parsed.data.workspaceId, {
    requireManager: true,
    sourceId: parsed.data.sourceId,
    managerErrorMessage: "Only managers and admins can attach WhatsApp Flows",
  });
  if (access.error) return accessFailure(access.error);
  const context = access.context;
  if (
    context.sourceId !== parsed.data.sourceId ||
    !context.accessToken ||
    !context.wabaId ||
    !context.user?.id
  ) {
    const result = failure(
      "SOURCE_BINDING_CHANGED",
      "WhatsApp source binding changed; refresh and retry"
    );
    return NextResponse.json(result, { status: httpStatus(result) });
  }

  try {
    const applicationId = getMetaServerAppConfig().appId.trim();
    const result = await attachWhatsAppFlowProviderReference({
      ...parsed.data,
      accessToken: context.accessToken,
      applicationId,
      ...(context.phoneNumberId
        ? { phoneNumberId: context.phoneNumberId }
        : {}),
      wabaId: context.wabaId,
      updatedBy: context.user.id,
    });
    return NextResponse.json(result, { status: httpStatus(result) });
  } catch {
    const result = failure(
      "ATTACH_FAILED",
      "WhatsApp Flow attachment failed",
      true
    );
    return NextResponse.json(result, { status: httpStatus(result) });
  }
}
