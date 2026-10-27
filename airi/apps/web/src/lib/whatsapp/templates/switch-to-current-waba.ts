import { getWhatsAppAccountCredentials } from "@/lib/whatsapp/account/resolution";
import { createWhatsAppTemplateMutation } from "@/lib/whatsapp/templates/mutation-service";
import { resolvePreviousWhatsAppWabaId } from "@/lib/whatsapp/templates/previous-waba";
import {
  remapTemplateFlowsForCurrentWaba,
  TemplateFlowRemapError,
} from "@/lib/whatsapp/templates/remap-template-flows-for-waba";
import {
  compactWhatsAppWabaId,
  inferWhatsAppTemplateSourceWabaId,
  type WhatsAppWabaHistoryEntry,
} from "@/lib/whatsapp/templates/waba-origin";
import type { WhatsAppTemplateData } from "@icecore/shared/types/templates";
import type { WhatsAppComponent, WhatsAppTemplateStatus } from "@icecore/shared/types/whatsapp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readNonEmptyStringOrUndefined } from "@icecore/shared/lib/value-utils";

export class SwitchUnifiedTemplateWabaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchUnifiedTemplateWabaError";
  }
}

export type SwitchUnifiedTemplateToCurrentWabaParams = {
  supabase: SupabaseClient;
  workspaceId: string;
  userId: string;
  templateId: string;
};

export type SwitchUnifiedTemplateToCurrentWabaResult = {
  metaTemplateId: string;
  status: string;
  wabaId: string;
  warning?: string;
};

function asWhatsAppTemplateData(
  value: unknown
): WhatsAppTemplateData | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as WhatsAppTemplateData;
}

export async function switchUnifiedTemplateToCurrentWaba(
  params: SwitchUnifiedTemplateToCurrentWabaParams
): Promise<SwitchUnifiedTemplateToCurrentWabaResult> {
  const credentials = await getWhatsAppAccountCredentials(params.workspaceId);
  const currentWabaId = compactWhatsAppWabaId(credentials.primaryCandidates[0]?.id);

  if (!currentWabaId) {
    throw new SwitchUnifiedTemplateWabaError(
      "Connect WhatsApp before switching this template to the current account."
    );
  }

  const { data: existing, error: loadError } = await params.supabase
    .from("message_templates")
    .select("id, name, channel, whatsapp_data, created_at")
    .eq("id", params.templateId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();

  if (loadError) {
    throw new SwitchUnifiedTemplateWabaError(
      `Database error: ${loadError.message}`
    );
  }
  if (!existing) {
    throw new SwitchUnifiedTemplateWabaError("Template not found");
  }

  const channel = existing.channel;
  if (channel !== "whatsapp" && channel !== "both") {
    throw new SwitchUnifiedTemplateWabaError(
      "Only WhatsApp templates can be switched to the current WABA."
    );
  }

  const whatsappData = asWhatsAppTemplateData(existing.whatsapp_data);
  if (
    !whatsappData?.language ||
    !whatsappData.category ||
    !Array.isArray(whatsappData.components) ||
    whatsappData.components.length === 0
  ) {
    throw new SwitchUnifiedTemplateWabaError(
      "This saved template is missing WhatsApp content needed to submit it."
    );
  }

  const accessToken = readNonEmptyStringOrUndefined(credentials.accessToken);
  if (!accessToken) {
    throw new SwitchUnifiedTemplateWabaError(
      "Connect WhatsApp before switching this template to the current account."
    );
  }

  let previousWabaId: string | null = null;
  let wabaHistory: WhatsAppWabaHistoryEntry[] = [];
  try {
    const previous = await resolvePreviousWhatsAppWabaId({
      workspaceId: params.workspaceId,
      currentWabaId,
    });
    previousWabaId = previous.previousWabaId;
    wabaHistory = previous.wabaHistory;
  } catch {
    previousWabaId = null;
    wabaHistory = [];
  }

  const sourceWabaId = inferWhatsAppTemplateSourceWabaId({
    storedWabaId: compactWhatsAppWabaId(whatsappData.wabaId),
    currentWabaId,
    templateCreatedAt:
      typeof existing.created_at === "string" ? existing.created_at : undefined,
    wabaHistory,
    fallbackPreviousWabaId: previousWabaId,
  });

  let remappedComponents: WhatsAppComponent[];
  try {
    remappedComponents = await remapTemplateFlowsForCurrentWaba({
      accessToken,
      currentWabaId,
      sourceWabaId,
      components: whatsappData.components,
    });
  } catch (error) {
    if (error instanceof TemplateFlowRemapError) {
      throw new SwitchUnifiedTemplateWabaError(error.message);
    }
    throw error;
  }

  const created = await createWhatsAppTemplateMutation({
    workspaceId: params.workspaceId,
    userId: params.userId,
    name: existing.name,
    language: whatsappData.language,
    category: whatsappData.category,
    components: remappedComponents,
    allowCategoryChange: whatsappData.allow_category_change,
    optimizationSpec: whatsappData.optimization_spec,
    audit: { enabled: false },
  });

  const nextWhatsAppData: WhatsAppTemplateData = {
    ...whatsappData,
    components: remappedComponents,
    metaTemplateId: created.id,
    status: created.status as WhatsAppTemplateStatus,
    wabaId: currentWabaId,
  };

  const { error: updateError } = await params.supabase
    .from("message_templates")
    .update({ whatsapp_data: nextWhatsAppData })
    .eq("id", params.templateId)
    .eq("workspace_id", params.workspaceId);

  if (updateError) {
    throw new SwitchUnifiedTemplateWabaError(
      `Template was submitted to Meta, but saving the local copy failed: ${updateError.message}`
    );
  }

  return {
    metaTemplateId: created.id,
    status: created.status,
    wabaId: currentWabaId,
    warning: created.warning,
  };
}
