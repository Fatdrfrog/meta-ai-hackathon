import "server-only";
import { isRecord } from "@icecore/shared/lib/value-utils";

import { getVertexGenAI } from "./vertex-genai-client";

const DEFAULT_VERTEX_VIDEO_LOCATION = "us-central1";

export type VertexVideoOperation = {
  name: string;
  done?: boolean;
  response?: unknown;
  error?: unknown;
};

export type VertexGeneratedVideoResult = {
  uri?: string;
  videoBytes?: string;
  mimeType: string;
};

function parseEnabledFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isVertexVideoConfigured(): boolean {
  return parseEnabledFlag(process.env.VERTEX_VIDEO_ENABLED);
}

export function getVertexVideoLocation(): string {
  return (
    process.env.VERTEX_VIDEO_LOCATION?.trim() || DEFAULT_VERTEX_VIDEO_LOCATION
  );
}

export async function pollVertexVideoOperation(
  operationName: string
): Promise<VertexVideoOperation> {
  if (!isVertexVideoConfigured()) {
    throw new Error("Vertex video generation is disabled");
  }

  const normalizedName = operationName.trim();
  if (!normalizedName) {
    throw new Error("Operation name is required");
  }

  const client = await getVertexGenAI(getVertexVideoLocation());
  const operations = (
    client as unknown as { operations?: Record<string, unknown> }
  ).operations;
  const getVideosOperation =
    operations && typeof operations.getVideosOperation === "function"
      ? (operations.getVideosOperation as (
          payload: unknown
        ) => Promise<unknown>)
      : null;
  const getGenericOperation =
    operations && typeof operations.get === "function"
      ? (operations.get as (payload: unknown) => Promise<unknown>)
      : null;

  if (!getVideosOperation && !getGenericOperation) {
    throw new Error(
      "@google/genai client does not expose operations.getVideosOperation"
    );
  }

  const operation = { name: normalizedName };
  const result = (await (getVideosOperation
    ? getVideosOperation({ operation })
    : getGenericOperation?.({ operation }))) as Record<string, unknown>;

  return {
    name: normalizedName,
    done: Boolean(result.done),
    response: result.response,
    error: result.error,
  };
}

export function extractVertexVideoResults(
  response: unknown
): VertexGeneratedVideoResult[] {
  if (!isRecord(response) || !Array.isArray(response.generatedVideos)) {
    return [];
  }

  return response.generatedVideos.flatMap(item => {
    if (!isRecord(item) || !isRecord(item.video)) return [];
    const uri = typeof item.video.uri === "string" ? item.video.uri : "";
    const videoBytes =
      typeof item.video.videoBytes === "string" ? item.video.videoBytes : "";
    if (!uri && !videoBytes) return [];
    return [
      {
        uri: uri || undefined,
        videoBytes: videoBytes || undefined,
        mimeType:
          typeof item.video.mimeType === "string"
            ? item.video.mimeType
            : "video/mp4",
      },
    ];
  });
}

export async function downloadVertexVideoResult(
  result: VertexGeneratedVideoResult
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (result.videoBytes) {
    return {
      buffer: Buffer.from(result.videoBytes, "base64"),
      mimeType: result.mimeType || "video/mp4",
    };
  }

  if (!result.uri) {
    throw new Error("Vertex video result did not include bytes or a URI");
  }

  if (result.uri.startsWith("gs://")) {
    throw new Error(
      "Vertex returned a GCS URI. Configure output download support or omit outputGcsUri so bytes are returned."
    );
  }

  if (!/^https?:\/\//i.test(result.uri)) {
    throw new Error("Vertex returned an unsupported video URI");
  }

  const response = await fetch(result.uri);
  if (!response.ok) {
    throw new Error(`Failed to download Vertex video: ${response.status}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType:
      response.headers.get("content-type") || result.mimeType || "video/mp4",
  };
}
