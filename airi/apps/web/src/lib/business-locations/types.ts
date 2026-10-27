import {
  MAX_SCENARIO_BUSINESS_LOCATIONS,
  findScenarioLocationOutlierOffices,
  listScenarioBusinessLocationIssues,
  normalizeScenarioBusinessLocation,
  type ScenarioBusinessLocation,
  type ScenarioBusinessLocationIssue,
  type ScenarioLocationOutlierOffice,
} from "@icecore/scenario-contracts";

/** Offices a workspace may keep in all, inactive ones included. */
export const MAX_BUSINESS_LOCATION_RECORDS = 2000;
/** Offices one save may send: a whole import file, or one edited office. */
export const MAX_BUSINESS_LOCATIONS_PER_SAVE = MAX_SCENARIO_BUSINESS_LOCATIONS;

/** One office as Settings → Offices lists it, inactive ones included. */
export type BusinessLocationRecord = ScenarioBusinessLocation & {
  isActive: boolean;
  updatedAt: string | null;
};

/** What the dialog and the import send; the server re-validates everything. */
export type BusinessLocationInput = {
  key: string;
  name: string;
  country: string;
  city: string;
  address?: string;
  phone?: string;
  mapUrl?: string;
  tags?: string[];
  latitude: number | string;
  longitude: number | string;
  isActive?: boolean;
  sortOrder?: number;
};

export type BusinessLocationsListResponse = {
  offices: BusinessLocationRecord[];
};

export type BusinessLocationsSaveSummary = {
  created: number;
  updated: number;
  deactivated: number;
};

export type BusinessLocationsSaveResponse = {
  offices: BusinessLocationRecord[];
  summary: BusinessLocationsSaveSummary;
};

export type BusinessLocationsCreateResponse = {
  office: BusinessLocationRecord;
  offices: BusinessLocationRecord[];
};

export const BUSINESS_LOCATIONS_ERROR_CODES = [
  "feature_disabled",
  "manager_required",
  "body_too_large",
  "invalid_request",
  "invalid_offices",
  "duplicate_keys",
  "office_limit",
  "record_limit",
  "office_key_taken",
  "save_conflict",
  "save_failed",
  "load_failed",
] as const;

export type BusinessLocationsErrorCode =
  (typeof BUSINESS_LOCATIONS_ERROR_CODES)[number];

/** The refused fields of one sent office; `index` is its place in the request. */
export type BusinessLocationRowIssues = {
  index: number;
  key: string | null;
  issues: ScenarioBusinessLocationIssue[];
};

export type BusinessLocationsErrorBody = {
  error: string;
  code: BusinessLocationsErrorCode;
  rows?: BusinessLocationRowIssues[];
  keys?: string[];
  limit?: number;
};

export type BusinessLocationValidation =
  | {
      ok: true;
      office: ScenarioBusinessLocation;
      isActive: boolean;
      sortOrder: number | undefined;
    }
  | { ok: false; issues: ScenarioBusinessLocationIssue[] };

/** One office as entered: refused with its issues, or the stored shape. */
export function validateBusinessLocationInput(
  value: unknown
): BusinessLocationValidation {
  const issues = listScenarioBusinessLocationIssues(value);
  const office = normalizeScenarioBusinessLocation(value);
  if (issues.length > 0 || !office) return { ok: false, issues };
  const { isActive, sortOrder } = value as {
    isActive?: unknown;
    sortOrder?: unknown;
  };
  return {
    ok: true,
    office,
    isActive: isActive !== false,
    sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
  };
}

const OPTIONAL_INPUT_FIELDS = [
  "address",
  "phone",
  "mapUrl",
  "tags",
  "isActive",
  "sortOrder",
] as const;

/**
 * A stored office as the whole row a save sends back, for Edit, Activate and
 * Deactivate. It keeps the sort order, tags and every optional field the
 * office has, and leaves out the ones it lacks. An override replaces a field;
 * an override set to undefined leaves an optional field out, which clears it.
 */
export function toBusinessLocationInput(
  record: BusinessLocationRecord,
  overrides: Partial<BusinessLocationInput> = {}
): BusinessLocationInput {
  const input: BusinessLocationInput = {
    key: record.key,
    name: record.name,
    country: record.country,
    city: record.city,
    address: record.address,
    phone: record.phone,
    mapUrl: record.mapUrl,
    tags: record.tags.length > 0 ? [...record.tags] : undefined,
    latitude: record.latitude,
    longitude: record.longitude,
    isActive: record.isActive,
    sortOrder: record.sortOrder,
    ...overrides,
  };
  for (const field of OPTIONAL_INPUT_FIELDS) {
    if (input[field] === undefined) delete input[field];
  }
  return input;
}

type SummarizedOffice = Pick<
  BusinessLocationRecord,
  "isActive" | "country" | "cityKey"
>;

/** Active offices, and the distinct cities and countries they are in. */
export function summarizeBusinessLocations(
  records: readonly SummarizedOffice[]
): { active: number; cities: number; countries: number } {
  const active = records.filter(record => record.isActive);
  return {
    active: active.length,
    cities: new Set(active.map(record => `${record.country}:${record.cityKey}`))
      .size,
    countries: new Set(active.map(record => record.country)).size,
  };
}

/** Active offices whose pin is far from every other active office of their city. */
export function findBusinessLocationOutliers(
  records: readonly BusinessLocationRecord[]
): ScenarioLocationOutlierOffice[] {
  return findScenarioLocationOutlierOffices(
    records.filter(record => record.isActive)
  );
}
