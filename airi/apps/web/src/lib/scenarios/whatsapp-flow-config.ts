import {
  isScenarioFormAnswerKey,
  normalizeWhatsAppFlowProviderReference,
  type EditableWhatsAppFlowConfig,
  type WhatsAppFlowConfig,
  type WhatsAppFlowNavigationMode,
  type WhatsAppFlowScreenAction,
} from "@icecore/scenario-contracts";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import {
  normalizeWhatsAppFlowUiLocale,
  WHATSAPP_FLOW_SUBMIT_MAX_LENGTH,
} from "@/lib/scenarios/whatsapp-flow-ui-locale";
import { htmlToPlainText, htmlToWhatsAppFormat } from "@/lib/whatsapp-format";

type FlowBranchRules = NonNullable<WhatsAppFlowConfig["flowBranchRules"]>;

export type WhatsAppFlowTextFormat = "whatsapp" | "plain_text";
export const DEFAULT_FLOW_CTA_TEXT = "Open";
export const DEFAULT_FLOW_BODY_TEXT = "Please complete this form.";
export const WHATSAPP_FLOW_SCREEN_ID_MAX_LENGTH = 50;
export const WHATSAPP_FLOW_SCREEN_ID_PATTERN = /^[A-Za-z_]+$/;
const PROVIDER_METADATA_FIELDS = [
  "managedProvisioning",
  "providerReference",
  "metaFlowId",
  "metaFlowName",
  "metaFlowStatus",
] as const;

export function toEditableWhatsAppFlowConfig(
  config: WhatsAppFlowConfig
): EditableWhatsAppFlowConfig {
  const editable: WhatsAppFlowConfig = { ...config };
  for (const field of PROVIDER_METADATA_FIELDS) delete editable[field];
  return editable as EditableWhatsAppFlowConfig;
}

export function hasWhatsAppFlowProviderMetadata(config: object): boolean {
  return PROVIDER_METADATA_FIELDS.some(field =>
    Object.prototype.hasOwnProperty.call(config, field)
  );
}

/**
 * Canonical browser-safe identity for the JSON-persisted editable contract.
 * The form's answers key is scenario data that never reaches Meta, so
 * naming it does not mark a managed Flow as changed.
 */
export function serializeWhatsAppFlowEditableContent(
  config: WhatsAppFlowConfig
): string {
  const content = toEditableWhatsAppFlowConfig(config);
  delete content.answersKey;
  const json = JSON.stringify(content);
  if (!json) throw new Error("WhatsApp Flow content is not JSON serializable");
  return serializeCanonicalJson(JSON.parse(json) as unknown);
}

const DIGIT_WORDS: Record<string, string> = {
  "0": "ZERO",
  "1": "ONE",
  "2": "TWO",
  "3": "THREE",
  "4": "FOUR",
  "5": "FIVE",
  "6": "SIX",
  "7": "SEVEN",
  "8": "EIGHT",
  "9": "NINE",
};

function alphaSequence(index: number): string {
  let value = Math.max(0, Math.floor(index));
  let out = "";
  do {
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return out;
}

function trimScreenId(value: string): string {
  return value.slice(0, WHATSAPP_FLOW_SCREEN_ID_MAX_LENGTH).replace(/_+$/g, "");
}

function normalizeScreenIdCandidate(
  rawId: unknown,
  screenIndex: number
): string {
  const fallback = `SCREEN_${alphaSequence(screenIndex)}`;
  const raw =
    typeof rawId === "string" && rawId.trim().length > 0
      ? rawId.trim()
      : fallback;
  const candidate = trimScreenId(
    raw
      .replace(/[0-9]/g, digit => `_${DIGIT_WORDS[digit] ?? ""}`)
      .replace(/[^A-Za-z_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
  );

  if (
    !candidate ||
    !WHATSAPP_FLOW_SCREEN_ID_PATTERN.test(candidate) ||
    candidate === "SUCCESS"
  ) {
    return fallback;
  }

  return candidate;
}

export function createWhatsAppFlowScreenId(
  rawId: unknown,
  screenIndex: number,
  usedIds: Set<string> = new Set()
): string {
  const base = normalizeScreenIdCandidate(rawId, screenIndex);
  let candidate = base;
  let collisionIndex = 1;

  while (usedIds.has(candidate) || candidate === "SUCCESS") {
    const suffix = `_${alphaSequence(collisionIndex)}`;
    const basePrefix =
      trimScreenId(base).slice(
        0,
        WHATSAPP_FLOW_SCREEN_ID_MAX_LENGTH - suffix.length
      ) || "SCREEN";
    candidate = `${basePrefix.replace(/_+$/g, "")}${suffix}`;
    collisionIndex += 1;
  }

  return candidate;
}

function normalizeFlowNavigationMode(
  value: unknown
): WhatsAppFlowNavigationMode | undefined {
  return value === "data_endpoint" || value === "static_graph"
    ? value
    : undefined;
}

function resolveSanitizedScreenId(
  value: string,
  screenIdMap: Map<string, string>
): string {
  const trimmed = value.trim();
  return screenIdMap.get(trimmed) ?? trimmed;
}

function sanitizeScreenRoutes(
  raw: unknown,
  validScreenIds: Set<string>,
  screenIdMap: Map<string, string>
): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string[]> = {};
  for (const [sourceKey, targets] of Object.entries(
    raw as Record<string, unknown>
  )) {
    const sourceId = resolveSanitizedScreenId(sourceKey, screenIdMap);
    if (!sourceId || !validScreenIds.has(sourceId)) continue;
    if (!Array.isArray(targets)) continue;
    const cleaned = targets
      .filter((t): t is string => typeof t === "string")
      .map(t => resolveSanitizedScreenId(t, screenIdMap))
      .filter(t => t.length > 0 && validScreenIds.has(t) && t !== sourceId);
    const unique = [...new Set(cleaned)];
    if (unique.length > 0) {
      out[sourceId] = unique;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeFlowBranchRules(
  raw: unknown,
  screenIdSet: Set<string>,
  screenIdMap: Map<string, string>
): FlowBranchRules | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: FlowBranchRules = {};
  for (const [screenId, fields] of Object.entries(
    raw as Record<string, unknown>
  )) {
    const sid = resolveSanitizedScreenId(screenId, screenIdMap);
    if (!sid || !screenIdSet.has(sid)) continue;
    if (!fields || typeof fields !== "object") continue;
    const fieldMap: Record<string, Record<string, string>> = {};
    for (const [fieldId, optMap] of Object.entries(
      fields as Record<string, unknown>
    )) {
      const fid = String(fieldId).trim();
      if (!fid) continue;
      if (!optMap || typeof optMap !== "object") continue;
      const optionsToTarget: Record<string, string> = {};
      for (const [optId, target] of Object.entries(
        optMap as Record<string, unknown>
      )) {
        const oid = String(optId).trim();
        const tid =
          typeof target === "string"
            ? resolveSanitizedScreenId(target, screenIdMap)
            : "";
        if (oid && tid && screenIdSet.has(tid)) {
          optionsToTarget[oid] = tid;
        }
      }
      if (Object.keys(optionsToTarget).length > 0) {
        fieldMap[fid] = optionsToTarget;
      }
    }
    if (Object.keys(fieldMap).length > 0) {
      out[sid] = fieldMap;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function serializeWhatsAppFlowText(
  value: string,
  format: WhatsAppFlowTextFormat = "whatsapp"
): string {
  if (typeof value !== "string") return "";
  const normalized =
    format === "plain_text"
      ? htmlToPlainText(value)
      : htmlToWhatsAppFormat(value);
  return normalized.trim();
}

function sanitizeOptionalFlowText(
  value: unknown,
  format: WhatsAppFlowTextFormat
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = serializeWhatsAppFlowText(value, format);
  return normalized.length > 0 ? normalized : undefined;
}

export function sanitizeWhatsAppFlowConfig(
  value: unknown
): WhatsAppFlowConfig | null {
  if (!value || typeof value !== "object") return null;
  const cfg = value as Partial<WhatsAppFlowConfig>;
  if (!Array.isArray(cfg.screens)) return null;

  const usedScreenIds = new Set<string>();
  const screenIdMap = new Map<string, string>();
  const screens = cfg.screens
    .filter(
      (screen): screen is NonNullable<WhatsAppFlowConfig["screens"][number]> =>
        Boolean(screen && typeof screen === "object")
    )
    .map((screen, screenIndex) => {
      const rawScreenId = typeof screen.id === "string" ? screen.id.trim() : "";
      const screenId = createWhatsAppFlowScreenId(
        rawScreenId,
        screenIndex,
        usedScreenIds
      );
      usedScreenIds.add(screenId);
      if (rawScreenId) {
        screenIdMap.set(rawScreenId, screenId);
      }

      return {
        id: screenId,
        title: sanitizeOptionalFlowText(screen.title, "plain_text") ?? "",
        ...(typeof screen.terminal === "boolean"
          ? { terminal: screen.terminal }
          : {}),
        ...(typeof screen.success === "boolean"
          ? { success: screen.success }
          : {}),
        ...(Array.isArray(screen.layoutContent)
          ? { layoutContent: screen.layoutContent.map(item => ({ ...item })) }
          : {}),
        ...(screen.data ? { data: screen.data } : {}),
        ...(screen.layoutForm
          ? { layoutForm: { name: screen.layoutForm.name.trim() } }
          : {}),
        ...(screen.footer
          ? {
              footer: {
                label:
                  sanitizeOptionalFlowText(screen.footer.label, "plain_text") ??
                  "",
                action: screen.footer.action,
              },
            }
          : {}),
        fields: Array.isArray(screen.fields)
          ? screen.fields
              .filter(
                (
                  field
                ): field is NonNullable<
                  WhatsAppFlowConfig["screens"][number]["fields"][number]
                > => Boolean(field && typeof field === "object")
              )
              .map((field, fieldIndex) => ({
                id:
                  typeof field.id === "string" && field.id.trim().length > 0
                    ? field.id.trim()
                    : `field_${screenIndex + 1}_${fieldIndex + 1}`,
                label:
                  sanitizeOptionalFlowText(field.label, "plain_text") ?? "",
                fieldType: field.fieldType,
                required: field.required === true,
                helperText: sanitizeOptionalFlowText(
                  field.helperText,
                  "plain_text"
                ),
                ...(Array.isArray(field.navigationItems)
                  ? {
                      navigationItems: field.navigationItems.map(item => ({
                        id: item.id.trim(),
                        title:
                          sanitizeOptionalFlowText(item.title, "plain_text") ??
                          "",
                        ...(item.description !== undefined
                          ? {
                              description:
                                sanitizeOptionalFlowText(
                                  item.description,
                                  "plain_text"
                                ) ?? "",
                            }
                          : {}),
                        action: item.action,
                      })),
                    }
                  : {}),
                options: Array.isArray(field.options)
                  ? field.options
                      .filter(
                        (
                          option
                        ): option is NonNullable<
                          NonNullable<typeof field.options>[number]
                        > => Boolean(option && typeof option === "object")
                      )
                      .map((option, optionIndex) => ({
                        id:
                          typeof option.id === "string" &&
                          option.id.trim().length > 0
                            ? option.id.trim()
                            : `opt_${screenIndex + 1}_${fieldIndex + 1}_${optionIndex + 1}`,
                        title:
                          sanitizeOptionalFlowText(
                            option.title,
                            "plain_text"
                          ) ?? "",
                        ...(option.description !== undefined
                          ? {
                              description:
                                sanitizeOptionalFlowText(
                                  option.description,
                                  "plain_text"
                                ) ?? "",
                            }
                          : {}),
                      }))
                  : undefined,
              }))
          : [],
      };
    });

  const rewriteAction = (
    action: WhatsAppFlowScreenAction
  ): WhatsAppFlowScreenAction =>
    action.name === "navigate"
      ? {
          ...action,
          nextScreenId: resolveSanitizedScreenId(
            action.nextScreenId,
            screenIdMap
          ),
        }
      : action;
  for (const screen of screens) {
    if (screen.footer)
      screen.footer.action = rewriteAction(screen.footer.action);
    for (const field of screen.fields) {
      for (const item of field.navigationItems ?? [])
        item.action = rewriteAction(item.action);
    }
  }

  const rawSubmit = sanitizeOptionalFlowText(cfg.flowSubmitLabel, "plain_text");
  const flowSubmitLabel =
    rawSubmit && rawSubmit.length > WHATSAPP_FLOW_SUBMIT_MAX_LENGTH
      ? rawSubmit.slice(0, WHATSAPP_FLOW_SUBMIT_MAX_LENGTH)
      : rawSubmit;

  const screenIdSet = new Set(screens.map(s => s.id));
  const flowNavigationMode = normalizeFlowNavigationMode(
    cfg.flowNavigationMode
  );
  const screenRoutes = sanitizeScreenRoutes(
    cfg.screenRoutes,
    screenIdSet,
    screenIdMap
  );
  const flowBranchRules = sanitizeFlowBranchRules(
    cfg.flowBranchRules,
    screenIdSet,
    screenIdMap
  );
  const providerReference = normalizeWhatsAppFlowProviderReference(
    cfg.providerReference
  );
  const answersKey =
    typeof cfg.answersKey === "string" &&
    isScenarioFormAnswerKey(cfg.answersKey.trim())
      ? cfg.answersKey.trim()
      : undefined;

  return {
    templateId: typeof cfg.templateId === "string" ? cfg.templateId.trim() : "",
    screens,
    ctaText:
      sanitizeOptionalFlowText(cfg.ctaText, "plain_text") ||
      DEFAULT_FLOW_CTA_TEXT,
    headerText: sanitizeOptionalFlowText(cfg.headerText, "whatsapp"),
    bodyText: sanitizeOptionalFlowText(cfg.bodyText, "whatsapp"),
    footerText: sanitizeOptionalFlowText(cfg.footerText, "whatsapp"),
    flowUiLocale: normalizeWhatsAppFlowUiLocale(cfg.flowUiLocale),
    ...(flowSubmitLabel ? { flowSubmitLabel } : {}),
    ...(flowNavigationMode ? { flowNavigationMode } : {}),
    ...(cfg.flowJsonVersion === "6.3" || cfg.flowJsonVersion === "7.3"
      ? { flowJsonVersion: cfg.flowJsonVersion }
      : {}),
    ...(screenRoutes ? { screenRoutes } : {}),
    ...(flowBranchRules ? { flowBranchRules } : {}),
    ...(providerReference ? { providerReference } : {}),
    ...(answersKey ? { answersKey } : {}),
    metaFlowId:
      typeof cfg.metaFlowId === "string" && cfg.metaFlowId.trim().length > 0
        ? cfg.metaFlowId.trim()
        : null,
    metaFlowName:
      typeof cfg.metaFlowName === "string" && cfg.metaFlowName.trim().length > 0
        ? cfg.metaFlowName.trim()
        : null,
    metaFlowStatus:
      typeof cfg.metaFlowStatus === "string" &&
      cfg.metaFlowStatus.trim().length > 0
        ? cfg.metaFlowStatus.trim()
        : null,
  };
}

/** Explicit screen rename: preserve wire payload keys and rewrite canonical screen references. */
export function renameWhatsAppFlowScreen(
  config: WhatsAppFlowConfig,
  screenIndex: number,
  rawId: string
): WhatsAppFlowConfig {
  const current = config.screens[screenIndex];
  if (!current) return config;
  const id = createWhatsAppFlowScreenId(
    rawId,
    screenIndex,
    new Set(
      config.screens
        .filter((_, index) => index !== screenIndex)
        .map(screen => screen.id)
    )
  );
  const rename = (value: string) => (value === current.id ? id : value);
  const action = (value: WhatsAppFlowScreenAction): WhatsAppFlowScreenAction =>
    value.name === "navigate"
      ? { ...value, nextScreenId: rename(value.nextScreenId) }
      : value;
  return {
    ...config,
    screens: config.screens.map((screen, index) => ({
      ...screen,
      id: index === screenIndex ? id : screen.id,
      ...(screen.footer
        ? { footer: { ...screen.footer, action: action(screen.footer.action) } }
        : {}),
      fields: screen.fields.map(field => ({
        ...field,
        ...(field.navigationItems
          ? {
              navigationItems: field.navigationItems.map(item => ({
                ...item,
                action: action(item.action),
              })),
            }
          : {}),
      })),
    })),
    ...(config.flowActionPayload?.screen
      ? {
          flowActionPayload: {
            ...config.flowActionPayload,
            screen: rename(config.flowActionPayload.screen),
          },
        }
      : {}),
    ...(config.screenRoutes
      ? {
          screenRoutes: Object.fromEntries(
            Object.entries(config.screenRoutes).map(([source, targets]) => [
              rename(source),
              targets.map(rename),
            ])
          ),
        }
      : {}),
    ...(config.flowBranchRules
      ? {
          flowBranchRules: Object.fromEntries(
            Object.entries(config.flowBranchRules).map(([screen, fields]) => [
              rename(screen),
              Object.fromEntries(
                Object.entries(fields).map(([field, options]) => [
                  field,
                  Object.fromEntries(
                    Object.entries(options).map(([option, target]) => [
                      option,
                      rename(target),
                    ])
                  ),
                ])
              ),
            ])
          ),
        }
      : {}),
  };
}
