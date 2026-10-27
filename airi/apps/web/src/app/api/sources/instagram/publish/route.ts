import { decryptMaybeString } from "@/lib/crypto";
import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { resolveInstagramGraphBase } from "@icecore/shared/lib/meta/graph-version";
import { NextRequest, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import {
  readTrimmedString as normalizeIdentifier,
  readUniqueStringArray,
} from "@icecore/shared/lib/value-utils";

export const maxDuration = 180;
export const dynamic = "force-dynamic";

type PublishMediaType = "image" | "video" | "reels";

type PublishRequestBody = {
  mediaType?: PublishMediaType;
  mediaUrl?: string;
  caption?: string;
  workspaceId?: string;
};

const IG_MAX_CAPTION_LENGTH = 2200;

type GraphErrorPayload = {
  error?: {
    message?: string;
    type?: string;
    code?: number | string;
    error_subcode?: number | string;
    fbtrace_id?: string;
  };
};

class GraphApiError extends Error {
  status: number;
  graphCode?: number;
  graphType?: string;
  graphSubcode?: number;
  graphTraceId?: string;

  constructor(
    status: number,
    message: string,
    options?: {
      graphCode?: number;
      graphType?: string;
      graphSubcode?: number;
      graphTraceId?: string;
    }
  ) {
    super(message);
    this.name = "GraphApiError";
    this.status = status;
    this.graphCode = options?.graphCode;
    this.graphType = options?.graphType;
    this.graphSubcode = options?.graphSubcode;
    this.graphTraceId = options?.graphTraceId;
  }
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toGraphApiError(
  status: number,
  json: Record<string, unknown>,
  fallbackMessage: string
): GraphApiError {
  const payload = json as GraphErrorPayload;
  const graphError = payload.error || {};
  const message =
    typeof graphError.message === "string" && graphError.message.trim()
      ? graphError.message.trim()
      : fallbackMessage;

  return new GraphApiError(status, message, {
    graphCode: toOptionalNumber(graphError.code),
    graphType:
      typeof graphError.type === "string" ? graphError.type.trim() : undefined,
    graphSubcode: toOptionalNumber(graphError.error_subcode),
    graphTraceId:
      typeof graphError.fbtrace_id === "string"
        ? graphError.fbtrace_id.trim()
        : undefined,
  });
}

function isGraphPermissionError(error: GraphApiError): boolean {
  const message = error.message.toLowerCase();
  return (
    error.graphCode === 10 ||
    error.graphCode === 200 ||
    message.includes("permission") ||
    message.includes("not authorized")
  );
}

function isGraphIdUnavailableError(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return false;
  if (![400, 403, 404].includes(error.status)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes("unsupported post request") ||
    message.includes("object with id") ||
    message.includes("does not exist") ||
    message.includes("invalid user id") ||
    message.includes("cannot be loaded due to missing permissions")
  );
}

function isGraphMediaIdNotAvailableError(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return false;
  const message = error.message.toLowerCase();
  return message.includes("media id") && message.includes("not available");
}

function mapGraphErrorStatus(error: GraphApiError): number {
  if (isGraphIdUnavailableError(error)) return 400;
  if (error.graphCode === 190) return 401;
  if (isGraphPermissionError(error)) return 403;
  if (error.status >= 400 && error.status < 500) return error.status;
  return 502;
}

function mapGraphErrorMessage(error: GraphApiError): string {
  if (error.graphCode === 190) {
    return "Instagram access token is invalid or expired. Reconnect Instagram and try again.";
  }
  if (isGraphIdUnavailableError(error)) {
    return "Connected Instagram account ID is not available for publishing. Reconnect Instagram and select the correct professional account.";
  }
  if (isGraphMediaIdNotAvailableError(error)) {
    return "Video or Reel is still processing on Instagram. Try again in 1-2 minutes, or use a shorter video. Ensure the media URL is publicly accessible.";
  }
  return error.message || "Graph API request failed";
}

function parseGrantedPermissions(raw: unknown): Set<string> {
  if (typeof raw !== "string") return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map(v => v.trim())
      .filter(Boolean)
  );
}

function resolveAccessToken(value: unknown): string {
  return decryptMaybeString(value);
}

function resolvePublishPermission(authMethod: string): string {
  return authMethod === "instagram_business_login"
    ? "instagram_business_content_publish"
    : "instagram_content_publish";
}

function resolveInstagramAccountIdCandidates(
  credentials: Record<string, unknown>
): string[] {
  const authMethod = String(credentials.auth_method || "");
  const businessId = normalizeIdentifier(
    credentials.instagram_business_account_id
  );
  const scopedId = normalizeIdentifier(credentials.instagram_scoped_id);
  const pageId = normalizeIdentifier(credentials.page_id);

  if (authMethod === "instagram_business_login") {
    return readUniqueStringArray([businessId, scopedId, pageId]);
  }

  return readUniqueStringArray([businessId, scopedId, pageId]);
}

function resolveGraphApiBase(authMethod: string): string {
  return resolveInstagramGraphBase(authMethod);
}

/**
 * Meta's current publishing docs use REELS for single-video publishing.
 * Keep "video" in our API for UI compatibility, but publish via REELS.
 */
function normalizeContainerMediaType(
  mediaType: PublishMediaType
): "image" | "reels" {
  return mediaType === "image" ? "image" : "reels";
}

function assertValidUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Only HTTP(S) URLs are allowed");
    }
    return url.toString();
  } catch {
    throw new Error("mediaUrl must be a valid HTTP(S) URL");
  }
}

async function graphPost(
  url: string,
  body: URLSearchParams
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
  });

  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    throw toGraphApiError(
      response.status,
      json,
      `Graph API request failed (${response.status})`
    );
  }

  return json;
}

async function graphGet(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "GET", cache: "no-store" });
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    throw toGraphApiError(
      response.status,
      json,
      `Graph API request failed (${response.status})`
    );
  }

  return json;
}

async function waitForVideoContainerReady(
  graphBase: string,
  creationId: string,
  accessToken: string
) {
  const maxAttempts = 48;
  const delayMs = 2500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const statusUrl = new URL(`${graphBase}/${encodeURIComponent(creationId)}`);
    statusUrl.searchParams.set("fields", "status_code,status");
    statusUrl.searchParams.set("access_token", accessToken);

    const statusJson = await graphGet(statusUrl.toString());
    const statusCode = String(
      statusJson.status_code || statusJson.status || ""
    ).toUpperCase();

    if (statusCode === "FINISHED" || statusCode === "PUBLISHED") {
      return;
    }

    if (
      statusCode === "ERROR" ||
      statusCode === "FAILED" ||
      statusCode === "EXPIRED"
    ) {
      throw new Error(
        `Instagram video processing failed with status: ${statusCode}`
      );
    }

    if (attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    "Instagram video or Reel is still processing. Try again in 1-2 minutes; some videos take longer to process."
  );
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as PublishRequestBody;
    const requestedWorkspaceId = String(body.workspaceId || "").trim();

    let workspaceId = "";
    if (requestedWorkspaceId) {
      if (
        !(await checkUserWorkspaceAccess(
          supabase,
          user.id,
          requestedWorkspaceId
        ))
      ) {
        return NextResponse.json(
          { error: "Access denied to this workspace" },
          { status: 403 }
        );
      }

      workspaceId = requestedWorkspaceId;
    } else {
      const { data: companyUser } = await supabase
        .from("company_users")
        .select("workspace_id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      if (!companyUser?.workspace_id) {
        return NextResponse.json(
          { error: "User not associated with workspace" },
          { status: 403 }
        );
      }

      workspaceId = companyUser.workspace_id;
    }

    const requestedMediaType =
      body.mediaType === "reels"
        ? "reels"
        : body.mediaType === "video"
          ? "video"
          : "image";
    const mediaType = normalizeContainerMediaType(requestedMediaType);
    const mediaUrlRaw = String(body.mediaUrl || "").trim();
    const caption = String(body.caption || "").trim();

    if (!mediaUrlRaw) {
      return NextResponse.json(
        { error: "mediaUrl is required" },
        { status: 400 }
      );
    }

    if (caption.length > IG_MAX_CAPTION_LENGTH) {
      return NextResponse.json(
        {
          error: `Caption is too long (${caption.length}/${IG_MAX_CAPTION_LENGTH})`,
        },
        { status: 400 }
      );
    }

    const mediaUrl = assertValidUrl(mediaUrlRaw);

    const source = await fetchSourceWithCredentials(undefined, "instagram", {
      workspace_id: workspaceId,
    });

    if (!source?.workspace_id) {
      return NextResponse.json(
        { error: "Instagram source not connected" },
        { status: 400 }
      );
    }

    const credentials = (source.credentials || {}) as Record<string, unknown>;
    const authMethod = String(credentials.auth_method || "");
    const requiredPermission = resolvePublishPermission(authMethod);
    const grantedPermissions = parseGrantedPermissions(
      credentials.granted_permissions
    );

    if (
      grantedPermissions.size > 0 &&
      !grantedPermissions.has(requiredPermission)
    ) {
      return NextResponse.json(
        {
          error: `Missing required permission: ${requiredPermission}. Reconnect Instagram and grant publishing scope.`,
          requiredPermission,
        },
        { status: 403 }
      );
    }

    const accessToken = resolveAccessToken(credentials.page_access_token);
    if (!accessToken) {
      return NextResponse.json(
        { error: "Instagram access token is missing" },
        { status: 400 }
      );
    }

    const instagramAccountCandidates =
      resolveInstagramAccountIdCandidates(credentials);
    if (instagramAccountCandidates.length === 0) {
      return NextResponse.json(
        { error: "Instagram account ID is missing" },
        { status: 400 }
      );
    }

    const graphBase = resolveGraphApiBase(authMethod);

    const createBodyTemplate = new URLSearchParams();
    createBodyTemplate.set("access_token", accessToken);
    createBodyTemplate.set("caption", caption);
    if (mediaType === "reels") {
      createBodyTemplate.set("media_type", "REELS");
      createBodyTemplate.set("video_url", mediaUrl);
      createBodyTemplate.set("share_to_feed", "true");
    } else {
      createBodyTemplate.set("image_url", mediaUrl);
    }

    let instagramAccountId = "";
    let creationId = "";
    let lastCreateError: unknown = null;

    for (const candidateAccountId of instagramAccountCandidates) {
      try {
        const createResponse = await graphPost(
          `${graphBase}/${encodeURIComponent(candidateAccountId)}/media`,
          new URLSearchParams(createBodyTemplate)
        );

        const candidateCreationId = String(createResponse.id || "");
        if (!candidateCreationId) {
          throw new Error("Failed to create Instagram media container");
        }

        instagramAccountId = candidateAccountId;
        creationId = candidateCreationId;
        break;
      } catch (error) {
        lastCreateError = error;
        if (isGraphIdUnavailableError(error)) {
          continue;
        }
        throw error;
      }
    }

    if (!instagramAccountId || !creationId) {
      if (
        lastCreateError instanceof GraphApiError &&
        isGraphIdUnavailableError(lastCreateError)
      ) {
        return NextResponse.json(
          {
            error:
              "Connected Instagram account ID is not available for publishing. Reconnect Instagram and select the correct professional account.",
            triedAccountIds: instagramAccountCandidates,
          },
          { status: 400 }
        );
      }
      if (lastCreateError) {
        throw lastCreateError;
      }
      return NextResponse.json(
        { error: "Failed to create Instagram media container" },
        { status: 500 }
      );
    }

    if (mediaType === "reels") {
      await waitForVideoContainerReady(graphBase, creationId, accessToken);
    }

    const publishBody = new URLSearchParams();
    publishBody.set("access_token", accessToken);
    publishBody.set("creation_id", creationId);

    const publishResponse = await graphPost(
      `${graphBase}/${encodeURIComponent(instagramAccountId)}/media_publish`,
      publishBody
    );

    const publishedMediaId = String(publishResponse.id || "");
    if (!publishedMediaId) {
      const graphError = (publishResponse as { error?: { message?: string } })
        .error?.message;
      const isMediaIdNotAvailable =
        typeof graphError === "string" &&
        graphError.toLowerCase().includes("media id") &&
        graphError.toLowerCase().includes("not available");
      return NextResponse.json(
        {
          error: isMediaIdNotAvailable
            ? "Video or Reel is still processing on Instagram. Try again in 1-2 minutes, or use a shorter video. Ensure the media URL is publicly accessible."
            : "Instagram media publish did not return media id",
        },
        { status: 500 }
      );
    }

    let permalink = "";
    try {
      const permalinkUrl = new URL(
        `${graphBase}/${encodeURIComponent(publishedMediaId)}`
      );
      permalinkUrl.searchParams.set("fields", "id,permalink,media_type");
      permalinkUrl.searchParams.set("access_token", accessToken);
      const permalinkResponse = await graphGet(permalinkUrl.toString());
      permalink = String(permalinkResponse.permalink || "");
    } catch {
      // Non-fatal if permalink fetch fails.
    }

    return NextResponse.json({
      ok: true,
      mediaType,
      requestedMediaType,
      instagramAccountId,
      creationId,
      publishedMediaId,
      permalink: permalink || undefined,
      requiredPermission,
      authMethod: authMethod || "unknown",
    });
  } catch (error) {
    if (error instanceof GraphApiError) {
      const status = mapGraphErrorStatus(error);
      return NextResponse.json(
        {
          error: mapGraphErrorMessage(error),
          graphStatus: error.status,
          graphCode: error.graphCode,
          graphType: error.graphType,
        },
        { status }
      );
    }

    const message =
      error instanceof Error ? error.message : "Failed to publish media";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
