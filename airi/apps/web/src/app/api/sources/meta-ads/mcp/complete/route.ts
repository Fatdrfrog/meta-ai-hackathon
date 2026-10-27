import { completeMetaAdsMcpOAuth } from "@/lib/meta-ads/mcp/complete-mcp-oauth";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { NextRequest } from "next/server";
import { noStoreJson } from "@/lib/http/no-store-json";
import { readJsonBodyOrResponse } from "@/lib/api/json-body";

type CompleteBody = {
  workspaceId?: unknown;
  code?: unknown;
  redirectUri?: unknown;
  allowCreateGraphSource?: unknown;
  intent?: unknown;
};

const json = (body: unknown, status = 200) =>
  noStoreJson(body, status, { cacheControl: "no-store" });

export async function POST(request: NextRequest) {
  const bodyResult = await readJsonBodyOrResponse(request, {
    headers: { "Cache-Control": "no-store" },
  });
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.body as CompleteBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid request body" }, 400);
  }
  if (
    body.intent !== undefined &&
    body.intent !== "reporting" &&
    body.intent !== "ai_ads"
  ) {
    return json({ error: "Invalid connection intent" }, 400);
  }

  const workspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const redirectUri =
    typeof body.redirectUri === "string" ? body.redirectUri.trim() : "";
  const allowCreateGraphSource = body.allowCreateGraphSource === true;

  if (!workspaceId) {
    return json({ error: "workspaceId is required" }, 400);
  }
  if (!code) {
    return json({ error: "code is required" }, 400);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }

  const hasAccess = await checkUserWorkspaceAccess(
    supabase,
    user.id,
    workspaceId
  );
  if (!hasAccess) {
    return json({ error: "Forbidden" }, 403);
  }

  const result = await completeMetaAdsMcpOAuth({
    supabase,
    workspaceId,
    code,
    redirectUri: redirectUri || null,
    allowCreateGraphSource,
    intent: body.intent ?? "ai_ads",
  });

  if (!result.ok) {
    return json(
      {
        error: result.error,
        ...(result.adAccounts
          ? {
              adAccounts: result.adAccounts,
              selectedAdAccountId: result.selectedAdAccountId,
            }
          : {}),
      },
      result.status
    );
  }

  return json({
    success: true,
    createdSource: result.createdSource,
    readiness: result.readiness,
    reportingReady: result.reportingReady,
    reporting: result.reporting,
    adAccounts: result.adAccounts,
    selectedAdAccountId: result.selectedAdAccountId,
  });
}
