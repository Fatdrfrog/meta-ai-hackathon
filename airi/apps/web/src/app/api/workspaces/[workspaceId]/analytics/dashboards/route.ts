import { dashboardBoardStateSchema } from "@/lib/analytics/dashboard-board-schema";
import {
  DashboardPreferencesConflictError,
  getDashboardPreferences,
  saveDashboardPreferences,
} from "@/lib/analytics/dashboard-preferences";
import { getDashboardRecommendation } from "@/lib/analytics/dashboard-recommendation-signals";
import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { logger } from "@/lib/logger";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextResponse } from "next/server";
import { z } from "zod";
import { noStoreJson } from "@/lib/http/no-store-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };
const MAX_BODY_BYTES = 64 * 1024;
const saveSchema = z
  .object({
    state: dashboardBoardStateSchema,
    revision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1)
      .nullable(),
  })
  .strict();

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

const json = (body: unknown, status = 200) =>
  noStoreJson(body, status, { cacheControl: "private, no-store" });

export async function GET(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return privateResponse(access.response);
    // The recommendation never fails the read; it resolves to null instead.
    const [preferences, recommendation] = await Promise.all([
      getDashboardPreferences(workspaceId, access.userId),
      getDashboardRecommendation({ supabase: access.supabase, workspaceId }),
    ]);
    return json({ ...preferences, recommendation });
  } catch (error) {
    logger.error("Analytics dashboard preference read failed", error, {
      workspaceId,
    });
    return json({ error: "Failed to load dashboard preferences" }, 500);
  }
}

export async function PUT(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return privateResponse(access.response);
    const body = await readJsonBodyWithinLimit(request, MAX_BODY_BYTES);
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success)
      return json({ error: "Invalid dashboard preferences" }, 400);
    return json(
      await saveDashboardPreferences({
        workspaceId,
        userId: access.userId,
        ...parsed.data,
      })
    );
  } catch (error) {
    if (error instanceof InvalidJsonBodyError)
      return json({ error: "Invalid JSON body" }, 400);
    if (error instanceof JsonBodyTooLargeError)
      return json({ error: "Dashboard preferences body is too large" }, 413);
    if (error instanceof DashboardPreferencesConflictError) {
      return json(
        {
          error: "Dashboard preferences changed. Reload before saving.",
          code: "revision_conflict",
        },
        409
      );
    }
    logger.error("Analytics dashboard preference save failed", error, {
      workspaceId,
    });
    return json({ error: "Failed to save dashboard preferences" }, 500);
  }
}
