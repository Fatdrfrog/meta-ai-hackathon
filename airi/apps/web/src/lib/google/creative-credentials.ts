import "server-only";

import { resolveGoogleAiCredentialsForWorkspace } from "./google-ai-source";
import type { createClient } from "@/lib/supabase/server";

type SourceClient = Pick<Awaited<ReturnType<typeof createClient>>, "from">;

/** Providers a workspace pays for with its own connected key. */
const OWN_SOURCE_PROVIDER_LABELS: Record<string, string> = {
  google: "Google AI",
  higgsfield: "higgsfield",
  elevenlabs: "ElevenLabs",
};

export class OwnCreativeAiSourceRequiredError extends Error {
  readonly code = "own_ai_source_required";
  constructor(provider: string, options?: { cause?: unknown }) {
    const label = Object.hasOwn(OWN_SOURCE_PROVIDER_LABELS, provider)
      ? OWN_SOURCE_PROVIDER_LABELS[provider]
      : null;
    super(
      label
        ? `Connect your own ${label} credentials in Settings > Integrations to generate images or video.`
        : `Customer-funded ${provider} generation is not available. Use a connected Google AI or Higgsfield source.`,
      options
    );
    this.name = "OwnCreativeAiSourceRequiredError";
  }
}

/** A source row that could not be read right now; the lookup may retry. */
const SOURCE_LOOKUP_UNAVAILABLE_CODES = new Set([
  "GOOGLE_AI_UNAVAILABLE",
  "SOURCE_LOOKUP_UNAVAILABLE",
]);

/**
 * Whether a source error means the source could not be read right now, not
 * that it is missing or invalid. Workers retry these instead of failing.
 */
export function isCreativeAiSourceLookupUnavailable(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const cause = error.cause;
  return (
    error.code === "own_ai_source_required" &&
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    SOURCE_LOOKUP_UNAVAILABLE_CODES.has(cause.code)
  );
}

/** Resolves only this workspace's source; never falls back to a server key. */
export async function resolveWorkspaceGoogleCreativeCredentials(input: {
  supabase: SourceClient;
  workspaceId: string;
  sourceId?: string | null;
}): Promise<{ sourceId: string; apiKey: string }> {
  let sourceId = input.sourceId;
  if (!sourceId) {
    const { data, error } = await input.supabase
      .from("sources")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .eq("type", "google_ai")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.id)
      throw new OwnCreativeAiSourceRequiredError("google");
    sourceId = data.id;
  }
  try {
    return await resolveGoogleAiCredentialsForWorkspace({
      ...input,
      sourceId: sourceId!,
    });
  } catch (error) {
    throw new OwnCreativeAiSourceRequiredError("google", { cause: error });
  }
}

/** Used immediately before worker submission; durable inputs contain only source IDs. */
export async function resolveGoogleCreativeWorkerApiKey(input: {
  workspaceId: string;
  providerSourceId?: string | null;
  allowLegacyPlatform?: boolean;
}): Promise<string> {
  if (!input.providerSourceId) {
    if (input.allowLegacyPlatform) {
      const { getGoogleGenerativeApiKey } = await import("./creative-assets");
      const key = getGoogleGenerativeApiKey();
      if (key) return key;
    }
    throw new OwnCreativeAiSourceRequiredError("google");
  }
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  return (
    await resolveWorkspaceGoogleCreativeCredentials({
      supabase: supabaseAdmin,
      workspaceId: input.workspaceId,
      sourceId: input.providerSourceId,
    })
  ).apiKey;
}

/**
 * The workspace's own ElevenLabs key for a scenario image, read right before
 * submission. Never Airi's platform key: the workspace pays for its images.
 */
export async function resolveElevenLabsCreativeWorkerApiKey(input: {
  workspaceId: string;
  providerSourceId?: string | null;
}): Promise<string> {
  if (!input.providerSourceId) {
    throw new OwnCreativeAiSourceRequiredError("elevenlabs");
  }
  const [{ supabaseAdmin }, { resolveWorkspaceElevenLabsGenerationAccess }] =
    await Promise.all([
      import("@/lib/supabase/admin"),
      import("@/lib/elevenlabs/elevenlabs-source"),
    ]);
  let access: Awaited<
    ReturnType<typeof resolveWorkspaceElevenLabsGenerationAccess>
  >;
  try {
    access = await resolveWorkspaceElevenLabsGenerationAccess({
      supabase: supabaseAdmin,
      workspaceId: input.workspaceId,
      sourceId: input.providerSourceId,
      allowPlatform: false,
    });
  } catch (error) {
    // The lookup throws only when the row could not be read.
    throw new OwnCreativeAiSourceRequiredError("elevenlabs", {
      cause: Object.assign(new Error("ElevenLabs source could not be read"), {
        code: "SOURCE_LOOKUP_UNAVAILABLE",
        cause: error,
      }),
    });
  }
  if (
    !access.available ||
    !access.apiKey ||
    access.credentialSource !== "workspace_source" ||
    access.sourceId !== input.providerSourceId
  ) {
    throw new OwnCreativeAiSourceRequiredError("elevenlabs");
  }
  return access.apiKey;
}

export async function assertWorkspaceCreativeCustomerSource(input: {
  workspaceId: string;
  provider: string;
  providerSourceId?: string | null;
}): Promise<void> {
  if (
    !input.providerSourceId ||
    !["google", "higgsfield"].includes(input.provider)
  ) {
    throw new OwnCreativeAiSourceRequiredError(input.provider);
  }
  if (input.provider === "google") {
    await resolveGoogleCreativeWorkerApiKey(input);
    return;
  }
  const [{ supabaseAdmin }, { resolveHiggsfieldAuthKeyForWorkspace }] =
    await Promise.all([
      import("@/lib/supabase/admin"),
      import("@/lib/higgsfield/higgsfield-source"),
    ]);
  const auth = await resolveHiggsfieldAuthKeyForWorkspace({
    supabase: supabaseAdmin,
    workspaceId: input.workspaceId,
    sourceId: input.providerSourceId,
  });
  if (auth.sourceId !== input.providerSourceId)
    throw new OwnCreativeAiSourceRequiredError(input.provider);
}

export function assertCreativeCustomerProviderSupported(
  provider: string
): void {
  if (!["google", "higgsfield"].includes(provider))
    throw new OwnCreativeAiSourceRequiredError(provider);
}
