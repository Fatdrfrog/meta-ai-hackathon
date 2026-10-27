import mongoose from "mongoose";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import {
  createProductVideoImport,
  findUploadedVideo,
} from "@/lib/products/imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * Starts importing products from a video the owner uploaded to the
 * workspace's media (`{ assetId }`). Answers with the import to follow.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const body = (await request.json().catch(() => null)) as {
    assetId?: unknown;
  } | null;
  const assetId = typeof body?.assetId === "string" ? body.assetId : "";
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!mongoose.isValidObjectId(assetId))
      return productsFail("invalid_request", 400);
    await connectDB();
    const video = await findUploadedVideo(workspaceId, assetId);
    if (!video) return productsFail("video_not_found", 404);
    const { importId } = await createProductVideoImport({
      workspaceId,
      source: "upload",
      video,
      createdBy: access.userId,
    });
    return productsJson({ importId }, 201);
  } catch (error) {
    logger.error("[Products API] import POST failed", error, {
      event: "products.import_create_failed",
      workspaceId,
    });
    return productsFail("import_unavailable", 503);
  }
}
