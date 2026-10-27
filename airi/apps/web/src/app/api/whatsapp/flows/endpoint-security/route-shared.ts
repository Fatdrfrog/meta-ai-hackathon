import "server-only";

import { getMetaServerAppConfig } from "@/lib/meta/app-config";
import { readJsonBodyWithinLimit } from "@/lib/api/json-body";
import { resolveWhatsAppAccountContext } from "@/lib/whatsapp/account/resolution";
import type { WhatsAppFlowEndpointSecurityRequest } from "@/lib/whatsapp/flows/endpoint-security-contract";
import {
  assertWhatsAppFlowEndpointSecurityMutationEnabled,
  EndpointSecurityServiceError,
  type ResolvedEndpointSecurityContext,
} from "@/lib/whatsapp/flows/endpoint-security-service";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import { NextResponse } from "next/server";
import { z } from "zod";

const EndpointSecurityRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(128),
    sourceId: z.string().trim().min(1).max(128),
  })
  .strict();

type ParsedEndpointSecurityRequest =
  | { ok: true; data: WhatsAppFlowEndpointSecurityRequest }
  | { ok: false; response: NextResponse };

type ResolvedRouteContext =
  | { ok: true; context: ResolvedEndpointSecurityContext }
  | { ok: false; response: NextResponse };

const QUERY_INPUT_MESSAGE =
  "workspaceId and sourceId are required exactly once";
const BODY_INPUT_MESSAGE =
  "Request body must contain only workspaceId and sourceId";
const ENDPOINT_SECURITY_REQUEST_MAX_BYTES = 1_024;

function fixedServiceError(
  code: ConstructorParameters<typeof EndpointSecurityServiceError>[0],
  message: string
): EndpointSecurityServiceError {
  return new EndpointSecurityServiceError(code, message);
}

function invalidInput(message: string): NextResponse {
  return endpointSecurityErrorResponse(
    fixedServiceError("WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT", message)
  );
}

export function parseEndpointSecurityGetRequest(
  request: Request
): ParsedEndpointSecurityRequest {
  const searchParams = new URL(request.url).searchParams;
  const keys = [...searchParams.keys()];
  if (
    keys.some(key => key !== "workspaceId" && key !== "sourceId") ||
    searchParams.getAll("workspaceId").length !== 1 ||
    searchParams.getAll("sourceId").length !== 1
  ) {
    return { ok: false, response: invalidInput(QUERY_INPUT_MESSAGE) };
  }
  const parsed = EndpointSecurityRequestSchema.safeParse({
    workspaceId: searchParams.get("workspaceId"),
    sourceId: searchParams.get("sourceId"),
  });
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, response: invalidInput(QUERY_INPUT_MESSAGE) };
}

export async function parseEndpointSecurityPostRequest(
  request: Request
): Promise<ParsedEndpointSecurityRequest> {
  let body: unknown;
  try {
    body = await readJsonBodyWithinLimit(
      request,
      ENDPOINT_SECURITY_REQUEST_MAX_BYTES
    );
  } catch {
    return { ok: false, response: invalidInput(BODY_INPUT_MESSAGE) };
  }
  const parsed = EndpointSecurityRequestSchema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, response: invalidInput(BODY_INPUT_MESSAGE) };
}

async function authorizeEndpointSecurityRequest(
  input: WhatsAppFlowEndpointSecurityRequest
): Promise<
  | {
      ok: true;
      context: Exclude<
        Awaited<ReturnType<typeof getWhatsAppWorkspaceContext>>["context"],
        undefined
      >;
    }
  | { ok: false; response: NextResponse }
> {
  try {
    const access = await getWhatsAppWorkspaceContext(input.workspaceId, {
      requireManager: true,
      sourceId: input.sourceId,
    });
    return access.error
      ? { ok: false, response: access.error }
      : { ok: true, context: access.context };
  } catch {
    return {
      ok: false,
      response: endpointSecurityErrorResponse(
        fixedServiceError(
          "WHATSAPP_FLOW_ENDPOINT_SECURITY_STORAGE_FAILED",
          "WhatsApp Flow endpoint security request failed"
        )
      ),
    };
  }
}

function resolveApplicationId():
  | { ok: true; applicationId: string }
  | { ok: false; response: NextResponse } {
  try {
    const rawApplicationId = getMetaServerAppConfig().appId;
    const applicationId =
      typeof rawApplicationId === "string" ? rawApplicationId.trim() : "";
    if (!applicationId) throw new Error("Missing Meta app ID");
    return { ok: true, applicationId };
  } catch {
    return {
      ok: false,
      response: endpointSecurityErrorResponse(
        fixedServiceError(
          "WHATSAPP_FLOW_ENDPOINT_SECURITY_CONFIGURATION_FAILED",
          "WhatsApp Flow endpoint security is not configured"
        )
      ),
    };
  }
}

export async function resolveEndpointSecurityReadContext(
  input: WhatsAppFlowEndpointSecurityRequest
): Promise<ResolvedRouteContext> {
  const access = await authorizeEndpointSecurityRequest(input);
  if (!access.ok) return access;
  const { accessToken, sourceId, wabaId } = access.context;
  if (
    sourceId !== input.sourceId ||
    typeof accessToken !== "string" ||
    !accessToken.trim() ||
    typeof wabaId !== "string" ||
    !wabaId.trim()
  ) {
    return {
      ok: false,
      response: endpointSecurityErrorResponse(
        fixedServiceError(
          "WHATSAPP_FLOW_ENDPOINT_SECURITY_CONFIGURATION_FAILED",
          "Stored WhatsApp Flow endpoint credentials are incomplete"
        )
      ),
    };
  }
  const application = resolveApplicationId();
  if (!application.ok) return application;
  return {
    ok: true,
    context: {
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      wabaId: wabaId.trim(),
      applicationId: application.applicationId,
      accessToken: accessToken.trim(),
    },
  };
}

export async function resolveEndpointSecurityMutationContext(
  input: WhatsAppFlowEndpointSecurityRequest,
  kind: "ENSURE" | "ROTATE"
): Promise<ResolvedRouteContext> {
  const access = await authorizeEndpointSecurityRequest(input);
  if (!access.ok) return access;
  if (access.context.sourceId !== input.sourceId) {
    return {
      ok: false,
      response: endpointSecurityErrorResponse(
        fixedServiceError(
          "WHATSAPP_FLOW_ENDPOINT_SECURITY_BINDING_CONFLICT",
          "WhatsApp source binding changed during endpoint security resolution"
        )
      ),
    };
  }
  try {
    assertWhatsAppFlowEndpointSecurityMutationEnabled(kind);
  } catch (error) {
    return {
      ok: false,
      response: endpointSecurityErrorResponse(error),
    };
  }

  let account: Awaited<ReturnType<typeof resolveWhatsAppAccountContext>>;
  try {
    account = await resolveWhatsAppAccountContext({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      probeEdge: "phone_numbers",
      probeFields: "id",
      logScope: "Flow endpoint security phone inventory",
      failureMessage:
        "Unable to resolve the WhatsApp Business Account for Flow endpoint security",
    });
  } catch {
    return {
      ok: false,
      response: endpointSecurityErrorResponse(
        fixedServiceError(
          "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
          "WhatsApp account resolution failed"
        )
      ),
    };
  }
  if (
    account.sourceId !== input.sourceId ||
    typeof account.wabaId !== "string" ||
    !account.wabaId.trim() ||
    typeof account.accessToken !== "string" ||
    !account.accessToken.trim()
  ) {
    return {
      ok: false,
      response: endpointSecurityErrorResponse(
        fixedServiceError(
          "WHATSAPP_FLOW_ENDPOINT_SECURITY_BINDING_CONFLICT",
          "WhatsApp account binding changed during endpoint security resolution"
        )
      ),
    };
  }
  const application = resolveApplicationId();
  if (!application.ok) return application;
  return {
    ok: true,
    context: {
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      wabaId: account.wabaId.trim(),
      applicationId: application.applicationId,
      accessToken: account.accessToken.trim(),
    },
  };
}

export function endpointSecurityErrorResponse(error: unknown): NextResponse {
  let safeError: EndpointSecurityServiceError;
  if (error instanceof EndpointSecurityServiceError) {
    safeError = error;
  } else {
    safeError = fixedServiceError(
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_STORAGE_FAILED",
      "WhatsApp Flow endpoint security request failed"
    );
  }

  let status: number;
  switch (safeError.code) {
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT":
      status = 400;
      break;
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED":
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_NOT_CONFIGURED":
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT":
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_BINDING_CONFLICT":
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_FOREIGN_KEY":
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_HISTORY_CAPACITY":
      status = 409;
      break;
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED":
      status = 502;
      break;
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_CONFIGURATION_FAILED":
    case "WHATSAPP_FLOW_ENDPOINT_SECURITY_STORAGE_FAILED":
      status = 500;
      break;
  }
  return NextResponse.json(
    { error: { code: safeError.code, message: safeError.message } },
    { status }
  );
}
