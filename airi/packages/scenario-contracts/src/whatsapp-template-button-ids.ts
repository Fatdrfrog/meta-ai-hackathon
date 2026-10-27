import type { ScenarioActionRoutingNormalization } from "./scenario-action-routing";
import {
  buildWhatsAppTemplateButtonPayload,
  listWhatsAppTemplateQuickReplyButtons,
  type WhatsAppTemplateQuickReplyButton,
} from "./whatsapp-interactive-replies";
import { isRecord, isNonNegativeSafeInteger } from "./value-guards";

export const SCENARIO_WHATSAPP_TEMPLATE_BUTTON_IDS_VERSION = 1 as const;

/**
 * A map that also keys carousel card buttons. Older readers see the version
 * as unsupported, so they never read a card button as a message button.
 */
export const SCENARIO_WHATSAPP_TEMPLATE_CARD_BUTTON_IDS_VERSION = 2 as const;

/**
 * Meta allows at most 10 template buttons, so positions are 0-9. Minted ids
 * start above them and never collide with an id a position already gave.
 */
export const MIN_MINTED_WHATSAPP_TEMPLATE_BUTTON_ID = 10;

/**
 * Without a map, card `c`'s button `i` takes id 100 + 10c + i. Card buttons
 * never take a position's id, so a tap sent before cards had ids, which
 * carried only the card-local position, routes nowhere instead of to the
 * wrong button.
 */
export const WHATSAPP_TEMPLATE_CARD_BUTTON_POSITION_ID_BASE = 100;
const WHATSAPP_TEMPLATE_CARD_BUTTON_POSITION_ID_STRIDE = 10;

export type ScenarioWhatsAppTemplateButtonId = {
  id: number;
  /** Position in the BUTTONS component, the index Meta receives. */
  index: number;
  /** The trimmed label. */
  text: string;
  /** Set for a carousel card's button: the card's position in the carousel. */
  cardIndex?: number;
};

/**
 * Per-step ids of the labelled quick replies in the step's saved template.
 * Route handles and tap payloads carry the id, so a route stays on its button
 * when other buttons are added, removed or reordered. A step without this map
 * uses each button's position as its id, which is how every route saved
 * before the map existed is keyed.
 */
export type ScenarioWhatsAppTemplateButtonIds = {
  version:
    | typeof SCENARIO_WHATSAPP_TEMPLATE_BUTTON_IDS_VERSION
    | typeof SCENARIO_WHATSAPP_TEMPLATE_CARD_BUTTON_IDS_VERSION;
  /** Only grows, so a deleted button's id is never reused. */
  nextId: number;
  buttons: ScenarioWhatsAppTemplateButtonId[];
};

export type ResolvedWhatsAppTemplateButton =
  WhatsAppTemplateQuickReplyButton & {
    /** `null`: the button has no id, so it has no route and no tap payload. */
    id: number | null;
  };

/**
 * How a rekey carries ids over to the next template's buttons:
 * - `byIndex`: same index and text, then a text unique on both sides, then
 *   the same index;
 * - `textOnly`: only a matching text keeps an id, as when another template is
 *   picked;
 * - `origins`: the previous id of each labelled quick reply of the message,
 *   in order, or `null` for a new button. Carousel card buttons, which no
 *   editor row shows, are carried as with `byIndex`.
 *
 * A carousel card's button only ever matches a button on the card at the
 * same position.
 */
export type WhatsAppTemplateButtonRekeyMatch =
  | "byIndex"
  | "textOnly"
  | { origins: ReadonlyArray<number | null> };

/** Compares button labels ignoring case and spacing. */
export function normalizeWhatsAppTemplateButtonText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The id a button has without a map: its position, offset for a card. */
export function getWhatsAppTemplateButtonPositionId(button: {
  index: number;
  cardIndex?: number;
}): number {
  return button.cardIndex === undefined
    ? button.index
    : WHATSAPP_TEMPLATE_CARD_BUTTON_POSITION_ID_BASE +
        button.cardIndex * WHATSAPP_TEMPLATE_CARD_BUTTON_POSITION_ID_STRIDE +
        button.index;
}

/** Where a button sits: on the message, or at an index on one card. */
function buttonSlotKey(button: { index: number; cardIndex?: number }): string {
  return `${button.cardIndex ?? ""}:${button.index}`;
}

function withCardIndex<T extends object>(
  value: T,
  cardIndex: number | undefined,
): T & { cardIndex?: number } {
  return cardIndex === undefined ? value : { ...value, cardIndex };
}

function normalizeButtonId(
  value: unknown,
  allowCards: boolean,
): ScenarioWhatsAppTemplateButtonId | null {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.id) ||
    !isNonNegativeSafeInteger(value.index)
  ) {
    return null;
  }
  const cardIndex = value.cardIndex;
  if (
    cardIndex !== undefined &&
    (!allowCards || !isNonNegativeSafeInteger(cardIndex))
  ) {
    return null;
  }
  const text = typeof value.text === "string" ? value.text.trim() : "";
  return text
    ? withCardIndex({ id: value.id, index: value.index, text }, cardIndex)
    : null;
}

function normalizeButtonIdList(
  value: unknown,
  allowCards: boolean,
): ScenarioWhatsAppTemplateButtonId[] | null {
  if (!Array.isArray(value)) return null;

  const buttons: ScenarioWhatsAppTemplateButtonId[] = [];
  const ids = new Set<number>();
  const slots = new Set<string>();
  for (const rawButton of value) {
    const button = normalizeButtonId(rawButton, allowCards);
    const slot = button ? buttonSlotKey(button) : "";
    if (!button || ids.has(button.id) || slots.has(slot)) {
      return null;
    }
    ids.add(button.id);
    slots.add(slot);
    buttons.push(button);
  }
  return buttons;
}

function getMintStart(ids: Iterable<number>, nextId = 0): number {
  return Math.max(
    MIN_MINTED_WHATSAPP_TEMPLATE_BUTTON_ID,
    nextId,
    ...Array.from(ids, (id) => id + 1),
  );
}

function readMapVersion(
  value: unknown,
): ScenarioWhatsAppTemplateButtonIds["version"] | null {
  return value === SCENARIO_WHATSAPP_TEMPLATE_BUTTON_IDS_VERSION ||
    value === SCENARIO_WHATSAPP_TEMPLATE_CARD_BUTTON_IDS_VERSION
    ? value
    : null;
}

/**
 * The map is machine-written, so any malformed part makes the whole map
 * unsupported: its buttons then resolve to no id rather than to positions.
 */
export function normalizeScenarioWhatsAppTemplateButtonIds(
  value: unknown,
): ScenarioActionRoutingNormalization<ScenarioWhatsAppTemplateButtonIds> {
  if (value === null || value === undefined) {
    return { status: "absent", value: null };
  }
  if (!isRecord(value)) {
    return {
      status: "unsupported",
      value: null,
      version: undefined,
      raw: value,
    };
  }

  const version = readMapVersion(value.version);
  const buttons = version
    ? normalizeButtonIdList(
        value.buttons,
        version === SCENARIO_WHATSAPP_TEMPLATE_CARD_BUTTON_IDS_VERSION,
      )
    : null;
  if (!version || !buttons || !isNonNegativeSafeInteger(value.nextId)) {
    return {
      status: "unsupported",
      value: null,
      version: value.version,
      raw: value,
    };
  }

  return {
    status: "supported",
    value: {
      version,
      nextId: getMintStart(
        buttons.map((button) => button.id),
        value.nextId,
      ),
      buttons,
    },
  };
}

/** The group of the message's own buttons; a card's group is its index. */
const MESSAGE_BUTTON_GROUP = -1;

function buttonGroup(button: { cardIndex?: number }): number {
  return button.cardIndex ?? MESSAGE_BUTTON_GROUP;
}

/** Counts labels per group, so two cards never share a count. */
function countTexts(
  buttons: readonly WhatsAppTemplateQuickReplyButton[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const button of buttons) {
    const key = groupTextKey(
      buttonGroup(button),
      normalizeWhatsAppTemplateButtonText(button.label),
    );
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function groupTextKey(group: number, text: string): string {
  return `${group}\u0000${text}`;
}

/** Each card once, with its normalized body text. */
function listButtonCards(
  buttons: readonly WhatsAppTemplateQuickReplyButton[],
): Array<{ cardIndex: number; text: string }> {
  const cards = new Map<number, string>();
  for (const button of buttons) {
    if (button.cardIndex === undefined || cards.has(button.cardIndex)) continue;
    cards.set(
      button.cardIndex,
      normalizeWhatsAppTemplateButtonText(button.cardText ?? ""),
    );
  }
  return Array.from(cards, ([cardIndex, text]) => ({ cardIndex, text }));
}

/**
 * Pairs each source card with at most one target card: same position and
 * body text, then a body text unique on both sides, then (with `byIndex`)
 * the same position. Card buttons usually share labels, so the card's text,
 * not its buttons, keeps a removed or moved card from taking a neighbour's
 * ids.
 */
function pairCarouselCards(
  sources: readonly WhatsAppTemplateQuickReplyButton[],
  targets: readonly WhatsAppTemplateQuickReplyButton[],
  byIndex: boolean,
): Map<number, number> {
  const sourceCards = listButtonCards(sources);
  const targetCards = listButtonCards(targets);
  const pairs = new Map<number, number>();
  const taken = new Set<number>();
  const claim = (source: number, target: number | undefined) => {
    if (target === undefined || taken.has(target) || pairs.has(source)) {
      return;
    }
    pairs.set(source, target);
    taken.add(target);
  };
  const countCardTexts = (cards: Array<{ text: string }>) => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      if (card.text) counts.set(card.text, (counts.get(card.text) ?? 0) + 1);
    }
    return counts;
  };
  const sourceTexts = countCardTexts(sourceCards);
  const targetTexts = countCardTexts(targetCards);

  for (const source of sourceCards) {
    claim(
      source.cardIndex,
      targetCards.find(
        (target) =>
          target.cardIndex === source.cardIndex && target.text === source.text,
      )?.cardIndex,
    );
  }
  for (const source of sourceCards) {
    if (
      !source.text ||
      sourceTexts.get(source.text) !== 1 ||
      targetTexts.get(source.text) !== 1
    ) {
      continue;
    }
    claim(
      source.cardIndex,
      targetCards.find((target) => target.text === source.text)?.cardIndex,
    );
  }
  if (byIndex) {
    for (const source of sourceCards) {
      claim(
        source.cardIndex,
        targetCards.find((target) => target.cardIndex === source.cardIndex)
          ?.cardIndex,
      );
    }
  }
  return pairs;
}

/**
 * Pairs each source button with at most one target: same index and text,
 * then a text unique on both sides, then (with `byIndex`) the same index.
 * The message's buttons only match the message's; a card's buttons only
 * match those of the card it pairs with.
 */
function matchWhatsAppTemplateButtons<
  T extends WhatsAppTemplateQuickReplyButton,
>(
  sources: readonly WhatsAppTemplateQuickReplyButton[],
  targets: readonly T[],
  byIndex: boolean,
): Array<T | null> {
  const matches = sources.map((): T | null => null);
  const taken = new Set<T>();
  const claim = (sourceIndex: number, target: T | undefined) => {
    if (!target || taken.has(target) || matches[sourceIndex]) return;
    matches[sourceIndex] = target;
    taken.add(target);
  };
  const cardPairs = pairCarouselCards(sources, targets, byIndex);
  const targetGroups = sources.map((source) =>
    source.cardIndex === undefined
      ? MESSAGE_BUTTON_GROUP
      : cardPairs.get(source.cardIndex),
  );
  const inGroup = (target: T, group: number | undefined) =>
    group !== undefined && buttonGroup(target) === group;
  const sourceTexts = countTexts(sources);
  const targetTexts = countTexts(targets);

  sources.forEach((source, sourceIndex) => {
    const group = targetGroups[sourceIndex];
    const text = normalizeWhatsAppTemplateButtonText(source.label);
    claim(
      sourceIndex,
      targets.find(
        (target) =>
          inGroup(target, group) &&
          target.index === source.index &&
          normalizeWhatsAppTemplateButtonText(target.label) === text,
      ),
    );
  });
  sources.forEach((source, sourceIndex) => {
    const group = targetGroups[sourceIndex];
    const text = normalizeWhatsAppTemplateButtonText(source.label);
    if (
      group === undefined ||
      sourceTexts.get(groupTextKey(buttonGroup(source), text)) !== 1 ||
      targetTexts.get(groupTextKey(group, text)) !== 1
    ) {
      return;
    }
    claim(
      sourceIndex,
      targets.find(
        (target) =>
          inGroup(target, group) &&
          normalizeWhatsAppTemplateButtonText(target.label) === text,
      ),
    );
  });
  if (byIndex) {
    sources.forEach((source, sourceIndex) => {
      const group = targetGroups[sourceIndex];
      claim(
        sourceIndex,
        targets.find(
          (target) => inGroup(target, group) && target.index === source.index,
        ),
      );
    });
  }

  return matches;
}

/**
 * The labelled quick replies of a step's saved template with their ids.
 * Without a map a button's id is its position (offset for a card button); an
 * unsupported map gives every button `null`, never a position.
 */
export function resolveWhatsAppTemplateButtons(
  components: unknown,
  buttonIds: unknown,
): ResolvedWhatsAppTemplateButton[] {
  const buttons = listWhatsAppTemplateQuickReplyButtons(components);
  const normalized = normalizeScenarioWhatsAppTemplateButtonIds(buttonIds);
  if (normalized.status === "absent") {
    return buttons.map((button) => ({
      ...button,
      id: getWhatsAppTemplateButtonPositionId(button),
    }));
  }
  if (normalized.status === "unsupported") {
    return buttons.map((button) => ({ ...button, id: null }));
  }

  const matches = matchWhatsAppTemplateButtons(
    buttons,
    normalized.value.buttons.map(({ id, index, text, cardIndex }) =>
      withCardIndex({ id, index, label: text }, cardIndex),
    ),
    true,
  );
  return buttons.map((button, position) => ({
    ...button,
    id: matches[position]?.id ?? null,
  }));
}

/**
 * Gives the buttons actually sent (a language variant or the live template)
 * the ids of the step's buttons they match: same index and text, then a text
 * unique on both sides, then the same index. Unmatched buttons get `null`.
 */
export function reconcileSentWhatsAppTemplateButtons(
  sent: readonly WhatsAppTemplateQuickReplyButton[],
  resolved: readonly ResolvedWhatsAppTemplateButton[],
): ResolvedWhatsAppTemplateButton[] {
  const matches = matchWhatsAppTemplateButtons(sent, resolved, true);
  return sent.map((button, position) => ({
    ...button,
    id: matches[position]?.id ?? null,
  }));
}

function carryWhatsAppTemplateButtonIds(
  next: readonly WhatsAppTemplateQuickReplyButton[],
  previous: readonly ResolvedWhatsAppTemplateButton[],
  match: WhatsAppTemplateButtonRekeyMatch,
): Array<number | null> {
  if (typeof match === "object") {
    const previousIds = new Set(previous.map((button) => button.id));
    const cardMatches = matchWhatsAppTemplateButtons(next, previous, true);
    let messagePosition = 0;
    return next.map((button, position) => {
      if (button.cardIndex !== undefined) {
        return cardMatches[position]?.id ?? null;
      }
      const origin = match.origins[messagePosition];
      messagePosition += 1;
      return typeof origin === "number" && previousIds.has(origin)
        ? origin
        : null;
    });
  }

  return matchWhatsAppTemplateButtons(next, previous, match === "byIndex").map(
    (button) => button?.id ?? null,
  );
}

/**
 * The map for a step's next template. Buttons carried over keep their ids and
 * new ones get ids from `nextId`. Returns `null` when the previous map is
 * unsupported: its ids cannot be read, so it is left as it is.
 */
export function rekeyWhatsAppTemplateButtonIds(params: {
  previous: { components: unknown; buttonIds: unknown };
  components: unknown;
  match: WhatsAppTemplateButtonRekeyMatch;
}): ScenarioWhatsAppTemplateButtonIds | null {
  const previousIds = normalizeScenarioWhatsAppTemplateButtonIds(
    params.previous.buttonIds,
  );
  if (previousIds.status === "unsupported") return null;

  const previous = resolveWhatsAppTemplateButtons(
    params.previous.components,
    params.previous.buttonIds,
  );
  const next = listWhatsAppTemplateQuickReplyButtons(params.components);
  const carried = carryWhatsAppTemplateButtonIds(next, previous, params.match);
  let nextId = getMintStart(
    previous.flatMap((button) => (button.id === null ? [] : [button.id])),
    previousIds.value?.nextId,
  );
  const usedIds = new Set<number>();
  const buttons = next.map((button, position) => {
    const carriedId = carried[position] ?? null;
    const id =
      carriedId !== null && !usedIds.has(carriedId) ? carriedId : nextId++;
    usedIds.add(id);
    return withCardIndex(
      { id, index: button.index, text: button.label },
      button.cardIndex,
    );
  });

  return {
    version: buttons.some((button) => button.cardIndex !== undefined)
      ? SCENARIO_WHATSAPP_TEMPLATE_CARD_BUTTON_IDS_VERSION
      : SCENARIO_WHATSAPP_TEMPLATE_BUTTON_IDS_VERSION,
    nextId,
    buttons,
  };
}

/**
 * The map a writer stores with the step's next template, or `undefined` to
 * keep the stored key as it is. A step without a map keeps using positions
 * while they still name the same buttons: it had no quick replies, or every
 * button keeps its position's id and no id goes away. An unsupported map is
 * left for a writer that can read it.
 */
export function rekeyStoredWhatsAppTemplateButtonIds(
  params: Parameters<typeof rekeyWhatsAppTemplateButtonIds>[0],
): ScenarioWhatsAppTemplateButtonIds | undefined {
  const map = rekeyWhatsAppTemplateButtonIds(params);
  if (!map) return undefined;
  if (
    normalizeScenarioWhatsAppTemplateButtonIds(params.previous.buttonIds)
      .status !== "absent"
  ) {
    return map;
  }

  const nextIds = new Set(map.buttons.map((button) => button.id));
  const previousIds = listWhatsAppTemplateQuickReplyButtons(
    params.previous.components,
  ).map(getWhatsAppTemplateButtonPositionId);
  const keepsPositions =
    previousIds.length === 0 ||
    (map.buttons.every(
      (button) => button.id === getWhatsAppTemplateButtonPositionId(button),
    ) &&
      previousIds.every((id) => nextIds.has(id)));
  return keepsPositions ? undefined : map;
}

/**
 * Builds each quick reply's tap payload for a template send. The sent buttons
 * are matched to the step's saved buttons, so a tap names the step's button
 * even when the sent order differs. Without a map, a message position that no
 * step button owns keeps today's positional payload. A carousel card's button
 * only gets a payload from a step button on the same card.
 */
export function createWhatsAppTemplateQuickReplyPayloadFactory(params: {
  actionNodeId: string | null | undefined;
  sentComponents: unknown;
  stepComponents?: unknown;
  stepButtonIds?: unknown;
}): (button: { index: number; cardIndex?: number }) => string | null {
  const actionNodeId = params.actionNodeId;
  if (!actionNodeId) return () => null;

  const stepButtons = resolveWhatsAppTemplateButtons(
    params.stepComponents,
    params.stepButtonIds,
  );
  const sentButtons = reconcileSentWhatsAppTemplateButtons(
    listWhatsAppTemplateQuickReplyButtons(params.sentComponents),
    stepButtons,
  );
  const keepsPositions =
    normalizeScenarioWhatsAppTemplateButtonIds(params.stepButtonIds).status ===
    "absent";
  const ownedIds = new Set(stepButtons.map((button) => button.id));

  return ({ index, cardIndex }) => {
    const sentId = sentButtons.find(
      (button) => button.index === index && button.cardIndex === cardIndex,
    )?.id;
    if (typeof sentId === "number") {
      return buildWhatsAppTemplateButtonPayload(actionNodeId, sentId);
    }
    if (cardIndex !== undefined) return null;
    return keepsPositions && !ownedIds.has(index)
      ? buildWhatsAppTemplateButtonPayload(actionNodeId, index)
      : null;
  };
}
