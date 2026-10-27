import { firstValidHttpUrl } from "@/lib/airi/reply/runtime/auto-reply-template-utils";
import {
  resolveDefaultScenarioFlowReplyCta,
  resolveDefaultScenarioLinkCta,
} from "@/lib/airi/reply/runtime/scenario-localization";
import type { RAGResponseResult } from "@/lib/airi/rag/response/rag-response-service";
import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import type { Channel, ConversationDocument } from "@/types/models";
import type { MessageDocument } from "@/types/models";
import { buildScenarioFormResponseFieldMetadata } from "@/lib/scenarios/scenario-form-response-metadata";
import type { StoredWhatsAppFlowFieldMetadataPreview } from "@icecore/shared/types/message-preview";
import type { GenerativeAIInboundCandidate } from "@icecore/airi-runtime/scenario-generative-ai-input-types";
import { getCurrentConversationClassification } from "@icecore/shared/lib/conversation-classification-freshness";
import {
  formatScenarioAnswerReference,
  labelScenarioAnswerReference,
  listScenarioAnswerReferences,
  quoteGenerativeAICustomerValue,
  readCollectedPromptInputValues,
  readScenarioAnswerReferenceValue,
  readScenarioFormAnswerTemplateValues,
  readScenarioFormSubmissions,
  renderScenarioAnswerReferences,
  resolveSendableWhatsAppFlowProviderId,
  resolveWhatsAppFlowActionType,
  resolveWhatsAppFlowProviderSource,
  sliceScenarioAnswerText,
} from "@icecore/scenario-contracts";
import { normalizeDateIso } from "./context";

export function buildGenerativeAIInboundCandidate(
  message:
    | Pick<
        MessageDocument,
        | "_id"
        | "text"
        | "mediaType"
        | "whatsappMediaId"
        | "mimeType"
        | "fileName"
      >
    | null
    | undefined
): GenerativeAIInboundCandidate | null {
  if (!message) return null;
  const text =
    typeof message.text === "string" && message.text.trim()
      ? message.text.trim()
      : null;
  return {
    messageId: String(message._id || "").trim(),
    kind:
      typeof message.mediaType === "string" && message.mediaType.trim()
        ? message.mediaType.trim().toLowerCase()
        : text
          ? "text"
          : null,
    textOrCaption: text,
    whatsappMediaId:
      typeof message.whatsappMediaId === "string" &&
      message.whatsappMediaId.trim()
        ? message.whatsappMediaId.trim()
        : null,
    declaredMimeType:
      typeof message.mimeType === "string" && message.mimeType.trim()
        ? message.mimeType.trim()
        : null,
    fileName:
      typeof message.fileName === "string" && message.fileName.trim()
        ? message.fileName.trim()
        : null,
  };
}

export function buildGenerativeAIInboundCandidateForTurn(params: {
  persistedMessage:
    | Pick<
        MessageDocument,
        | "_id"
        | "text"
        | "mediaType"
        | "whatsappMediaId"
        | "mimeType"
        | "fileName"
      >
    | null
    | undefined;
  direction?: "inbound" | "outbound" | null;
  synthetic: boolean;
  proactive: boolean;
}): GenerativeAIInboundCandidate | null {
  if (params.synthetic || params.proactive || params.direction !== "inbound") {
    return null;
  }
  return buildGenerativeAIInboundCandidate(params.persistedMessage);
}

export function resolveScenarioWhatsAppCta(params: {
  channel: Channel;
  scenarioRuntime?: AiriScenarioRuntimeConfig | null;
  targetLanguage?: string | null;
}): {
  whatsappCtaLink?: { url: string; title?: string };
  whatsappFlowCta?: {
    flowId?: string;
    flowName?: string;
    managedSourceId?: string;
    managedWabaId?: string;
    flowActionType?: "data_exchange";
    flowCta?: string;
    responseFieldMetadata?: StoredWhatsAppFlowFieldMetadataPreview[] | null;
    evaluationId?: string;
    scenarioId?: string;
    scenarioName?: string;
    actionNodeId?: string;
  };
} {
  if (params.channel !== "whatsapp") return {};
  const runtime = params.scenarioRuntime;
  if (!runtime || runtime.actionType !== "reply") return {};
  if (runtime.actionWhatsAppServiceMessage) return {};

  const ctaType = (runtime.actionReplyCtaType || "").trim();
  const flowId =
    resolveSendableWhatsAppFlowProviderId({
      flowConfig: runtime.actionFlowConfig,
      legacyFlowId: runtime.actionReplyCtaFlowId,
    }) || "";
  const providerSource = resolveWhatsAppFlowProviderSource({
    flowConfig: runtime.actionFlowConfig,
  });
  const managedSourceId = providerSource?.sourceId || undefined;
  const managedWabaId = providerSource?.wabaId || undefined;
  const flowActionType = resolveWhatsAppFlowActionType(
    runtime.actionFlowConfig
  );
  const linkUrl = firstValidHttpUrl(runtime.actionLinkUrls);
  const ctaLabel = (runtime.actionReplyCtaLabel || "").trim();
  const buildFlowCta = () => ({
    whatsappFlowCta: {
      flowId,
      ...(managedSourceId ? { managedSourceId } : {}),
      ...(managedWabaId ? { managedWabaId } : {}),
      ...(flowActionType === "data_exchange" ? { flowActionType } : {}),
      flowCta:
        ctaLabel || resolveDefaultScenarioFlowReplyCta(params.targetLanguage),
      responseFieldMetadata: buildScenarioFormResponseFieldMetadata(
        runtime.actionFlowConfig
          ? { flowConfig: runtime.actionFlowConfig }
          : null
      ),
      evaluationId: runtime.evaluationId,
      scenarioId: runtime.scenarioId,
      scenarioName: runtime.scenarioName,
      actionNodeId: runtime.nextActionNodeId || undefined,
    },
  });

  if (ctaType === "none") return {};

  if (ctaType === "flow") {
    if (flowId) {
      return buildFlowCta();
    }
    if (linkUrl) {
      return {
        whatsappCtaLink: {
          url: linkUrl,
          title:
            ctaLabel || resolveDefaultScenarioLinkCta(params.targetLanguage),
        },
      };
    }
    return {};
  }

  if (ctaType === "link") {
    if (linkUrl) {
      return {
        whatsappCtaLink: {
          url: linkUrl,
          title:
            ctaLabel || resolveDefaultScenarioLinkCta(params.targetLanguage),
        },
      };
    }
    if (flowId) {
      return buildFlowCta();
    }
    return {};
  }

  if (flowId) {
    return buildFlowCta();
  }
  if (linkUrl) {
    return {
      whatsappCtaLink: {
        url: linkUrl,
        title: ctaLabel || resolveDefaultScenarioLinkCta(params.targetLanguage),
      },
    };
  }

  return {};
}

export function shouldRetryWithSiblingScenario(params: {
  scenarioRuntime: AiriScenarioRuntimeConfig | null;
  ragResult: RAGResponseResult;
}): boolean {
  if (!params.scenarioRuntime) return false;
  if (params.scenarioRuntime.lockedByConversationState) return false;
  if (params.ragResult.type === "fallback") return true;
  return params.ragResult.decision?.priority === "generic";
}

export function buildScenarioCrmContextBlock(params: {
  scenarioRuntime: AiriScenarioRuntimeConfig | null;
  conversation: ConversationDocument;
}): string {
  const scenarioRuntime = params.scenarioRuntime;
  if (!scenarioRuntime) return "";

  const includeCrmContext =
    scenarioRuntime.includeCustomerProfile ||
    scenarioRuntime.includePurchaseHistory ||
    scenarioRuntime.includeActiveSubscriptions;
  if (!includeCrmContext) return "";

  const conversationAny = params.conversation as ConversationDocument & {
    preferred_language?: string;
    classification?: { category?: string };
    internal_labels?: string[];
    churn_risk_level?: string | null;
    estimated_customer_ltv?: number | null;
    revenue_attribution_id?: string | null;
    createdAt?: Date | string | null;
    updatedAt?: Date | string | null;
    lastMessageAt?: Date | string | null;
  };

  const internalLabels = Array.isArray(conversationAny.internal_labels)
    ? conversationAny.internal_labels
        .map(label => String(label).trim())
        .filter(Boolean)
    : [];
  const stageLabel =
    internalLabels.find(label => label.toLowerCase().startsWith("stage:")) ||
    null;
  const segmentLabel =
    internalLabels.find(label => label.toLowerCase().startsWith("seg:")) ||
    null;
  const lastSeenIso =
    normalizeDateIso(conversationAny.lastMessageAt) ||
    normalizeDateIso(conversationAny.updatedAt) ||
    normalizeDateIso(conversationAny.createdAt);
  const currentClassification = getCurrentConversationClassification<{
    category?: string | null;
  }>(params.conversation);

  const sections: string[] = [];

  if (scenarioRuntime.includeCustomerProfile) {
    const profileLines = [
      `- Channel: ${String((params.conversation as { channel?: string }).channel || "unknown")}`,
      `- Preferred language: ${conversationAny.preferred_language || "unknown"}`,
      `- Classification: ${currentClassification?.category || "unknown"}`,
      `- Funnel stage label: ${stageLabel || "unknown"}`,
      `- Segment label: ${segmentLabel || "unknown"}`,
      `- Last seen: ${lastSeenIso || "unknown"}`,
    ];
    sections.push(`Customer Profile:\n${profileLines.join("\n")}`);
  }

  if (scenarioRuntime.includePurchaseHistory) {
    const ltv =
      typeof conversationAny.estimated_customer_ltv === "number"
        ? conversationAny.estimated_customer_ltv
        : null;
    const revenueAttributionId =
      typeof conversationAny.revenue_attribution_id === "string"
        ? conversationAny.revenue_attribution_id.trim()
        : "";
    const purchaseLines = [
      `- Estimated LTV: ${ltv !== null ? String(ltv) : "unknown"}`,
      `- Revenue attribution id: ${revenueAttributionId || "none"}`,
    ];
    sections.push(`Purchase History:\n${purchaseLines.join("\n")}`);
  }

  if (scenarioRuntime.includeActiveSubscriptions) {
    const subscriptionLines = [
      `- Active-stage label: ${stageLabel || "unknown"}`,
    ];
    sections.push(`Active Subscriptions:\n${subscriptionLines.join("\n")}`);
  }

  if (sections.length === 0) return "";
  return `CRM CONTEXT (trusted internal data):\n${sections.join("\n\n")}`;
}

/** The longest customer answer an AI reply reads, in characters. */
export const MAX_SCENARIO_CUSTOMER_ANSWER_CHARACTERS = 500;

const CUSTOMER_ANSWER_NOT_GIVEN = "(not answered)";
const CUSTOMER_ANSWER_NOT_GIVEN_RULE = `${CUSTOMER_ANSWER_NOT_GIVEN} means the customer has not given that answer: do not invent it; ask for it or leave it out.`;

/**
 * One line, bounded and quoted, so an answer can never pose as another:
 * brackets become parentheses, so no value can imitate a "[Form › Field]"
 * reference.
 */
function quoteScenarioCustomerAnswer(value: string): string {
  return quoteGenerativeAICustomerValue(
    sliceScenarioAnswerText(
      value.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim(),
      MAX_SCENARIO_CUSTOMER_ANSWER_CHARACTERS
    )
  );
}

/**
 * An "AI writes" instruction as the model reads it, with the customer
 * answers it names. Each answer token becomes a bracketed reference such as
 * "[Order form › Size]", and the answers go to their own prompt section,
 * one quoted line per reference, so the customer's words never become part
 * of the instruction. Only answers this scenario recorded are read; a
 * missing one reads "(not answered)". Other tokens stay as they were.
 */
export function buildScenarioInstructionAnswers(params: {
  scenarioRuntime: AiriScenarioRuntimeConfig;
  scenarioState: unknown;
}): {
  scenarioRuntime: AiriScenarioRuntimeConfig;
  customerAnswersBlock: string;
} {
  const runtime = params.scenarioRuntime;
  const instruction = runtime.actionReplyInstruction ?? "";
  const references = listScenarioAnswerReferences(instruction);
  if (references.length === 0) {
    return { scenarioRuntime: runtime, customerAnswersBlock: "" };
  }
  const promptInputs = readCollectedPromptInputValues(
    params.scenarioState,
    runtime.scenarioId
  );
  const formAnswers = readScenarioFormAnswerTemplateValues(
    readScenarioFormSubmissions(params.scenarioState, runtime.scenarioId),
    runtime.formAnswerFields
  );
  // Two answers never share a reference, even when their names match.
  const labels = new Map<string, string>();
  const taken = new Set<string>();
  for (const reference of references) {
    const name = labelScenarioAnswerReference(
      reference,
      runtime.formAnswerFields
    );
    let label = name;
    for (
      let copy = 2;
      taken.has(formatScenarioAnswerReference(label));
      copy += 1
    ) {
      label = `${name} ${copy}`;
    }
    taken.add(formatScenarioAnswerReference(label));
    labels.set(reference.token, label);
  }
  let missing = false;
  const lines = references.map(reference => {
    const value = readScenarioAnswerReferenceValue(reference, {
      promptInputs,
      formAnswers,
    });
    missing ||= !value;
    const answer = value
      ? quoteScenarioCustomerAnswer(value)
      : CUSTOMER_ANSWER_NOT_GIVEN;
    return `${formatScenarioAnswerReference(labels.get(reference.token) ?? "")}: ${answer}`;
  });
  return {
    scenarioRuntime: {
      ...runtime,
      actionReplyInstruction: renderScenarioAnswerReferences(
        instruction,
        reference => labels.get(reference.token) ?? ""
      ),
    },
    customerAnswersBlock: [
      ...(missing ? [CUSTOMER_ANSWER_NOT_GIVEN_RULE] : []),
      ...lines,
    ].join("\n"),
  };
}
