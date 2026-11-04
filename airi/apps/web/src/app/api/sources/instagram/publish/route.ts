import { decryptMaybeString } from "@/lib/crypto";
import {
  GraphApiError,
  createContainerForAccount,
  grantedPermissions as parseGrantedPermissions,
  isGraphIdUnavailableError,
  isGraphMediaIdNotAvailableError,
  isGraphPermissionError,
  permalinkOf,
  publishContainer,
  resolveGraphApiBase,
  resolveInstagramAccountIdCandidates,
  resolvePublishPermission,
  waitForContainerReady,
} from "@/lib/instagram/publish";
import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

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

function resolveAccessToken(value: unknown): string {
  return decryptMaybeString(value);
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

    const access = {
      graphBase: resolveGraphApiBase(authMethod),
      accessToken,
    };

    let instagramAccountId = "";
    let creationId = "";
    try {
      const created = await createContainerForAccount(
        access,
        instagramAccountCandidates,
        mediaType === "reels"
          ? { kind: "reel", videoUrl: mediaUrl, caption, shareToFeed: true }
          : { kind: "image", imageUrl: mediaUrl, caption }
      );
      instagramAccountId = created.accountId;
      creationId = created.containerId;
    } catch (error) {
      if (error instanceof GraphApiError && isGraphIdUnavailableError(error)) {
        return NextResponse.json(
          {
            error:
              "Connected Instagram account ID is not available for publishing. Reconnect Instagram and select the correct professional account.",
            triedAccountIds: instagramAccountCandidates,
          },
          { status: 400 }
        );
      }
      throw error;
    }

    if (mediaType === "reels") {
      await waitForContainerReady(access, creationId);
    }

    const { mediaId: publishedMediaId, response: publishResponse } =
      await publishContainer(access, instagramAccountId, creationId);

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

    // Non-fatal if the permalink can't be read.
    const permalink = await permalinkOf(access, publishedMediaId);

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
