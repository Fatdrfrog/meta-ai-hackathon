import { requireAppAdmin } from "@/lib/auth/app-admin";
import { createRequestLogger } from "@/lib/observability/server-logs";
import { resolveTikTokOAuthConfig } from "@/lib/tiktok-discovery/oauth-config";
import {
  TIKTOK_ADMIN_OAUTH_RESULTS,
  type TikTokAdminOAuthResult,
} from "@/lib/tiktok-discovery/oauth-result";
import {
  readTikTokPlatformCredentialStatus,
  type TikTokPlatformCredentialSafeRecord,
} from "@/lib/tiktok-discovery/platform-credential";
import type { TikTokSafeErrorCode } from "@/lib/tiktok-discovery/safe-errors";
import { type NextRequest, NextResponse } from "next/server";

export type TikTokAdminStatusResponse = {
  configured: boolean;
  result: TikTokAdminOAuthResult | null;
  credential: null | {
    status: "connected" | "reconnect_required";
    selectedAdvertiserId: string;
    authorizedAdvertiserCount: number;
    connectedAt: string;
    lastValidatedAt: string | null;
    lastErrorCode: TikTokSafeErrorCode | null;
  };
};

const ADMIN_OAUTH_RESULT_SET = new Set<TikTokAdminOAuthResult>(
  TIKTOK_ADMIN_OAUTH_RESULTS
);

function toAdminStatusCredential(
  record: TikTokPlatformCredentialSafeRecord | null
): TikTokAdminStatusResponse["credential"] {
  if (!record) return null;
  return {
    status: record.status,
    selectedAdvertiserId: record.advertiserId,
    authorizedAdvertiserCount: record.authorizedAdvertiserCount,
    connectedAt: record.connectedAt.toISOString(),
    lastValidatedAt: record.lastValidatedAt?.toISOString() ?? null,
    lastErrorCode: record.lastErrorCode,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const admin = await requireAppAdmin();
  if (admin.response) return admin.response;

  const configured = resolveTikTokOAuthConfig();
  if (configured.status !== "configured") {
    // The response intentionally reduces configuration to a Boolean, so the
    // specific missing or malformed environment value is only recorded
    // server-side. The reason is a fixed enum and never carries credentials.
    createRequestLogger("api.internal.tiktok.status", request).warn(
      "TikTok Discovery is not configured",
      { reason: configured.reason }
    );
  }

  let record: TikTokPlatformCredentialSafeRecord | null;
  try {
    record = await readTikTokPlatformCredentialStatus();
  } catch {
    return NextResponse.json(
      { error: "TikTok Discovery is temporarily unavailable" },
      { status: 503 }
    );
  }
  const result = request.nextUrl.searchParams.get("result");
  const response: TikTokAdminStatusResponse = {
    configured: configured.status === "configured",
    result:
      result && ADMIN_OAUTH_RESULT_SET.has(result as TikTokAdminOAuthResult)
        ? (result as TikTokAdminOAuthResult)
        : null,
    credential: toAdminStatusCredential(record),
  };
  return NextResponse.json(response);
}
