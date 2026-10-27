import type { ScenarioActionAttachment } from "./scenario-action-attachments";
import type { WhatsAppServiceSendCommand } from "./whatsapp-service-message-compiler";
import { isRecord } from "./value-guards";

/**
 * Where a WhatsApp service payload keeps media. An action's `message` and the
 * send command compiled from it use the same fields: the media `attachment`,
 * an interactive `header` of kind `media`, and carousel `cards[].media`.
 */
export type ScenarioServiceMessageMediaLocation =
  | { kind: "service_attachment" }
  | { kind: "service_header" }
  | { kind: "service_carousel_card"; cardIndex: number };

/** Every place scenario node data keeps media, including its service message. */
export type ScenarioMediaLocation =
  | ScenarioServiceMessageMediaLocation
  | { kind: "generative_reference"; index: number }
  | { kind: "action_attachment"; index: number }
  /** Legacy URL strings; new writes use `actionAttachments`. */
  | { kind: "action_image_url"; index: number }
  | { kind: "action_media_asset"; index: number };

/**
 * Returns the value to store at a location. Returning the value it was given
 * leaves that location, and every container above it, untouched.
 */
export type ScenarioMediaVisitor<Value, Location> = (
  value: Value,
  location: Location,
) => Value;

export type ScenarioMediaAsyncVisitor<Value, Location> = (
  value: Value,
  location: Location,
) => Promise<Value>;

type UnknownRecord = Record<string, unknown>;

/** Copies `record` on the first changed key, so an untouched record is reused. */
function createRecordWriter(record: UnknownRecord) {
  let next = record;
  return {
    set(key: string, value: unknown) {
      if (value === next[key]) return;
      if (next === record) next = { ...record };
      next[key] = value;
    },
    get result() {
      return next;
    },
  };
}

function mapList(
  items: unknown[],
  visit: (item: unknown, index: number) => unknown,
): unknown[] {
  let changed = false;
  const next = items.map((item, index) => {
    const value = visit(item, index);
    if (value !== item) changed = true;
    return value;
  });
  return changed ? next : items;
}

function mapServicePayloadMedia(
  payload: unknown,
  visit: ScenarioMediaVisitor<unknown, ScenarioServiceMessageMediaLocation>,
): unknown {
  if (!isRecord(payload)) return payload;
  const writer = createRecordWriter(payload);
  if (isRecord(payload.attachment)) {
    writer.set(
      "attachment",
      visit(payload.attachment, { kind: "service_attachment" }),
    );
  }
  const header = payload.header;
  if (
    isRecord(header) &&
    header.kind === "media" &&
    isRecord(header.attachment)
  ) {
    const attachment = visit(header.attachment, { kind: "service_header" });
    if (attachment !== header.attachment) {
      writer.set("header", { ...header, attachment });
    }
  }
  if (Array.isArray(payload.cards)) {
    writer.set(
      "cards",
      mapList(payload.cards, (card, cardIndex) => {
        if (!isRecord(card) || !isRecord(card.media)) return card;
        const media = visit(card.media, {
          kind: "service_carousel_card",
          cardIndex,
        });
        return media === card.media ? card : { ...card, media };
      }),
    );
  }
  return writer.result;
}

function mapNodeMedia(
  data: unknown,
  visit: ScenarioMediaVisitor<unknown, ScenarioMediaLocation>,
): unknown {
  if (!isRecord(data)) return data;
  const writer = createRecordWriter(data);

  const generative = data.actionGenerativeAIConfig;
  if (
    isRecord(generative) &&
    isRecord(generative.image) &&
    Array.isArray(generative.image.referenceImages)
  ) {
    const image = generative.image;
    const referenceImages = mapList(
      generative.image.referenceImages,
      (item, index) => visit(item, { kind: "generative_reference", index }),
    );
    if (referenceImages !== image.referenceImages) {
      writer.set("actionGenerativeAIConfig", {
        ...generative,
        image: { ...image, referenceImages },
      });
    }
  }

  const lists = [
    ["actionAttachments", "action_attachment"],
    ["actionImageUrls", "action_image_url"],
    ["actionMediaAssets", "action_media_asset"],
  ] as const;
  for (const [field, kind] of lists) {
    const items = data[field];
    if (Array.isArray(items)) {
      writer.set(
        field,
        mapList(items, (item, index) => visit(item, { kind, index })),
      );
    }
  }

  const service = data.actionWhatsAppServiceMessage;
  if (isRecord(service)) {
    const message = mapServicePayloadMedia(service.message, visit);
    if (message !== service.message) {
      writer.set("actionWhatsAppServiceMessage", { ...service, message });
    }
  }
  return writer.result;
}

/**
 * Runs an async visitor over every location a sync mapper visits, all at
 * once, then rebuilds the value with the results in visit order.
 */
async function mapMediaAsync<Location>(
  value: unknown,
  map: (
    value: unknown,
    visit: ScenarioMediaVisitor<unknown, Location>,
  ) => unknown,
  visit: ScenarioMediaAsyncVisitor<unknown, Location>,
): Promise<unknown> {
  const pending: Promise<unknown>[] = [];
  map(value, (item, location) => {
    pending.push(visit(item, location));
    return item;
  });
  if (pending.length === 0) return value;
  const results = await Promise.all(pending);
  let next = 0;
  return map(value, () => results[next++]);
}

/**
 * Visits the media a WhatsApp service payload holds: an action's `message`
 * or a compiled send command. A typed command yields typed attachments.
 */
export function mapScenarioServiceMessageMedia(
  command: WhatsAppServiceSendCommand,
  visit: ScenarioMediaVisitor<
    ScenarioActionAttachment,
    ScenarioServiceMessageMediaLocation
  >,
): WhatsAppServiceSendCommand;
export function mapScenarioServiceMessageMedia<Payload>(
  payload: Payload,
  visit: ScenarioMediaVisitor<unknown, ScenarioServiceMessageMediaLocation>,
): Payload;
export function mapScenarioServiceMessageMedia(
  payload: unknown,
  visit: (
    value: never,
    location: ScenarioServiceMessageMediaLocation,
  ) => unknown,
): unknown {
  return mapServicePayloadMedia(
    payload,
    visit as ScenarioMediaVisitor<unknown, ScenarioServiceMessageMediaLocation>,
  );
}

export function mapScenarioServiceMessageMediaAsync(
  command: WhatsAppServiceSendCommand,
  visit: ScenarioMediaAsyncVisitor<
    ScenarioActionAttachment,
    ScenarioServiceMessageMediaLocation
  >,
): Promise<WhatsAppServiceSendCommand>;
export function mapScenarioServiceMessageMediaAsync<Payload>(
  payload: Payload,
  visit: ScenarioMediaAsyncVisitor<
    unknown,
    ScenarioServiceMessageMediaLocation
  >,
): Promise<Payload>;
export function mapScenarioServiceMessageMediaAsync(
  payload: unknown,
  visit: (
    value: never,
    location: ScenarioServiceMessageMediaLocation,
  ) => Promise<unknown>,
): Promise<unknown> {
  return mapMediaAsync(
    payload,
    mapServicePayloadMedia,
    visit as ScenarioMediaAsyncVisitor<
      unknown,
      ScenarioServiceMessageMediaLocation
    >,
  );
}

/** Visits every media location on scenario node data. */
export function mapScenarioNodeMedia<Data>(
  data: Data,
  visit: ScenarioMediaVisitor<unknown, ScenarioMediaLocation>,
): Data {
  return mapNodeMedia(data, visit) as Data;
}

export function mapScenarioNodeMediaAsync<Data>(
  data: Data,
  visit: ScenarioMediaAsyncVisitor<unknown, ScenarioMediaLocation>,
): Promise<Data> {
  return mapMediaAsync(data, mapNodeMedia, visit) as Promise<Data>;
}
