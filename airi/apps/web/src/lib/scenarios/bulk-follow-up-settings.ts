import type {
  BulkFollowUpSettings,
  BulkFollowUpTemplateRoute,
} from "@icecore/scenario-contracts";
import { readNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";

export function normalizeBulkFollowUpSettings(
  raw: unknown
): BulkFollowUpSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const routesRaw = o.templateRoutes;
  if (!Array.isArray(routesRaw)) {
    return {
      templateRoutes: [],
    };
  }

  const templateRoutes: BulkFollowUpTemplateRoute[] = [];
  for (const item of routesRaw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const taxonomyLabel = normalizeOptionalString(r.taxonomyLabel);
    const whatsappTemplateName = normalizeOptionalString(
      r.whatsappTemplateName
    );
    if (!taxonomyLabel || !whatsappTemplateName) continue;
    templateRoutes.push({
      taxonomyLabel,
      whatsappTemplateName,
      whatsappTemplateLanguage:
        normalizeOptionalString(r.whatsappTemplateLanguage) ?? undefined,
      campaignNodeId: normalizeOptionalString(r.campaignNodeId),
      internalLabel: normalizeOptionalString(r.internalLabel),
    });
  }

  return {
    templateRoutes,
  };
}
