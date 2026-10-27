import { createServerLogger } from "@/lib/observability/server-logs";
import {
  getWhatsAppWorkspaceContext,
  WHATSAPP_TEMPLATE_MANAGER_ONLY,
} from "@/lib/whatsapp/get-workspace-context";
import { WHATSAPP_TEMPLATES_CONNECTION_REQUIRED_CODE } from "@/lib/whatsapp/templates/connection-state";
import { WhatsAppTemplateCatalogError } from "@/lib/whatsapp/templates/catalog-contracts";
import {
  createWhatsAppTemplateMutation,
  deleteWhatsAppTemplateMutation,
  updateWhatsAppTemplateMutation,
  WhatsAppTemplateMutationValidationError,
} from "@/lib/whatsapp/templates/mutation-service";
import { resolvePreviousWhatsAppWabaId } from "@/lib/whatsapp/templates/previous-waba";
import { listTemplates } from "@/lib/whatsapp/templates/service";
import type { WhatsAppTemplateStatus } from "@icecore/shared/types/whatsapp";
import { NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

const templateRouteLogger = createServerLogger("api.whatsapp.templates");

type TemplateRouteCredentials = {
  accessToken?: string;
  businessId?: string;
  wabaId?: string;
};

function hasTemplateRouteCredentials(credentials: TemplateRouteCredentials) {
  return Boolean(
    credentials.accessToken && (credentials.wabaId || credentials.businessId)
  );
}

function whatsappConnectionRequiredResponse(options?: {
  includeTemplates?: boolean;
}) {
  return NextResponse.json(
    {
      error: "Connect WhatsApp before managing message templates.",
      code: WHATSAPP_TEMPLATES_CONNECTION_REQUIRED_CODE,
      requiresWhatsAppConnection: true,
      ...(options?.includeTemplates ? { templates: [] } : {}),
    },
    { status: 409 }
  );
}

function templateMutationErrorResponse(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";
  return NextResponse.json(
    { error: errorMessage },
    {
      status:
        error instanceof WhatsAppTemplateMutationValidationError ? 400 : 500,
    }
  );
}

function logUnexpectedTemplateMutationError(label: string, error: unknown) {
  if (error instanceof WhatsAppTemplateMutationValidationError) return;
  templateRouteLogger.error(label, error);
}

/**
 * GET - List all message templates for workspace
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const sourceId = searchParams.get("sourceId")?.trim() || undefined;
    const statusParam = searchParams.get("status");
    const status = statusParam
      ? (statusParam as WhatsAppTemplateStatus)
      : undefined;
    const limitParam = searchParams.get("limit");
    const parsedLimit = limitParam ? Number(limitParam) : undefined;
    const limit =
      typeof parsedLimit === "number" &&
      Number.isFinite(parsedLimit) &&
      parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), 500)
        : undefined;

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      requireCredentials: false,
      ...(sourceId ? { sourceId } : {}),
    });
    if (accessResult.error) return accessResult.error;
    if (!hasTemplateRouteCredentials(accessResult.context.credentials)) {
      return whatsappConnectionRequiredResponse({ includeTemplates: true });
    }

    const result = await listTemplates(workspaceId, {
      status,
      limit,
      ...(sourceId ? { sourceId } : {}),
      ...(searchParams.has("_refresh") ? { force: true } : {}),
    });
    const currentWabaId =
      result.catalog?.wabaId ||
      accessResult.context.wabaId ||
      accessResult.context.credentials.wabaId ||
      null;
    const origin = await resolvePreviousWhatsAppWabaId({
      workspaceId,
      currentWabaId,
    }).catch(() => ({ previousWabaId: null, wabaHistory: [] }));

    return NextResponse.json({
      ...result,
      wabaId: currentWabaId,
      previousWabaId: origin.previousWabaId,
      wabaHistory: origin.wabaHistory,
    });
  } catch (error) {
    if (error instanceof WhatsAppTemplateCatalogError) {
      const retryAtMs = error.retryAt ? Date.parse(error.retryAt) : NaN;
      const retryAfter = Number.isFinite(retryAtMs)
        ? String(
            Math.min(
              21_600,
              Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000))
            )
          )
        : undefined;
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          providerCode: error.providerCode,
          retryAt: error.retryAt,
        },
        {
          status: error.status,
          ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}),
        }
      );
    }
    templateRouteLogger.error("Get templates error", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * POST - Create a new message template
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      workspaceId,
      name,
      language,
      category,
      components,
      allow_category_change,
      optimization_spec,
    } = body;

    if (!workspaceId || !name || !language || !category || !components) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: workspaceId, name, language, category, components",
        },
        { status: 400 }
      );
    }
    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      managerErrorMessage: WHATSAPP_TEMPLATE_MANAGER_ONLY.create,
      requireCredentials: false,
      requireManager: true,
    });
    if (accessResult.error) return accessResult.error;
    if (!hasTemplateRouteCredentials(accessResult.context.credentials)) {
      return whatsappConnectionRequiredResponse();
    }

    const result = await createWhatsAppTemplateMutation({
      workspaceId,
      userId: accessResult.context.user.id,
      name,
      language,
      category,
      components,
      allowCategoryChange: allow_category_change,
      optimizationSpec: optimization_spec,
      analyticsOrigin: "templates_page",
    });

    return NextResponse.json({
      id: result.id,
      status: result.status,
      warning: result.warning,
      message: "Template created successfully. It will be reviewed by Meta.",
    });
  } catch (error) {
    logUnexpectedTemplateMutationError("Create template error:", error);
    return templateMutationErrorResponse(error);
  }
}

/**
 * PATCH - Update an existing template
 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const {
      workspaceId,
      templateId,
      category,
      components,
      allow_category_change,
      optimization_spec,
    } = body;

    if (!workspaceId || !templateId) {
      return NextResponse.json(
        { error: "workspaceId and templateId are required" },
        { status: 400 }
      );
    }
    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      managerErrorMessage: WHATSAPP_TEMPLATE_MANAGER_ONLY.update,
      requireCredentials: false,
      requireManager: true,
    });
    if (accessResult.error) return accessResult.error;
    if (!hasTemplateRouteCredentials(accessResult.context.credentials)) {
      return whatsappConnectionRequiredResponse();
    }

    const result = await updateWhatsAppTemplateMutation({
      workspaceId,
      userId: accessResult.context.user.id,
      templateId,
      category,
      components,
      allowCategoryChange: allow_category_change,
      optimizationSpec: optimization_spec,
    });

    return NextResponse.json({
      success: result.success,
      warning: result.warning,
      message: "Template updated successfully. It will be reviewed by Meta.",
    });
  } catch (error) {
    logUnexpectedTemplateMutationError("Update template error:", error);
    return templateMutationErrorResponse(error);
  }
}

/**
 * DELETE - Delete a message template
 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const templateName = searchParams.get("name");
    const templateId = searchParams.get("templateId") || undefined;
    const requestedTemplateLanguage = searchParams.get("language") || undefined;

    if (!workspaceId || !templateName) {
      return NextResponse.json(
        { error: "workspaceId and template name are required" },
        { status: 400 }
      );
    }
    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      managerErrorMessage: WHATSAPP_TEMPLATE_MANAGER_ONLY.delete,
      requireCredentials: false,
      requireManager: true,
    });
    if (accessResult.error) return accessResult.error;
    if (!hasTemplateRouteCredentials(accessResult.context.credentials)) {
      return whatsappConnectionRequiredResponse();
    }

    const result = await deleteWhatsAppTemplateMutation({
      workspaceId,
      userId: accessResult.context.user.id,
      templateName,
      templateId,
      templateLanguage: requestedTemplateLanguage,
    });

    return NextResponse.json({
      success: result.success,
      deletedBy: result.deletedBy,
      message: "Template deleted successfully",
    });
  } catch (error) {
    logUnexpectedTemplateMutationError("Delete template error:", error);
    return templateMutationErrorResponse(error);
  }
}
