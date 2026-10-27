import "server-only";
import {
  MAX_SCENARIO_BUSINESS_LOCATIONS,
  normalizeScenarioBusinessLocation,
  type ScenarioBusinessLocation,
} from "@icecore/scenario-contracts";
import { BusinessLocation } from "@/models/business-location";
import {
  MAX_BUSINESS_LOCATION_RECORDS,
  type BusinessLocationRecord,
} from "./types";

/**
 * The workspace's active offices, as routing reads them. Read fresh each
 * time a shared location is decided, so a catalog edit applies at once;
 * a row routing could not use is left out.
 */
export async function loadActiveBusinessLocations(
  workspaceId: string
): Promise<ScenarioBusinessLocation[]> {
  const rows = await BusinessLocation.find({ workspaceId, isActive: true })
    .sort({ sortOrder: 1, key: 1 })
    .limit(MAX_SCENARIO_BUSINESS_LOCATIONS)
    .select(
      "key name country city address phone mapUrl tags latitude longitude sortOrder"
    )
    .lean<Record<string, unknown>[]>();
  return rows.flatMap(row => {
    const office = normalizeScenarioBusinessLocation(row);
    return office ? [office] : [];
  });
}

/**
 * Every office of the workspace as Settings → Offices lists it: active ones
 * first, then catalog order. A stored row routing could not use is left out.
 */
export async function listBusinessLocations(
  workspaceId: string
): Promise<BusinessLocationRecord[]> {
  const rows = await BusinessLocation.find({ workspaceId })
    .sort({ isActive: -1, sortOrder: 1, key: 1 })
    .limit(MAX_BUSINESS_LOCATION_RECORDS)
    .select(
      "key name country city address phone mapUrl tags latitude longitude sortOrder isActive updatedAt"
    )
    .lean<Record<string, unknown>[]>();
  return rows.flatMap(row => {
    const office = normalizeScenarioBusinessLocation(row);
    if (!office) return [];
    const { isActive, updatedAt } = row;
    return [
      {
        ...office,
        isActive: isActive !== false,
        updatedAt:
          updatedAt instanceof Date && !Number.isNaN(updatedAt.getTime())
            ? updatedAt.toISOString()
            : null,
      },
    ];
  });
}
