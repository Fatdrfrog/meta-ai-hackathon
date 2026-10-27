import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";
import connectDB from "@/lib/mongoose";
import {
  createWhatsAppTemplateQuickReplyPayloadFactory,
  getScenarioWhatsAppTemplateFallbackContextKey,
  getScenarioWhatsAppTemplateParameterId,
  resolveScenarioWhatsAppTemplateBindings,
  type ScenarioWhatsAppTemplateBindings,
  type ScenarioWhatsAppTemplateButtonIds,
} from "@icecore/scenario-contracts";
import { isWhatsAppCdnUrl } from "@/lib/whatsapp/templates/header-media-utils";
import {
  buildWhatsAppTemplateSendComponentsFromTemplate,
  type WhatsAppTemplateSendComponentInput,
} from "@/lib/whatsapp/templates/message-types";
import { WhatsAppTemplateModel } from "@/models/whatsapp-template";
import type {
  ChatDocument,
  ConversationDocument,
  MessageDocument,
} from "@/types/models";
import {
  buildWhatsAppReferralTemplateAliases,
  pickWhatsAppReferralFields,
} from "@icecore/whatsapp/referralFields";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
type ScenarioTemplateSendComponent = WhatsAppTemplateSendComponentInput;

type WhatsAppInfo = {
  contactData: {
    waId?: string;
    userId?: string;
    parentUserId?: string;
    profile?: { name?: string; username?: string };
  };
};

type TemplateLanguageCandidate = {
  language: string;
  components?: WhatsAppComponent[];
};

export type ScenarioTemplateLanguageFallbackTier =
  | "customer_exact"
  | "customer_prefix"
  | "workspace_default"
  | "node_configured"
  | "node_configured_unresolved";

export type ScenarioTemplateLanguageResolution = {
  requestedLanguage: string;
  resolvedLanguage: string;
  fallbackTier: ScenarioTemplateLanguageFallbackTier;
  templateComponents?: WhatsAppComponent[];
  matchedVariant: boolean;
  availableLanguages: string[];
};

function normalizeLocaleCode(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/-/g, "_").toLowerCase();
  if (!normalized) return "";

  // Meta uses `kk` for Kazakh template locales while the app commonly stores
  // `kz` for user/workspace language preferences.
  if (normalized === "kz" || normalized === "kz_kz" || normalized === "kk_kz") {
    return "kk";
  }

  return normalized;
}

function localeBase(value: string): string {
  const normalized = normalizeLocaleCode(value);
  if (!normalized) return "";
  const [base] = normalized.split("_");
  return base || "";
}

function hasWhatsAppCdnMediaHandle(header: {
  format?: string;
  example?: { header_handle?: string[] };
}): boolean {
  if (!["IMAGE", "VIDEO", "DOCUMENT"].includes(header.format || "")) {
    return false;
  }
  const handles = header.example?.header_handle;
  return (
    Array.isArray(handles) &&
    handles.some(
      handle => typeof handle === "string" && isWhatsAppCdnUrl(handle)
    )
  );
}

/**
 * A cached template whose header, or any carousel card's header, still points
 * at Meta's CDN must be re-read live: those links expire.
 */
export function hasWhatsAppCdnHeaderMediaHandle(
  components?: WhatsAppComponent[]
): boolean {
  if (!Array.isArray(components)) return false;

  return components.some(component => {
    if (component.type === "HEADER") {
      return hasWhatsAppCdnMediaHandle(component);
    }
    if (component.type === "CAROUSEL" && Array.isArray(component.cards)) {
      return component.cards.some(card =>
        card.components?.some(
          cardComponent =>
            cardComponent.type === "HEADER" &&
            hasWhatsAppCdnMediaHandle(cardComponent)
        )
      );
    }
    return false;
  });
}

function findExactLanguageCandidate(
  candidates: TemplateLanguageCandidate[],
  targetLanguage: string
): TemplateLanguageCandidate | null {
  const normalizedTarget = normalizeLocaleCode(targetLanguage);
  if (!normalizedTarget) return null;
  return (
    candidates.find(
      candidate => normalizeLocaleCode(candidate.language) === normalizedTarget
    ) || null
  );
}

function findPrefixLanguageCandidate(
  candidates: TemplateLanguageCandidate[],
  targetLanguage: string
): TemplateLanguageCandidate | null {
  const normalizedTarget = normalizeLocaleCode(targetLanguage);
  const targetBase = localeBase(normalizedTarget);
  if (!targetBase) return null;
  const baseMatches = candidates.filter(
    candidate => localeBase(candidate.language) === targetBase
  );
  if (baseMatches.length === 0) return null;

  return (
    baseMatches.find(
      candidate => normalizeLocaleCode(candidate.language) === targetBase
    ) || baseMatches[0]
  );
}

export function resolveScenarioTemplateLanguageFromCandidates(params: {
  requestedLanguage?: string | null;
  workspaceDefaultLanguage?: string | null;
  nodeConfiguredLanguage?: string | null;
  nodeTemplateComponents?: WhatsAppComponent[];
  candidates: TemplateLanguageCandidate[];
}): ScenarioTemplateLanguageResolution {
  const requestedLanguage = normalizeLocaleCode(params.requestedLanguage);
  const workspaceDefaultLanguage = normalizeLocaleCode(
    params.workspaceDefaultLanguage
  );
  const nodeConfiguredLanguage = normalizeLocaleCode(
    params.nodeConfiguredLanguage
  );

  const normalizedCandidates = params.candidates
    .flatMap(candidate => {
      const normalizedLanguage = normalizeLocaleCode(candidate.language);
      if (!normalizedLanguage) return [];
      return [
        {
          language: normalizedLanguage,
          components: candidate.components,
        },
      ];
    })
    .sort((left, right) => left.language.localeCompare(right.language));

  const availableLanguages = normalizedCandidates.map(
    candidate => candidate.language
  );

  const exactCustomer = findExactLanguageCandidate(
    normalizedCandidates,
    requestedLanguage
  );
  if (exactCustomer) {
    return {
      requestedLanguage: requestedLanguage || "en",
      resolvedLanguage: exactCustomer.language,
      fallbackTier: "customer_exact",
      templateComponents: exactCustomer.components,
      matchedVariant: true,
      availableLanguages,
    };
  }

  const prefixCustomer = findPrefixLanguageCandidate(
    normalizedCandidates,
    requestedLanguage
  );
  if (prefixCustomer) {
    return {
      requestedLanguage: requestedLanguage || "en",
      resolvedLanguage: prefixCustomer.language,
      fallbackTier: "customer_prefix",
      templateComponents: prefixCustomer.components,
      matchedVariant: true,
      availableLanguages,
    };
  }

  const workspaceDefaultMatch =
    findExactLanguageCandidate(
      normalizedCandidates,
      workspaceDefaultLanguage
    ) ||
    findPrefixLanguageCandidate(normalizedCandidates, workspaceDefaultLanguage);
  if (workspaceDefaultMatch) {
    return {
      requestedLanguage: requestedLanguage || "en",
      resolvedLanguage: workspaceDefaultMatch.language,
      fallbackTier: "workspace_default",
      templateComponents: workspaceDefaultMatch.components,
      matchedVariant: true,
      availableLanguages,
    };
  }

  const nodeConfiguredMatch =
    findExactLanguageCandidate(normalizedCandidates, nodeConfiguredLanguage) ||
    findPrefixLanguageCandidate(normalizedCandidates, nodeConfiguredLanguage);
  if (nodeConfiguredMatch) {
    return {
      requestedLanguage: requestedLanguage || "en",
      resolvedLanguage: nodeConfiguredMatch.language,
      fallbackTier: "node_configured",
      templateComponents: nodeConfiguredMatch.components,
      matchedVariant: true,
      availableLanguages,
    };
  }

  return {
    requestedLanguage: requestedLanguage || "en",
    resolvedLanguage:
      nodeConfiguredLanguage ||
      workspaceDefaultLanguage ||
      requestedLanguage ||
      "en",
    fallbackTier: "node_configured_unresolved",
    templateComponents: params.nodeTemplateComponents,
    matchedVariant: false,
    availableLanguages,
  };
}

export async function resolveScenarioTemplateLanguage(params: {
  workspaceId: string;
  sourceId?: string;
  templateName: string;
  requestedLanguage?: string | null;
  workspaceDefaultLanguage?: string | null;
  nodeConfiguredLanguage?: string | null;
  nodeTemplateComponents?: WhatsAppComponent[];
}): Promise<ScenarioTemplateLanguageResolution> {
  const workspaceId = String(params.workspaceId || "").trim();
  const templateName = String(params.templateName || "").trim();
  if (!workspaceId || !templateName) {
    return resolveScenarioTemplateLanguageFromCandidates({
      requestedLanguage: params.requestedLanguage,
      workspaceDefaultLanguage: params.workspaceDefaultLanguage,
      nodeConfiguredLanguage: params.nodeConfiguredLanguage,
      nodeTemplateComponents: params.nodeTemplateComponents,
      candidates: [],
    });
  }

  try {
    await connectDB();
    const templateVariants = await WhatsAppTemplateModel.find({
      workspaceId,
      name: templateName,
      status: "APPROVED",
    })
      .select("language components")
      .sort({ language: 1 })
      .lean<Array<{ language?: string; components?: WhatsAppComponent[] }>>();

    const cachedCandidates = (templateVariants || [])
      .filter(variant => typeof variant?.language === "string")
      .map(variant => ({
        language: String(variant.language),
        components: Array.isArray(variant.components)
          ? (variant.components as WhatsAppComponent[])
          : undefined,
      }));

    const cachedResolution = resolveScenarioTemplateLanguageFromCandidates({
      requestedLanguage: params.requestedLanguage,
      workspaceDefaultLanguage: params.workspaceDefaultLanguage,
      nodeConfiguredLanguage: params.nodeConfiguredLanguage,
      nodeTemplateComponents: params.nodeTemplateComponents,
      candidates: cachedCandidates,
    });

    if (
      cachedResolution.matchedVariant &&
      !hasWhatsAppCdnHeaderMediaHandle(cachedResolution.templateComponents)
    ) {
      return cachedResolution;
    }

    try {
      const [{ listApprovedWhatsAppTemplatesForSend }, { supabaseAdmin }] =
        await Promise.all([
          import("@/lib/whatsapp/templates/send-lookup"),
          import("@/lib/supabase/admin"),
        ]);
      // The catalog owns its request deadline, source authorization and shared
      // read coordination. A shorter Promise.race here used to silently select
      // an expired snapshot while the healthy catalog request was still running.
      // This remains language selection; required media refresh runs at delivery.
      const liveTemplates = await listApprovedWhatsAppTemplatesForSend(
        workspaceId,
        {
          supabase: supabaseAdmin,
          ...(params.sourceId ? { sourceId: params.sourceId } : {}),
        }
      );
      const liveCandidates = liveTemplates
        .filter(
          template =>
            template?.name === templateName &&
            typeof template.language === "string"
        )
        .map(template => ({
          language: template.language,
          components: Array.isArray(template.components)
            ? (template.components as WhatsAppComponent[])
            : undefined,
        }));

      if (liveCandidates.length === 0) {
        return cachedResolution;
      }

      return resolveScenarioTemplateLanguageFromCandidates({
        requestedLanguage: params.requestedLanguage,
        workspaceDefaultLanguage: params.workspaceDefaultLanguage,
        nodeConfiguredLanguage: params.nodeConfiguredLanguage,
        nodeTemplateComponents: params.nodeTemplateComponents,
        candidates: liveCandidates,
      });
    } catch (liveError) {
      airiOrchestrationLogger.warn("airi.orchestration.scenario", {
        workspaceId,
        note: "refresh_whatsapp_template_variants_failed",
        templateName,
        errorMessage:
          liveError instanceof Error ? liveError.message : String(liveError),
      });
      return cachedResolution;
    }
  } catch (error) {
    airiOrchestrationLogger.warn("airi.orchestration.scenario", {
      workspaceId,
      note: "resolve_localized_whatsapp_template_variant_failed",
      templateName,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return resolveScenarioTemplateLanguageFromCandidates({
      requestedLanguage: params.requestedLanguage,
      workspaceDefaultLanguage: params.workspaceDefaultLanguage,
      nodeConfiguredLanguage: params.nodeConfiguredLanguage,
      nodeTemplateComponents: params.nodeTemplateComponents,
      candidates: [],
    });
  }
}

function pickFirstNameFromDisplayName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const cleaned = trimmed.replace(/^customer\s+/i, "").trim();
  if (!cleaned) return "";
  const [first] = cleaned.split(/\s+/).filter(Boolean);
  return first || "";
}

export function firstValidHttpUrl(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {
      // Ignore invalid URL.
    }
  }
  return undefined;
}

export function buildScenarioTemplateValueMap(params: {
  conversation: ConversationDocument;
  chatDocument: ChatDocument;
  whatsAppInfo?: WhatsAppInfo;
  triggerMessage?: MessageDocument | null;
  actionLinkUrls?: string[];
  actionReplyText?: string | null;
}): Record<string, string> {
  const chatAny = params.chatDocument as ChatDocument & {
    first_name?: string;
    last_name?: string;
    username?: string;
    title?: string;
  };
  const conversationAny = params.conversation as ConversationDocument & {
    chat?: unknown;
    preferred_language?: string;
  };
  const waId = params.whatsAppInfo?.contactData?.waId || "";
  const waUserId = params.whatsAppInfo?.contactData?.userId || "";
  const waParentUserId = params.whatsAppInfo?.contactData?.parentUserId || "";
  const chatFirstName =
    typeof chatAny.first_name === "string" ? chatAny.first_name.trim() : "";
  const chatLastName =
    typeof chatAny.last_name === "string" ? chatAny.last_name.trim() : "";
  const chatUsername =
    typeof chatAny.username === "string" ? chatAny.username.trim() : "";
  const waProfileName =
    params.whatsAppInfo?.contactData?.profile?.name?.trim() || "";
  const composedName = [chatFirstName, chatLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const customerName =
    waProfileName || composedName || chatFirstName || chatUsername;
  const derivedFirstName =
    chatFirstName || pickFirstNameFromDisplayName(customerName);
  const conversationId = String(params.conversation._id || "");
  const chatId =
    typeof conversationAny.chat === "string" ||
    typeof conversationAny.chat === "number"
      ? String(conversationAny.chat)
      : conversationAny.chat &&
          typeof conversationAny.chat === "object" &&
          "_id" in conversationAny.chat &&
          (conversationAny.chat as { _id?: unknown })._id !== undefined
        ? String((conversationAny.chat as { _id?: unknown })._id)
        : "";
  const link = firstValidHttpUrl(params.actionLinkUrls) || "";
  const actionReplyText = (params.actionReplyText || "").trim();
  const whatsappReferral = pickWhatsAppReferralFields({
    triggerMessage: params.triggerMessage,
    conversation: params.conversation,
  });

  const map: Record<string, string> = {
    first_name: chatFirstName,
    last_name: chatLastName,
    username: chatUsername,
    title: typeof chatAny.title === "string" ? chatAny.title.trim() : "",
    full_name: customerName,
    name: customerName,
    customer_name: customerName,
    wa_id: waId,
    phone: waId,
    whatsapp_user_id: waUserId,
    whatsapp_parent_user_id: waParentUserId,
    whatsapp_id: waId || waUserId || waParentUserId,
    chat_id: chatId,
    conversation_id: conversationId,
    channel: String(
      (params.conversation as { channel?: string }).channel || ""
    ),
    preferred_language:
      typeof conversationAny.preferred_language === "string"
        ? conversationAny.preferred_language
        : "",
    link,
    link1: link,
    reply: actionReplyText,
    reply_text: actionReplyText,
    text: actionReplyText,
    message: actionReplyText,
    ...buildWhatsAppReferralTemplateAliases(whatsappReferral),
  };

  if (derivedFirstName) {
    map.first_name = derivedFirstName;
  }

  return map;
}

/**
 * Placeholder used when a template variable cannot be resolved to a real value.
 * WhatsApp Cloud API error #131009 rejects empty parameter values, so we must
 * always provide a non-empty string.
 */
const TEMPLATE_PARAM_FALLBACK = "-";

function createScenarioTemplateFlowToken(): string {
  return `flow_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTemplateFlowId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value)).trim();
  }
  return "";
}

function collectTemplateFlowButtonIds(
  templateComponents?: WhatsAppComponent[]
): string[] {
  if (!Array.isArray(templateComponents)) return [];

  const flowIds: string[] = [];
  for (const component of templateComponents) {
    if (component.type !== "BUTTONS") continue;
    for (const button of component.buttons || []) {
      if (button.type !== "FLOW") continue;
      const flowId = normalizeTemplateFlowId(button.flow_id);
      if (flowId) {
        flowIds.push(flowId);
      }
    }
  }

  return flowIds;
}

function collectTemplateFlowButtonNames(
  templateComponents?: WhatsAppComponent[]
): string[] {
  if (!Array.isArray(templateComponents)) return [];

  const flowNames: string[] = [];
  for (const component of templateComponents) {
    if (component.type !== "BUTTONS") continue;
    for (const button of component.buttons || []) {
      if (button.type !== "FLOW") continue;
      const flowName = normalizeTemplateFlowId(button.flow_name);
      if (flowName) {
        flowNames.push(flowName);
      }
    }
  }

  return flowNames;
}

export function assertScenarioTemplateFlowComponents(params: {
  templateName: string;
  templateComponents?: WhatsAppComponent[];
  linkedFlowId?: string | null;
  linkedFlowName?: string | null;
}): void {
  const linkedFlowId = normalizeTemplateFlowId(params.linkedFlowId);
  const linkedFlowName = normalizeTemplateFlowId(params.linkedFlowName);
  if (!linkedFlowId && !linkedFlowName) return;

  const flowIds = collectTemplateFlowButtonIds(params.templateComponents);
  const flowNames = collectTemplateFlowButtonNames(params.templateComponents);
  if (linkedFlowId && flowIds.includes(linkedFlowId)) return;
  if (linkedFlowName && flowNames.includes(linkedFlowName)) return;

  const templateName = params.templateName.trim() || "selected template";
  const found = [...flowIds, ...flowNames];
  const actual = found.length > 0 ? ` Found: ${found.join(", ")}.` : "";
  const expected = linkedFlowId || linkedFlowName;
  throw new Error(
    `WhatsApp template "${templateName}" does not contain FLOW button for scenario Flow "${expected}".${actual}`
  );
}

function resolveScenarioTemplateVariableValue(
  key: string,
  values: Record<string, string>
): string {
  const normalized = key.trim();
  if (!normalized) return TEMPLATE_PARAM_FALLBACK;
  const lower = normalized.toLowerCase();
  const direct = values[lower];
  if (direct) return direct;

  switch (getScenarioWhatsAppTemplateFallbackContextKey(lower)) {
    case "customer_name":
      return values.full_name || values.name || TEMPLATE_PARAM_FALLBACK;
    case "phone":
      return values.phone || values.wa_id || TEMPLATE_PARAM_FALLBACK;
    case "conversation_id":
      return values.conversation_id || TEMPLATE_PARAM_FALLBACK;
    case "chat_id":
      return values.chat_id || TEMPLATE_PARAM_FALLBACK;
    case "link":
      return values.link || TEMPLATE_PARAM_FALLBACK;
  }
}

function resolveScenarioTemplateDirectValue(
  key: string,
  values: Record<string, string>
): string | null {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return null;

  const candidates = [
    normalized,
    normalized.replace(/[\s-]+/g, "_"),
    normalized.replace(/[\s_-]+/g, ""),
  ];

  for (const candidate of candidates) {
    const direct = values[candidate];
    if (typeof direct === "string" && direct.trim()) {
      return direct;
    }
  }

  return null;
}

/**
 * `templateComponents` is what is sent: the step's saved copy, a language
 * variant or the live template. Tap payloads name the step's buttons, matched
 * from `nodeTemplateComponents` (the step's saved copy) and its button ids.
 */
export function buildScenarioTemplateComponents(params: {
  templateComponents?: WhatsAppComponent[];
  values: Record<string, string>;
  bindings?: ScenarioWhatsAppTemplateBindings;
  promptInputs?: Record<string, string>;
  flowToken?: string;
  flowActionData?: Record<string, unknown>;
  actionNodeId?: string | null;
  nodeTemplateComponents?: WhatsAppComponent[];
  templateButtonIds?: ScenarioWhatsAppTemplateButtonIds;
}): ScenarioTemplateSendComponent[] | undefined {
  const templateComponents = params.templateComponents;
  const boundValues =
    params.bindings === undefined
      ? undefined
      : resolveScenarioWhatsAppTemplateBindings({
          components: templateComponents,
          bindings: params.bindings,
          values: params.values,
          promptInputs: params.promptInputs,
        });
  if (boundValues?.issues.length) {
    throw new Error(
      `SCENARIO_TEMPLATE_BINDING_INVALID: ${boundValues.issues
        .map(
          issue =>
            `${issue.code}${issue.parameterId ? ` (${issue.parameterId})` : ""}`
        )
        .join(", ")}`
    );
  }
  if (!Array.isArray(templateComponents) || templateComponents.length === 0) {
    return undefined;
  }

  const bodyReplyText =
    params.values.reply ||
    params.values.reply_text ||
    params.values.text ||
    params.values.message ||
    "";
  const result = buildWhatsAppTemplateSendComponentsFromTemplate({
    templateComponents,
    values: params.values,
    fallbackText: TEMPLATE_PARAM_FALLBACK,
    createFlowToken: () =>
      typeof params.flowToken === "string" && params.flowToken.trim()
        ? params.flowToken.trim()
        : createScenarioTemplateFlowToken(),
    createFlowActionData: () =>
      params.flowActionData && Object.keys(params.flowActionData).length > 0
        ? params.flowActionData
        : undefined,
    createQuickReplyPayload: createWhatsAppTemplateQuickReplyPayloadFactory({
      actionNodeId: params.actionNodeId,
      sentComponents: templateComponents,
      stepComponents: params.nodeTemplateComponents,
      stepButtonIds: params.templateButtonIds,
    }),
    resolveVariableValue: ({
      component,
      variable,
      variables,
      buttonIndex,
      cardIndex,
    }) => {
      if (boundValues) {
        const parameterId = getScenarioWhatsAppTemplateParameterId({
          component:
            component.type === "HEADER"
              ? "header"
              : component.type === "BODY"
                ? "body"
                : "button",
          variable,
          buttonIndex,
          cardIndex,
        });
        const value = Object.hasOwn(boundValues.values, parameterId)
          ? boundValues.values[parameterId]
          : undefined;
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(
            `SCENARIO_TEMPLATE_BINDING_INVALID: unresolved (${parameterId})`
          );
        }
        return value;
      }
      const direct = resolveScenarioTemplateDirectValue(
        variable,
        params.values
      );
      if (direct) return direct;

      if (component.type === "BODY" && bodyReplyText.trim()) {
        const unresolvedVariables = variables.filter(
          candidate =>
            !resolveScenarioTemplateDirectValue(candidate, params.values)
        );
        if (
          unresolvedVariables.length === 1 &&
          unresolvedVariables[0] === variable
        ) {
          return bodyReplyText;
        }
      }

      return resolveScenarioTemplateVariableValue(variable, params.values);
    },
  });

  const missingHeaderMedia = result.issues.find(
    issue => issue.type === "missing_header_media"
  );
  if (missingHeaderMedia) {
    throw new Error(
      `WhatsApp template requires ${missingHeaderMedia.format.toLowerCase()} header media. Use an approved template with a reusable media URL or provide header media before sending.`
    );
  }

  return result.components;
}
