import {
  isScenarioFormAnswerKey,
  WHATSAPP_FLOW_UI_LOCALE_IDS,
} from "@icecore/scenario-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { readJsonBodyWithinLimit } from "@/lib/api/json-body";
import type {
  WhatsAppFlowProvisioningFailureCode,
  WhatsAppFlowProvisioningResult,
} from "@/lib/whatsapp/flows/provisioning-contract";
import { provisionWhatsAppFlow } from "@/lib/whatsapp/flows/provisioning-service";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";

const REQUEST_MAX_BYTES = 2 * 1_024 * 1_024;
const boundedId = z.string().trim().min(1).max(256);
const boundedText = z.string().max(4_096);

const FlowOptionSchema = z
  .object({
    id: boundedId,
    title: z.string().trim().min(1).max(256),
  })
  .strict();

const FlowFieldSchema = z
  .object({
    id: boundedId,
    label: z.string().trim().min(1).max(256),
    fieldType: z.enum([
      "TextInput",
      "Dropdown",
      "DatePicker",
      "RadioButtonsGroup",
      "CheckboxGroup",
      "TextArea",
    ]),
    required: z.boolean().optional(),
    helperText: boundedText.optional(),
    options: z.array(FlowOptionSchema).max(200).optional(),
  })
  .strict();

const FlowScreenSchema = z
  .object({
    id: boundedId,
    title: z.string().max(256),
    fields: z.array(FlowFieldSchema).max(100),
  })
  .strict();

const EditableFlowConfigSchema = z
  .object({
    templateId: boundedId,
    screens: z.array(FlowScreenSchema).min(1).max(20),
    ctaText: z.string().trim().min(1).max(256),
    headerText: boundedText.optional(),
    bodyText: boundedText.optional(),
    footerText: boundedText.optional(),
    flowUiLocale: z.enum(WHATSAPP_FLOW_UI_LOCALE_IDS).optional(),
    flowSubmitLabel: z.string().trim().min(1).max(256).optional(),
    flowNavigationMode: z.enum(["linear", "data_endpoint"]).optional(),
    screenRoutes: z.record(z.string(), z.array(boundedId).max(20)).optional(),
    flowBranchRules: z
      .record(z.string(), z.record(z.string(), z.record(z.string(), boundedId)))
      .optional(),
    // Scenario data kept with the form; it is not part of the Flow content.
    answersKey: z.string().refine(isScenarioFormAnswerKey).optional(),
  })
  .strict();

const ProvisionRequestSchema = z
  .object({
    workspaceId: boundedId,
    sourceId: boundedId,
    scenarioId: boundedId,
    nodeId: boundedId,
    editableConfig: EditableFlowConfigSchema,
  })
  .strict();

function failureResponse(params: {
  status: number;
  code: WhatsAppFlowProvisioningFailureCode;
  message: string;
  retryable?: boolean;
}) {
  const body: WhatsAppFlowProvisioningResult = {
    ok: false,
    stage: "VALIDATING",
    phones: [],
    validationErrors: [],
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable ?? false,
    },
  };
  return NextResponse.json(body, { status: params.status });
}

function invalidRequest() {
  return failureResponse({
    status: 400,
    code: "WHATSAPP_FLOW_PROVISIONING_INVALID_INPUT",
    message: "Request must contain one strict editable Flow target",
  });
}

function provisioningHttpStatus(
  result: Extract<WhatsAppFlowProvisioningResult, { ok: false }>
): number {
  if (result.error.retryable) return 503;
  if (result.error.code === "WHATSAPP_FLOW_PROVISIONING_ACCESS_DENIED") {
    return 403;
  }
  if (
    result.error.code === "WHATSAPP_FLOW_PROVISIONING_INVALID_INPUT" ||
    result.error.code === "WHATSAPP_FLOW_PROVISIONING_TARGET_INVALID"
  ) {
    return 400;
  }
  return 409;
}

async function accessFailure(response: NextResponse) {
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  return failureResponse({
    status: response.status,
    code: "WHATSAPP_FLOW_PROVISIONING_ACCESS_DENIED",
    message:
      typeof payload?.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : "WhatsApp Flow publishing access was denied",
  });
}

export async function POST(
  request: Request
): Promise<NextResponse<WhatsAppFlowProvisioningResult>> {
  let body: unknown;
  try {
    body = await readJsonBodyWithinLimit(request, REQUEST_MAX_BYTES);
  } catch {
    return invalidRequest();
  }
  const parsed = ProvisionRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();

  const access = await getWhatsAppWorkspaceContext(parsed.data.workspaceId, {
    requireManager: true,
    sourceId: parsed.data.sourceId,
    managerErrorMessage: "Only managers and admins can publish WhatsApp Flows",
  });
  if (access.error) return accessFailure(access.error);
  if (
    access.context.sourceId !== parsed.data.sourceId ||
    !access.context.user?.id
  ) {
    return failureResponse({
      status: 409,
      code: "WHATSAPP_FLOW_PROVISIONING_SOURCE_BINDING_CHANGED",
      message: "WhatsApp source binding changed; refresh and retry",
    });
  }

  try {
    const result = await provisionWhatsAppFlow({
      ...parsed.data,
      updatedBy: access.context.user.id,
    });
    return NextResponse.json(result, {
      status: result.ok ? 200 : provisioningHttpStatus(result),
    });
  } catch {
    return failureResponse({
      status: 500,
      code: "WHATSAPP_FLOW_PROVISIONING_FAILED",
      message: "WhatsApp Flow provisioning failed",
      retryable: true,
    });
  }
}
