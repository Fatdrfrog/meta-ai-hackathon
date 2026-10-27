import type {
  ScenarioActionType,
  ScenarioNodeData,
} from "@/components/scenarios/types";
import {
  projectScenarioWhatsAppServiceMessagePresentation,
  resolveScenarioWhatsAppServiceMessage,
} from "@/lib/scenarios/whatsapp-service-message";
import {
  resolveReplyModeFromNodeData,
  resolveScenarioActionTypeFromNodeData,
} from "@icecore/airi-runtime/scenario-action-semantics";
import {
  getScenarioLogicType,
  parseScenarioPromptInputToken,
  SCENARIO_TEMPLATE_VARIABLE_PATTERN,
  type ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import { readTrimmedString as clean } from "@icecore/shared/lib/value-utils";
import {
  WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS,
  WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS,
} from "./builders/whatsapp/service-message/service-message-labels";
import type { ScenarioActionNodeEnrichment } from "./view/node-enrichment/types";
import { buildScenarioFormAnswerTokenLabels } from "./view/scenario-form-answer-labels";
import { resolveScenarioTokenLabel } from "./view/scenario-template-utils";

const DESTINATION_TOKEN_PATTERN = /\{\{[^}]+\}\}|\*\{\([^)]*\)?\}?/g;
const READABLE_TEXT_PATTERN = /[\p{L}\p{N}]/u;

type Translate = (key: string) => string;

type LabeledActionNodeData = ScenarioNodeData &
  Partial<
    Pick<
      ScenarioActionNodeEnrichment,
      | "actionPreviewText"
      | "uiScenarioPromptInputs"
      | "uiScenarioFormAnswerSources"
    >
  >;

/**
 * What a step's card shows under its title. `blocking_empty` means the step
 * sends nothing until it is filled in; `info_empty` is a valid empty state.
 */
export type ScenarioActionPreviewState =
  | "content"
  | "blocking_empty"
  | "info_empty";

export type ScenarioActionPreview = {
  text: string;
  state: ScenarioActionPreviewState;
};

function contentPreview(text: string): ScenarioActionPreview {
  return { text, state: "content" };
}

function hasReadableText(text: string): boolean {
  return READABLE_TEXT_PATTERN.test(text);
}

/** The first line of a label with variables shown as "…". */
export function sanitizeScenarioDestinationLabel(text: string): string {
  return (
    text
      .replace(DESTINATION_TOKEN_PATTERN, "…")
      .split("\n")[0]
      ?.replace(/\s+/g, " ")
      .replace(/\s+([,.!?;:])/g, "$1")
      .trim() ?? ""
  );
}

/**
 * Shows `{{token}}` variables as readable names in brackets: a form answer
 * as "Size · Order details", a collected detail by its label.
 */
function formatPreviewVariables(
  text: string,
  nodeData: LabeledActionNodeData,
  t: Translate
): string {
  const formAnswerLabels = buildScenarioFormAnswerTokenLabels(
    nodeData.uiScenarioFormAnswerSources
  );
  return text.replace(
    new RegExp(SCENARIO_TEMPLATE_VARIABLE_PATTERN.source, "g"),
    (_match, token: string) => {
      const inputKey = parseScenarioPromptInputToken(token);
      const inputLabel = inputKey
        ? clean(
            nodeData.uiScenarioPromptInputs?.find(
              field => field.key === inputKey
            )?.label
          )
        : "";
      return `[${formAnswerLabels.get(token) || inputLabel || resolveScenarioTokenLabel(token, t)}]`;
    }
  );
}

/** "AI writes the reply", followed by the instructions when there are any. */
export function resolveAiReplyPreviewText({
  instruction,
  nodeData,
  t,
}: {
  instruction: string | undefined;
  nodeData: LabeledActionNodeData;
  t: Translate;
}): string {
  const label = t("actionPreviewAiReply");
  const text = clean(instruction);
  return text
    ? `${label} · ${formatPreviewVariables(text, nodeData, t)}`
    : label;
}

function resolveServiceMessageEmptyPreview(
  message: ScenarioWhatsAppServiceMessagePayload,
  nodeData: LabeledActionNodeData,
  t: Translate
): ScenarioActionPreview {
  switch (message.kind) {
    case "text":
    case "reply_buttons":
    case "list":
    case "cta_url":
      return { text: t("actionPreviewEmpty"), state: "blocking_empty" };
    case "media": {
      const mediaType = message.attachment.mediaType;
      return contentPreview(
        t(
          mediaType in WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS
            ? WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS[
                mediaType as keyof typeof WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS
              ]
            : WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.media
        )
      );
    }
    case "media_carousel":
      return contentPreview(
        clean(message.cards[0]?.bodyText) ||
          t(WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.media_carousel)
      );
    case "flow":
      return contentPreview(
        clean(message.flowConfig?.metaFlowName) || t("untitledForm")
      );
    case "commerce":
      return contentPreview(
        clean(
          "bodyText" in message.commerce ? message.commerce.bodyText : ""
        ) || t(WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.commerce)
      );
    case "contacts":
    case "location":
      return contentPreview(
        projectScenarioWhatsAppServiceMessagePresentation(nodeData)
          ?.previewText ||
          t(WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS[message.kind])
      );
    case "appointment":
    case "location_request":
    case "request_contact_info":
    case "voice_call":
      return contentPreview(
        t(WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS[message.kind])
      );
  }
}

/**
 * A WhatsApp chat message's preview. Media shows its type and a form its
 * name, never a file name, a storage path or the provider's form ID.
 */
function resolveServiceMessagePreview(
  nodeData: LabeledActionNodeData,
  t: Translate
): ScenarioActionPreview | null {
  const resolution = resolveScenarioWhatsAppServiceMessage(nodeData);
  if (resolution.status !== "canonical") return null;
  const message = resolution.value.message;
  const body = "body" in message ? message.body : undefined;
  if (body?.mode === "ai") {
    return contentPreview(
      resolveAiReplyPreviewText({ instruction: body.instruction, nodeData, t })
    );
  }
  const bodyText = body?.mode === "fixed" ? clean(body.text) : "";
  if (bodyText) return contentPreview(bodyText);
  return resolveServiceMessageEmptyPreview(message, nodeData, t);
}

/** What an action sends, or why it has nothing to show yet. */
export function resolveActionPreview({
  nodeData,
  t,
}: {
  nodeData: LabeledActionNodeData;
  t: Translate;
}): ScenarioActionPreview {
  const actionType = resolveScenarioActionTypeFromNodeData(nodeData) ?? "reply";
  const enrichedText = clean(nodeData.actionPreviewText);
  switch (actionType) {
    case "end_scenario":
      return contentPreview(t("actionTypeEndScenario"));
    case "generative_ai": {
      const prompt = clean(nodeData.actionGenerativeAIConfig?.prompt);
      return prompt
        ? contentPreview(formatPreviewVariables(prompt, nodeData, t))
        : {
            text: t("generativeAIPromptEmptyPreview"),
            state: "blocking_empty",
          };
    }
    case "assign_human": {
      const message = enrichedText || clean(nodeData.actionInstruction);
      return message
        ? contentPreview(message)
        : { text: t("handoffPreviewEmpty"), state: "info_empty" };
    }
    case "whatsapp_template": {
      const text =
        enrichedText ||
        clean(
          nodeData.actionWhatsAppTemplateComponents?.find(
            component => component.type === "BODY"
          )?.text
        ) ||
        clean(nodeData.actionWhatsAppTemplateName) ||
        clean(nodeData.generatedTemplateDraft?.name);
      return text
        ? contentPreview(text)
        : { text: t("templatePreviewEmpty"), state: "blocking_empty" };
    }
    default:
      break;
  }

  const servicePreview = resolveServiceMessagePreview(nodeData, t);
  if (servicePreview) return servicePreview;
  if (nodeData.actionWhatsAppServiceMessage !== undefined) {
    // An unreadable chat message: nothing it holds can be shown safely.
    return { text: t("actionPreviewEmpty"), state: "blocking_empty" };
  }
  if (resolveReplyModeFromNodeData(nodeData) === "ai") {
    return contentPreview(
      enrichedText ||
        resolveAiReplyPreviewText({
          instruction: nodeData.actionReplyInstruction,
          nodeData,
          t,
        })
    );
  }
  const text =
    enrichedText ||
    clean(nodeData.actionReplyText) ||
    clean(nodeData.actionReplyTemplate) ||
    clean(nodeData.actionSnippetAnswer) ||
    clean(nodeData.actionFlowConfig?.ctaText);
  return text
    ? contentPreview(text)
    : { text: t("actionPreviewEmpty"), state: "blocking_empty" };
}

export function resolveCompactActionTitle({
  actionLabel,
  actionType,
  nodeData,
}: {
  actionLabel: string;
  actionType: ScenarioActionType;
  nodeData: ScenarioNodeData;
}) {
  if (actionType === "generative_ai" || actionType === "end_scenario") {
    return actionLabel;
  }
  const resolution = resolveScenarioWhatsAppServiceMessage(nodeData);
  if (resolution.status === "canonical") {
    const message = resolution.value.message;
    // A form is named by its name, never by the provider's form ID.
    if (message.kind === "flow") {
      return clean(message.flowConfig?.metaFlowName) || actionLabel;
    }
    return (
      projectScenarioWhatsAppServiceMessagePresentation(nodeData)?.title ||
      actionLabel
    );
  }
  if (nodeData.actionWhatsAppServiceMessage !== undefined) return actionLabel;

  if (actionType === "whatsapp_template") {
    return (
      clean(nodeData.actionWhatsAppTemplateName) ||
      clean(nodeData.generatedTemplateDraft?.name) ||
      actionLabel
    );
  }

  return actionLabel;
}

/** Names an action whose title and preview say nothing readable. */
const ACTION_DESTINATION_FALLBACK_KEYS: Partial<
  Record<ScenarioActionType, string>
> = {
  assign_human: "presetActionAssignHuman",
  generative_ai: "presetActionGenerativeAI",
  whatsapp_template: "whatsappActionKindTemplate",
};

function resolveActionDestinationLabel(
  nodeData: LabeledActionNodeData,
  t: Translate
): string {
  const actionType = resolveScenarioActionTypeFromNodeData(nodeData) ?? "reply";
  if (actionType === "end_scenario") return t("actionTypeEndScenario");

  const title = sanitizeScenarioDestinationLabel(
    resolveCompactActionTitle({ actionLabel: "", actionType, nodeData })
  );
  if (hasReadableText(title)) return title;

  // Empty-state copy never names a step.
  const preview = resolveActionPreview({ nodeData, t });
  if (preview.state === "content") {
    const text = sanitizeScenarioDestinationLabel(preview.text);
    if (hasReadableText(text)) return text;
  }

  return t(ACTION_DESTINATION_FALLBACK_KEYS[actionType] ?? "presetActionReply");
}

/** The name a route shows for the step it leads to. */
export function resolveScenarioDestinationLabel({
  nodeData,
  t,
}: {
  nodeData: LabeledActionNodeData;
  t: Translate;
}): string {
  switch (nodeData.kind) {
    case "action":
      return resolveActionDestinationLabel(nodeData, t);
    case "scenario_link":
      return clean(nodeData.linkedScenarioName) || t("scenarioLinkPlaceholder");
    case "context":
      return t("badgeContext");
    case "logic":
      switch (getScenarioLogicType(nodeData)) {
        case "post_action_condition":
          return t("postActionConditionLabel");
        case "recipient_column_split":
          return t("presetLogicRecipientColumnSplit");
        default:
          return t("scenarioGate");
      }
    default:
      return t("scenarioGate");
  }
}
