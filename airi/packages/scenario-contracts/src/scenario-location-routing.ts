import { isRecord } from "./value-guards";

/**
 * Location routes: a location the customer shares goes to the nearest active
 * office of the workspace's Offices catalog, then down the first route whose
 * group contains that office. Distance is a straight line (haversine). There
 * is no geocoding, so country and city always come from the nearest office,
 * never from the free-text name or address of the share.
 */

export const MAX_SCENARIO_LOCATION_ROUTES = 20;
export const MAX_SCENARIO_LOCATION_ROUTE_VALUES = 50;
export const DEFAULT_SCENARIO_LOCATION_MAX_DISTANCE_KM = 100;
export const MAX_SCENARIO_LOCATION_MAX_DISTANCE_KM = 20_000;
/** Location decisions kept for one scenario; the earliest is dropped past this. */
export const MAX_SCENARIO_ROUTED_LOCATIONS = 10;
export const MAX_SCENARIO_BUSINESS_LOCATIONS = 500;
/** The longest text an office keeps per field, and how many tags it keeps. */
export const SCENARIO_BUSINESS_LOCATION_LIMITS = {
  keyLength: 64,
  nameLength: 160,
  cityLength: 120,
  addressLength: 240,
  phoneLength: 40,
  mapUrlLength: 500,
  tags: 10,
  tagLength: 40,
} as const;
/** An office farther than this from every other office of its city gets a warning. */
export const SCENARIO_LOCATION_OUTLIER_DISTANCE_KM = 50;
/**
 * Meta stamps inbound messages in whole seconds while a wait starts at an
 * exact server time, so a share may read up to this much before its wait.
 */
export const SCENARIO_LOCATION_WAIT_SKEW_MS = 2_000;
/**
 * A share no turn decided (one merged into another message, or a turn that
 * was dropped) is routed this long after it arrived, instead of waiting for
 * the No reply reminder.
 */
export const SCENARIO_LOCATION_RESCUE_DELAY_MS = 60_000;

export const SCENARIO_LOCATION_ROUTE_MATCH_KINDS = [
  "country",
  "city",
  "tag",
  "office",
] as const;

export type ScenarioLocationRouteMatchKind =
  (typeof SCENARIO_LOCATION_ROUTE_MATCH_KINDS)[number];

/**
 * A group of offices. Values are ISO-3166 alpha-2 countries, `COUNTRY:cityKey`
 * cities (so same-name cities of two countries stay apart), catalog tags or
 * office keys.
 */
export type ScenarioActionLocationRoute = {
  id: string;
  label?: string;
  match: { by: ScenarioLocationRouteMatchKind; values: string[] };
};

/**
 * Routes are checked in order and the first that contains the nearest office
 * wins; "Any other office" takes the rest. With `outside`, an office farther
 * than `maxDistanceKm` takes "No office within N km" instead.
 */
export type ScenarioActionLocationRoutes = {
  routes: ScenarioActionLocationRoute[];
  outside?: { maxDistanceKm: number };
};

const MAX_ROUTE_ID_LENGTH = 80;
const MAX_ROUTE_LABEL_LENGTH = 80;
const MAX_OFFICE_KEY_LENGTH = SCENARIO_BUSINESS_LOCATION_LIMITS.keyLength;
const MAX_OFFICE_NAME_LENGTH = SCENARIO_BUSINESS_LOCATION_LIMITS.nameLength;
const MAX_OFFICE_CITY_LENGTH = SCENARIO_BUSINESS_LOCATION_LIMITS.cityLength;
const MAX_OFFICE_ADDRESS_LENGTH =
  SCENARIO_BUSINESS_LOCATION_LIMITS.addressLength;
const MAX_OFFICE_PHONE_LENGTH = SCENARIO_BUSINESS_LOCATION_LIMITS.phoneLength;
const MAX_OFFICE_MAP_URL_LENGTH =
  SCENARIO_BUSINESS_LOCATION_LIMITS.mapUrlLength;
const MAX_OFFICE_TAGS = SCENARIO_BUSINESS_LOCATION_LIMITS.tags;
const MAX_OFFICE_TAG_LENGTH = SCENARIO_BUSINESS_LOCATION_LIMITS.tagLength;
const MAX_LEDGER_ID_LENGTH = 256;
const MAX_UNROUTED_REASON_LENGTH = 40;
const COORDINATE_PRECISION = 6;
const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Single spaces and trimmed, at any length; "" for a non-string. Text people
 * read keeps what was typed (NFC, so "№5" stays "№5"); values only compared,
 * such as city keys and tags, also fold compatibility forms (NFKC).
 */
function collapseText(value: unknown, form: "NFC" | "NFKC" = "NFC"): string {
  if (typeof value !== "string") return "";
  return value.normalize(form).replace(/\s+/g, " ").trim();
}

function normalizeText(
  value: unknown,
  maxLength: number,
  form: "NFC" | "NFKC" = "NFC",
): string {
  return collapseText(value, form).slice(0, maxLength);
}

function normalizeIdValue(value: unknown, maxLength: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
}

/** Route ids follow answer-rule ids: `[A-Za-z0-9_-]`, at most 80 characters. */
export function normalizeScenarioLocationRouteId(
  value: unknown,
  fallbackIndex = 0,
): string {
  return (
    normalizeIdValue(value, MAX_ROUTE_ID_LENGTH) ||
    `location_${fallbackIndex + 1}`
  );
}

/** An ISO-3166 alpha-2 code in upper case, or null. */
export function normalizeScenarioLocationCountry(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const country = value.normalize("NFKC").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

/** The comparable form of a city name: NFKC, lower case, single spaces. */
export function normalizeScenarioLocationCityKey(value: unknown): string {
  return normalizeText(value, MAX_OFFICE_CITY_LENGTH, "NFKC").toLowerCase();
}

/** A city route value, `COUNTRY:cityKey`, or null without both parts. */
export function buildScenarioLocationCityValue(
  country: unknown,
  city: unknown,
): string | null {
  const normalizedCountry = normalizeScenarioLocationCountry(country);
  const cityKey = normalizeScenarioLocationCityKey(city);
  return normalizedCountry && cityKey
    ? `${normalizedCountry}:${cityKey}`
    : null;
}

export function normalizeScenarioLocationTag(value: unknown): string {
  return normalizeText(value, MAX_OFFICE_TAG_LENGTH, "NFKC").toLowerCase();
}

/** Office keys are chosen by the merchant: `[A-Za-z0-9_-]`, 1 to 64 long. */
export function normalizeScenarioBusinessLocationKey(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return /^[A-Za-z0-9_-]+$/.test(key) && key.length <= MAX_OFFICE_KEY_LENGTH
    ? key
    : null;
}

function normalizeRouteValue(
  kind: ScenarioLocationRouteMatchKind,
  value: unknown,
): string | null {
  switch (kind) {
    case "country":
      return normalizeScenarioLocationCountry(value);
    case "city": {
      if (typeof value !== "string") return null;
      const separator = value.indexOf(":");
      if (separator < 0) return null;
      return buildScenarioLocationCityValue(
        value.slice(0, separator),
        value.slice(separator + 1),
      );
    }
    case "tag":
      return normalizeScenarioLocationTag(value) || null;
    case "office":
      return normalizeScenarioBusinessLocationKey(value);
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function isRouteMatchKind(
  value: unknown,
): value is ScenarioLocationRouteMatchKind {
  return SCENARIO_LOCATION_ROUTE_MATCH_KINDS.some((kind) => kind === value);
}

function normalizeRouteValues(
  kind: ScenarioLocationRouteMatchKind,
  value: unknown,
): string[] {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const normalized = normalizeRouteValue(kind, raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
    if (values.length === MAX_SCENARIO_LOCATION_ROUTE_VALUES) break;
  }
  return values;
}

/** Unique and still a valid route id, so its handle names this route only. */
function createUniqueId(baseId: string, seen: Set<string>): string {
  let id = baseId;
  let suffix = 2;
  while (seen.has(id)) {
    const tail = `_${suffix}`;
    id = `${baseId.slice(0, MAX_ROUTE_ID_LENGTH - tail.length).replace(/_+$/, "")}${tail}`;
    suffix += 1;
  }
  seen.add(id);
  return id;
}

/** A clamped whole number of kilometres; an unreadable value takes the default. */
export function normalizeScenarioLocationMaxDistanceKm(value: unknown): number {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim().replace(",", "."))
        : Number.NaN;
  if (!Number.isFinite(raw)) return DEFAULT_SCENARIO_LOCATION_MAX_DISTANCE_KM;
  return Math.min(
    MAX_SCENARIO_LOCATION_MAX_DISTANCE_KM,
    Math.max(1, Math.round(raw)),
  );
}

/**
 * The routes a step stores. A route keeps its place while the merchant edits
 * it, even with no values yet, and `outside` stays while its switch is on,
 * so a draft edit never drops a route and its connection; activation checks
 * that every route has values.
 */
export function normalizeScenarioActionLocationRoutes(
  value: unknown,
): ScenarioActionLocationRoutes | undefined {
  if (!isRecord(value)) return undefined;

  const routes: ScenarioActionLocationRoute[] = [];
  const seenIds = new Set<string>();
  const rawRoutes = Array.isArray(value.routes) ? value.routes : [];
  for (const [index, rawRoute] of rawRoutes.entries()) {
    if (!isRecord(rawRoute) || !isRecord(rawRoute.match)) continue;
    const kind = rawRoute.match.by;
    if (!isRouteMatchKind(kind)) continue;

    const label = normalizeText(rawRoute.label, MAX_ROUTE_LABEL_LENGTH);
    routes.push({
      id: createUniqueId(
        normalizeScenarioLocationRouteId(rawRoute.id, index),
        seenIds,
      ),
      ...(label ? { label } : {}),
      match: {
        by: kind,
        values: normalizeRouteValues(kind, rawRoute.match.values),
      },
    });
    if (routes.length === MAX_SCENARIO_LOCATION_ROUTES) break;
  }

  return {
    routes,
    ...(isRecord(value.outside)
      ? {
          outside: {
            maxDistanceKm: normalizeScenarioLocationMaxDistanceKm(
              value.outside.maxDistanceKm,
            ),
          },
        }
      : {}),
  };
}

/**
 * Route ids that two stored routes share once normalized, before
 * normalization renames one, so the compiler can block the graph.
 */
export function listDuplicateScenarioLocationRouteIds(
  value: unknown,
): string[] {
  if (!isRecord(value) || !Array.isArray(value.routes)) return [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const rawRoute of value.routes) {
    if (!isRecord(rawRoute)) continue;
    const id = normalizeIdValue(rawRoute.id, MAX_ROUTE_ID_LENGTH);
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

export type ScenarioLocationPoint = { latitude: number; longitude: number };

/**
 * A coordinate typed or pasted by a merchant: a number, or a string with a
 * dot or comma decimal, within range, rounded to 6 decimals.
 */
export function parseScenarioLocationCoordinate(
  value: unknown,
  axis: "latitude" | "longitude",
): number | null {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim().replace(",", "."))
        : Number.NaN;
  const limit = axis === "latitude" ? 90 : 180;
  if (!Number.isFinite(raw) || raw < -limit || raw > limit) return null;
  return Number(raw.toFixed(COORDINATE_PRECISION));
}

function isNullIsland(point: ScenarioLocationPoint): boolean {
  return point.latitude === 0 && point.longitude === 0;
}

/**
 * The point a customer shared. Meta sends numbers; anything else, an
 * out-of-range value or 0,0 is not a usable share.
 */
export function normalizeScenarioSharedLocationPoint(
  value: unknown,
): ScenarioLocationPoint | null {
  if (!isRecord(value)) return null;
  const { latitude, longitude } = value;
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return null;
  }
  const point = {
    latitude: parseScenarioLocationCoordinate(latitude, "latitude"),
    longitude: parseScenarioLocationCoordinate(longitude, "longitude"),
  };
  if (point.latitude === null || point.longitude === null) return null;
  const parsed = { latitude: point.latitude, longitude: point.longitude };
  return isNullIsland(parsed) ? null : parsed;
}

/** Straight-line distance in whole metres. */
export function measureScenarioLocationDistanceMeters(
  from: ScenarioLocationPoint,
  to: ScenarioLocationPoint,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return Math.round(
    2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine))),
  );
}

/** A Google Maps link to a point, as the conversation thread shows shares. */
export function buildScenarioLocationMapsUrl(
  point: ScenarioLocationPoint,
): string {
  return `https://www.google.com/maps?q=${point.latitude},${point.longitude}`;
}

export type ScenarioLocationInput =
  | {
      status: "point";
      point: ScenarioLocationPoint;
      source: "coordinates" | "maps_link";
    }
  /** A short share link (maps.app.goo.gl, goo.gl/maps, go.2gis.com, yandex …/maps/-/): a redirect that is never followed. */
  | { status: "short_link" }
  /** A link that names no point: q=<address>, a 2GIS or Yandex card, any other site. */
  | { status: "no_coordinates" }
  /** Empty, unreadable, out of range, or 0,0. */
  | { status: "invalid" };

/** "lat, lng", "lat,lng", "lat; lng" or "lat lng", with dot or comma decimals. */
// The separator alternatives don't overlap, so a long run of spaces fails in
// linear time.
const COORDINATE_PAIR_PATTERN =
  /^(-?\d{1,3}(?:[.,]\d+)?)(?:\s*[,;]\s*|\s+)(-?\d{1,3}(?:[.,]\d+)?)$/;
/** Longer pasted text is not a pair of coordinates or a map link. */
const MAX_LOCATION_INPUT_LENGTH = 2_000;
/** Hand-typed map links often drop the scheme. */
const SCHEMELESS_MAP_LINK_PATTERN =
  /^(?:www\.|maps\.|google\.|goo\.gl|go\.2gis\.com)/i;
const GOOGLE_HOST_PATTERN = /^google\.(?:com?\.)?[a-z]{2,3}$/;
const GOOGLE_MAPS_HOST_PATTERN = /^maps\.google\.(?:com?\.)?[a-z]{2,3}$/;
const YANDEX_HOST_PATTERN = /^yandex\.(?:com?\.)?[a-z]{2,3}$/;
/** The place pin of a Google Maps place link. */
const GOOGLE_PLACE_PIN_PATTERN = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g;
/** The map centre of a Google Maps link, less exact than the pin. */
const GOOGLE_MAP_CENTER_PATTERN = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
const GOOGLE_POINT_PARAMS = ["q", "query", "ll", "destination", "daddr"];

function matchCoordinatePair(text: string): RegExpExecArray | null {
  return COORDINATE_PAIR_PATTERN.exec(text.trim());
}

function toLocationInput(
  latitude: unknown,
  longitude: unknown,
  source: "coordinates" | "maps_link",
): ScenarioLocationInput {
  const point = {
    latitude: parseScenarioLocationCoordinate(latitude, "latitude"),
    longitude: parseScenarioLocationCoordinate(longitude, "longitude"),
  };
  if (point.latitude === null || point.longitude === null) {
    return { status: "invalid" };
  }
  const parsed = { latitude: point.latitude, longitude: point.longitude };
  return isNullIsland(parsed)
    ? { status: "invalid" }
    : { status: "point", point: parsed, source };
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** A pasted "lat, lng" or a full Google Maps link, read locally and never fetched. */
export function parseScenarioLocationInput(
  value: unknown,
): ScenarioLocationInput {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_LOCATION_INPUT_LENGTH) {
    return { status: "invalid" };
  }
  const pair = matchCoordinatePair(text);
  if (pair) return toLocationInput(pair[1], pair[2], "coordinates");

  let url: URL;
  try {
    url = new URL(
      SCHEMELESS_MAP_LINK_PATTERN.test(text) ? `https://${text}` : text,
    );
  } catch {
    return { status: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { status: "invalid" };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname;
  if (
    host === "maps.app.goo.gl" ||
    (host === "goo.gl" && path.startsWith("/maps")) ||
    host === "go.2gis.com" ||
    (YANDEX_HOST_PATTERN.test(host) && path.startsWith("/maps/-/"))
  ) {
    return { status: "short_link" };
  }
  // 2GIS and Yandex links put longitude first, so only Google links are read.
  const isGoogleMaps =
    (GOOGLE_HOST_PATTERN.test(host) && path.startsWith("/maps")) ||
    GOOGLE_MAPS_HOST_PATTERN.test(host);
  if (!isGoogleMaps) return { status: "no_coordinates" };

  const pin = [...decodeHref(url.href).matchAll(GOOGLE_PLACE_PIN_PATTERN)].at(
    -1,
  );
  if (pin) return toLocationInput(pin[1], pin[2], "maps_link");
  for (const name of GOOGLE_POINT_PARAMS) {
    const param = url.searchParams.get(name);
    const paramPair = param
      ? matchCoordinatePair(param.trim().replace(/^loc:/i, ""))
      : null;
    if (paramPair)
      return toLocationInput(paramPair[1], paramPair[2], "maps_link");
  }
  const center = GOOGLE_MAP_CENTER_PATTERN.exec(path);
  return center
    ? toLocationInput(center[1], center[2], "maps_link")
    : { status: "no_coordinates" };
}

/** One office of the workspace catalog, as routing reads it. */
export type ScenarioBusinessLocation = {
  key: string;
  name: string;
  country: string;
  city: string;
  cityKey: string;
  address?: string;
  phone?: string;
  mapUrl?: string;
  tags: string[];
  latitude: number;
  longitude: number;
  sortOrder: number;
};

function normalizeMapUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || raw.length > MAX_OFFICE_MAP_URL_LENGTH) return undefined;
  try {
    return new URL(raw).protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const raw of value) {
    const tag = normalizeScenarioLocationTag(raw);
    if (!tag || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length === MAX_OFFICE_TAGS) break;
  }
  return tags;
}

/**
 * One normalizer for every reader of the catalog: the API, the import, the
 * runtime and the preview. An office without a key, name, country, city or
 * usable coordinates is not an office.
 */
export function normalizeScenarioBusinessLocation(
  value: unknown,
): ScenarioBusinessLocation | null {
  if (!isRecord(value)) return null;
  const key = normalizeScenarioBusinessLocationKey(value.key);
  const name = normalizeText(value.name, MAX_OFFICE_NAME_LENGTH);
  const country = normalizeScenarioLocationCountry(value.country);
  const city = normalizeText(value.city, MAX_OFFICE_CITY_LENGTH);
  const latitude = parseScenarioLocationCoordinate(value.latitude, "latitude");
  const longitude = parseScenarioLocationCoordinate(
    value.longitude,
    "longitude",
  );
  if (
    !key ||
    !name ||
    !country ||
    !city ||
    latitude === null ||
    longitude === null ||
    isNullIsland({ latitude, longitude })
  ) {
    return null;
  }
  const address = normalizeText(value.address, MAX_OFFICE_ADDRESS_LENGTH);
  const phone = normalizeText(value.phone, MAX_OFFICE_PHONE_LENGTH);
  const mapUrl = normalizeMapUrl(value.mapUrl);
  const sortOrder =
    typeof value.sortOrder === "number" && Number.isSafeInteger(value.sortOrder)
      ? value.sortOrder
      : 0;
  return {
    key,
    name,
    country,
    city,
    cityKey: normalizeScenarioLocationCityKey(city),
    ...(address ? { address } : {}),
    ...(phone ? { phone } : {}),
    ...(mapUrl ? { mapUrl } : {}),
    tags: normalizeTags(value.tags),
    latitude,
    longitude,
    sortOrder,
  };
}

export const SCENARIO_BUSINESS_LOCATION_ISSUES = [
  "key_invalid",
  "name_missing",
  "name_too_long",
  "country_invalid",
  "city_missing",
  "city_too_long",
  "address_too_long",
  "phone_too_long",
  "map_url_invalid",
  "tags_invalid",
  "tags_too_many",
  "tag_too_long",
  "latitude_invalid",
  "longitude_invalid",
  "coordinates_zero",
  "sort_order_invalid",
] as const;

export type ScenarioBusinessLocationIssue =
  (typeof SCENARIO_BUSINESS_LOCATION_ISSUES)[number];

function addTagIssues(
  value: unknown,
  issues: Set<ScenarioBusinessLocationIssue>,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    issues.add("tags_invalid");
    return;
  }
  const tags = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      issues.add("tags_invalid");
      continue;
    }
    const tag = collapseText(raw, "NFKC");
    if (!tag) continue;
    // A spreadsheet lists tags split on these, so a tag holding one would
    // not come back from an export unchanged.
    if (/[,;|]/.test(tag)) issues.add("tags_invalid");
    if (tag.length > MAX_OFFICE_TAG_LENGTH) issues.add("tag_too_long");
    tags.add(tag.toLowerCase());
  }
  if (tags.size > MAX_OFFICE_TAGS) issues.add("tags_too_many");
}

/**
 * Every reason an office as entered would be refused, or changed, by
 * `normalizeScenarioBusinessLocation`; empty when it is stored exactly as
 * entered.
 */
export function listScenarioBusinessLocationIssues(
  value: unknown,
): ScenarioBusinessLocationIssue[] {
  if (!isRecord(value)) {
    return [
      "key_invalid",
      "name_missing",
      "country_invalid",
      "city_missing",
      "latitude_invalid",
      "longitude_invalid",
    ];
  }
  const issues = new Set<ScenarioBusinessLocationIssue>();
  if (!normalizeScenarioBusinessLocationKey(value.key)) {
    issues.add("key_invalid");
  }
  const name = collapseText(value.name);
  if (!name) issues.add("name_missing");
  else if (name.length > MAX_OFFICE_NAME_LENGTH) issues.add("name_too_long");
  if (!normalizeScenarioLocationCountry(value.country)) {
    issues.add("country_invalid");
  }
  const city = collapseText(value.city);
  if (!city) issues.add("city_missing");
  else if (city.length > MAX_OFFICE_CITY_LENGTH) issues.add("city_too_long");
  if (collapseText(value.address).length > MAX_OFFICE_ADDRESS_LENGTH) {
    issues.add("address_too_long");
  }
  if (collapseText(value.phone).length > MAX_OFFICE_PHONE_LENGTH) {
    issues.add("phone_too_long");
  }
  const mapUrl = value.mapUrl;
  if (
    mapUrl !== undefined &&
    mapUrl !== null &&
    (typeof mapUrl !== "string" ||
      (mapUrl.trim() !== "" && !normalizeMapUrl(mapUrl)))
  ) {
    issues.add("map_url_invalid");
  }
  addTagIssues(value.tags, issues);
  const latitude = parseScenarioLocationCoordinate(value.latitude, "latitude");
  const longitude = parseScenarioLocationCoordinate(
    value.longitude,
    "longitude",
  );
  if (latitude === null) issues.add("latitude_invalid");
  if (longitude === null) issues.add("longitude_invalid");
  if (
    latitude !== null &&
    longitude !== null &&
    isNullIsland({ latitude, longitude })
  ) {
    issues.add("coordinates_zero");
  }
  if (
    value.sortOrder !== undefined &&
    value.sortOrder !== null &&
    !Number.isSafeInteger(value.sortOrder)
  ) {
    issues.add("sort_order_invalid");
  }
  return SCENARIO_BUSINESS_LOCATION_ISSUES.filter((issue) => issues.has(issue));
}

/** Russian and Kazakh letters as Latin, so a name typed in either language works. */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  ә: "a",
  б: "b",
  в: "v",
  г: "g",
  ғ: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  қ: "q",
  л: "l",
  м: "m",
  н: "n",
  ң: "n",
  о: "o",
  ө: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ұ: "u",
  ү: "u",
  ф: "f",
  х: "kh",
  һ: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  і: "i",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/** Russian and Kazakh letters as Latin, lower case, without diacritics. */
export function transliterateScenarioKeyText(text: string): string {
  return [...text.toLowerCase()]
    .map((character) => CYRILLIC_TO_LATIN[character] ?? character)
    .join("")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function slugifyKeyPart(value: unknown): string {
  // NFKC, so "№5" becomes "no5" rather than losing the N.
  return transliterateScenarioKeyText(collapseText(value, "NFKC"))
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The key an imported office without one gets, e.g. `kz_almaty_abay`; null when the country is invalid or the city or name has nothing usable. */
export function buildScenarioBusinessLocationKey(params: {
  country: unknown;
  city: unknown;
  name: unknown;
}): string | null {
  const country = normalizeScenarioLocationCountry(params.country);
  if (!country) return null;
  const city = slugifyKeyPart(params.city);
  const name = slugifyKeyPart(params.name);
  if (!city || !name) return null;
  const key = `${country.toLowerCase()}_${city}_${name}`
    .slice(0, MAX_OFFICE_KEY_LENGTH)
    .replace(/_+$/, "");
  return normalizeScenarioBusinessLocationKey(key);
}

export type ScenarioLocationOutlierOffice = {
  key: string;
  /** `COUNTRY:cityKey`, the same value city routes store. */
  cityValue: string;
  /** The closest other office of the same city, and how far it is. */
  nearestKey: string;
  distanceMeters: number;
};

/** Offices whose pin is far from every other office of their city, in input order. */
export function findScenarioLocationOutlierOffices(
  offices: readonly Pick<
    ScenarioBusinessLocation,
    "key" | "country" | "cityKey" | "latitude" | "longitude"
  >[],
  maxDistanceKm = SCENARIO_LOCATION_OUTLIER_DISTANCE_KM,
): ScenarioLocationOutlierOffice[] {
  const cityValueOf = (office: (typeof offices)[number]) =>
    `${office.country}:${office.cityKey}`;
  const cities = new Map<string, number[]>();
  offices.forEach((office, index) => {
    const cityValue = cityValueOf(office);
    const peers = cities.get(cityValue);
    if (peers) peers.push(index);
    else cities.set(cityValue, [index]);
  });

  const outliers: ScenarioLocationOutlierOffice[] = [];
  offices.forEach((office, index) => {
    const cityValue = cityValueOf(office);
    let nearest: { key: string; distanceMeters: number } | null = null;
    for (const peerIndex of cities.get(cityValue) ?? []) {
      const peer = offices[peerIndex];
      if (peerIndex === index || !peer) continue;
      const distanceMeters = measureScenarioLocationDistanceMeters(
        office,
        peer,
      );
      if (!nearest || distanceMeters < nearest.distanceMeters) {
        nearest = { key: peer.key, distanceMeters };
      }
    }
    if (nearest && nearest.distanceMeters > maxDistanceKm * 1000) {
      outliers.push({
        key: office.key,
        cityValue,
        nearestKey: nearest.key,
        distanceMeters: nearest.distanceMeters,
      });
    }
  });
  return outliers;
}

/** Whether a route's group contains the office. */
export function scenarioLocationRouteMatchesOffice(
  route: ScenarioActionLocationRoute,
  office: Pick<
    ScenarioBusinessLocation,
    "key" | "country" | "cityKey" | "tags"
  >,
): boolean {
  const values = route.match.values;
  switch (route.match.by) {
    case "country":
      return values.includes(office.country);
    case "city":
      return values.includes(`${office.country}:${office.cityKey}`);
    case "tag":
      return office.tags.some((tag) => values.includes(tag));
    case "office":
      return values.includes(office.key);
    default: {
      const exhaustive: never = route.match.by;
      return exhaustive;
    }
  }
}

function compareOffices(
  left: { office: ScenarioBusinessLocation; distanceMeters: number },
  right: { office: ScenarioBusinessLocation; distanceMeters: number },
): number {
  return (
    left.distanceMeters - right.distanceMeters ||
    left.office.sortOrder - right.office.sortOrder ||
    (left.office.key < right.office.key
      ? -1
      : left.office.key > right.office.key
        ? 1
        : 0)
  );
}

/**
 * The nearest office. Equal distances go to the lower sort order, then the
 * lower key, so a retried turn decides the same way.
 */
export function findNearestScenarioBusinessLocation(
  offices: readonly ScenarioBusinessLocation[],
  point: ScenarioLocationPoint,
): { office: ScenarioBusinessLocation; distanceMeters: number } | null {
  let nearest: {
    office: ScenarioBusinessLocation;
    distanceMeters: number;
  } | null = null;
  for (const office of offices) {
    const candidate = {
      office,
      distanceMeters: measureScenarioLocationDistanceMeters(point, office),
    };
    if (!nearest || compareOffices(candidate, nearest) < 0) {
      nearest = candidate;
    }
  }
  return nearest;
}

export type ScenarioLocationRouteDecision =
  | {
      outcome: "route";
      routeId: string;
      office: ScenarioBusinessLocation;
      distanceMeters: number;
    }
  | {
      outcome: "any_office";
      office: ScenarioBusinessLocation;
      distanceMeters: number;
    }
  | {
      outcome: "outside";
      office: ScenarioBusinessLocation | null;
      distanceMeters: number | null;
    }
  | { outcome: "no_office" };

/** The route a shared point takes. Pure, so the runtime and preview agree. */
export function resolveScenarioLocationRoute(params: {
  routing: ScenarioActionLocationRoutes;
  offices: readonly ScenarioBusinessLocation[];
  point: ScenarioLocationPoint;
}): ScenarioLocationRouteDecision {
  const nearest = findNearestScenarioBusinessLocation(
    params.offices,
    params.point,
  );
  const cutoff = params.routing.outside;
  if (!nearest) {
    return cutoff
      ? { outcome: "outside", office: null, distanceMeters: null }
      : { outcome: "no_office" };
  }
  if (cutoff && nearest.distanceMeters > cutoff.maxDistanceKm * 1000) {
    return { outcome: "outside", ...nearest };
  }
  const route = params.routing.routes.find((candidate) =>
    scenarioLocationRouteMatchesOffice(candidate, nearest.office),
  );
  return route
    ? { outcome: "route", routeId: route.id, ...nearest }
    : { outcome: "any_office", ...nearest };
}

/**
 * How many offices each route takes by first match, and how many fall to
 * "Any other office", for the builder's coverage line.
 */
export function summarizeScenarioLocationRouteCoverage(
  routing: ScenarioActionLocationRoutes,
  offices: readonly ScenarioBusinessLocation[],
): {
  routes: Array<{ routeId: string; officeCount: number }>;
  anyOfficeCount: number;
} {
  const counts = new Map(routing.routes.map((route) => [route.id, 0]));
  let anyOfficeCount = 0;
  for (const office of offices) {
    const route = routing.routes.find((candidate) =>
      scenarioLocationRouteMatchesOffice(candidate, office),
    );
    if (route) counts.set(route.id, (counts.get(route.id) ?? 0) + 1);
    else anyOfficeCount += 1;
  }
  return {
    routes: routing.routes.map((route) => ({
      routeId: route.id,
      officeCount: counts.get(route.id) ?? 0,
    })),
    anyOfficeCount,
  };
}

export const SCENARIO_LOCATION_DECISION_SOURCES = [
  "turn",
  "lookup",
  "timer",
] as const;

export type ScenarioLocationDecisionSource =
  (typeof SCENARIO_LOCATION_DECISION_SOURCES)[number];

export const SCENARIO_ROUTED_LOCATION_OUTCOMES = [
  "route",
  "any_office",
  "outside",
  "unrouted",
] as const;

export type ScenarioRoutedLocationOutcome =
  (typeof SCENARIO_ROUTED_LOCATION_OUTCOMES)[number];

/** The office a decision chose, as it was when chosen. */
export type ScenarioRoutedLocationOffice = Omit<
  ScenarioBusinessLocation,
  "sortOrder"
>;

/**
 * One decided share. Every entry, routed or not, consumes its message, so a
 * share is decided once. The customer's own coordinates are never copied.
 */
export type ScenarioRoutedLocationEntry = {
  sourceActionNodeId: string;
  inboundMessageId: string;
  /** ISO time of the share. */
  sharedAt: string;
  /** ISO time of the decision. */
  decidedAt: string;
  source: ScenarioLocationDecisionSource;
  outcome: ScenarioRoutedLocationOutcome;
  routeId?: string;
  office?: ScenarioRoutedLocationOffice;
  distanceMeters?: number;
  /** Why an unrouted share sent nothing. */
  reason?: string;
};

/** The decisions of one scenario, oldest first. */
export type ScenarioRoutedLocations = {
  scenarioId: string;
  entries: ScenarioRoutedLocationEntry[];
};

function readLedgerId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return id.length <= MAX_LEDGER_ID_LENGTH ? id : "";
}

function readIsoTime(value: unknown): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : "";
}

function normalizeRoutedOffice(
  value: unknown,
): ScenarioRoutedLocationOffice | undefined {
  const office = normalizeScenarioBusinessLocation(value);
  return office ? toScenarioRoutedLocationOffice(office) : undefined;
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((candidate) => candidate === value);
}

export function normalizeScenarioRoutedLocationEntry(
  value: unknown,
): ScenarioRoutedLocationEntry | null {
  if (!isRecord(value)) return null;
  const sourceActionNodeId = readLedgerId(value.sourceActionNodeId);
  const inboundMessageId = readLedgerId(value.inboundMessageId);
  const sharedAt = readIsoTime(value.sharedAt);
  const decidedAt = readIsoTime(value.decidedAt);
  if (
    !sourceActionNodeId ||
    !inboundMessageId ||
    !sharedAt ||
    !decidedAt ||
    !isOneOf(SCENARIO_LOCATION_DECISION_SOURCES, value.source) ||
    !isOneOf(SCENARIO_ROUTED_LOCATION_OUTCOMES, value.outcome)
  ) {
    return null;
  }
  const routeId =
    value.outcome === "route"
      ? normalizeIdValue(value.routeId, MAX_ROUTE_ID_LENGTH)
      : "";
  const office = normalizeRoutedOffice(value.office);
  const distanceMeters =
    typeof value.distanceMeters === "number" &&
    Number.isFinite(value.distanceMeters) &&
    value.distanceMeters >= 0
      ? Math.round(value.distanceMeters)
      : undefined;
  const reason = normalizeIdValue(value.reason, MAX_UNROUTED_REASON_LENGTH);
  return {
    sourceActionNodeId,
    inboundMessageId,
    sharedAt,
    decidedAt,
    source: value.source,
    outcome: value.outcome,
    ...(routeId ? { routeId } : {}),
    ...(office ? { office } : {}),
    ...(distanceMeters !== undefined ? { distanceMeters } : {}),
    ...(reason ? { reason } : {}),
  };
}

function limitEntries(
  entries: ScenarioRoutedLocationEntry[],
): ScenarioRoutedLocationEntry[] {
  return entries.slice(-MAX_SCENARIO_ROUTED_LOCATIONS);
}

export function normalizeScenarioRoutedLocations(
  value: unknown,
): ScenarioRoutedLocations | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) return null;
  const scenarioId = readLedgerId(value.scenarioId);
  if (!scenarioId) return null;
  const entries = limitEntries(
    value.entries.flatMap((item) => {
      const entry = normalizeScenarioRoutedLocationEntry(item);
      return entry ? [entry] : [];
    }),
  );
  return entries.length > 0 ? { scenarioId, entries } : null;
}

/** Records a decision; another scenario's decisions are replaced. */
export function recordScenarioRoutedLocation(
  state: unknown,
  params: { scenarioId: string; entry: ScenarioRoutedLocationEntry },
): Record<string, unknown> {
  const base = isRecord(state) ? { ...state } : {};
  const existing = normalizeScenarioRoutedLocations(base.routedLocations);
  const scenarioId = params.scenarioId.trim();
  return {
    ...base,
    routedLocations: {
      scenarioId,
      entries: limitEntries([
        ...(existing?.scenarioId === scenarioId
          ? existing.entries.filter(
              (entry) =>
                entry.inboundMessageId !== params.entry.inboundMessageId,
            )
          : []),
        params.entry,
      ]),
    },
  };
}

/** The scenario's decisions, oldest first; another scenario's are never read. */
export function readScenarioRoutedLocations(
  state: unknown,
  scenarioId: string | null | undefined,
): ScenarioRoutedLocationEntry[] {
  if (!isRecord(state) || !scenarioId) return [];
  const ledger = normalizeScenarioRoutedLocations(state.routedLocations);
  return ledger?.scenarioId === scenarioId ? ledger.entries : [];
}

/**
 * Which shares are already decided, and the earliest time a share may have
 * to still be undecided: no earlier than the wait's start (less the clock
 * skew) and later than the newest decided share, so an older share that was
 * lost is never routed after a newer one.
 */
export function readScenarioLocationLookupBounds(
  state: unknown,
  params: { scenarioId: string; waitStartedAt: Date | null },
): { since: Date | null; consumedMessageIds: string[] } {
  const entries = readScenarioRoutedLocations(state, params.scenarioId);
  const waitFloor = params.waitStartedAt
    ? params.waitStartedAt.getTime() - SCENARIO_LOCATION_WAIT_SKEW_MS
    : Number.NaN;
  const decidedFloor = entries.reduce(
    (latest, entry) => Math.max(latest, Date.parse(entry.sharedAt)),
    Number.NEGATIVE_INFINITY,
  );
  const since = Number.isFinite(waitFloor)
    ? Math.max(waitFloor, decidedFloor)
    : Number.NaN;
  return {
    since: Number.isFinite(since) ? new Date(since) : null,
    consumedMessageIds: entries.map((entry) => entry.inboundMessageId),
  };
}

/**
 * The latest decision that routed, which `{{office.*}}` reads. A routed
 * decision with no office (an empty catalog past the cutoff) reads empty
 * rather than as an earlier office.
 */
export function readScenarioRoutedOffice(
  state: unknown,
  scenarioId: string | null | undefined,
): ScenarioRoutedLocationEntry | null {
  const entries = readScenarioRoutedLocations(state, scenarioId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.outcome !== "unrouted") return entry;
  }
  return null;
}

/** `{{office.*}}` values; all empty before an office was found. */
export function readScenarioRoutedOfficeTemplateValues(
  entry: ScenarioRoutedLocationEntry | null | undefined,
): {
  name: string;
  address: string;
  city: string;
  phone: string;
  distance_km: string;
  maps_url: string;
} {
  const office = entry?.office;
  if (!office) {
    return {
      name: "",
      address: "",
      city: "",
      phone: "",
      distance_km: "",
      maps_url: "",
    };
  }
  return {
    name: office.name,
    address: office.address ?? "",
    city: office.city,
    phone: office.phone ?? "",
    distance_km:
      typeof entry.distanceMeters === "number"
        ? (entry.distanceMeters / 1000).toFixed(1)
        : "",
    maps_url: office.mapUrl ?? buildScenarioLocationMapsUrl(office),
  };
}

/** The snapshot of an office that a decision stores. */
export function toScenarioRoutedLocationOffice(
  office: ScenarioBusinessLocation,
): ScenarioRoutedLocationOffice {
  const snapshot: Partial<ScenarioBusinessLocation> = { ...office };
  delete snapshot.sortOrder;
  return snapshot as ScenarioRoutedLocationOffice;
}
