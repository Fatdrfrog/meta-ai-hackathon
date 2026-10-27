import {
  isRagScenarioContextOptionId,
  isScenarioContextOptionId,
  resolveWhatsAppFlowProviderId,
  type ScenarioActionReplyChannel,
  type ScenarioActionType,
  type ScenarioContextOptionId,
  type ScenarioInstagramConfig,
  type ScenarioNodeData,
  type ScenarioNodeDataInput,
  type ScenarioReplyCtaType,
  type ScenarioReplyMode,
  type ScenarioTelegramQuickReplyButton,
  type ScenarioTelegramQuickReplyRow,
  type WhatsAppFlowConfig,
  resolveOwnedScenarioWhatsAppServiceBodyMode,
} from "@icecore/scenario-contracts";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import {
  DEFAULT_FLOW_BODY_TEXT,
  DEFAULT_FLOW_CTA_TEXT,
  sanitizeWhatsAppFlowConfig,
} from "@/lib/scenarios/whatsapp-flow-config";
import { normalizeInstagramConfig } from "@/lib/scenarios/instagram-reply-config";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  readNonEmptyStringOrUndefined,
  readStringArray,
} from "@icecore/shared/lib/value-utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPLY_CTA_TYPE_SET = new Set<ScenarioReplyCtaType>([
  "none",
  "link",
  "flow",
]);

// ---------------------------------------------------------------------------
// Pure normalization functions
// ---------------------------------------------------------------------------

export const toStringArray = readStringArray;

export function normalizeScenarioPriority(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function normalizeActionType(
  nodeData: ScenarioNodeDataInput | null | undefined
): ScenarioActionType | null {
  return resolveScenarioActionTypeFromNodeData(nodeData ?? undefined);
}

export function normalizeReplyModeForActionNode(
  nodeData: ScenarioNodeDataInput
): ScenarioReplyMode {
  const serviceBodyMode = resolveOwnedScenarioWhatsAppServiceBodyMode(nodeData);
  if (serviceBodyMode) return serviceBodyMode;

  const explicitMode =
    typeof nodeData.actionReplyMode === "string"
      ? nodeData.actionReplyMode.trim()
      : "";
  if (explicitMode === "ai" || explicitMode === "fixed") {
    return explicitMode;
  }

  const explicitType =
    typeof nodeData.actionType === "string" ? nodeData.actionType.trim() : "";
  if (explicitType === "send_reply") return "fixed";
  if (explicitType === "draft_reply") return "ai";

  const source =
    typeof nodeData.source === "string"
      ? nodeData.source.toLowerCase().trim()
      : "";
  if (source === "messaging") return "fixed";
  if (source === "airi") return "ai";

  // New replies default to Fixed; AI is opt-in via the Fixed/AI control.
  return "fixed";
}

export function normalizeActionReplyChannelForActionNode(
  nodeData: ScenarioNodeDataInput
): ScenarioActionReplyChannel | undefined {
  if (nodeData.actionWhatsAppServiceMessage !== undefined) {
    return "whatsapp";
  }
  const explicit =
    typeof nodeData.actionReplyChannel === "string"
      ? nodeData.actionReplyChannel.trim()
      : "";
  if (
    explicit === "telegram" ||
    explicit === "instagram" ||
    explicit === "whatsapp" ||
    explicit === "email" ||
    explicit === "web_widget"
  ) {
    return explicit;
  }

  if (Array.isArray(nodeData.actionTelegramQuickReplies)) {
    return "telegram";
  }

  return undefined;
}

export function normalizeReplyCtaTypeForActionNode(params: {
  nodeData: ScenarioNodeData;
  actionLinkUrls: string[];
  actionReplyCtaFlowId?: string;
}): ScenarioReplyCtaType {
  const explicit =
    typeof params.nodeData.actionReplyCtaType === "string"
      ? params.nodeData.actionReplyCtaType.trim()
      : "";
  const hasLinks = params.actionLinkUrls.length > 0;
  const hasFlowId =
    resolveWhatsAppFlowProviderId({
      flowConfig: params.nodeData.actionFlowConfig,
      legacyFlowId: params.actionReplyCtaFlowId,
    }) !== null;

  if (REPLY_CTA_TYPE_SET.has(explicit as ScenarioReplyCtaType)) {
    if (explicit === "flow") {
      if (hasFlowId) return "flow";
      if (hasLinks) return "link";
      return "none";
    }
    if (explicit === "link") {
      if (hasLinks) return "link";
      if (hasFlowId) return "flow";
      return "none";
    }
    return "none";
  }

  if (hasFlowId) return "flow";
  if (hasLinks) return "link";
  return "none";
}

export const normalizeOptionalNodeText = readNonEmptyStringOrUndefined;
export const normalizeOptionalNodeId = readNonEmptyStringOrUndefined;

export function normalizeWhatsAppTemplateComponents(
  value: unknown
): WhatsAppComponent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter(
    component => component && typeof component === "object"
  ) as WhatsAppComponent[];
  return filtered.length > 0 ? filtered : undefined;
}

export {
  DEFAULT_FLOW_BODY_TEXT,
  DEFAULT_FLOW_CTA_TEXT,
  sanitizeWhatsAppFlowConfig,
};

export function normalizeFlowConfig(value: unknown): WhatsAppFlowConfig | null {
  const providerFlowId = resolveWhatsAppFlowProviderId({
    flowConfig:
      typeof value === "object" && value !== null
        ? (value as WhatsAppFlowConfig)
        : null,
  });
  const sanitized = sanitizeWhatsAppFlowConfig(value);
  if (!sanitized || !providerFlowId) return null;
  return { ...sanitized, metaFlowId: providerFlowId };
}

export function normalizeContextOptionId(
  nodeData: ScenarioNodeData
): ScenarioContextOptionId | null {
  const explicit = (nodeData.contextOptionId || "").trim();
  if (isScenarioContextOptionId(explicit)) return explicit;
  return null;
}

/**
 * `true` when `value` is the nested row shape: first element is an array of buttons.
 * Empty arrays are treated as legacy flat (no rows).
 */
export function isTelegramQuickRepliesNestedRowShape(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return Array.isArray(value[0]);
}

function normalizeTelegramQuickReplyButton(
  item: unknown
): ScenarioTelegramQuickReplyButton | null {
  if (typeof item !== "object" || item === null) return null;
  const rec = item as Record<string, unknown>;
  const text = typeof rec.text === "string" ? rec.text.trim() : "";
  const payload = typeof rec.payload === "string" ? rec.payload.trim() : "";
  if (!text || !payload) return null;
  return { text, payload };
}

/**
 * Coerces persisted `actionTelegramQuickReplies` to row arrays (legacy flat → one button per row).
 */
export function coerceTelegramQuickRepliesToRows(
  value: unknown
): ScenarioTelegramQuickReplyRow[] {
  if (!Array.isArray(value) || value.length === 0) return [];

  if (isTelegramQuickRepliesNestedRowShape(value)) {
    return (value as unknown[]).flatMap(
      (row): ScenarioTelegramQuickReplyRow[] => {
        if (!Array.isArray(row)) return [];
        const buttons = row
          .map(normalizeTelegramQuickReplyButton)
          .filter((b): b is ScenarioTelegramQuickReplyButton => b !== null);
        return buttons.length > 0 ? [buttons] : [];
      }
    );
  }

  const flat = (value as unknown[])
    .map(normalizeTelegramQuickReplyButton)
    .filter((b): b is ScenarioTelegramQuickReplyButton => b !== null);
  return flat.map(button => [button]);
}

/**
 * Validates buttons and returns row-major keyboard data for runtime / API, or `undefined` if empty.
 */
export function normalizeTelegramQuickReplies(
  value: unknown
): ScenarioTelegramQuickReplyRow[] | undefined {
  const rows = coerceTelegramQuickRepliesToRows(value);
  return rows.length > 0 ? rows : undefined;
}

export function normalizeInstagramConfigForActionNode(
  value: unknown
): ScenarioInstagramConfig | undefined {
  const config = normalizeInstagramConfig(value);
  if (config.kind === "text") return config;
  if (config.kind === "quick_replies") {
    return (config.quickReplies ?? []).length > 0 ? config : undefined;
  }
  if (config.kind === "button_template") {
    return (config.buttons ?? []).length > 0 ? config : undefined;
  }
  if (config.kind === "generic_template") {
    return (config.buttons ?? []).length > 0 || (config.cards ?? []).length > 0
      ? config
      : undefined;
  }
  if (config.kind === "media") {
    return config.mediaUrl ? config : undefined;
  }
  return undefined;
}

export function flattenTelegramQuickReplyRows(
  rows: ScenarioTelegramQuickReplyRow[] | undefined | null
): ScenarioTelegramQuickReplyButton[] {
  if (!rows || !Array.isArray(rows)) return [];
  return rows.flat();
}

export function normalizeUrlArray(value: unknown): string[] {
  const seen = new Set<string>();
  return toStringArray(value).flatMap(item => {
    try {
      const parsed = new URL(item);
      if (!["http:", "https:"].includes(parsed.protocol)) return [];
      const normalized = parsed.toString();
      if (seen.has(normalized)) return [];
      seen.add(normalized);
      return [normalized];
    } catch {
      return [];
    }
  });
}

export function normalizeAudienceDays(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  if (normalized < 1) return null;
  return normalized;
}

// Re-export types used by consumers
export type {
  ScenarioActionType,
  ScenarioContextOptionId,
  ScenarioNodeData,
  ScenarioReplyCtaType,
  ScenarioReplyMode,
  WhatsAppFlowConfig,
};

export { isRagScenarioContextOptionId, isScenarioContextOptionId };
