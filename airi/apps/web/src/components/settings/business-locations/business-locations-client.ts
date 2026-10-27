import {
  MAX_SCENARIO_BUSINESS_LOCATIONS,
  SCENARIO_BUSINESS_LOCATION_LIMITS,
  type ScenarioBusinessLocationIssue,
} from "@icecore/scenario-contracts";
import {
  BUSINESS_LOCATIONS_ERROR_CODES,
  MAX_BUSINESS_LOCATION_RECORDS,
  type BusinessLocationsErrorBody,
  type BusinessLocationsErrorCode,
} from "@/lib/business-locations/types";
import type { useTranslations } from "next-intl";

// Requests and error copy shared by the Settings → Offices manager, the
// office dialog and the import dialog.

export type BusinessLocationsTranslator = ReturnType<
  typeof useTranslations<"BusinessLocationsSettings">
>;

/** The Offices API of one workspace. */
export function businessLocationsApiUrl(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/business-locations`;
}

/** A refused request, with the server's error body when it sent one. */
export class BusinessLocationsRequestError extends Error {
  readonly code: BusinessLocationsErrorCode | null;

  constructor(
    readonly status: number,
    readonly body: BusinessLocationsErrorBody | null
  ) {
    super(body?.code ?? `HTTP ${status}`);
    this.name = "BusinessLocationsRequestError";
    this.code = body?.code ?? null;
  }
}

function readErrorBody(value: unknown): BusinessLocationsErrorBody | null {
  if (!value || typeof value !== "object") return null;
  const { code } = value as { code?: unknown };
  return BUSINESS_LOCATIONS_ERROR_CODES.some(known => known === code)
    ? (value as BusinessLocationsErrorBody)
    : null;
}

/** Calls the Offices API; a refusal throws BusinessLocationsRequestError. */
export async function requestBusinessLocations<T>(
  url: string,
  init: { method?: "GET" | "PUT" | "POST"; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    cache: "no-store",
    headers:
      init.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new BusinessLocationsRequestError(
      response.status,
      readErrorBody(body)
    );
  }
  return (await response.json()) as T;
}

/** One translated sentence for a failed request; limits and duplicate keys are named. */
export function describeBusinessLocationsError(
  t: BusinessLocationsTranslator,
  error: unknown
): string {
  if (!(error instanceof BusinessLocationsRequestError)) {
    return t("errors.save_failed");
  }
  const { body, code, status } = error;
  switch (code) {
    case null:
      return t(
        status === 401 || status === 403
          ? "errors.access_denied"
          : "errors.unknown"
      );
    case "office_limit":
      return t("errors.office_limit", {
        limit: body?.limit ?? MAX_SCENARIO_BUSINESS_LOCATIONS,
      });
    case "record_limit":
      return t("errors.record_limit", {
        limit: body?.limit ?? MAX_BUSINESS_LOCATION_RECORDS,
      });
    case "duplicate_keys":
      return t("errors.duplicate_keys", {
        keys: (body?.keys ?? []).join(", "),
      });
    default:
      return t(`errors.${code}`);
  }
}

const ISSUE_LIMITS: Partial<Record<ScenarioBusinessLocationIssue, number>> = {
  key_invalid: SCENARIO_BUSINESS_LOCATION_LIMITS.keyLength,
  name_too_long: SCENARIO_BUSINESS_LOCATION_LIMITS.nameLength,
  city_too_long: SCENARIO_BUSINESS_LOCATION_LIMITS.cityLength,
  address_too_long: SCENARIO_BUSINESS_LOCATION_LIMITS.addressLength,
  phone_too_long: SCENARIO_BUSINESS_LOCATION_LIMITS.phoneLength,
  map_url_invalid: SCENARIO_BUSINESS_LOCATION_LIMITS.mapUrlLength,
  tags_too_many: SCENARIO_BUSINESS_LOCATION_LIMITS.tags,
  tag_too_long: SCENARIO_BUSINESS_LOCATION_LIMITS.tagLength,
};

/** One translated sentence for a refused office field, with its length limit. */
export function describeBusinessLocationIssue(
  t: BusinessLocationsTranslator,
  issue: ScenarioBusinessLocationIssue
): string {
  const max = ISSUE_LIMITS[issue];
  return max === undefined
    ? t(`issues.${issue}`)
    : t(`issues.${issue}`, { max });
}
