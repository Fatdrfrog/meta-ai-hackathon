import {
  normalizeScenarioWhatsAppTemplateButtonIds,
  type ScenarioGeneratedTemplateDraft,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { isRecord } from "@icecore/shared/lib/value-utils";

export type GeneratedTemplateScenarioPatch = Pick<
  ScenarioNodeData,
  | "generatedTemplateDraft"
  | "actionWhatsAppTemplateId"
  | "actionWhatsAppTemplateName"
  | "actionWhatsAppTemplateLanguage"
  | "actionWhatsAppTemplateCategory"
  | "actionWhatsAppTemplateComponents"
  | "actionWhatsAppTemplateButtonIds"
>;

export type GeneratedTemplateScenarioUpdate = {
  nodeId: string;
  previousScenarioUpdatedAt: string;
  scenarioUpdatedAt: string;
  patch: GeneratedTemplateScenarioPatch;
};

export type GeneratedTemplateSubmissionResult = {
  templateId?: string;
  status?: ScenarioGeneratedTemplateDraft["status"];
  scenarioUpdate: GeneratedTemplateScenarioUpdate;
};

const PATCH_KEYS = new Set<keyof GeneratedTemplateScenarioPatch>([
  "generatedTemplateDraft",
  "actionWhatsAppTemplateId",
  "actionWhatsAppTemplateName",
  "actionWhatsAppTemplateLanguage",
  "actionWhatsAppTemplateCategory",
  "actionWhatsAppTemplateComponents",
  "actionWhatsAppTemplateButtonIds",
]);

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isComponentArray(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.every(component => {
      if (!isRecord(component) || typeof component.type !== "string") {
        return false;
      }
      if (
        component.buttons !== undefined &&
        (!Array.isArray(component.buttons) ||
          !component.buttons.every(
            button => isRecord(button) && typeof button.type === "string"
          ))
      ) {
        return false;
      }
      if (
        component.cards !== undefined &&
        (!Array.isArray(component.cards) ||
          !component.cards.every(
            card => isRecord(card) && isComponentArray(card.components)
          ))
      ) {
        return false;
      }
      return true;
    })
  );
}

function isGeneratedDraft(
  value: unknown
): value is ScenarioGeneratedTemplateDraft {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.language === "string" &&
    typeof value.status === "string" &&
    [
      "draft",
      "submitting",
      "submitted",
      "pending",
      "approved",
      "rejected",
    ].includes(value.status) &&
    (value.category === undefined || typeof value.category === "string") &&
    (value.metaTemplateId === undefined ||
      typeof value.metaTemplateId === "string") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.headerMediaUrl === undefined ||
      typeof value.headerMediaUrl === "string") &&
    (value.headerMediaFormat === undefined ||
      (typeof value.headerMediaFormat === "string" &&
        ["IMAGE", "VIDEO", "DOCUMENT"].includes(value.headerMediaFormat))) &&
    (value.components === undefined || isComponentArray(value.components))
  );
}

export function readGeneratedTemplateScenarioUpdate(
  value: unknown
): GeneratedTemplateScenarioUpdate | null {
  if (!isRecord(value) || !isRecord(value.patch)) return null;
  const patchKeys = Object.keys(value.patch);
  if (
    patchKeys.some(
      key => !PATCH_KEYS.has(key as keyof GeneratedTemplateScenarioPatch)
    )
  ) {
    return null;
  }
  if (
    typeof value.nodeId !== "string" ||
    !value.nodeId.trim() ||
    value.nodeId !== value.nodeId.trim() ||
    !isCanonicalTimestamp(value.previousScenarioUpdatedAt) ||
    !isCanonicalTimestamp(value.scenarioUpdatedAt) ||
    !isGeneratedDraft(value.patch.generatedTemplateDraft) ||
    (value.patch.actionWhatsAppTemplateComponents !== undefined &&
      !isComponentArray(value.patch.actionWhatsAppTemplateComponents)) ||
    (value.patch.actionWhatsAppTemplateButtonIds !== undefined &&
      normalizeScenarioWhatsAppTemplateButtonIds(
        value.patch.actionWhatsAppTemplateButtonIds
      ).status !== "supported")
  ) {
    return null;
  }
  for (const key of [
    "actionWhatsAppTemplateId",
    "actionWhatsAppTemplateName",
    "actionWhatsAppTemplateLanguage",
    "actionWhatsAppTemplateCategory",
  ] as const) {
    if (
      value.patch[key] !== undefined &&
      typeof value.patch[key] !== "string"
    ) {
      return null;
    }
  }
  const category = value.patch.actionWhatsAppTemplateCategory;
  if (
    category !== undefined &&
    (typeof category !== "string" ||
      !["MARKETING", "UTILITY", "AUTHENTICATION"].includes(category))
  ) {
    return null;
  }
  return value as GeneratedTemplateScenarioUpdate;
}

export function createGeneratedTemplateTargetDigest(
  data: Partial<ScenarioNodeData>
): string {
  const draft = data.generatedTemplateDraft;
  return JSON.stringify({
    kind: data.kind,
    actionType: data.actionType,
    actionReplyText: data.actionReplyText,
    actionWhatsAppTemplateId: data.actionWhatsAppTemplateId,
    actionWhatsAppTemplateName: data.actionWhatsAppTemplateName,
    actionWhatsAppTemplateLanguage: data.actionWhatsAppTemplateLanguage,
    actionWhatsAppTemplateCategory: data.actionWhatsAppTemplateCategory,
    actionWhatsAppTemplateComponents: data.actionWhatsAppTemplateComponents,
    generatedTemplateDraft: draft
      ? {
          id: draft.id,
          name: draft.name,
          language: draft.language,
          category: draft.category,
          components: draft.components,
          status: draft.status,
          metaTemplateId: draft.metaTemplateId,
          headerMediaUrl: draft.headerMediaUrl,
          headerMediaFormat: draft.headerMediaFormat,
        }
      : undefined,
  });
}
