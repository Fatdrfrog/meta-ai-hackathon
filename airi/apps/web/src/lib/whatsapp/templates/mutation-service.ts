import { createServerLogger } from "@/lib/observability/server-logs";
import { captureFunnelEvent } from "@/lib/funnel-analytics";
import { normalizeMarketingMessagesOptimizationSpec } from "@/lib/whatsapp/marketing/message-pricing";
import {
  getWhatsAppTemplateComponentsErrorMessage,
  parseWhatsAppTemplateSubmissionComponents,
} from "@/lib/whatsapp/templates/component-schemas";
import {
  createTemplate,
  type WhatsAppTemplateAccountOptions,
  deleteTemplate,
  getTemplate,
  logTemplateAction,
  resolveTemplateAccountContext,
  syncTemplatesToMongo,
  updateTemplate,
} from "@/lib/whatsapp/templates/service";
import {
  deleteTemplateSnapshots,
  mirrorWhatsAppTemplate,
} from "@/lib/whatsapp/templates/template-mirror";
import { normalizeWhatsAppTemplateLanguageCode } from "@icecore/shared/constants/whatsapp-templates";
import type {
  CreateWhatsAppTemplatePayload,
  UpdateWhatsAppTemplatePayload,
  WhatsAppComponent,
  WhatsAppMarketingMessagesOptimizationSpec,
  WhatsAppTemplate,
  WhatsAppTemplateCategory,
} from "@icecore/shared/types/whatsapp";

const templateMutationLogger = createServerLogger("whatsapp.template-mutation");

export class WhatsAppTemplateMutationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppTemplateMutationValidationError";
  }
}

type WhatsAppTemplateMutationAuditOptions = {
  enabled?: boolean;
};

export type CreateWhatsAppTemplateMutationInput = {
  workspaceId: string;
  accountContext?: WhatsAppTemplateAccountOptions["accountContext"];
  /** Trusted batch operators must verify and mirror the final batch before enabling it. */
  deferCreatedStatusReadback?: boolean;
  userId?: string;
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  components: unknown;
  allowCategoryChange?: boolean;
  optimizationSpec?: unknown;
  audit?: WhatsAppTemplateMutationAuditOptions;
  /** Where a person submitted it; omitted for system re-creations. */
  analyticsOrigin?: WhatsAppTemplateSubmissionOrigin;
};

export type WhatsAppTemplateSubmissionOrigin =
  | "templates_page"
  | "scenario_generator"
  | "airi";

export type UpdateWhatsAppTemplateMutationInput = {
  workspaceId: string;
  accountContext?: WhatsAppTemplateAccountOptions["accountContext"];
  userId?: string;
  templateId: string;
  category?: WhatsAppTemplateCategory;
  components?: unknown;
  allowCategoryChange?: boolean;
  optimizationSpec?: unknown;
  audit?: WhatsAppTemplateMutationAuditOptions;
};

export type DeleteWhatsAppTemplateMutationInput = {
  workspaceId: string;
  userId?: string;
  templateName: string;
  templateId?: string;
  templateLanguage?: string;
  audit?: WhatsAppTemplateMutationAuditOptions;
};

export type SyncWhatsAppTemplatesMutationInput = {
  workspaceId: string;
  userId: string;
};

function normalizeLanguage(language: string): string {
  const normalized = normalizeWhatsAppTemplateLanguageCode(language);
  if (!normalized) {
    throw new WhatsAppTemplateMutationValidationError(
      `Unsupported WhatsApp template language code: ${language}`
    );
  }
  return normalized;
}

function normalizeComponents(
  components: unknown,
  category?: WhatsAppTemplateCategory
): WhatsAppComponent[] {
  const parsed = parseWhatsAppTemplateSubmissionComponents(
    components,
    category
  );
  if (!parsed.success) {
    throw new WhatsAppTemplateMutationValidationError(
      getWhatsAppTemplateComponentsErrorMessage(parsed.error)
    );
  }
  return parsed.data;
}

function normalizeOptimizationSpec(
  value: unknown,
  category?: WhatsAppTemplateCategory
): WhatsAppMarketingMessagesOptimizationSpec | undefined {
  const normalized = normalizeMarketingMessagesOptimizationSpec(value);
  if (!normalized.ok) {
    throw new WhatsAppTemplateMutationValidationError(normalized.error);
  }
  if (normalized.value !== undefined && category && category !== "MARKETING") {
    throw new WhatsAppTemplateMutationValidationError(
      "optimization_spec is only supported for MARKETING templates"
    );
  }
  return normalized.value;
}

function buildCreateTemplatePayload(
  input: CreateWhatsAppTemplateMutationInput
): CreateWhatsAppTemplatePayload {
  const payload: CreateWhatsAppTemplatePayload = {
    name: input.name,
    language: normalizeLanguage(input.language),
    category: input.category,
    components: normalizeComponents(input.components, input.category),
  };

  if (input.allowCategoryChange !== undefined) {
    payload.allow_category_change = input.allowCategoryChange;
  }

  const optimizationSpec = normalizeOptimizationSpec(
    input.optimizationSpec,
    input.category
  );
  if (optimizationSpec !== undefined) {
    payload.optimization_spec = optimizationSpec;
  }

  return payload;
}

function buildUpdateTemplatePayload(
  input: UpdateWhatsAppTemplateMutationInput
): UpdateWhatsAppTemplatePayload {
  const payload: UpdateWhatsAppTemplatePayload = {};

  if (input.category !== undefined) {
    payload.category = input.category;
  }
  if (input.components !== undefined) {
    payload.components = normalizeComponents(input.components, input.category);
  }
  if (input.allowCategoryChange !== undefined) {
    payload.allow_category_change = input.allowCategoryChange;
  }

  const optimizationSpec = normalizeOptimizationSpec(
    input.optimizationSpec,
    input.category
  );
  if (optimizationSpec !== undefined) {
    payload.optimization_spec = optimizationSpec;
  }

  return payload;
}

function normalizeDeleteTemplateLanguage(
  language: string | undefined
): string | undefined {
  return language ? normalizeLanguage(language) : undefined;
}

function shouldWriteAudit(params: {
  audit?: WhatsAppTemplateMutationAuditOptions;
  userId?: string;
}) {
  return params.audit?.enabled !== false && Boolean(params.userId);
}

/**
 * Re-reads the template Meta now holds into our cache and stored rows. Meta
 * already accepted the change, so a failed refresh only logs: the lifecycle
 * webhooks and Sync bring both copies up to date later.
 */
async function refreshTemplateMirrors(
  workspaceId: string,
  templateId: string,
  options?: WhatsAppTemplateAccountOptions
): Promise<WhatsAppTemplate | null> {
  try {
    const template = options
      ? await getTemplate(workspaceId, templateId, options)
      : await getTemplate(workspaceId, templateId);
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const mirrored = await mirrorWhatsAppTemplate({
      supabase: supabaseAdmin,
      workspaceId,
      template,
    });
    if (mirrored.errors.length > 0) {
      templateMutationLogger.warn("WhatsApp template mirror write failed", {
        workspaceId,
        templateId,
        errors: mirrored.errors,
      });
    }
    return template;
  } catch (error) {
    templateMutationLogger.warn("WhatsApp template mirror refresh failed", {
      workspaceId,
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The status Meta reports right after a create, which may already be
 * approved. Our copies get the template once a caller stores its row and
 * the lifecycle webhooks arrive.
 */
async function readCreatedTemplateStatus(
  workspaceId: string,
  templateId: string,
  options?: WhatsAppTemplateAccountOptions
): Promise<string | null> {
  try {
    const template = options
      ? await getTemplate(workspaceId, templateId, options)
      : await getTemplate(workspaceId, templateId);
    return template.status || null;
  } catch (error) {
    templateMutationLogger.warn("WhatsApp template status read failed", {
      workspaceId,
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function createWhatsAppTemplateMutation(
  input: CreateWhatsAppTemplateMutationInput
): Promise<{ id: string; status: string; warning?: string }> {
  if (input.deferCreatedStatusReadback === true && !input.accountContext) {
    throw new WhatsAppTemplateMutationValidationError(
      "Deferred status readback requires a selected WhatsApp account"
    );
  }
  const payload = buildCreateTemplatePayload(input);
  const options =
    input.accountContext !== undefined
      ? { accountContext: input.accountContext }
      : {
          accountContext: await resolveTemplateAccountContext(
            input.workspaceId
          ),
        };
  const result = await createTemplate(input.workspaceId, payload, options);
  const status =
    input.deferCreatedStatusReadback === true
      ? null
      : await readCreatedTemplateStatus(input.workspaceId, result.id, options);

  if (shouldWriteAudit(input)) {
    await logTemplateAction(
      input.workspaceId,
      input.userId!,
      "CREATE",
      input.name,
      { templateId: result.id }
    ).catch(() => {});
  }

  const finalStatus = status || result.status || "PENDING";
  if (input.analyticsOrigin && input.userId) {
    await captureFunnelEvent({
      event: "template_submitted",
      userId: input.userId,
      workspaceId: input.workspaceId,
      properties: {
        origin: input.analyticsOrigin,
        category: input.category,
        language: payload.language,
        status: finalStatus,
      },
      insertId: `template_submitted:${result.id}`,
    });
  }

  return {
    id: result.id,
    status: finalStatus,
    warning: result.warning,
  };
}

export async function updateWhatsAppTemplateMutation(
  input: UpdateWhatsAppTemplateMutationInput
): Promise<{
  success: boolean;
  warning?: string;
  template?: WhatsAppTemplate;
}> {
  const payload = buildUpdateTemplatePayload(input);
  const options =
    input.accountContext !== undefined
      ? { accountContext: input.accountContext }
      : {
          accountContext: await resolveTemplateAccountContext(
            input.workspaceId
          ),
        };
  const result = await updateTemplate(
    input.workspaceId,
    input.templateId,
    payload,
    options
  );
  const refreshed = await refreshTemplateMirrors(
    input.workspaceId,
    input.templateId,
    options
  );

  if (shouldWriteAudit(input)) {
    await logTemplateAction(
      input.workspaceId,
      input.userId!,
      "UPDATE",
      refreshed?.name || input.templateId,
      {
        templateId: input.templateId,
        changes: payload as Record<string, unknown>,
      }
    ).catch(() => {});
  }

  return {
    success: result.success,
    warning: result.warning,
    ...(input.accountContext !== undefined && refreshed
      ? { template: refreshed }
      : {}),
  };
}

export async function deleteWhatsAppTemplateMutation(
  input: DeleteWhatsAppTemplateMutationInput
): Promise<{
  success: boolean;
  deletedBy: "id" | "name";
  templateId?: string;
}> {
  const result = await deleteTemplate(input.workspaceId, {
    templateName: input.templateName,
    templateId: input.templateId,
    language: normalizeDeleteTemplateLanguage(input.templateLanguage),
  });
  // A name-only delete removes every language of the name in Meta.
  await deleteTemplateSnapshots({
    workspaceId: input.workspaceId,
    templateId: result.deletedBy === "id" ? result.templateId : undefined,
    name: input.templateName,
  }).catch(error => {
    templateMutationLogger.warn("WhatsApp template cache cleanup failed", {
      workspaceId: input.workspaceId,
      templateName: input.templateName,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  if (shouldWriteAudit(input)) {
    await logTemplateAction(
      input.workspaceId,
      input.userId!,
      "DELETE",
      input.templateName,
      { templateId: input.templateId }
    ).catch(() => {});
  }

  return result;
}

export async function syncWhatsAppTemplatesMutation(
  input: SyncWhatsAppTemplatesMutationInput
) {
  return syncTemplatesToMongo(input.workspaceId, input.userId);
}
