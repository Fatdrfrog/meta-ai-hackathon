import type { ScenarioActionAttachment } from "@icecore/scenario-contracts";
import { getWhatsAppVoiceReplyStorage } from "@icecore/airi-runtime/whatsapp-voice-reply-storage";
import { createHash } from "node:crypto";
import { resolveWorkspaceVoiceReplyAccess } from "@/lib/airi/voice-reply-access";
import { submitElevenLabsTextToSpeech } from "@/lib/elevenlabs/creative-assets";
import { resolveElevenLabsSpeechOptions } from "@/lib/elevenlabs/speech-options";
import { getPostHogClient } from "@/lib/posthog/server";
import { formatReplyMarkdownForInstagram } from "./reply-rich-text-format";
import { airiReplyLogger } from "../runtime/reply-logging";

export const WHATSAPP_VOICE_REPLY_MAX_CHARACTERS = 600;
const OUTPUT_FORMAT = "opus_48000_64";
const GLOBAL_PENDING_KEY = "__icecoreWhatsAppVoiceReplyPending__";
const UNSPOKEN_LINK_OR_CODE =
  /https?:\/\/|www\.|\[[^\]]*\]\s*\(|\b(?:mailto|tel):|<[^>]+>|`/i;

export { configureWhatsAppVoiceReplyStorage } from "@icecore/airi-runtime/whatsapp-voice-reply-storage";

type StorageGlobal = typeof globalThis & {
  [GLOBAL_PENDING_KEY]?: Map<string, Promise<ScenarioActionAttachment | null>>;
};

function isMonoOpus(buffer: Buffer, mimeType: string): boolean {
  const opusHeader = buffer.indexOf("OpusHead", 28);
  return (
    mimeType.split(";")[0].trim().toLowerCase() === "audio/ogg" &&
    buffer.length <= 1024 * 1024 &&
    buffer.subarray(0, 4).toString() === "OggS" &&
    opusHeader >= 28 &&
    opusHeader < 256 &&
    buffer.length > opusHeader + 9 &&
    buffer[opusHeader + 9] === 1
  );
}

function recordOutcome(
  workspaceId: string,
  status: string,
  characters: number,
  reason?: string
): void {
  // These are preparation events, never paid revenue or provider delivery receipts.
  try {
    getPostHogClient()?.capture({
      distinctId: `airi:workspace:${workspaceId}`,
      event: "airi_whatsapp_voice_reply_prepared",
      properties: {
        // A workspace is not a person; keep it out of person profiles.
        $process_person_profile: false,
        workspace_id: workspaceId,
        status,
        characters,
        reason,
      },
    });
  } catch {
    airiReplyLogger.warn("airi.reply.voice", {
      workspaceId,
      note: "voice_reply_metrics_unavailable",
    });
  }
}

export async function prepareWhatsAppVoiceReply(input: {
  workspaceId: string;
  text: string;
  language?: string | null;
  deliveryKey: string;
}): Promise<ScenarioActionAttachment | null> {
  const rawText = input.text.trim();
  // Never shorten facts, speak URLs/code, or hide a required clickable link in audio.
  if (
    !input.deliveryKey.trim() ||
    !rawText ||
    rawText.length > WHATSAPP_VOICE_REPLY_MAX_CHARACTERS ||
    UNSPOKEN_LINK_OR_CODE.test(rawText)
  )
    return null;
  const text = formatReplyMarkdownForInstagram(rawText)
    .replace(/ +([.,!?;])/g, "$1")
    .trim();
  if (
    !text ||
    text.length > WHATSAPP_VOICE_REPLY_MAX_CHARACTERS ||
    UNSPOKEN_LINK_OR_CODE.test(text)
  )
    return null;
  const port = getWhatsAppVoiceReplyStorage();
  if (!port) return null;
  let stage = "access_unavailable";
  try {
    const access = await resolveWorkspaceVoiceReplyAccess({
      workspaceId: input.workspaceId,
    });
    if (!access.available || !access.apiKey) {
      recordOutcome(
        input.workspaceId,
        "fallback",
        text.length,
        access.reason || stage
      );
      return null;
    }
    const apiKey = access.apiKey;
    const speechOptions = resolveElevenLabsSpeechOptions({
      language: input.language,
      modelId: process.env.ELEVENLABS_TTS_MODEL,
    });
    const assetId = `airi-voice-${createHash("sha256")
      .update(
        JSON.stringify([
          input.workspaceId,
          input.deliveryKey,
          text,
          speechOptions.languageCode,
          speechOptions.modelId,
          access.defaultVoiceId || process.env.ELEVENLABS_TTS_VOICE_ID || null,
          OUTPUT_FORMAT,
        ])
      )
      .digest("hex")}`;
    const ref = { workspaceId: input.workspaceId, assetId };
    stage = "storage_read_unavailable";
    const existing = await port.find(ref);
    if (existing) {
      recordOutcome(input.workspaceId, "reused", text.length);
      return existing;
    }
    const state = globalThis as StorageGlobal;
    const pending = (state[GLOBAL_PENDING_KEY] ??= new Map());
    const overlapping = pending.get(assetId);
    if (overlapping) return await overlapping;
    stage = "generation_busy";
    const generation = (async () => {
      // Default-off replies do not load the Mongo-backed creative admission owner.
      const { withWorkspaceCreativeGenerationAdmission } = await import(
        "@/lib/creative-assets/creative-generation-admission"
      );
      return withWorkspaceCreativeGenerationAdmission(
        input.workspaceId,
        async () => {
          // A different worker may have completed the same asset while we waited.
          stage = "storage_read_unavailable";
          const stored = await port.find(ref);
          if (stored) return stored;
          stage = "synthesis_unavailable";
          const generated = await submitElevenLabsTextToSpeech({
            apiKey,
            voiceId: access.defaultVoiceId,
            text,
            language: input.language,
            outputFormat: OUTPUT_FORMAT,
            timeoutMs: 10000,
          });
          if (!isMonoOpus(generated.buffer, generated.mimeType)) {
            recordOutcome(
              input.workspaceId,
              "fallback",
              text.length,
              "invalid_voice_audio"
            );
            return null;
          }
          stage = "storage_write_unavailable";
          const attachment = await port.store({
            ...ref,
            buffer: generated.buffer,
          });
          recordOutcome(input.workspaceId, "generated", text.length);
          return attachment;
        }
      );
    })();
    pending.set(assetId, generation);
    try {
      return await generation;
    } finally {
      pending.delete(assetId);
    }
  } catch {
    // Provider errors can contain credentials/content. Keep only a bounded reason.
    recordOutcome(input.workspaceId, "fallback", text.length, stage);
    return null;
  }
}
