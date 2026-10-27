export const TIKTOK_DISCOVERY_MARKETS = [
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
] as const;

export const TIKTOK_DISCOVERY_CATEGORIES = [
  "ALL",
  "APPAREL_AND_ACCESSORIES",
  "BABY_KIDS_AND_MATERNITY",
  "BEAUTY_AND_PERSONAL_CARE",
  "BUSINESS_SERVICES",
  "EDUCATION",
  "FINANCIAL_SERVICES",
  "FOOD_AND_BEVERAGE",
  "GAMES",
  "HEALTH",
  "HOME_IMPROVEMENT",
  "HOUSEHOLD_PRODUCTS",
  "LIFE_SERVICES",
  "NEWS_AND_ENTERTAINMENT",
  "PETS",
  "SPORTS_AND_OUTDOOR",
  "TECHNOLOGY",
  "TRAVEL",
  "VEHICLE_AND_TRANSPORTATION",
] as const;

export type TikTokDiscoveryMarket = (typeof TIKTOK_DISCOVERY_MARKETS)[number];
export type TikTokDiscoveryCategory =
  (typeof TIKTOK_DISCOVERY_CATEGORIES)[number];

export type TikTokMarketingTemplateReference = {
  providerVideoId: string;
  shareUrl: string;
  thumbnailUrl: string | null;
  creatorName: string | null;
  creatorUrl: string | null;
  hashtag: string;
  hashtagRank: number;
  videoRank: number;
  market: TikTokDiscoveryMarket;
  category: TikTokDiscoveryCategory;
  windowDays: 7;
};

export type TikTokMarketingTemplateCatalogItem = {
  id: `tiktok:${string}`;
  source: "tiktok_discovery";
  title: string;
  preset: null;
  reference: TikTokMarketingTemplateReference;
};

export type TikTokMarketingTemplatesResponse =
  | {
      status: "ok";
      items: TikTokMarketingTemplateCatalogItem[];
      market: TikTokDiscoveryMarket;
      category: TikTokDiscoveryCategory;
      windowDays: 7;
      updatedAt: string;
      stale: boolean;
      warning?: "provider_unavailable" | "provider_rate_limited";
    }
  | { status: "unavailable"; items: [] }
  | {
      status: "temporarily_unavailable";
      items: [];
      retryAt?: string;
    }
  | { status: "error"; items: []; retryable: boolean };

export type TikTokDiscoveryPreferences = {
  market: TikTokDiscoveryMarket;
  category: TikTokDiscoveryCategory;
};

const MARKET_SET = new Set<string>(TIKTOK_DISCOVERY_MARKETS);
const CATEGORY_SET = new Set<string>(TIKTOK_DISCOVERY_CATEGORIES);
const TIKTOK_SHARE_ROOTS = ["tiktok.com"] as const;
const TIKTOK_THUMBNAIL_ROOTS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "muscdn.com",
] as const;
const MAX_CATALOG_ITEMS = 12;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TITLE_LENGTH = 500;
const MAX_CREATOR_LENGTH = 128;
const MAX_HASHTAG_LENGTH = 200;
const MAX_PROVIDER_RANK = 1_000;
const MAX_URL_LENGTH = 2_048;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
export const DEFAULT_TIKTOK_DISCOVERY_MARKET = "KZ" as const;
export const DEFAULT_TIKTOK_DISCOVERY_CATEGORY = "ALL" as const;
export const TIKTOK_DISCOVERY_WINDOW_DAYS = 7 as const;

export function isTikTokDiscoveryMarket(
  value: unknown
): value is TikTokDiscoveryMarket {
  return typeof value === "string" && MARKET_SET.has(value);
}

export function isTikTokDiscoveryCategory(
  value: unknown
): value is TikTokDiscoveryCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && "value" in descriptor);
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    keys.every(key => typeof key === "string" && allowed.has(key)) &&
    required.every(key => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isPlainJsonArray(value: unknown, maximum: number): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return keys.every(
    key =>
      key === "length" ||
      (typeof key === "string" &&
        Number.isSafeInteger(Number(key)) &&
        Number(key) >= 0 &&
        Number(key) < value.length &&
        String(Number(key)) === key)
  );
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

export function isTikTokDiscoveryIdentifier(value: unknown): value is string {
  return (
    isBoundedText(value, MAX_IDENTIFIER_LENGTH) &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isProviderRank(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_PROVIDER_RANK
  );
}

function isResponseWarning(
  value: unknown
): value is "provider_unavailable" | "provider_rate_limited" {
  return value === "provider_unavailable" || value === "provider_rate_limited";
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 24) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? value : null;
}

function normalizeAllowedHttpsUrl(
  value: unknown,
  roots: readonly string[]
): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const allowed = roots.some(
      root => hostname === root || hostname.endsWith(`.${root}`)
    );
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !allowed
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function decodeCatalogItem(
  value: unknown,
  expected: {
    market: TikTokDiscoveryMarket;
    category: TikTokDiscoveryCategory;
  }
): TikTokMarketingTemplateCatalogItem | null {
  if (
    !isPlainDataRecord(value) ||
    !hasExactKeys(value, ["id", "source", "title", "preset", "reference"]) ||
    value.source !== "tiktok_discovery" ||
    value.preset !== null ||
    !isBoundedText(value.title, MAX_TITLE_LENGTH) ||
    !isPlainDataRecord(value.reference)
  ) {
    return null;
  }

  const reference = value.reference;
  if (
    !hasExactKeys(reference, [
      "providerVideoId",
      "shareUrl",
      "thumbnailUrl",
      "creatorName",
      "creatorUrl",
      "hashtag",
      "hashtagRank",
      "videoRank",
      "market",
      "category",
      "windowDays",
    ]) ||
    !isTikTokDiscoveryIdentifier(reference.providerVideoId) ||
    value.id !== `tiktok:${reference.providerVideoId}` ||
    (reference.creatorName !== null &&
      !isBoundedText(reference.creatorName, MAX_CREATOR_LENGTH)) ||
    !isBoundedText(reference.hashtag, MAX_HASHTAG_LENGTH) ||
    !isProviderRank(reference.hashtagRank) ||
    !isProviderRank(reference.videoRank) ||
    reference.market !== expected.market ||
    reference.category !== expected.category ||
    reference.windowDays !== TIKTOK_DISCOVERY_WINDOW_DAYS
  ) {
    return null;
  }

  const shareUrl = normalizeAllowedHttpsUrl(
    reference.shareUrl,
    TIKTOK_SHARE_ROOTS
  );
  const thumbnailUrl =
    reference.thumbnailUrl === null
      ? null
      : normalizeAllowedHttpsUrl(
          reference.thumbnailUrl,
          TIKTOK_THUMBNAIL_ROOTS
        );
  const creatorUrl =
    reference.creatorUrl === null
      ? null
      : normalizeAllowedHttpsUrl(reference.creatorUrl, TIKTOK_SHARE_ROOTS);
  if (
    shareUrl === null ||
    (reference.thumbnailUrl !== null && thumbnailUrl === null) ||
    (reference.creatorUrl !== null && creatorUrl === null)
  ) {
    return null;
  }

  return {
    id: `tiktok:${reference.providerVideoId}`,
    source: "tiktok_discovery",
    title: value.title,
    preset: null,
    reference: {
      providerVideoId: reference.providerVideoId,
      shareUrl,
      thumbnailUrl,
      creatorName: reference.creatorName,
      creatorUrl,
      hashtag: reference.hashtag,
      hashtagRank: reference.hashtagRank,
      videoRank: reference.videoRank,
      market: expected.market,
      category: expected.category,
      windowDays: TIKTOK_DISCOVERY_WINDOW_DAYS,
    },
  };
}

function decodeResponse(
  value: unknown,
  expected: {
    market: TikTokDiscoveryMarket;
    category: TikTokDiscoveryCategory;
  }
): TikTokMarketingTemplatesResponse | null {
  if (
    !isPlainDataRecord(value) ||
    !isTikTokDiscoveryMarket(expected.market) ||
    !isTikTokDiscoveryCategory(expected.category)
  ) {
    return null;
  }

  if (value.status === "unavailable") {
    if (
      !hasExactKeys(value, ["status", "items"]) ||
      !isPlainJsonArray(value.items, 0)
    ) {
      return null;
    }
    return { status: "unavailable", items: [] };
  }

  if (value.status === "temporarily_unavailable") {
    if (
      !hasExactKeys(value, ["status", "items"], ["retryAt"]) ||
      !isPlainJsonArray(value.items, 0)
    ) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(value, "retryAt")) {
      return { status: "temporarily_unavailable", items: [] };
    }
    const retryAt = normalizeIsoTimestamp(value.retryAt);
    return retryAt === null
      ? null
      : { status: "temporarily_unavailable", items: [], retryAt };
  }

  if (value.status === "error") {
    if (
      !hasExactKeys(value, ["status", "items", "retryable"]) ||
      !isPlainJsonArray(value.items, 0) ||
      typeof value.retryable !== "boolean"
    ) {
      return null;
    }
    return { status: "error", items: [], retryable: value.retryable };
  }

  if (
    value.status !== "ok" ||
    !hasExactKeys(
      value,
      [
        "status",
        "items",
        "market",
        "category",
        "windowDays",
        "updatedAt",
        "stale",
      ],
      ["warning"]
    ) ||
    value.market !== expected.market ||
    value.category !== expected.category ||
    value.windowDays !== TIKTOK_DISCOVERY_WINDOW_DAYS ||
    typeof value.stale !== "boolean" ||
    !isPlainJsonArray(value.items, MAX_CATALOG_ITEMS)
  ) {
    return null;
  }

  const updatedAt = normalizeIsoTimestamp(value.updatedAt);
  const hasWarning = Object.prototype.hasOwnProperty.call(value, "warning");
  const warning = hasWarning ? value.warning : undefined;
  if (updatedAt === null || (hasWarning && !isResponseWarning(warning))) {
    return null;
  }

  const items: TikTokMarketingTemplateCatalogItem[] = [];
  const providerVideoIds = new Set<string>();
  for (const rawItem of value.items) {
    const item = decodeCatalogItem(rawItem, expected);
    if (item === null || providerVideoIds.has(item.reference.providerVideoId)) {
      return null;
    }
    providerVideoIds.add(item.reference.providerVideoId);
    items.push(item);
  }

  const response: Extract<TikTokMarketingTemplatesResponse, { status: "ok" }> =
    {
      status: "ok",
      items,
      market: expected.market,
      category: expected.category,
      windowDays: TIKTOK_DISCOVERY_WINDOW_DAYS,
      updatedAt,
      stale: value.stale,
    };
  if (isResponseWarning(warning)) {
    response.warning = warning;
  }
  return response;
}

export function decodeTikTokMarketingTemplatesResponse(
  value: unknown,
  expected: {
    market: TikTokDiscoveryMarket;
    category: TikTokDiscoveryCategory;
  }
): TikTokMarketingTemplatesResponse | null {
  try {
    return decodeResponse(value, expected);
  } catch {
    return null;
  }
}

export function normalizeTikTokDiscoveryPreferences(
  value: unknown
): TikTokDiscoveryPreferences {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    market: isTikTokDiscoveryMarket(record.market) ? record.market : "KZ",
    category: isTikTokDiscoveryCategory(record.category)
      ? record.category
      : "ALL",
  };
}

export function getTikTokDiscoveryPreferencesStorageKey(
  workspaceId: string
): string {
  return `airi:assets:tiktok-discovery-preferences:v1:${workspaceId}`;
}

export function buildTikTokMarketingTemplatesUrl(input: {
  workspaceId: string;
  market: TikTokDiscoveryMarket;
  category: TikTokDiscoveryCategory;
}): string {
  const query = new URLSearchParams({
    market: input.market,
    category: input.category,
  });
  return `/api/workspaces/${encodeURIComponent(input.workspaceId)}/assets/marketing-templates/tiktok?${query.toString()}`;
}
