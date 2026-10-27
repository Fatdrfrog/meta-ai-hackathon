import "server-only";
import {
  MAX_SCENARIO_BUSINESS_LOCATIONS,
  type ScenarioBusinessLocation,
} from "@icecore/scenario-contracts";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import { BusinessLocation } from "@/models/business-location";
import {
  MAX_BUSINESS_LOCATION_RECORDS,
  type BusinessLocationRecord,
  type BusinessLocationsSaveSummary,
} from "./types";

/** An office `validateBusinessLocationInput` accepted, ready to store. */
export type BusinessLocationSaveRow = {
  office: ScenarioBusinessLocation;
  isActive: boolean;
  sortOrder: number | undefined;
};

/** A write that would leave too many active offices, or too many in all. */
export class BusinessLocationsLimitError extends Error {
  constructor(
    readonly code: "office_limit" | "record_limit",
    readonly limit: number
  ) {
    super(`Business location ${code} of ${limit} exceeded`);
    this.name = "BusinessLocationsLimitError";
  }
}

/** Add was refused: the workspace already has an office with this key. */
export class BusinessLocationKeyTakenError extends Error {
  constructor(readonly key: string) {
    super(`Business location key ${key} is already taken`);
    this.name = "BusinessLocationKeyTakenError";
  }
}

type StoredOffice = { key: string; isActive: boolean };

const OPTIONAL_TEXT_FIELDS = ["address", "phone", "mapUrl"] as const;

async function readStoredOffices(workspaceId: string): Promise<StoredOffice[]> {
  const rows = await BusinessLocation.find({ workspaceId })
    .select("key isActive")
    .lean<{ key: string; isActive?: boolean }[]>();
  return rows.map(row => ({ key: row.key, isActive: row.isActive !== false }));
}

/**
 * Refuses a write that would leave more than 500 active offices or more than
 * 2000 in all, and returns the keys it would create. Two managers saving at
 * once can push a catalog past a limit (last write wins), so a write that
 * only brings the count down, or keeps it, is always allowed.
 */
function checkLimits(
  existing: readonly StoredOffice[],
  rows: readonly Pick<BusinessLocationSaveRow, "office" | "isActive">[],
  deactivateMissing: boolean
): string[] {
  const existingKeys = new Set(existing.map(office => office.key));
  const rowKeys = new Set(rows.map(row => row.office.key));
  const created = [...rowKeys].filter(key => !existingKeys.has(key));
  const activeBefore = existing.filter(office => office.isActive).length;
  const keptActive = deactivateMissing
    ? 0
    : existing.filter(office => office.isActive && !rowKeys.has(office.key))
        .length;
  const activeAfter = rows.filter(row => row.isActive).length + keptActive;
  if (
    activeAfter > MAX_SCENARIO_BUSINESS_LOCATIONS &&
    activeAfter > activeBefore
  ) {
    throw new BusinessLocationsLimitError(
      "office_limit",
      MAX_SCENARIO_BUSINESS_LOCATIONS
    );
  }
  if (
    created.length > 0 &&
    existing.length + created.length > MAX_BUSINESS_LOCATION_RECORDS
  ) {
    throw new BusinessLocationsLimitError(
      "record_limit",
      MAX_BUSINESS_LOCATION_RECORDS
    );
  }
  return created;
}

/**
 * Bulk writes skip schema validators, which is why rows arrive validated. An
 * emptied address, phone or map link is unset rather than left behind.
 */
function toUpsertOperation(
  workspaceId: string,
  userId: string,
  { office, isActive, sortOrder }: BusinessLocationSaveRow
) {
  const $set: Record<string, unknown> = {
    name: office.name,
    country: office.country,
    city: office.city,
    cityKey: office.cityKey,
    tags: office.tags,
    latitude: office.latitude,
    longitude: office.longitude,
    isActive,
    updatedBy: userId,
  };
  const $unset: Record<string, ""> = {};
  for (const field of OPTIONAL_TEXT_FIELDS) {
    const value = office[field];
    if (value) $set[field] = value;
    else $unset[field] = "";
  }
  if (sortOrder !== undefined) $set.sortOrder = sortOrder;
  return {
    updateOne: {
      filter: { workspaceId, key: office.key },
      update: {
        $set,
        ...(Object.keys($unset).length > 0 ? { $unset } : {}),
        $setOnInsert: { createdBy: userId },
      },
      upsert: true,
    },
  };
}

/**
 * Upserts the offices by key; with `deactivateMissing`, every other active
 * office of the workspace is deactivated. Nothing is ever deleted. The
 * limits are checked against the catalog as it is now (last write wins).
 * The caller connects to Mongo and checks that keys are unique.
 */
export async function saveBusinessLocations({
  workspaceId,
  userId,
  rows,
  deactivateMissing = false,
}: {
  workspaceId: string;
  userId: string;
  rows: readonly BusinessLocationSaveRow[];
  deactivateMissing?: boolean;
}): Promise<BusinessLocationsSaveSummary> {
  const existing = await readStoredOffices(workspaceId);
  const created = checkLimits(existing, rows, deactivateMissing);
  // Without throwOnValidationError an unordered bulk write skips a row it
  // can't cast and still resolves, so the summary would count it as saved.
  await BusinessLocation.bulkWrite(
    rows.map(row => toUpsertOperation(workspaceId, userId, row)),
    { ordered: false, throwOnValidationError: true }
  );
  let deactivated = 0;
  if (deactivateMissing) {
    const result = await BusinessLocation.updateMany(
      {
        workspaceId,
        key: { $nin: rows.map(row => row.office.key) },
        isActive: true,
      },
      { $set: { isActive: false, updatedBy: userId } }
    );
    deactivated = result.modifiedCount;
  }
  return {
    created: created.length,
    updated: rows.length - created.length,
    deactivated,
  };
}

/** Adds one office; a key the workspace already has is refused, never updated. */
export async function createBusinessLocation({
  workspaceId,
  userId,
  office,
  isActive,
  sortOrder,
}: {
  workspaceId: string;
  userId: string;
} & BusinessLocationSaveRow): Promise<BusinessLocationRecord> {
  const existing = await readStoredOffices(workspaceId);
  if (existing.some(stored => stored.key === office.key)) {
    throw new BusinessLocationKeyTakenError(office.key);
  }
  checkLimits(existing, [{ office, isActive }], false);
  const record = { ...office, isActive, sortOrder: sortOrder ?? 0 };
  try {
    const created = await BusinessLocation.create({
      workspaceId,
      ...record,
      createdBy: userId,
      updatedBy: userId,
    });
    return {
      ...record,
      updatedAt:
        created.updatedAt instanceof Date
          ? created.updatedAt.toISOString()
          : null,
    };
  } catch (error) {
    if (isMongoDuplicateKeyError(error)) {
      throw new BusinessLocationKeyTakenError(office.key);
    }
    throw error;
  }
}
