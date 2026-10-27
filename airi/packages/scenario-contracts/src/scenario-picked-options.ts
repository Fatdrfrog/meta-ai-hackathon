import type {
  ScenarioActionAttachment,
  ScenarioActionAttachmentMediaType,
} from "./scenario-action-attachments";
import type { ScenarioWhatsAppServiceOption } from "./whatsapp-service-options";
import { isRecord, cleanString } from "./value-guards";

/** Picks kept for one scenario; the earliest is dropped past this. */
export const MAX_SCENARIO_PICKED_OPTIONS = 10;
const MAX_PICKED_ID_CHARACTERS = 256;
const MAX_PICKED_LABEL_CHARACTERS = 256;
const MAX_PICKED_CARD_TEXT_CHARACTERS = 1024;
const MAX_SCENARIO_ID_CHARACTERS = 128;

/**
 * A choice the customer tapped on a scenario service message, as the sent
 * message offered it: a reply button, a list row or a carousel quick reply.
 * A carousel pick also carries its card.
 */
export type ScenarioPickedOption = {
  sourceActionNodeId: string;
  optionId: string;
  label: string;
  cardIndex?: number;
  cardId?: string;
  cardBodyText?: string;
  /** The card's stored media: its durable `gcs://` URL, bucket and path. */
  cardMedia?: ScenarioActionAttachment;
  /** ISO time of the tap, or empty when a stored value had none. */
  pickedAt: string;
};

/** The picks of one scenario, oldest first, the latest one per message node. */
export type ScenarioPickedOptions = {
  scenarioId: string;
  picks: ScenarioPickedOption[];
};

function readId(value: unknown, maxCharacters: number): string {
  const id = typeof value === "string" ? value.trim() : "";
  return id.length <= maxCharacters ? id : "";
}

const ATTACHMENT_MEDIA_TYPES = new Set<ScenarioActionAttachmentMediaType>([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
]);

/** A clean copy of a stored attachment, or undefined when it is unusable. */
function copyCardMedia(value: unknown): ScenarioActionAttachment | undefined {
  if (!isRecord(value)) return undefined;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const mediaType = value.mediaType;
  if (
    !url ||
    typeof mediaType !== "string" ||
    !ATTACHMENT_MEDIA_TYPES.has(mediaType as ScenarioActionAttachmentMediaType)
  ) {
    return undefined;
  }
  return {
    url,
    mediaType: mediaType as ScenarioActionAttachmentMediaType,
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
    ...(typeof value.fileSize === "number" ? { fileSize: value.fileSize } : {}),
    ...(typeof value.bucket === "string" ? { bucket: value.bucket } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
  };
}

export function normalizeScenarioPickedOption(
  value: unknown,
): ScenarioPickedOption | null {
  if (!isRecord(value)) return null;
  const sourceActionNodeId = readId(
    value.sourceActionNodeId,
    MAX_PICKED_ID_CHARACTERS,
  );
  const optionId = readId(value.optionId, MAX_PICKED_ID_CHARACTERS);
  if (!sourceActionNodeId || !optionId) return null;
  const cardIndex = value.cardIndex;
  const cardId = readId(value.cardId, MAX_PICKED_ID_CHARACTERS);
  const cardBodyText = cleanString(
    value.cardBodyText,
    MAX_PICKED_CARD_TEXT_CHARACTERS,
  );
  const cardMedia = copyCardMedia(value.cardMedia);
  const pickedAt =
    typeof value.pickedAt === "string" &&
    !Number.isNaN(Date.parse(value.pickedAt))
      ? value.pickedAt
      : "";
  return {
    sourceActionNodeId,
    optionId,
    label: cleanString(value.label, MAX_PICKED_LABEL_CHARACTERS),
    ...(typeof cardIndex === "number" &&
    Number.isSafeInteger(cardIndex) &&
    cardIndex >= 0
      ? { cardIndex }
      : {}),
    ...(cardId ? { cardId } : {}),
    ...(cardBodyText ? { cardBodyText } : {}),
    ...(cardMedia ? { cardMedia } : {}),
    pickedAt,
  };
}

/** The pick a tap on `option` records, or null without a node or option id. */
export function buildScenarioPickedOption(params: {
  sourceActionNodeId: string;
  option: ScenarioWhatsAppServiceOption;
  pickedAt: Date;
}): ScenarioPickedOption | null {
  const { id, ...card } = params.option;
  return normalizeScenarioPickedOption({
    ...card,
    sourceActionNodeId: params.sourceActionNodeId,
    optionId: id,
    pickedAt: params.pickedAt.toISOString(),
  });
}

function limitPicks(picks: ScenarioPickedOption[]): ScenarioPickedOption[] {
  const latest = picks.filter(
    (pick, index) =>
      !picks
        .slice(index + 1)
        .some((later) => later.sourceActionNodeId === pick.sourceActionNodeId),
  );
  return latest.slice(-MAX_SCENARIO_PICKED_OPTIONS);
}

export function normalizeScenarioPickedOptions(
  value: unknown,
): ScenarioPickedOptions | null {
  if (!isRecord(value) || !Array.isArray(value.picks)) return null;
  const scenarioId = readId(value.scenarioId, MAX_SCENARIO_ID_CHARACTERS);
  if (!scenarioId) return null;
  const picks = limitPicks(
    value.picks.flatMap((item) => {
      const pick = normalizeScenarioPickedOption(item);
      return pick ? [pick] : [];
    }),
  );
  return picks.length > 0 ? { scenarioId, picks } : null;
}

/**
 * Record a tap in scenario state. A newer tap on the same message replaces
 * the earlier one; a tap from another scenario starts that scenario's list.
 */
export function recordScenarioPickedOption(
  state: unknown,
  params: { scenarioId: string; pick: ScenarioPickedOption },
): Record<string, unknown> {
  const base = isRecord(state) ? { ...state } : {};
  const existing = normalizeScenarioPickedOptions(base.pickedOptions);
  const scenarioId = params.scenarioId.trim();
  return {
    ...base,
    pickedOptions: {
      scenarioId,
      picks: limitPicks([
        ...(existing?.scenarioId === scenarioId ? existing.picks : []),
        params.pick,
      ]),
    },
  };
}

/**
 * The pick a scenario reads: the latest tap on `sourceActionNodeId` when one
 * is named, else the scenario's latest tap. Taps recorded by another
 * scenario are never read.
 */
export function readScenarioPickedOption(
  state: unknown,
  params: {
    scenarioId: string | null | undefined;
    sourceActionNodeId?: string | null;
  },
): ScenarioPickedOption | null {
  if (!isRecord(state) || !params.scenarioId) return null;
  const picked = normalizeScenarioPickedOptions(state.pickedOptions);
  if (picked?.scenarioId !== params.scenarioId) return null;
  const sourceActionNodeId = params.sourceActionNodeId?.trim();
  const picks = sourceActionNodeId
    ? picked.picks.filter(
        (pick) => pick.sourceActionNodeId === sourceActionNodeId,
      )
    : picked.picks;
  return picks.at(-1) ?? null;
}

/** `{{picked.label}}` is the tapped option; `{{picked.text}}` its card's text. */
export function readScenarioPickedOptionTemplateValues(
  pick: ScenarioPickedOption | null | undefined,
): { label: string; text: string } {
  return { label: pick?.label ?? "", text: pick?.cardBodyText ?? "" };
}
