import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  invalidJsonBodyResponse,
  readJsonBodyWithinLimit,
  readJsonObjectBody,
  requiredFieldResponse,
} from "@/lib/api/json-body";
import {
  normalizeWhatsappRecipient,
  sendWhatsappInteractiveFlow,
} from "@/lib/whatsapp";
import {
  createMetaWhatsAppFlow,
  deleteMetaWhatsAppFlow,
  getMetaWhatsAppFlow,
  isMetaWhatsAppFlowOwnedByWaba,
  listMetaWhatsAppFlows,
  updateMetaWhatsAppFlow,
  type WhatsAppFlowServiceResult,
} from "@/lib/whatsapp/flows/service";
import {
  isWhatsAppFlowProviderManaged,
  listWhatsAppFlowProviderArtifacts,
  type WhatsAppFlowProviderArtifact,
} from "@/lib/whatsapp/flows/provisioning-operation-store";
import { resolveWhatsAppFlowProviderArtifact } from "@/lib/whatsapp/flows/provisioning-provider-resolution-service";
import {
  getWhatsAppWorkspaceContext,
  getWhatsAppWorkspaceReadiness,
} from "@/lib/whatsapp/get-workspace-context";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  WHATSAPP_FLOW_CATEGORIES,
  WHATSAPP_FLOW_LIMITS,
} from "@icecore/shared/types/whatsapp-flows";

const FlowNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(WHATSAPP_FLOW_LIMITS.NAME_MAX_LENGTH);
const FlowCategoriesSchema = z.array(z.enum(WHATSAPP_FLOW_CATEGORIES)).min(1);
const FlowJsonDocumentSchema = z
  .object({
    version: z.string().trim().min(1),
    screens: z
      .array(z.object({ id: z.string().trim().min(1) }).passthrough())
      .min(1),
  })
  .passthrough()
  .refine(
    document =>
      new Set(document.screens.map(screen => screen.id)).size ===
      document.screens.length,
    { message: "Flow screen ids must be unique", path: ["screens"] }
  );
const FlowJsonSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (
      Buffer.byteLength(value, "utf8") >
      WHATSAPP_FLOW_LIMITS.JSON_ASSET_MAX_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Flow JSON exceeds the 10 MiB asset limit",
      });
      return;
    }
    try {
      const parsed = FlowJsonDocumentSchema.safeParse(JSON.parse(value));
      if (!parsed.success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Flow JSON must contain a version and unique screens with non-empty ids",
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Flow JSON must be a valid JSON object",
      });
    }
  });
// JSON string escaping can double the asset size in the HTTP envelope.
const FLOW_JSON_REQUEST_MAX_BYTES =
  WHATSAPP_FLOW_LIMITS.JSON_ASSET_MAX_BYTES * 2 + 65_536;

const SendFlowSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceId: z.string().min(1),
    recipientPhone: z.string().min(3),
    flowId: z.string().min(1),
    mode: z.enum(["draft", "published"]).optional(),
    flowToken: z.string().min(1),
    flowActionType: z.enum(["navigate", "data_exchange"]).optional(),
    flowActionPayload: z.record(z.unknown()).optional(),
    headerText: z.string().min(1).max(60).optional(),
    bodyText: z.string().min(1).max(1024).optional(),
    footerText: z.string().min(1).max(60).optional(),
    flowCta: z.string().min(1).max(30).optional(),
  })
  .strict();

const CreateFlowSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceId: z.string().min(1),
    name: FlowNameSchema,
    categories: FlowCategoriesSchema.optional(),
    cloneFlowId: z.string().min(1).optional(),
  })
  .strict();

const UpdateFlowMetadataSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceId: z.string().min(1),
    flowId: z.string().min(1),
    operation: z.enum(["publish", "deprecate", "update"]),
    name: FlowNameSchema.optional(),
    categories: FlowCategoriesSchema.optional(),
    acknowledgePreviouslySentMessagesWillStopOpening: z
      .literal(true)
      .optional(),
  })
  .strict();

const UpdateFlowSchema = z.discriminatedUnion("operation", [
  UpdateFlowMetadataSchema,
  z
    .object({
      workspaceId: z.string().min(1),
      sourceId: z.string().min(1),
      flowId: z.string().min(1),
      operation: z.literal("update_json"),
      flowJson: FlowJsonSchema,
    })
    .strict(),
]);

const DeleteFlowSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceId: z.string().min(1),
    flowId: z.string().min(1),
    acknowledgeDraftDeletion: z.literal(true).optional(),
  })
  .strict();

type ParsedFlowRequestBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

async function parseFlowRequestBody(
  request: Request,
  maxBytes?: number
): Promise<ParsedFlowRequestBody> {
  try {
    if (maxBytes === undefined) {
      return { ok: true, body: await readJsonObjectBody(request) };
    }
    const body = await readJsonBodyWithinLimit(request, maxBytes);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new InvalidJsonBodyError("JSON body must be an object");
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Flow request exceeds the byte limit" },
          { status: 413 }
        ),
      };
    }
    if (error instanceof InvalidJsonBodyError) {
      return { ok: false, response: invalidJsonBodyResponse(error) };
    }
    throw error;
  }
}

function parseBooleanSearchParam(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function flowServiceErrorResponse(
  result: Pick<
    WhatsAppFlowServiceResult,
    "error" | "status" | "validation_errors"
  >,
  fallback: string
) {
  const status =
    result.status >= 200 && result.status < 300 ? 502 : result.status || 500;
  return NextResponse.json(
    {
      error: result.error ?? fallback,
      ...(result.validation_errors
        ? { validation_errors: result.validation_errors }
        : {}),
    },
    { status }
  );
}

function flowNotOwnedResponse() {
  return NextResponse.json(
    { error: "Flow not found for this WhatsApp Business Account" },
    { status: 404 }
  );
}

function managedFlowMutationResponse() {
  return NextResponse.json(
    {
      error:
        "This Flow is managed by a scenario release. Publish or replace it from the scenario editor.",
    },
    { status: 409 }
  );
}

async function verifyFlowOwnership(params: {
  accessToken: string;
  flowId: string;
  wabaId: string;
  requireDraft?: boolean;
}): Promise<NextResponse | null> {
  const details = await getMetaWhatsAppFlow({
    accessToken: params.accessToken,
    flowId: params.flowId,
  });
  if (!details.ok) {
    return flowServiceErrorResponse(details, "Failed to fetch flow details");
  }
  if (!isMetaWhatsAppFlowOwnedByWaba(details.flow, params.wabaId)) {
    return flowNotOwnedResponse();
  }
  if (params.requireDraft && details.flow?.status !== "DRAFT") {
    return NextResponse.json(
      {
        error:
          "Only DRAFT Flows can be edited. Duplicate this Flow to make changes.",
      },
      { status: 409 }
    );
  }
  return null;
}

function suggestedProviderResolutionKind(
  artifact: WhatsAppFlowProviderArtifact
): "published_deprecated" | "draft_deleted" | null {
  if (artifact.resolutionKind) return artifact.resolutionKind;
  if (artifact.lastKnownProviderStatus === "DRAFT") return "draft_deleted";
  if (
    artifact.lastKnownProviderStatus === "PUBLISHED" ||
    artifact.lastKnownProviderStatus === "DEPRECATED"
  ) {
    return "published_deprecated";
  }
  if (
    !artifact.lastKnownProviderStatus &&
    [
      "CREATING_FLOW",
      "ATTACHING_APPLICATION",
      "ENSURING_PHONE_KEYS",
      "UPLOADING_JSON",
    ].includes(artifact.stage)
  ) {
    return "draft_deleted";
  }
  return null;
}

function managedArtifactPayload(artifact: WhatsAppFlowProviderArtifact) {
  const suggestedResolutionKind = suggestedProviderResolutionKind(artifact);
  return {
    operationId: artifact.operationId,
    scenarioId: artifact.scenarioId,
    ledgerStatus: artifact.status,
    stage: artifact.stage,
    cleanupEligibility:
      artifact.cleanupEligibility === "ELIGIBLE" && !suggestedResolutionKind
        ? "STATUS_UNVERIFIED"
        : artifact.cleanupEligibility,
    ...(suggestedResolutionKind ? { suggestedResolutionKind } : {}),
    ...(artifact.resolutionKind
      ? { resolutionKind: artifact.resolutionKind }
      : {}),
    ...(artifact.resolutionOutcome
      ? { resolutionOutcome: artifact.resolutionOutcome }
      : {}),
  };
}

function mergeManagedProviderArtifacts(params: {
  flows: Array<Record<string, unknown>>;
  artifacts: WhatsAppFlowProviderArtifact[];
}): Array<Record<string, unknown>> {
  const latestArtifactByFlowId = new Map<
    string,
    WhatsAppFlowProviderArtifact
  >();
  for (const artifact of params.artifacts) {
    if (!latestArtifactByFlowId.has(artifact.providerFlowId)) {
      latestArtifactByFlowId.set(artifact.providerFlowId, artifact);
    }
  }
  const providerFlowIds = new Set<string>();
  const flows = params.flows.map(flow => {
    const flowId = typeof flow.id === "string" ? flow.id : "";
    if (flowId) providerFlowIds.add(flowId);
    const artifact = flowId ? latestArtifactByFlowId.get(flowId) : undefined;
    return artifact
      ? { ...flow, managedArtifact: managedArtifactPayload(artifact) }
      : flow;
  });
  for (const artifact of latestArtifactByFlowId.values()) {
    if (providerFlowIds.has(artifact.providerFlowId)) continue;
    flows.push({
      id: artifact.providerFlowId,
      name: artifact.providerFlowName || artifact.providerFlowId,
      status: "MISSING",
      categories: [],
      validation_errors: [],
      providerUnavailable: true,
      managedArtifact: managedArtifactPayload(artifact),
    });
  }
  return flows;
}

function providerResolutionResponse(
  result: Awaited<ReturnType<typeof resolveWhatsAppFlowProviderArtifact>>,
  operation: "deprecate" | "delete"
) {
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        validation_errors: result.validation_errors,
      },
      { status: result.status }
    );
  }
  return NextResponse.json({
    success: true,
    operation,
    managedResolution: result,
  });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const sourceId = searchParams.get("sourceId")?.trim() || undefined;
    const flowId = searchParams.get("flowId")?.trim();
    const includeJson = parseBooleanSearchParam(
      searchParams.get("includeJson")
    );
    const rawLimit = searchParams.get("limit")?.trim();
    const limit =
      rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : undefined;

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const readinessResult = await getWhatsAppWorkspaceReadiness(workspaceId, {
      sourceId,
    });
    if (readinessResult.error) return readinessResult.error;

    const {
      readiness,
      wabaId,
      accessToken,
      phoneNumberId,
      sourceId: resolvedSourceId,
    } = readinessResult;
    if (!readiness?.hasWabaId || !readiness?.hasAccessToken) {
      if (flowId) {
        return NextResponse.json(
          {
            error: "WhatsApp credentials incomplete",
            readiness,
          },
          { status: 400 }
        );
      }

      return NextResponse.json({
        flows: [],
        paging: null,
        readiness,
        sourceId: resolvedSourceId,
      });
    }
    if (!wabaId || !accessToken) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete", readiness },
        { status: 400 }
      );
    }

    if (flowId) {
      const details = await getMetaWhatsAppFlow({
        accessToken,
        flowId,
        phoneNumberId,
        includeJson,
        expectedWabaId: wabaId,
      });
      if (!details.ok) {
        return flowServiceErrorResponse(
          details,
          "Failed to fetch flow details"
        );
      }
      if (!isMetaWhatsAppFlowOwnedByWaba(details.flow, wabaId)) {
        return flowNotOwnedResponse();
      }

      return NextResponse.json({
        flow: details.flow,
        flowJson: details.flowJson ?? null,
        flowJsonError: details.flowJsonError ?? null,
        readiness,
        sourceId: resolvedSourceId,
      });
    }

    const listResult = await listMetaWhatsAppFlows({
      accessToken,
      wabaId,
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!listResult.ok) {
      return NextResponse.json(
        { error: listResult.error ?? "Failed to fetch flows" },
        { status: listResult.status || 500 }
      );
    }

    const managedArtifacts = sourceId
      ? await listWhatsAppFlowProviderArtifacts({
          workspaceId,
          sourceId,
          wabaId,
          limit: Math.min(limit ?? 200, 200),
        })
      : [];

    return NextResponse.json({
      flows: mergeManagedProviderArtifacts({
        flows: (listResult.flows ?? []) as Array<Record<string, unknown>>,
        artifacts: managedArtifacts,
      }),
      paging: listResult.paging ?? null,
      sourceId: resolvedSourceId,
      readiness: {
        hasWabaId: Boolean(wabaId),
        hasPhoneNumberId: Boolean(phoneNumberId),
        hasAccessToken: Boolean(accessToken),
      },
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const parsedBody = await parseFlowRequestBody(request);
    if (!parsedBody.ok) return parsedBody.response;
    const validated = SendFlowSchema.safeParse(parsedBody.body);
    if (!validated.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: validated.error.flatten(),
        },
        { status: 400 }
      );
    }

    const body = validated.data;
    const accessResult = await getWhatsAppWorkspaceContext(body.workspaceId, {
      requireManager: true,
      requirePhoneNumber: true,
      sourceId: body.sourceId,
    });
    if (accessResult.error) return accessResult.error;

    const accessToken = accessResult.context.accessToken || "";
    const phoneNumberId = accessResult.context.phoneNumberId || "";
    const wabaId = accessResult.context.wabaId || "";
    if (!accessToken || !phoneNumberId || !wabaId) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete" },
        { status: 400 }
      );
    }
    const ownershipError = await verifyFlowOwnership({
      accessToken,
      flowId: body.flowId,
      wabaId,
    });
    if (ownershipError) return ownershipError;

    const normalizedPhone = normalizeWhatsappRecipient(body.recipientPhone);
    const sendResult = await sendWhatsappInteractiveFlow(
      phoneNumberId,
      accessToken,
      body.recipientPhone,
      {
        flowId: body.flowId,
        mode: body.mode,
        flowToken: body.flowToken,
        flowCta: body.flowCta,
        bodyText: body.bodyText,
        headerText: body.headerText,
        footerText: body.footerText,
        flowActionType: body.flowActionType,
        flowActionPayload: body.flowActionPayload,
      }
    );

    return NextResponse.json({
      success: true,
      messageId: sendResult.messageId,
      recipientPhone: normalizedPhone,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const parsedBody = await parseFlowRequestBody(request);
    if (!parsedBody.ok) return parsedBody.response;
    const validated = CreateFlowSchema.safeParse(parsedBody.body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const body = validated.data;
    const accessResult = await getWhatsAppWorkspaceContext(body.workspaceId, {
      requireManager: true,
      sourceId: body.sourceId,
    });
    if (accessResult.error) return accessResult.error;

    const accessToken = accessResult.context.accessToken || "";
    const wabaId = accessResult.context.wabaId || "";
    if (!accessToken || !wabaId) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete" },
        { status: 400 }
      );
    }

    if (body.cloneFlowId) {
      const ownershipError = await verifyFlowOwnership({
        accessToken,
        flowId: body.cloneFlowId,
        wabaId,
      });
      if (ownershipError) return ownershipError;
    }

    const createResult = await createMetaWhatsAppFlow({
      accessToken,
      wabaId,
      name: body.name,
      categories: body.categories,
      cloneFlowId: body.cloneFlowId,
    });
    if (!createResult.ok) {
      return flowServiceErrorResponse(createResult, "Failed to create flow");
    }

    return NextResponse.json({
      success: true,
      flow: createResult.flow,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const parsedBody = await parseFlowRequestBody(
      request,
      FLOW_JSON_REQUEST_MAX_BYTES
    );
    if (!parsedBody.ok) return parsedBody.response;
    const validated = UpdateFlowSchema.safeParse(parsedBody.body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const body = validated.data;
    if (
      body.operation === "deprecate" &&
      body.acknowledgePreviouslySentMessagesWillStopOpening !== true
    ) {
      return NextResponse.json(
        { error: "Flow retirement acknowledgement is required" },
        { status: 400 }
      );
    }
    const accessResult = await getWhatsAppWorkspaceContext(body.workspaceId, {
      requireManager: true,
      sourceId: body.sourceId,
    });
    if (accessResult.error) return accessResult.error;

    const accessToken = accessResult.context.accessToken || "";
    const wabaId = accessResult.context.wabaId || "";
    if (!accessToken || !wabaId) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete" },
        { status: 400 }
      );
    }
    const managed = await isWhatsAppFlowProviderManaged({
      wabaId,
      providerFlowId: body.flowId,
    });
    if (managed) {
      if (body.operation !== "deprecate") {
        return managedFlowMutationResponse();
      }
      const resolution = await resolveWhatsAppFlowProviderArtifact({
        workspaceId: body.workspaceId,
        sourceId: body.sourceId,
        wabaId,
        accessToken,
        providerFlowId: body.flowId,
        requestedBy: accessResult.context.user.id,
        kind: "published_deprecated",
      });
      return providerResolutionResponse(resolution, "deprecate");
    }
    const ownershipError = await verifyFlowOwnership({
      accessToken,
      flowId: body.flowId,
      wabaId,
      ...(body.operation === "update_json" ? { requireDraft: true } : {}),
    });
    if (ownershipError) return ownershipError;

    const updateResult = await updateMetaWhatsAppFlow({
      accessToken,
      flowId: body.flowId,
      operation: body.operation,
      ...(body.operation === "update_json"
        ? { flowJson: body.flowJson }
        : { name: body.name, categories: body.categories }),
    });
    if (!updateResult.ok) {
      return flowServiceErrorResponse(updateResult, "Failed to update flow");
    }
    if (
      body.operation === "update_json" &&
      updateResult.flow?.status !== "DRAFT"
    ) {
      return NextResponse.json(
        { error: "Meta did not confirm the Flow as DRAFT after JSON upload" },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      operation: body.operation,
      flow: updateResult.flow,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const parsedBody = await parseFlowRequestBody(request);
    if (!parsedBody.ok) return parsedBody.response;
    const validated = DeleteFlowSchema.safeParse(parsedBody.body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const body = validated.data;
    if (body.acknowledgeDraftDeletion !== true) {
      return NextResponse.json(
        { error: "Flow draft deletion acknowledgement is required" },
        { status: 400 }
      );
    }
    const accessResult = await getWhatsAppWorkspaceContext(body.workspaceId, {
      requireManager: true,
      sourceId: body.sourceId,
    });
    if (accessResult.error) return accessResult.error;

    const accessToken = accessResult.context.accessToken || "";
    const wabaId = accessResult.context.wabaId || "";
    if (!accessToken || !wabaId) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete" },
        { status: 400 }
      );
    }
    const managed = await isWhatsAppFlowProviderManaged({
      wabaId,
      providerFlowId: body.flowId,
    });
    if (managed) {
      const resolution = await resolveWhatsAppFlowProviderArtifact({
        workspaceId: body.workspaceId,
        sourceId: body.sourceId,
        wabaId,
        accessToken,
        providerFlowId: body.flowId,
        requestedBy: accessResult.context.user.id,
        kind: "draft_deleted",
      });
      return providerResolutionResponse(resolution, "delete");
    }
    const ownershipError = await verifyFlowOwnership({
      accessToken,
      flowId: body.flowId,
      wabaId,
    });
    if (ownershipError) return ownershipError;

    const deleteResult = await deleteMetaWhatsAppFlow({
      accessToken,
      flowId: body.flowId,
    });
    if (!deleteResult.ok) {
      return flowServiceErrorResponse(deleteResult, "Failed to delete flow");
    }

    return NextResponse.json({
      success: true,
      flowId: body.flowId,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
