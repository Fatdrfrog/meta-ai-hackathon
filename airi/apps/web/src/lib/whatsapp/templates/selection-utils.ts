import type {
  TelegramTemplateData,
  TemplateChannel,
  UnifiedTemplate,
} from "@icecore/shared/types/templates";
import {
  type WhatsAppComponent,
  type WhatsAppTemplate,
  type WhatsAppTemplateCategory,
  type WhatsAppTemplateStatus,
  getTemplatePreview,
  getTemplateVariables,
} from "@icecore/shared/types/whatsapp";
import { mergeComponentsWithUnifiedHeaderMediaUrl } from "@/lib/whatsapp/templates/header-media-utils";
import {
  getWhatsAppTemplateOptionValue,
  type WhatsAppTemplateNameLanguage,
} from "@/lib/whatsapp/templates/selection";
import {
  inferWhatsAppTemplateSourceWabaId,
  type WhatsAppWabaHistoryEntry,
} from "@/lib/whatsapp/templates/waba-origin";

export type WhatsAppTemplateSelectionItem = WhatsAppTemplate & {
  templateKey?: string;
  metaId?: string;
  dbId?: string;
  channel?: TemplateChannel;
  telegramData?: TelegramTemplateData;
  sourceWabaId?: string;
  isOnCurrentWaba?: boolean;
  canSwitchToCurrentWaba?: boolean;
};

export type WhatsAppTemplateCardModel = {
  id: string;
  template: WhatsAppTemplateSelectionItem;
  preview: string;
  variableCount: number;
  isEditable: boolean;
  missingReason?: string;
  copyId?: string;
};

type WhatsAppTemplateIdentityInput = WhatsAppTemplateNameLanguage &
  Pick<WhatsAppTemplateSelectionItem, "id" | "templateKey" | "metaId" | "dbId">;

type WhatsAppTemplateSelectionFilter = {
  platformFilter?: TemplateChannel;
  searchQuery?: string;
  statusFilter?: WhatsAppTemplateStatus;
};

type WhatsAppTemplateCardCopy = {
  missingMetaId: string;
  missingDbId: string;
};

function normalizeLanguageForKey(language?: string): string {
  return (language || "").trim().toLowerCase();
}

export function getWhatsAppTemplateMapKey(
  name: string,
  language?: string
): string {
  return `${name.trim()}::${normalizeLanguageForKey(language)}`;
}

export function getWhatsAppTemplateIdentity(
  template: WhatsAppTemplateIdentityInput
): string {
  return (
    template.templateKey ||
    `${template.name}_${template.language}_${template.metaId || template.dbId || template.id || ""}`
  );
}

export function findWhatsAppTemplateByOptionValue<
  TTemplate extends WhatsAppTemplateNameLanguage,
>(templates: TTemplate[], value?: string | null): TTemplate | null {
  if (!value) return null;
  return (
    templates.find(
      template => getWhatsAppTemplateOptionValue(template) === value
    ) || null
  );
}

export function findSelectedWhatsAppTemplate<
  TTemplate extends WhatsAppTemplateNameLanguage & { id?: string },
>(params: {
  templates: TTemplate[];
  value?: string | null;
  templateId?: string | null;
  name?: string | null;
  language?: string | null;
}): TTemplate | null {
  const selectedByValue = findWhatsAppTemplateByOptionValue(
    params.templates,
    params.value
  );
  if (selectedByValue) return selectedByValue;

  const templateId = params.templateId?.trim();
  if (templateId) {
    const selectedById = params.templates.find(
      template => template.id?.trim() === templateId
    );
    if (selectedById) return selectedById;
  }

  const name = params.name?.trim();
  const language = params.language?.trim();
  if (!name || !language) return null;

  return (
    params.templates.find(
      template => template.name === name && template.language === language
    ) || null
  );
}

export function duplicateWhatsAppTemplateSelectionItem(
  template: WhatsAppTemplateSelectionItem
): WhatsAppTemplateSelectionItem {
  return {
    ...template,
    name: `${template.name}_copy`,
    id: undefined,
    metaId: undefined,
    dbId: undefined,
    templateKey: undefined,
  };
}

export function getWhatsAppTemplateSelectionPreview(
  template: WhatsAppTemplateSelectionItem
): string {
  return getTemplatePreview(template) || template.telegramData?.text || "";
}

function compactWabaId(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isWhatsAppTemplateChannel(channel?: TemplateChannel): boolean {
  return channel === "whatsapp" || channel === "both";
}

export function mergeWhatsAppTemplateSources(params: {
  metaTemplates: WhatsAppTemplate[];
  unifiedTemplates: UnifiedTemplate[];
  currentWabaId?: string | null;
  previousWabaId?: string | null;
  wabaHistory?: WhatsAppWabaHistoryEntry[] | null;
}): WhatsAppTemplateSelectionItem[] {
  const templateMap = new Map<string, WhatsAppTemplateSelectionItem>();
  const currentWabaId = compactWabaId(params.currentWabaId);
  const previousWabaId = compactWabaId(params.previousWabaId);

  for (const template of params.metaTemplates) {
    const templateKey = getWhatsAppTemplateMapKey(
      template.name,
      template.language
    );
    templateMap.set(templateKey, {
      id: template.id,
      templateKey,
      name: template.name,
      language: template.language,
      status: template.status,
      category: template.category,
      components: template.components,
      metaId: template.id,
      dbId: undefined,
      channel: "whatsapp",
      rejected_reason: template.rejected_reason,
      sourceWabaId: currentWabaId,
      isOnCurrentWaba: true,
      canSwitchToCurrentWaba: false,
    });
  }

  for (const unified of params.unifiedTemplates) {
    const whatsappData = unified.whatsapp_data;
    const unifiedLanguage = whatsappData?.language || "";
    const templateKey = unifiedLanguage
      ? getWhatsAppTemplateMapKey(unified.name, unifiedLanguage)
      : `db:${unified.id}`;
    const existing = templateMap.get(templateKey);

    if (existing) {
      existing.dbId = unified.id;
      if (!existing.id) {
        existing.id = unified.id;
      }
      if (!existing.metaId && whatsappData?.metaTemplateId) {
        existing.metaId = whatsappData.metaTemplateId;
      }
      existing.channel = unified.channel;
      existing.telegramData = unified.telegram_data;
      existing.isOnCurrentWaba = true;
      existing.canSwitchToCurrentWaba = false;
      existing.sourceWabaId =
        currentWabaId || compactWabaId(whatsappData?.wabaId);
      const mergedComponents = mergeComponentsWithUnifiedHeaderMediaUrl({
        metaComponents: existing.components,
        unifiedComponents: whatsappData?.components as
          | WhatsAppComponent[]
          | undefined,
      });
      if (mergedComponents) {
        existing.components = mergedComponents;
      }
      continue;
    }

    const channel = unified.channel;
    const isWhatsApp = isWhatsAppTemplateChannel(channel);
    const sourceWabaId = inferWhatsAppTemplateSourceWabaId({
      storedWabaId: whatsappData?.wabaId,
      currentWabaId,
      templateCreatedAt: unified.created_at,
      wabaHistory: params.wabaHistory,
      fallbackPreviousWabaId: previousWabaId,
    });
    const hasSwitchableComponents =
      Array.isArray(whatsappData?.components) &&
      whatsappData.components.length > 0;

    templateMap.set(templateKey, {
      id: unified.id,
      templateKey,
      name: unified.name,
      language: whatsappData?.language || "",
      status: (whatsappData?.status || "PENDING") as WhatsAppTemplateStatus,
      category: (whatsappData?.category ||
        "UTILITY") as WhatsAppTemplateCategory,
      components: whatsappData?.components as WhatsAppComponent[] | undefined,
      metaId: whatsappData?.metaTemplateId,
      dbId: unified.id,
      channel,
      telegramData: unified.telegram_data,
      sourceWabaId,
      isOnCurrentWaba: !isWhatsApp,
      canSwitchToCurrentWaba:
        Boolean(currentWabaId) &&
        isWhatsApp &&
        Boolean(unified.id) &&
        hasSwitchableComponents,
    });
  }

  return Array.from(templateMap.values());
}

export function filterWhatsAppTemplateSelectionItems<
  TTemplate extends WhatsAppTemplateSelectionItem,
>(
  templates: TTemplate[],
  filters: WhatsAppTemplateSelectionFilter
): TTemplate[] {
  const normalizedSearchQuery = filters.searchQuery?.trim().toLowerCase() || "";

  return templates.filter(template => {
    const channel = template.channel || "whatsapp";
    if (filters.statusFilter && template.status !== filters.statusFilter) {
      return false;
    }

    if (filters.platformFilter) {
      if (
        filters.platformFilter === "whatsapp" &&
        channel !== "whatsapp" &&
        channel !== "both"
      ) {
        return false;
      }
      if (
        filters.platformFilter === "telegram" &&
        channel !== "telegram" &&
        channel !== "both"
      ) {
        return false;
      }
      if (filters.platformFilter === "both" && channel !== "both") {
        return false;
      }
    }

    if (!normalizedSearchQuery) return true;
    const preview = getWhatsAppTemplateSelectionPreview(template);
    return (
      template.name.toLowerCase().includes(normalizedSearchQuery) ||
      template.language.toLowerCase().includes(normalizedSearchQuery) ||
      preview.toLowerCase().includes(normalizedSearchQuery)
    );
  });
}

export function buildWhatsAppTemplateCardModels(
  templates: WhatsAppTemplateSelectionItem[],
  copy: WhatsAppTemplateCardCopy
): WhatsAppTemplateCardModel[] {
  return templates.map(template => {
    const templateId = getWhatsAppTemplateIdentity(template);
    const preview = getWhatsAppTemplateSelectionPreview(template);
    const variableCount = getTemplateVariables(template).length;
    const copyId = template.dbId || template.metaId || template.id;
    const channel = template.channel || "whatsapp";

    const effectiveMetaId =
      template.metaId || (channel !== "telegram" ? template.id : undefined);
    const effectiveDbId =
      template.dbId ||
      (channel === "telegram" || channel === "both" ? template.id : undefined);

    const needsWhatsAppId = channel === "whatsapp" || channel === "both";
    const needsDbId = channel === "telegram" || channel === "both";
    const missingMeta = needsWhatsAppId && !effectiveMetaId;
    const missingDb = needsDbId && !effectiveDbId;

    return {
      id: templateId,
      template,
      preview,
      variableCount,
      copyId,
      isEditable: !missingMeta && !missingDb,
      missingReason: missingMeta
        ? copy.missingMetaId
        : missingDb
          ? copy.missingDbId
          : undefined,
    };
  });
}
