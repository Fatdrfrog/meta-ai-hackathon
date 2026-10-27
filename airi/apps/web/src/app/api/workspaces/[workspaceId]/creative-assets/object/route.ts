import { getGoogleCloudPlatformAccessToken } from "@/lib/google/gcp-auth";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import {
  isCreativeAssetObjectPathForWorkspace,
  resolveCreativeAssetGcsObjectRef,
} from "@icecore/airi-runtime/media-api";
import { NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stream a workspace creative-asset object for conversation/UI display.
 * Used when durable `gcs://` refs cannot be signed via Media API (local ADC).
 */
export async function GET(
  request: Request,
  { params }: { params: Params }
): Promise<Response> {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const url = new URL(request.url);
    const ref = resolveCreativeAssetGcsObjectRef({
      url: url.searchParams.get("url"),
      bucket: url.searchParams.get("bucket"),
      path: url.searchParams.get("path"),
    });
    if (!ref) {
      return NextResponse.json(
        { error: "Missing creative asset object ref" },
        { status: 400 }
      );
    }

    if (
      !isCreativeAssetObjectPathForWorkspace({
        workspaceId,
        path: ref.path,
      })
    ) {
      return NextResponse.json({ error: "Forbidden object path" }, { status: 403 });
    }

    const accessToken = await getGoogleCloudPlatformAccessToken();
    const objectUrl =
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(ref.bucket)}` +
      `/o/${encodeURIComponent(ref.path)}?alt=media`;

    const upstream = await fetch(objectUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      return NextResponse.json(
        {
          error: `Failed to read creative asset (${upstream.status})`,
          detail: detail.slice(0, 300),
        },
        { status: upstream.status === 404 ? 404 : 502 }
      );
    }

    const headers = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);
    headers.set("Cache-Control", "private, max-age=300");

    return new Response(upstream.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load creative asset",
      },
      { status: 500 }
    );
  }
}
