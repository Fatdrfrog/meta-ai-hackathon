import { readStringField } from "@icecore/shared/lib/value-utils";

export const INSTAGRAM_QUICK_REPLY_TITLE_MAX_CHARS = 20;
export const INSTAGRAM_BUTTON_TITLE_MAX_CHARS = 20;
export const INSTAGRAM_PAYLOAD_MAX_CHARS = 1000;
export const INSTAGRAM_QUICK_REPLY_MAX_COUNT = 13;
export const INSTAGRAM_TEMPLATE_BUTTON_MAX_COUNT = 3;
export const INSTAGRAM_GENERIC_CARD_MAX_COUNT = 10;

export type ScenarioInstagramMessageKind =
  | "text"
  | "quick_replies"
  | "button_template"
  | "generic_template"
  | "media";

export type ScenarioInstagramButtonType = "postback" | "web_url";

export type ScenarioInstagramQuickReply = {
  title: string;
  payload: string;
};

export type ScenarioInstagramButton = {
  type: ScenarioInstagramButtonType;
  title: string;
  payload?: string;
  url?: string;
};

export type ScenarioInstagramGenericCard = {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons?: ScenarioInstagramButton[];
};

export type ScenarioInstagramMediaType = "image" | "video" | "audio";

export type ScenarioInstagramConfig = {
  kind: ScenarioInstagramMessageKind;
  quickReplies?: ScenarioInstagramQuickReply[];
  buttons?: ScenarioInstagramButton[];
  cards?: ScenarioInstagramGenericCard[];
  mediaType?: ScenarioInstagramMediaType;
  mediaUrl?: string;
};

export const DEFAULT_INSTAGRAM_CONFIG: ScenarioInstagramConfig = {
  kind: "quick_replies",
  quickReplies: [],
};

export type InstagramBranchOption = {
  id: string;
  label: string;
};

const INSTAGRAM_MESSAGE_KINDS = new Set<ScenarioInstagramMessageKind>([
  "text",
  "quick_replies",
  "button_template",
  "generic_template",
  "media",
]);

function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function stableTextHash(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return hash.toString(36);
}

export function generateInstagramPayload(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (slug || `ig_${stableTextHash(title || "button")}`).slice(
    0,
    INSTAGRAM_PAYLOAD_MAX_CHARS
  );
}

function normalizePayload(value: string, fallbackTitle: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || generateInstagramPayload(fallbackTitle)).slice(
    0,
    INSTAGRAM_PAYLOAD_MAX_CHARS
  );
}

function ensureUniquePayload(payload: string, used: Set<string>): string {
  if (!used.has(payload)) {
    used.add(payload);
    return payload;
  }

  let suffix = 2;
  while (suffix < 10_000) {
    const suffixText = `_${suffix}`;
    const base = payload.slice(
      0,
      INSTAGRAM_PAYLOAD_MAX_CHARS - suffixText.length
    );
    const candidate = `${base}${suffixText}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    suffix += 1;
  }

  const fallback = `${payload.slice(0, INSTAGRAM_PAYLOAD_MAX_CHARS - 2)}_x`;
  used.add(fallback);
  return fallback;
}

function normalizeUrl(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeQuickReplies(
  value: unknown,
  usedPayloads: Set<string>
): ScenarioInstagramQuickReply[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const title = clampText(
        readStringField(record, "title", { trim: true }),
        INSTAGRAM_QUICK_REPLY_TITLE_MAX_CHARS
      );
      if (!title) return [];
      const rawPayload = readStringField(record, "payload", { trim: true });
      const payload = ensureUniquePayload(
        normalizePayload(rawPayload, title),
        usedPayloads
      );
      return [{ title, payload }];
    })
    .slice(0, INSTAGRAM_QUICK_REPLY_MAX_COUNT);
}

function normalizeButtons(
  value: unknown,
  usedPayloads: Set<string>,
  maxCount = INSTAGRAM_TEMPLATE_BUTTON_MAX_COUNT
): ScenarioInstagramButton[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((item): ScenarioInstagramButton[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const title = clampText(
        readStringField(record, "title", { trim: true }),
        INSTAGRAM_BUTTON_TITLE_MAX_CHARS
      );
      if (!title) return [];

      if (record.type === "web_url") {
        const url = normalizeUrl(
          readStringField(record, "url", { trim: true })
        );
        return url ? [{ type: "web_url" as const, title, url }] : [];
      }

      const payload = ensureUniquePayload(
        normalizePayload(
          readStringField(record, "payload", { trim: true }),
          title
        ),
        usedPayloads
      );
      return [{ type: "postback" as const, title, payload }];
    })
    .slice(0, maxCount);
}

function normalizeCards(
  value: unknown,
  usedPayloads: Set<string>
): ScenarioInstagramGenericCard[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const title = readStringField(record, "title", { trim: true }).slice(
        0,
        80
      );
      if (!title) return [];
      const id =
        readStringField(record, "id", { trim: true }) || `card-${index + 1}`;
      const subtitle = readStringField(record, "subtitle", {
        trim: true,
      }).slice(0, 80);
      const imageUrl = normalizeUrl(
        readStringField(record, "imageUrl", { trim: true })
      );
      const buttons = normalizeButtons(
        record.buttons,
        usedPayloads,
        INSTAGRAM_TEMPLATE_BUTTON_MAX_COUNT
      );

      return [
        {
          id,
          title,
          ...(subtitle ? { subtitle } : {}),
          ...(imageUrl ? { imageUrl } : {}),
          ...(buttons.length > 0 ? { buttons } : {}),
        },
      ];
    })
    .slice(0, INSTAGRAM_GENERIC_CARD_MAX_COUNT);
}

export function normalizeInstagramConfig(
  value: unknown
): ScenarioInstagramConfig {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_INSTAGRAM_CONFIG };
  }

  const record = value as Record<string, unknown>;
  const kind = INSTAGRAM_MESSAGE_KINDS.has(
    record.kind as ScenarioInstagramMessageKind
  )
    ? (record.kind as ScenarioInstagramMessageKind)
    : DEFAULT_INSTAGRAM_CONFIG.kind;
  const usedPayloads = new Set<string>();

  if (kind === "text") {
    return { kind };
  }

  if (kind === "button_template") {
    return {
      kind,
      buttons: normalizeButtons(record.buttons, usedPayloads),
    };
  }

  if (kind === "generic_template") {
    // Instagram's generic template has no root buttons, so stored ones were
    // never sent and their branches could never fire.
    return {
      kind,
      cards: normalizeCards(record.cards, usedPayloads),
    };
  }

  if (kind === "media") {
    const mediaType =
      record.mediaType === "video" || record.mediaType === "audio"
        ? record.mediaType
        : "image";
    const mediaUrl = normalizeUrl(
      readStringField(record, "mediaUrl", { trim: true })
    );
    return {
      kind,
      mediaType,
      ...(mediaUrl ? { mediaUrl } : {}),
    };
  }

  return {
    kind: "quick_replies",
    quickReplies: normalizeQuickReplies(record.quickReplies, usedPayloads),
  };
}

export function extractInstagramBranchOptions(
  value: unknown
): InstagramBranchOption[] {
  const config = normalizeInstagramConfig(value);

  if (config.kind === "quick_replies") {
    return (config.quickReplies ?? []).map(option => ({
      id: option.payload,
      label: option.title,
    }));
  }

  const rootButtons = (config.buttons ?? [])
    .filter(button => button.type === "postback" && button.payload)
    .map(button => ({
      id: button.payload!,
      label: button.title,
    }));
  const cardButtons = (config.cards ?? []).flatMap(card =>
    (card.buttons ?? [])
      .filter(button => button.type === "postback" && button.payload)
      .map(button => ({
        id: button.payload!,
        label: button.title,
      }))
  );

  return [...rootButtons, ...cardButtons];
}
