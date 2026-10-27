import {
  readScenarioActionAttachment,
  type ScenarioActionAttachment,
} from "./scenario-action-attachments";
import { isRecord, readTrimmedString as text } from "./value-guards";

/*
 * The choices a service message offers. A leaf module, so the prompt-input
 * rules can read them without importing the service-message module that
 * imports those rules.
 */

/**
 * A choice a service message offers: a reply button, a list row or a carousel
 * quick reply. Ids are trimmed and unique across the message (carousel ids
 * look like `wsc:<nodeId>:<uuid>`); labels are trimmed and may still be empty
 * in a draft. Carousel options also name their card.
 */
export type ScenarioWhatsAppServiceOption = {
  id: string;
  label: string;
  cardIndex?: number;
  cardId?: string;
  /** The card's media as stored: its durable `gcs://` URL, bucket and path. */
  cardMedia?: ScenarioActionAttachment;
  cardBodyText?: string;
};

function readRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * The choices a service payload offers: an action's `message`, or the send
 * command stored on the outbound message, which keeps the same fields.
 */
export function listScenarioWhatsAppServicePayloadOptions(
  payload: unknown,
): ScenarioWhatsAppServiceOption[] {
  if (!isRecord(payload)) return [];
  const options: ScenarioWhatsAppServiceOption[] = [];
  const add = (
    id: unknown,
    label: unknown,
    card?: Omit<ScenarioWhatsAppServiceOption, "id" | "label">,
  ) => {
    const optionId = text(id);
    if (optionId) options.push({ id: optionId, label: text(label), ...card });
  };
  switch (payload.kind) {
    case "reply_buttons":
      for (const option of readRecords(payload.options)) {
        add(option.id, option.label);
      }
      break;
    case "list":
      for (const section of readRecords(payload.sections)) {
        for (const row of readRecords(section.rows)) add(row.id, row.title);
      }
      break;
    case "media_carousel": {
      const cards: unknown[] = Array.isArray(payload.cards)
        ? payload.cards
        : [];
      // cardIndex is the card's position in the sent carousel.
      cards.forEach((card, cardIndex) => {
        if (!isRecord(card)) return;
        const interaction = card.interaction;
        if (!isRecord(interaction) || interaction.kind !== "quick_replies") {
          return;
        }
        const cardId = text(card.id);
        const cardMedia = readScenarioActionAttachment(card.media);
        const cardBodyText = text(card.bodyText);
        for (const option of readRecords(interaction.options)) {
          add(option.id, option.label, {
            cardIndex,
            ...(cardId ? { cardId } : {}),
            ...(cardMedia ? { cardMedia } : {}),
            ...(cardBodyText ? { cardBodyText } : {}),
          });
        }
      });
      break;
    }
  }
  return options;
}

/**
 * The option a tap chose, read from the node's service-message config or
 * from the `whatsappServiceMessage` preview stored on the outbound message
 * (`{ version, kind, bodyText, command }`). A carousel option names its card.
 * Null when that message offers no option with this id.
 */
export function findScenarioWhatsAppServiceOption(
  source: { message?: unknown; command?: unknown } | null | undefined,
  optionId: string | null | undefined,
): ScenarioWhatsAppServiceOption | null {
  const id = text(optionId);
  if (!id || !isRecord(source)) return null;
  const payload = isRecord(source.message) ? source.message : source.command;
  return (
    listScenarioWhatsAppServicePayloadOptions(payload).find(
      (candidate) => candidate.id === id,
    ) ?? null
  );
}
