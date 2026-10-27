import "server-only";
import {
  reserveWorkspaceAiSpend,
  settleWorkspaceAiSpend,
} from "@icecore/airi-runtime/workspace-ai-spend";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveWorkspaceElevenLabsGenerationAccess } from "./elevenlabs-source";
import {
  submitElevenLabsTextToSpeech,
  verifyStandardElevenLabsVoice,
} from "./creative-assets";
import { resolveElevenLabsSpeechOptions } from "./speech-options";

export async function generateWorkspaceSpeech(input: {
  workspaceId: string;
  actionId: string;
  text: string;
  voiceId?: string | null;
  language?: string;
  outputFormat?: string;
}) {
  const text = input.text.trim();
  if (!text || text.length > 2500)
    throw new Error("Speech requires between 1 and 2500 characters.");
  const access = await resolveWorkspaceElevenLabsGenerationAccess({
    supabase: supabaseAdmin,
    workspaceId: input.workspaceId,
    allowPlatform: true,
  });
  if (!access.apiKey)
    throw new Error("Connect an ElevenLabs source to generate speech.");
  const voiceId = input.voiceId || access.defaultVoiceId;
  if (access.credentialSource === "platform") {
    if (!voiceId)
      throw new Error("A standard platform voice must be configured.");
    await verifyStandardElevenLabsVoice(access.apiKey, voiceId);
  }
  const reservation =
    access.credentialSource === "platform"
      ? await reserveWorkspaceAiSpend({
          supabase: supabaseAdmin,
          workspaceId: input.workspaceId,
          actionId: input.actionId,
          operationId: "speech",
          provider: "elevenlabs",
          maxCostMicros: 500_000,
        })
      : null;
  const result = await submitElevenLabsTextToSpeech({
    apiKey: access.apiKey,
    text,
    language: input.language,
    voiceId,
    outputFormat: input.outputFormat,
    ...(access.credentialSource === "platform"
      ? {
          modelId: resolveElevenLabsSpeechOptions({ language: input.language })
            .modelId,
        }
      : {}),
  });
  if (reservation)
    await settleWorkspaceAiSpend({
      supabase: supabaseAdmin,
      reservation,
      actualCostMicros: reservation.maxCostMicros,
    });
  if (result.buffer.byteLength > 5 * 1024 * 1024)
    throw new Error("Generated speech exceeds the 5 MiB storage limit.");
  return result;
}
