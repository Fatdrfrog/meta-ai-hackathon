import "server-only";

import { decryptMaybeString } from "@/lib/crypto";
import type { createClient } from "@/lib/supabase/server";
import { asRecord, cleanString } from "@icecore/shared/lib/value-utils";

type SupabaseSourceClient = Pick<
  Awaited<ReturnType<typeof createClient>>,
  "from"
>;

export type ElevenLabsCredentialSource = "workspace_source" | "platform";
export type ElevenLabsDisabledReason =
  | "source_required"
  | "server_unconfigured";

export type ElevenLabsGenerationAccess = {
  available: boolean;
  reason: ElevenLabsDisabledReason | null;
  sourceId: string | null;
  credentialSource: ElevenLabsCredentialSource | null;
  apiKey: string | null;
  defaultVoiceId: string | null;
};

type SourceRow = {
  id?: string | null;
  credentials?: unknown;
};

export function getPlatformElevenLabsApiKey(): string {
  return cleanString(process.env.ELEVENLABS_API_KEY, 4000);
}

export function isPlatformElevenLabsConfigured(): boolean {
  return Boolean(getPlatformElevenLabsApiKey());
}

/** Saved keys are encrypted; keys saved before that are plain text. */
export function buildElevenLabsCredentials(credentials: unknown): {
  apiKey: string;
  defaultVoiceId: string | null;
} {
  const raw = asRecord(credentials);
  const apiKey =
    cleanString(decryptMaybeString(raw.api_key), 4000) ||
    cleanString(raw.apiKey, 4000) ||
    cleanString(raw.key, 4000);
  const defaultVoiceId =
    cleanString(raw.default_voice_id, 200) ||
    cleanString(raw.defaultVoiceId, 200) ||
    null;
  return { apiKey, defaultVoiceId };
}

async function loadElevenLabsSource(params: {
  supabase: SupabaseSourceClient;
  workspaceId: string;
  sourceId?: string | null;
}): Promise<{
  id: string;
  apiKey: string;
  defaultVoiceId: string | null;
} | null> {
  let query = params.supabase
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", params.workspaceId)
    .eq("type", "elevenlabs");

  if (params.sourceId) {
    query = query.eq("id", params.sourceId);
  } else {
    query = query.order("created_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("ElevenLabs source could not be loaded.");
  if (!data) return null;

  const source = data as SourceRow;
  const sourceId = cleanString(source.id, 200);
  const credentials = buildElevenLabsCredentials(source.credentials);
  if (!sourceId) throw new Error("ElevenLabs source is invalid.");

  return {
    id: sourceId,
    apiKey: credentials.apiKey,
    defaultVoiceId: credentials.defaultVoiceId,
  };
}

export async function resolveWorkspaceElevenLabsGenerationAccess(params: {
  supabase: SupabaseSourceClient;
  workspaceId: string;
  sourceId?: string | null;
  allowPlatform?: boolean;
}): Promise<ElevenLabsGenerationAccess> {
  const source = await loadElevenLabsSource(params);
  if ((source && !source.apiKey) || (!source && params.sourceId)) {
    return {
      available: false,
      reason: "source_required",
      sourceId: source?.id ?? params.sourceId ?? null,
      credentialSource: "workspace_source",
      apiKey: null,
      defaultVoiceId: source?.defaultVoiceId ?? null,
    };
  }
  if (source) {
    return {
      available: true,
      reason: null,
      sourceId: source.id,
      credentialSource: "workspace_source",
      apiKey: source.apiKey,
      defaultVoiceId: source.defaultVoiceId,
    };
  }

  if (!params.allowPlatform) {
    return {
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
      apiKey: null,
      defaultVoiceId: null,
    };
  }
  const platformKey = getPlatformElevenLabsApiKey();
  if (!platformKey) {
    return {
      available: false,
      reason: "server_unconfigured",
      sourceId: null,
      credentialSource: null,
      apiKey: null,
      defaultVoiceId: null,
    };
  }

  return {
    available: true,
    reason: null,
    sourceId: null,
    credentialSource: "platform",
    apiKey: platformKey,
    defaultVoiceId:
      cleanString(process.env.ELEVENLABS_TTS_VOICE_ID, 200) || null,
  };
}

export async function resolveElevenLabsCredentialsForWorkspace(params: {
  supabase: SupabaseSourceClient;
  workspaceId: string;
  sourceId?: string | null;
  allowPlatform?: boolean;
}): Promise<{
  apiKey: string;
  sourceId: string | null;
  credentialSource: ElevenLabsCredentialSource;
  defaultVoiceId: string | null;
}> {
  const access = await resolveWorkspaceElevenLabsGenerationAccess(params);
  if (!access.available || !access.apiKey) {
    throw new Error(
      "Connect an ElevenLabs source in Settings > Integrations to generate audio and captions."
    );
  }

  return {
    apiKey: access.apiKey,
    sourceId: access.sourceId,
    credentialSource: access.credentialSource || "platform",
    defaultVoiceId: access.defaultVoiceId,
  };
}

export function toPublicElevenLabsCredentials(
  credentials: unknown
): Record<string, unknown> {
  const resolved = buildElevenLabsCredentials(credentials);
  const suffix = resolved.apiKey ? resolved.apiKey.slice(-4) : "";

  return {
    has_api_key: Boolean(resolved.apiKey),
    key_label: suffix ? `****${suffix}` : null,
    default_voice_id: resolved.defaultVoiceId,
    connected_at: cleanString(asRecord(credentials).connected_at, 100) || null,
  };
}
