import {
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioTriggerEventKind,
} from "./scenario-triggers";
import { isRecord } from "./value-guards";

const WHATSAPP_SESSION_CHOICE_PAYLOAD_PREFIX = "wsc";
const WHATSAPP_TEMPLATE_BUTTON_PAYLOAD_PREFIX = "stb";
const WHATSAPP_BOOK_CALL_PAYLOAD_PREFIX = "wbc";
const PAYLOAD_SEPARATOR = ":";

export type WhatsAppSessionChoicePayload = {
  actionNodeId: string;
  choiceId: string;
};

export type WhatsAppTemplateButtonPayload = {
  actionNodeId: string;
  /**
   * The step's id for the button (whatsapp-template-button-ids.ts), not its
   * position. Payloads sent before the step had ids carry the position, which
   * is that button's id.
   */
  buttonId: number;
};

export type WhatsAppBookCallPayload = {
  actionNodeId: string;
  startMs: number;
  endMs: number;
};

function encodePayloadPart(value: string): string {
  return encodeURIComponent(value.trim());
}

export function buildWhatsAppSessionChoicePayload(
  params: WhatsAppSessionChoicePayload,
): string {
  return [
    WHATSAPP_SESSION_CHOICE_PAYLOAD_PREFIX,
    encodePayloadPart(params.actionNodeId),
    encodePayloadPart(params.choiceId),
  ].join(PAYLOAD_SEPARATOR);
}

export function parseWhatsAppSessionChoicePayload(
  payload: string | null | undefined,
): WhatsAppSessionChoicePayload | null {
  const normalized = typeof payload === "string" ? payload.trim() : "";
  if (!normalized) return null;

  const parts = normalized.split(PAYLOAD_SEPARATOR);
  if (
    parts.length !== 3 ||
    parts[0] !== WHATSAPP_SESSION_CHOICE_PAYLOAD_PREFIX
  ) {
    return null;
  }

  try {
    const actionNodeId = decodeURIComponent(parts[1] || "").trim();
    const choiceId = decodeURIComponent(parts[2] || "").trim();
    return actionNodeId && choiceId ? { actionNodeId, choiceId } : null;
  } catch {
    return null;
  }
}

export function buildWhatsAppTemplateButtonPayload(
  actionNodeId: string,
  buttonId: number,
): string {
  return [
    WHATSAPP_TEMPLATE_BUTTON_PAYLOAD_PREFIX,
    encodePayloadPart(actionNodeId),
    String(Math.max(0, Math.trunc(buttonId))),
  ].join(PAYLOAD_SEPARATOR);
}

export function parseWhatsAppTemplateButtonPayload(
  payload: string | null | undefined,
): WhatsAppTemplateButtonPayload | null {
  const normalizedPayload = typeof payload === "string" ? payload.trim() : "";
  if (!normalizedPayload) return null;

  const prefix = `${WHATSAPP_TEMPLATE_BUTTON_PAYLOAD_PREFIX}${PAYLOAD_SEPARATOR}`;
  if (!normalizedPayload.startsWith(prefix)) return null;

  const parts = normalizedPayload.slice(prefix.length).split(PAYLOAD_SEPARATOR);
  if (parts.length !== 2) return null;

  const [encodedActionNodeId, buttonIdText] = parts;
  if (!encodedActionNodeId || !buttonIdText) return null;

  try {
    const actionNodeId = decodeURIComponent(encodedActionNodeId).trim();
    const buttonId = Number.parseInt(buttonIdText, 10);
    if (!actionNodeId || !Number.isInteger(buttonId) || buttonId < 0) {
      return null;
    }
    return { actionNodeId, buttonId };
  } catch {
    return null;
  }
}

export type WhatsAppTemplateQuickReplyButton = {
  index: number;
  label: string;
  /** Set for a carousel card's button: the card's position in the carousel. */
  cardIndex?: number;
  /** A carousel card's body text, which tells its cards apart. */
  cardText?: string;
};

function collectQuickReplyButtons(
  component: unknown,
  buttons: WhatsAppTemplateQuickReplyButton[],
  card?: { cardIndex: number; cardText: string },
): void {
  if (
    !isRecord(component) ||
    component.type !== "BUTTONS" ||
    !Array.isArray(component.buttons)
  ) {
    return;
  }

  component.buttons.forEach((button: unknown, index: number) => {
    if (!isRecord(button) || button.type !== "QUICK_REPLY") return;
    const label = typeof button.text === "string" ? button.text.trim() : "";
    if (!label) return;
    buttons.push(card ? { index, label, ...card } : { index, label });
  });
}

function readCarouselCardText(components: unknown[]): string {
  const body = components.find(
    (component) => isRecord(component) && component.type === "BODY",
  );
  return isRecord(body) && typeof body.text === "string"
    ? body.text.trim()
    : "";
}

/**
 * Labeled quick-reply buttons, indexed by position in their BUTTONS component:
 * the message's own buttons first, then each carousel card's, which carry
 * `cardIndex`. Routes key a button by its id instead: see
 * resolveWhatsAppTemplateButtons.
 */
export function listWhatsAppTemplateQuickReplyButtons(
  components: unknown,
): WhatsAppTemplateQuickReplyButton[] {
  if (!Array.isArray(components)) return [];

  const buttons: WhatsAppTemplateQuickReplyButton[] = [];
  for (const component of components) {
    collectQuickReplyButtons(component, buttons);
  }
  for (const component of components) {
    if (
      !isRecord(component) ||
      component.type !== "CAROUSEL" ||
      !Array.isArray(component.cards)
    ) {
      continue;
    }
    component.cards.forEach((card: unknown, cardIndex: number) => {
      if (!isRecord(card) || !Array.isArray(card.components)) return;
      const cardText = readCarouselCardText(card.components);
      for (const cardComponent of card.components) {
        collectQuickReplyButtons(cardComponent, buttons, {
          cardIndex,
          cardText,
        });
      }
    });
  }

  return buttons;
}

/**
 * A template FLOW button's Flow id as text. A saved template can hold the id
 * as a number (a BSON double), which is read as its whole digits.
 */
export function normalizeWhatsAppTemplateFlowId(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "boolean") return "";
  return String(value).trim();
}

export type WhatsAppTemplateFlowButton = {
  flowId: string;
  /** The button's label, as the customer sees it; empty when it has none. */
  text: string;
};

/**
 * The template's one FLOW button. Null unless the template has exactly one
 * FLOW button and it names its Flow by id: Meta allows one per template, and
 * a reply to it does not say which button opened the form.
 */
export function readSingleWhatsAppTemplateFlowButton(
  components: unknown,
): WhatsAppTemplateFlowButton | null {
  if (!Array.isArray(components)) return null;

  const flowButtons: WhatsAppTemplateFlowButton[] = [];
  for (const component of components) {
    if (
      !isRecord(component) ||
      component.type !== "BUTTONS" ||
      !Array.isArray(component.buttons)
    ) {
      continue;
    }
    for (const button of component.buttons) {
      if (isRecord(button) && button.type === "FLOW") {
        flowButtons.push({
          flowId: normalizeWhatsAppTemplateFlowId(button.flow_id),
          text: typeof button.text === "string" ? button.text.trim() : "",
        });
      }
    }
  }

  const [flowButton] = flowButtons;
  return flowButtons.length === 1 && flowButton?.flowId ? flowButton : null;
}

/** The Flow the template's one FLOW button opens: see the button's reader. */
export function readSingleWhatsAppTemplateFlowButtonFlowId(
  components: unknown,
): string | null {
  return readSingleWhatsAppTemplateFlowButton(components)?.flowId ?? null;
}

/**
 * Whether a step can have a "Form submitted" route, from its data alone: a
 * WhatsApp template whose one FLOW button opens a Flow. A service message
 * routes its own form; a message key left undefined, as the builder's type
 * change leaves it, is no service message. Graph rules, such as Flow-branch
 * routes or a bulk step, are the caller's.
 */
export function whatsAppTemplateOffersFormSubmittedRoute(
  data: unknown,
): boolean {
  return (
    isRecord(data) &&
    data.kind === "action" &&
    data.actionType === "whatsapp_template" &&
    data.actionWhatsAppServiceMessage === undefined &&
    readSingleWhatsAppTemplateFlowButtonFlowId(
      data.actionWhatsAppTemplateComponents,
    ) !== null
  );
}

export function buildWhatsAppBookCallPayload(
  params: WhatsAppBookCallPayload,
): string {
  return [
    WHATSAPP_BOOK_CALL_PAYLOAD_PREFIX,
    encodePayloadPart(params.actionNodeId),
    String(Math.trunc(params.startMs)),
    String(Math.trunc(params.endMs)),
  ].join(PAYLOAD_SEPARATOR);
}

export function parseWhatsAppBookCallPayload(
  payload: string | null | undefined,
): WhatsAppBookCallPayload | null {
  const normalized = typeof payload === "string" ? payload.trim() : "";
  if (!normalized) return null;

  const parts = normalized.split(PAYLOAD_SEPARATOR);
  if (parts.length !== 4 || parts[0] !== WHATSAPP_BOOK_CALL_PAYLOAD_PREFIX) {
    return null;
  }

  try {
    const actionNodeId = decodeURIComponent(parts[1] || "").trim();
    const startMs = Number(parts[2]);
    const endMs = Number(parts[3]);
    if (
      !actionNodeId ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      return null;
    }
    return {
      actionNodeId,
      startMs: Math.trunc(startMs),
      endMs: Math.trunc(endMs),
    };
  } catch {
    return null;
  }
}

export type ResolveWhatsAppInteractiveReplyTriggerEventKindParams = {
  isWhatsAppFlowReply: boolean;
  messageType?: string | null;
  interactiveReplyType?: string | null;
  interactiveReplyOptionId?: string | null;
  quickReplyPayload?: string | null;
};

export function resolveWhatsAppInteractiveReplyTriggerEventKind(
  params: ResolveWhatsAppInteractiveReplyTriggerEventKindParams,
): ScenarioTriggerEventKind | undefined {
  if (params.isWhatsAppFlowReply) {
    return SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply;
  }

  const quickReplyPayload =
    typeof params.quickReplyPayload === "string"
      ? params.quickReplyPayload.trim()
      : "";
  if (!quickReplyPayload) return undefined;

  const isTemplateButtonReply =
    (params.messageType === "button" ||
      params.interactiveReplyType === "button_reply") &&
    Boolean(parseWhatsAppTemplateButtonPayload(quickReplyPayload));
  const isSessionChoiceReply =
    Boolean(params.interactiveReplyOptionId) &&
    Boolean(parseWhatsAppSessionChoicePayload(quickReplyPayload));
  const isBookCallReply =
    Boolean(params.interactiveReplyOptionId) &&
    Boolean(parseWhatsAppBookCallPayload(quickReplyPayload));

  return isTemplateButtonReply || isSessionChoiceReply || isBookCallReply
    ? SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply
    : undefined;
}
