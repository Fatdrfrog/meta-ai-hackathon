import "server-only";

import { NextResponse } from "next/server";

import type { VideoGenerationQueueError } from "./video-generation-queue";

export function videoGenerationQueueErrorResponse(
  error: VideoGenerationQueueError
): NextResponse {
  const headers =
    error.status === 503 && error.code === "generation_admission_busy"
      ? { "Retry-After": "1" }
      : undefined;
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      ...(typeof error.maxLength === "number"
        ? { maxLength: error.maxLength }
        : {}),
    },
    { status: error.status, headers }
  );
}
