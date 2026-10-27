import { normalizeScenarioBusinessLocationKey } from "@icecore/scenario-contracts";
import { z } from "zod";
import {
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import {
  BusinessLocationKeyTakenError,
  BusinessLocationsLimitError,
  createBusinessLocation,
  saveBusinessLocations,
  type BusinessLocationSaveRow,
} from "@/lib/business-locations/save";
import { listBusinessLocations } from "@/lib/business-locations/store";
import {
  MAX_BUSINESS_LOCATIONS_PER_SAVE,
  validateBusinessLocationInput,
  type BusinessLocationInput,
  type BusinessLocationRowIssues,
  type BusinessLocationsCreateResponse,
  type BusinessLocationsErrorBody,
  type BusinessLocationsErrorCode,
  type BusinessLocationsListResponse,
  type BusinessLocationsSaveResponse,
} from "@/lib/business-locations/types";
import { logger } from "@/lib/logger";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import { noStoreJson } from "@/lib/http/no-store-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/** A 500-office import is far below this. */
const MAX_BODY_BYTES = 1_048_576;

const ERROR_MESSAGES: Record<BusinessLocationsErrorCode, string> = {
  feature_disabled: "Feature disabled",
  manager_required: "Workspace manager access required",
  body_too_large: "Request body is too large",
  invalid_request: "Invalid request",
  invalid_offices: "Some offices are invalid",
  duplicate_keys: "Office keys must be unique",
  office_limit: "Too many active offices",
  record_limit: "Too many offices",
  office_key_taken: "An office with this key already exists",
  save_conflict: "Offices changed while saving; try again",
  save_failed: "Offices could not be saved",
  load_failed: "Offices could not be loaded",
};

const json = (data: unknown, status = 200) =>
  noStoreJson(data, status, { cacheControl: "private, no-store" });

const fail = (
  code: BusinessLocationsErrorCode,
  status: number,
  details: Pick<BusinessLocationsErrorBody, "rows" | "keys" | "limit"> = {}
) =>
  json(
    {
      error: ERROR_MESSAGES[code],
      code,
      ...details,
    } satisfies BusinessLocationsErrorBody,
    status
  );

/**
 * An office may carry only `BusinessLocationInput` fields. The issue list
 * reports a wrong type everywhere else, but would drop a non-string address
 * or phone, and read any non-false `isActive` as active.
 */
const officeSchema = z
  .object({
    key: z.unknown(),
    name: z.unknown(),
    country: z.unknown(),
    city: z.unknown(),
    address: z.string().nullish(),
    phone: z.string().nullish(),
    mapUrl: z.unknown(),
    tags: z.unknown(),
    latitude: z.unknown(),
    longitude: z.unknown(),
    isActive: z.boolean().optional(),
    sortOrder: z.unknown(),
  } satisfies Record<keyof BusinessLocationInput, z.ZodTypeAny>)
  .strict();

const saveRequestSchema = z
  .object({
    offices: z.array(z.unknown()).min(1).max(MAX_BUSINESS_LOCATIONS_PER_SAVE),
    deactivateMissing: z.boolean().optional(),
  })
  .strict();

const createRequestSchema = z.object({ office: z.unknown() }).strict();

type Refusal = { response: Response };

/** Membership first (its 401/403 as is), then the flag, then for writes the role. */
async function authorize(
  workspaceId: string,
  write: boolean
): Promise<Refusal | { userId: string }> {
  const access = await getAuthenticatedWorkspaceMembership(workspaceId);
  if (access.error) return { response: access.error };
  const enabled = await isWorkspaceFeatureEnabled(
    workspaceId,
    "scenario_location_routing"
  ).catch(() => false);
  if (!enabled) return { response: fail("feature_disabled", 404) };
  if (write && !isWorkspaceManagerRole(access.membership.role)) {
    return { response: fail("manager_required", 403) };
  }
  return { userId: access.user.id };
}

async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>
): Promise<Refusal | { data: T }> {
  let body: unknown;
  try {
    body = await readJsonBodyWithinLimit(request, MAX_BODY_BYTES);
  } catch (error) {
    return {
      response:
        error instanceof JsonBodyTooLargeError
          ? fail("body_too_large", 413)
          : fail("invalid_request", 400),
    };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { data: parsed.data }
    : { response: fail("invalid_request", 400) };
}

/** Every refused office is reported by its index in the request. */
function validateOffices(
  values: readonly unknown[]
): Refusal | { rows: BusinessLocationSaveRow[] } {
  if (!values.every(value => officeSchema.safeParse(value).success)) {
    return { response: fail("invalid_request", 400) };
  }
  const rows: BusinessLocationSaveRow[] = [];
  const refused: BusinessLocationRowIssues[] = [];
  values.forEach((value, index) => {
    const result = validateBusinessLocationInput(value);
    if (result.ok) {
      const { office, isActive, sortOrder } = result;
      rows.push({ office, isActive, sortOrder });
      return;
    }
    refused.push({
      index,
      key: normalizeScenarioBusinessLocationKey(
        (value as { key?: unknown }).key
      ),
      issues: result.issues,
    });
  });
  return refused.length > 0
    ? { response: fail("invalid_offices", 400, { rows: refused }) }
    : { rows };
}

function findDuplicateKeys(rows: readonly BusinessLocationSaveRow[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { office } of rows) {
    if (seen.has(office.key)) duplicates.add(office.key);
    seen.add(office.key);
  }
  return [...duplicates];
}

function writeFailure(
  error: unknown,
  workspaceId: string,
  method: "PUT" | "POST"
) {
  if (error instanceof BusinessLocationsLimitError) {
    return fail(error.code, 409, { limit: error.limit });
  }
  if (error instanceof BusinessLocationKeyTakenError) {
    return fail("office_key_taken", 409);
  }
  if (isMongoDuplicateKeyError(error)) return fail("save_conflict", 409);
  logger.error(`[BusinessLocations API] ${method} failed`, error, {
    event: `business_locations.${method.toLowerCase()}_failed`,
    workspaceId,
  });
  return fail("save_failed", 503);
}

/** Every office of the workspace, inactive included; any member may read. */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await authorize(workspaceId, false);
    if ("response" in access) return access.response;
    await connectDB();
    const offices = await listBusinessLocations(workspaceId);
    return json({ offices } satisfies BusinessLocationsListResponse);
  } catch (error) {
    logger.error("[BusinessLocations API] GET failed", error, {
      event: "business_locations.get_failed",
      workspaceId,
    });
    return fail("load_failed", 503);
  }
}

/**
 * Upserts offices by key: the import, and Edit, Deactivate and Activate.
 * With `deactivateMissing`, active offices the request leaves out are
 * deactivated.
 */
export async function PUT(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await authorize(workspaceId, true);
    if ("response" in access) return access.response;
    const body = await readBody(request, saveRequestSchema);
    if ("response" in body) return body.response;
    const validated = validateOffices(body.data.offices);
    if ("response" in validated) return validated.response;
    const keys = findDuplicateKeys(validated.rows);
    if (keys.length > 0) return fail("duplicate_keys", 400, { keys });
    await connectDB();
    const summary = await saveBusinessLocations({
      workspaceId,
      userId: access.userId,
      rows: validated.rows,
      deactivateMissing: body.data.deactivateMissing === true,
    });
    const offices = await listBusinessLocations(workspaceId);
    return json({ offices, summary } satisfies BusinessLocationsSaveResponse);
  } catch (error) {
    return writeFailure(error, workspaceId, "PUT");
  }
}

/** Adds one office (Add office); a key already in the catalog is refused. */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await authorize(workspaceId, true);
    if ("response" in access) return access.response;
    const body = await readBody(request, createRequestSchema);
    if ("response" in body) return body.response;
    const validated = validateOffices([body.data.office]);
    if ("response" in validated) return validated.response;
    const [row] = validated.rows;
    await connectDB();
    const office = await createBusinessLocation({
      workspaceId,
      userId: access.userId,
      ...row,
    });
    const offices = await listBusinessLocations(workspaceId);
    return json(
      { office, offices } satisfies BusinessLocationsCreateResponse,
      201
    );
  } catch (error) {
    return writeFailure(error, workspaceId, "POST");
  }
}
