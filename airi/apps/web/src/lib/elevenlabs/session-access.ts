import "server-only";

import {
  checkCriticalRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import { NextResponse } from "next/server";
import { resolveWorkspaceElevenLabsGenerationAccess } from "./elevenlabs-source";

const tokenLimiter = createRateLimiter({
  requests: 6,
  window: "1 m",
  prefix: "elevenlabs:session-token",
  analytics: false,
});

export async function resolveElevenLabsSessionAccess(
  params: Parameters<typeof resolveWorkspaceElevenLabsGenerationAccess>[0]
): Promise<
  | { apiKey: string; response?: never }
  | { response: NextResponse; apiKey?: never }
> {
  const access = await resolveWorkspaceElevenLabsGenerationAccess(params);
  // A bearer session cannot enforce the platform's per-action spending bound.
  if (access.credentialSource !== "workspace_source" || !access.apiKey) {
    return {
      response: NextResponse.json(
        {
          error: "Connect an ElevenLabs source to use realtime voice.",
          code: "elevenlabs_source_required",
        },
        { status: 402 }
      ),
    };
  }

  const admission = await checkCriticalRateLimit(
    tokenLimiter,
    params.workspaceId
  );
  if (admission.status !== "granted") {
    return {
      response: NextResponse.json(
        {
          error:
            admission.status === "limited"
              ? "Voice session limit reached. Try again shortly."
              : "Voice sessions are temporarily unavailable.",
          code:
            admission.status === "limited"
              ? "rate_limited"
              : "admission_unavailable",
        },
        { status: admission.status === "limited" ? 429 : 503 }
      ),
    };
  }
  return { apiKey: access.apiKey };
}
