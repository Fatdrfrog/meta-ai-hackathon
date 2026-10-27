import connectDB from "@/lib/mongoose";
import { parsePositiveInt } from "@/lib/api/query-params";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { ScenarioTriggerLog } from "@/models/scenario-trigger-log";
import { Types } from "mongoose";
import { NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

type TriggerLogCursor = {
  evaluatedAt: string;
  id: string;
};

function encodeTriggerLogCursor(cursor: TriggerLogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTriggerLogCursor(raw: string | null): TriggerLogCursor | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    ) as Partial<TriggerLogCursor>;
    if (
      !decoded ||
      typeof decoded.evaluatedAt !== "string" ||
      typeof decoded.id !== "string"
    ) {
      return null;
    }
    if (!Types.ObjectId.isValid(decoded.id)) return null;
    const evaluatedAt = new Date(decoded.evaluatedAt);
    if (Number.isNaN(evaluatedAt.getTime())) return null;
    return {
      evaluatedAt: evaluatedAt.toISOString(),
      id: decoded.id,
    };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const scenarioId = searchParams.get("scenarioId");
    const days = parsePositiveInt(searchParams.get("days"), 14, 1, 90);
    const limit = parsePositiveInt(searchParams.get("limit"), 200, 1, 500);
    const cursor = decodeTriggerLogCursor(searchParams.get("cursor"));

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }

    await connectDB();

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Math.max(1, Math.min(days, 90)));

    const query: Record<string, unknown> = {
      workspaceId,
      evaluatedAt: { $gte: startDate },
    };
    if (scenarioId) {
      query.scenarioId = scenarioId;
    }
    if (cursor) {
      query.$or = [
        { evaluatedAt: { $lt: new Date(cursor.evaluatedAt) } },
        {
          evaluatedAt: new Date(cursor.evaluatedAt),
          _id: { $lt: new Types.ObjectId(cursor.id) },
        },
      ];
    }

    const logs = await ScenarioTriggerLog.find(query)
      .sort({ evaluatedAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean<Record<string, unknown>[]>();

    const hasMore = logs.length > limit;
    const sliced = hasMore ? logs.slice(0, limit) : logs;

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = sliced[sliced.length - 1];
      const lastId = String(last?._id || "");
      const evaluatedAt = new Date(last?.evaluatedAt as string | Date);
      if (lastId && !Number.isNaN(evaluatedAt.getTime())) {
        nextCursor = encodeTriggerLogCursor({
          id: lastId,
          evaluatedAt: evaluatedAt.toISOString(),
        });
      }
    }

    return NextResponse.json({ logs: sliced, hasMore, nextCursor });
  } catch (error) {
    console.error("[Scenario Trigger Logs API] GET error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
