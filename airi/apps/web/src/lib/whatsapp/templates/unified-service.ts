import { getWhatsAppAccountCredentials } from "@/lib/whatsapp/account/resolution";
import {
  createWhatsAppTemplateMutation,
  type WhatsAppTemplateSubmissionOrigin,
} from "@/lib/whatsapp/templates/mutation-service";
import {
  logTemplateAction,
  type WhatsAppTemplateAccountOptions,
} from "@/lib/whatsapp/templates/service";
import type {
  TelegramTemplateData,
  TemplateChannel,
  WhatsAppTemplateData,
} from "@icecore/shared/types/templates";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CreateUnifiedTemplateRecordParams = {
  supabase: SupabaseClient;
  workspaceId: string;
  accountContext?: WhatsAppTemplateAccountOptions["accountContext"];
  /** Server-only batch option; final provider readback and mirror proof are required. */
  deferCreatedStatusReadback?: boolean;
  userId: string;
  name: string;
  channel: TemplateChannel;
  whatsappData?: WhatsAppTemplateData;
  telegramData?: TelegramTemplateData;
  analyticsOrigin?: WhatsAppTemplateSubmissionOrigin;
};

export type CreateUnifiedTemplateRecordResult = {
  id: string;
  warning?: string;
  metaTemplateId?: string;
  metaTemplateStatus?: string;
};

/** Meta accepted creation, but the owned local record could not be confirmed. */
export class WhatsAppTemplateRecordPersistenceError extends Error {
  readonly metaTemplateId: string;
  readonly metaTemplateStatus: string;

  constructor(message: string, result: { id: string; status: string }) {
    super(message);
    this.name = "WhatsAppTemplateRecordPersistenceError";
    this.metaTemplateId = result.id;
    this.metaTemplateStatus = result.status;
  }
}

export async function createUnifiedTemplateRecord(
  params: CreateUnifiedTemplateRecordParams
): Promise<CreateUnifiedTemplateRecordResult> {
  if (
    params.deferCreatedStatusReadback === true &&
    (!params.accountContext ||
      !params.whatsappData ||
      (params.channel !== "whatsapp" && params.channel !== "both"))
  ) {
    throw new Error(
      "Deferred status readback requires a selected WhatsApp account and WhatsApp payload"
    );
  }
  let metaTemplateResult: {
    id: string;
    status: string;
    warning?: string;
  } | null = null;

  if (
    (params.channel === "whatsapp" || params.channel === "both") &&
    params.whatsappData
  ) {
    try {
      metaTemplateResult = await createWhatsAppTemplateMutation({
        workspaceId: params.workspaceId,
        ...(params.accountContext !== undefined
          ? { accountContext: params.accountContext }
          : {}),
        ...(params.deferCreatedStatusReadback === true
          ? { deferCreatedStatusReadback: true }
          : {}),
        userId: params.userId,
        name: params.name,
        language: params.whatsappData.language,
        category: params.whatsappData.category,
        components: params.whatsappData.components,
        allowCategoryChange: params.whatsappData.allow_category_change,
        optimizationSpec: params.whatsappData.optimization_spec,
        audit: { enabled: false },
        ...(params.analyticsOrigin
          ? { analyticsOrigin: params.analyticsOrigin }
          : {}),
      });
    } catch (error) {
      throw new Error(
        `WhatsApp API error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  const currentWabaId = params.whatsappData
    ? params.accountContext?.wabaId ||
      params.whatsappData.wabaId ||
      (await resolveCurrentWhatsAppWabaId(params.workspaceId))
    : undefined;

  let template: { id: string };
  try {
    const { data: insertedTemplate, error: insertError } = await params.supabase
      .from("message_templates")
      .insert({
        workspace_id: params.workspaceId,
        name: params.name,
        channel: params.channel,
        whatsapp_data: params.whatsappData
          ? {
              ...params.whatsappData,
              metaTemplateId: metaTemplateResult?.id,
              status: metaTemplateResult?.status,
              ...(currentWabaId ? { wabaId: currentWabaId } : {}),
            }
          : null,
        telegram_data: params.telegramData || null,
      })
      .select("id")
      .single();

    if (insertError) {
      throw new Error(`Database error: ${insertError.message}`);
    }
    if (!insertedTemplate?.id) {
      throw new Error("Database error: template insert did not return an id");
    }
    template = insertedTemplate;
  } catch (error) {
    if (metaTemplateResult) {
      throw new WhatsAppTemplateRecordPersistenceError(
        error instanceof Error
          ? error.message
          : "Database error: template insert failed",
        metaTemplateResult
      );
    }
    throw error;
  }

  await logTemplateAction(
    params.workspaceId,
    params.userId,
    "CREATE",
    params.name,
    {
      templateId: template.id,
    }
  ).catch(() => {});

  return {
    id: template.id,
    warning: metaTemplateResult?.warning,
    metaTemplateId: metaTemplateResult?.id,
    metaTemplateStatus: metaTemplateResult?.status,
  };
}

async function resolveCurrentWhatsAppWabaId(
  workspaceId: string
): Promise<string | undefined> {
  try {
    const credentials = await getWhatsAppAccountCredentials(workspaceId);
    const wabaId = credentials.primaryCandidates[0]?.id?.trim();
    return wabaId || undefined;
  } catch {
    return undefined;
  }
}
