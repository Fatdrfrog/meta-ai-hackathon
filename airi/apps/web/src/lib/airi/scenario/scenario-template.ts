import { parseWhatsAppName } from "@/lib/whatsapp/contact/utils";
import {
  buildMessagingWindowCountdownContext,
  hoursRemainingFromCountdown,
  type ScenarioCalendarTemplateAvailability,
} from "@/lib/airi/scenario/scenario-template-dynamics";
import {
  buildWhatsAppReferralTemplateAliases,
  pickWhatsAppReferralFields,
} from "@icecore/whatsapp/referralFields";
import type {
  Channel,
  ChatDocument,
  ConversationDocument,
  MessageDocument,
} from "@/types/models";

import {
  buildScenarioTemplateSlots,
  hasScenarioTemplateTokens,
  isScenarioFormAnswerKey,
  isScenarioPromptInputKey,
  pickScenarioTemplateReferralAliases,
  readScenarioPickedOptionTemplateValues,
  readScenarioRoutedOfficeTemplateValues,
  renderScenarioTemplate,
  type ScenarioPickedOption,
  type ScenarioRoutedLocationEntry,
  type ScenarioTemplateContext,
} from "@icecore/scenario-contracts";
import { joinNameParts } from "@/lib/scenarios/task-utils";
import { readNonEmptyStringOrUndefined as asNonEmptyString } from "@icecore/shared/lib/value-utils";

type WhatsAppInfo = {
  contactData?: {
    waId?: string;
    userId?: string;
    parentUserId?: string;
    profile?: { name?: string; username?: string };
  };
};

type ScenarioReplyTemplateParams = {
  template?: string;
  reply: string;
  channel: Channel;
  conversation: ConversationDocument;
  chatDocument: ChatDocument;
  whatsAppInfo?: WhatsAppInfo;
  triggerMessage?: MessageDocument | null;
  configuredLinks?: string[];
  configuredImages?: string[];
  attachedArticleLinks?: Array<{ url: string; title: string }>;
  /** Pre-fetched Google Calendar free/busy when reply uses calendar.* tokens. */
  calendarAvailability?: ScenarioCalendarTemplateAvailability | null;
  /** Override "now" for countdown (tests). */
  now?: Date;
  /** Answers collected by a preceding WhatsApp prompt-input question. */
  promptInputs?: Record<string, string>;
  /** The option the customer tapped on an earlier service message. */
  pickedOption?: ScenarioPickedOption | null;
  /** Answers of the forms the customer submitted, by form, then field key. */
  formAnswers?: Record<string, Record<string, string>>;
  /** The office nearest to a location the customer shared. */
  routedOffice?: ScenarioRoutedLocationEntry | null;
  /**
   * Return an empty render as empty. By default an empty render falls back to
   * the source text; a model prompt must never receive raw template syntax.
   */
  allowEmptyRender?: boolean;
  /**
   * Merchant-authored text fails closed on a missing answer. Text a model
   * generated may echo a token it saw; a missing answer then renders empty
   * instead of failing the turn. Defaults to true.
   */
  requirePromptInputs?: boolean;
  /**
   * A generative prompt also fails on a form the customer never submitted
   * (ScenarioFormAnswerMissingError). Other text renders that answer empty.
   */
  requireFormAnswers?: boolean;
};

function getGenericNameFallback(language?: string): string {
  const lang = (language || "").toLowerCase();
  if (lang.startsWith("ru")) return "клиент";
  if (lang.startsWith("kz")) return "клиент";
  if (lang.startsWith("uz")) return "mijoz";
  return "there";
}

function getConversationChatId(
  conversation: ConversationDocument
): string | undefined {
  const chat = (conversation as ConversationDocument & { chat?: unknown }).chat;
  if (chat === null || chat === undefined) return undefined;
  if (typeof chat === "string" || typeof chat === "number") {
    return String(chat);
  }
  if (typeof chat === "object") {
    const chatAny = chat as Record<string, unknown>;
    if (chatAny._id !== null && chatAny._id !== undefined) {
      return String(chatAny._id);
    }
  }
  return undefined;
}

function readPromptInputContext(
  value: Record<string, string> | undefined
): Record<string, string> {
  if (!value) return {};
  const input: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isScenarioPromptInputKey(key) || typeof raw !== "string") continue;
    const answer = raw.trim();
    if (!answer) continue;
    input[key] = answer;
  }
  return input;
}

/**
 * Form answers by form, then field. Every submitted form keeps its group, so
 * a blank answer reads as empty rather than as a form never submitted.
 */
function readFormAnswerContext(
  value: Record<string, Record<string, string>> | undefined
): Record<string, Record<string, string>> {
  if (!value) return {};
  const forms: Record<string, Record<string, string>> = {};
  for (const [formKey, fields] of Object.entries(value)) {
    if (!isScenarioFormAnswerKey(formKey) || !fields) continue;
    const answers: Record<string, string> = {};
    for (const [fieldKey, raw] of Object.entries(fields)) {
      if (!isScenarioFormAnswerKey(fieldKey) || typeof raw !== "string") {
        continue;
      }
      const answer = raw.trim();
      if (answer) answers[fieldKey] = answer;
    }
    forms[formKey] = answers;
  }
  return forms;
}

export function applyScenarioReplyTemplate(
  params: ScenarioReplyTemplateParams
): string {
  const template = asNonEmptyString(params.template);

  const chatAny = params.chatDocument as ChatDocument & {
    first_name?: string;
    last_name?: string;
    username?: string;
    title?: string;
  };

  const conversationAny = params.conversation as ConversationDocument & {
    preferred_language?: string;
    internal_labels?: string[];
    last_inbound_at?: Date | string | null;
  };

  const configuredLinks = Array.isArray(params.configuredLinks)
    ? params.configuredLinks
    : [];
  const configuredImages = Array.isArray(params.configuredImages)
    ? params.configuredImages
    : [];
  const kbLinks = (params.attachedArticleLinks || [])
    .map(item => asNonEmptyString(item.url))
    .filter((item): item is string => Boolean(item));
  const resolvedLinks = configuredLinks.length > 0 ? configuredLinks : kbLinks;
  const firstLink = resolvedLinks[0];
  const firstImage = configuredImages[0];
  const preferredLanguage = asNonEmptyString(
    conversationAny.preferred_language
  );
  const waProfileNameRaw = asNonEmptyString(
    params.whatsAppInfo?.contactData?.profile?.name
  );
  const parsedWhatsAppName = parseWhatsAppName(waProfileNameRaw);
  const waFirstName = asNonEmptyString(parsedWhatsAppName.firstName);
  const waLastName = asNonEmptyString(parsedWhatsAppName.lastName);
  const waFullName = asNonEmptyString(parsedWhatsAppName.fullName);
  const chatFirstName = asNonEmptyString(chatAny.first_name);
  const chatLastName = asNonEmptyString(chatAny.last_name);
  const chatUsername = asNonEmptyString(chatAny.username);
  const chatTitle = asNonEmptyString(chatAny.title);
  const whatsappName = waFullName || waProfileNameRaw;
  const customerName =
    whatsappName ||
    joinNameParts(waFirstName, waLastName) ||
    joinNameParts(chatFirstName, chatLastName) ||
    waFirstName ||
    chatFirstName ||
    chatTitle ||
    chatUsername ||
    getGenericNameFallback(preferredLanguage);
  const customerFirstName =
    chatFirstName ||
    waFirstName ||
    asNonEmptyString(customerName.split(/\s+/)[0]) ||
    getGenericNameFallback(preferredLanguage);
  const whatsappReferral = pickWhatsAppReferralFields({
    triggerMessage: params.triggerMessage,
    conversation: params.conversation,
  });

  const countdown = buildMessagingWindowCountdownContext({
    lastInboundAt: conversationAny.last_inbound_at,
    language: preferredLanguage,
    now: params.now,
  });
  const calendarAvailability = params.calendarAvailability ?? {
    connected: false,
    nextFreeSlot: "",
    nextFreeSlotEnd: "",
    timeZone: "",
    slotCount: 0,
  };

  // Exactly the described paths, so editor validation matches what renders.
  const context = {
    reply: params.reply,
    link: firstLink || "",
    image: firstImage || "",
    ...buildScenarioTemplateSlots("link", resolvedLinks),
    ...buildScenarioTemplateSlots("image", configuredImages),
    links: {
      first: firstLink || "",
      count: resolvedLinks.length,
    },
    images: {
      first: firstImage || "",
      count: configuredImages.length,
    },
    channel: params.channel,
    customer: {
      name: customerName || "",
      firstName: customerFirstName || "",
      lastName: chatLastName || waLastName || "",
      username: chatUsername || "",
      id: getConversationChatId(params.conversation) || "",
    },
    whatsappclient: {
      name: whatsappName || customerName || "",
      wa_id: asNonEmptyString(params.whatsAppInfo?.contactData?.waId) || "",
      user_id: asNonEmptyString(params.whatsAppInfo?.contactData?.userId) || "",
      parent_user_id:
        asNonEmptyString(params.whatsAppInfo?.contactData?.parentUserId) || "",
    },
    chat: {
      id: getConversationChatId(params.conversation) || "",
      title: chatTitle || "",
      first_name: customerFirstName || "",
      last_name: chatLastName || waLastName || "",
      username: chatUsername || "",
    },
    conversation: {
      id: String(params.conversation._id || ""),
      channel: params.channel,
      preferred_language: preferredLanguage || "",
      internal_labels: Array.isArray(conversationAny.internal_labels)
        ? conversationAny.internal_labels.filter(Boolean).join(", ")
        : "",
    },
    trigger: {
      message: {
        id: params.triggerMessage?._id ? String(params.triggerMessage._id) : "",
        text:
          typeof params.triggerMessage?.text === "string"
            ? params.triggerMessage.text
            : "",
      },
      whatsappReferral,
    },
    whatsappReferral,
    ...pickScenarioTemplateReferralAliases(
      buildWhatsAppReferralTemplateAliases(whatsappReferral)
    ),
    first_name: customerFirstName || "",
    last_name: chatLastName || waLastName || "",
    username: chatUsername || "",
    customer_name: customerName || "",
    calendar: {
      connected: calendarAvailability.connected ? "yes" : "",
      next_free_slot: calendarAvailability.nextFreeSlot || "",
      next_free_slot_end: calendarAvailability.nextFreeSlotEnd || "",
      time_zone: calendarAvailability.timeZone || "",
      slot_count: calendarAvailability.slotCount || 0,
    },
    countdown: {
      days: countdown.days,
      hours: hoursRemainingFromCountdown(countdown),
      minutes: countdown.minutes,
      humanized: countdown.humanized,
      expired: countdown.expired ? "yes" : "",
      iso: countdown.iso,
    },
    picked: readScenarioPickedOptionTemplateValues(params.pickedOption),
    office: readScenarioRoutedOfficeTemplateValues(params.routedOffice),
    input: readPromptInputContext(params.promptInputs),
    form: readFormAnswerContext(params.formAnswers),
  } satisfies ScenarioTemplateContext;
  const missing =
    params.requirePromptInputs === false
      ? "empty"
      : params.requireFormAnswers
        ? "require_answers"
        : "require_prompt_inputs";

  if (!template) {
    if (!hasScenarioTemplateTokens(params.reply)) {
      return params.reply;
    }

    const renderedReply = renderScenarioTemplate(
      params.reply,
      context,
      missing
    ).trim();
    return renderedReply || (params.allowEmptyRender ? "" : params.reply);
  }

  const renderedTemplate = renderScenarioTemplate(
    template,
    context,
    missing
  ).trim();
  return renderedTemplate || params.reply;
}
