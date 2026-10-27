import type { ScenarioWhatsAppLocationConfig } from "@icecore/scenario-contracts";
import {
  asNullableRecord,
  readNonEmptyStringOrUndefined,
} from "@icecore/shared/lib/value-utils";

const MAX_LOCATION_TEXT_LENGTH = 160;
const COORDINATE_PRECISION = 6;

export type WhatsAppLocationMessagePayload = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

const cleanText = (value: unknown, maxLength = MAX_LOCATION_TEXT_LENGTH) =>
  readNonEmptyStringOrUndefined(value, {
    normalizeWhitespace: true,
    maxLength,
  });

function parseCoordinate(
  value: unknown,
  min: number,
  max: number
): number | undefined {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim().replace(",", "."))
        : Number.NaN;
  if (!Number.isFinite(raw)) return undefined;
  if (raw < min || raw > max) return undefined;
  return Number(raw.toFixed(COORDINATE_PRECISION));
}

export function getDefaultWhatsAppLocationConfig(): ScenarioWhatsAppLocationConfig {
  return { version: 1 };
}

export function getEditableWhatsAppLocationConfig(
  value: unknown
): ScenarioWhatsAppLocationConfig {
  const record = asNullableRecord(value);
  if (!record) return getDefaultWhatsAppLocationConfig();

  return {
    version: 1,
    latitude:
      typeof record.latitude === "number" || typeof record.latitude === "string"
        ? record.latitude
        : undefined,
    longitude:
      typeof record.longitude === "number" ||
      typeof record.longitude === "string"
        ? record.longitude
        : undefined,
    name: cleanText(record.name),
    address: cleanText(record.address, 240),
  };
}

export function normalizeWhatsAppLocationConfig(
  value: unknown
): ScenarioWhatsAppLocationConfig | undefined {
  const draft = getEditableWhatsAppLocationConfig(value);
  const latitude = parseCoordinate(draft.latitude, -90, 90);
  const longitude = parseCoordinate(draft.longitude, -180, 180);
  if (latitude === undefined || longitude === undefined) return undefined;

  return {
    version: 1,
    latitude,
    longitude,
    name: cleanText(draft.name),
    address: cleanText(draft.address, 240),
  };
}

export function buildWhatsAppLocationMessagePayload(
  value: unknown
): WhatsAppLocationMessagePayload | null {
  const config = normalizeWhatsAppLocationConfig(value);
  if (
    !config ||
    typeof config.latitude !== "number" ||
    typeof config.longitude !== "number"
  ) {
    return null;
  }

  return {
    latitude: config.latitude,
    longitude: config.longitude,
    ...(config.name ? { name: config.name } : {}),
    ...(config.address ? { address: config.address } : {}),
  };
}
