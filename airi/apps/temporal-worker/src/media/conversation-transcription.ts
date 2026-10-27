import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  submitElevenLabsAudioTranscriptionFromUrl,
  submitElevenLabsVideoTranscriptionFromUrl,
  type ElevenLabsTranscriptionWebhookMetadata,
  type SubmitTranscriptionOptions,
} from "@icecore/airi-runtime/elevenlabs-stt";
import type { WorkspaceAiSpendReservation } from "@icecore/airi-runtime/workspace-ai-spend";
import { runProcess } from "./process-runner";
import { downloadProviderVideoToFile } from "./safe-provider-download";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SECONDS = 600;
const MAX_COST_MICROS = 100_000;
const MEDIA_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "application/octet-stream",
]);

export async function prepareConversationTranscription(
  url: string,
  options: SubmitTranscriptionOptions = {},
): Promise<{ fileBuffer: Buffer; durationSeconds: number }> {
  if (options.fileBuffer && options.fileBuffer.length > MAX_BYTES)
    throw new Error("Media exceeds the 20 MiB transcription limit");
  const directory = await mkdtemp(join(tmpdir(), "airi-transcription-"));
  const path = join(directory, "media");
  const audioPath = join(directory, "audio.wav");
  try {
    if (options.fileBuffer) await writeFile(path, options.fileBuffer);
    else
      await downloadProviderVideoToFile({
        url,
        destinationPath: path,
        policy: { kind: "dynamic" },
        maxBytes: MAX_BYTES,
        timeoutMs: 30_000,
        allowedMimeTypes: MEDIA_MIME_TYPES,
      });
    await runProcess({
      command: "ffmpeg",
      args: [
        "-v",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,matroska,webm,mp3,ogg,wav,flac,aac",
        "-i",
        path,
        "-vn",
        "-t",
        String(MAX_SECONDS + 1),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        audioPath,
      ],
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024,
    });
    const result = await runProcess({
      command: "ffprobe",
      args: [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        audioPath,
      ],
      timeoutMs: 5000,
      maxOutputBytes: 16 * 1024,
    });
    const probe = JSON.parse(result.stdout) as {
      format?: { duration?: unknown };
      streams?: Array<{ duration?: unknown }>;
    };
    const durations = [
      probe.format?.duration,
      ...(probe.streams ?? []).map((stream) => stream.duration),
    ]
      .map(Number)
      .filter(Number.isFinite);
    const durationSeconds = Math.max(...durations);
    if (!(durationSeconds > 0) || durationSeconds > MAX_SECONDS)
      throw new Error(
        "Media duration is unknown or exceeds the 10 minute transcription limit",
      );
    return { fileBuffer: await readFile(audioPath), durationSeconds };
  } finally {
    await unlink(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await unlink(audioPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(directory);
  }
}

type Dependencies = {
  resolveAccess: (workspaceId: string) => Promise<{
    apiKey: string;
    credentialSource: "workspace_source" | "platform";
    sourceId?: string | null;
  }>;
  claimSubmission: (input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    credentialSource: "workspace_source" | "platform";
    sourceId: string | null;
  }) => Promise<boolean>;
  reserve: (
    input: WorkspaceAiSpendReservation & { provider: "elevenlabs" },
  ) => Promise<WorkspaceAiSpendReservation>;
  settle: (
    reservation: WorkspaceAiSpendReservation,
    actualCostMicros: number,
  ) => Promise<void>;
  prepare?: typeof prepareConversationTranscription;
  submitAudio?: typeof submitElevenLabsAudioTranscriptionFromUrl;
  submitVideo?: typeof submitElevenLabsVideoTranscriptionFromUrl;
};

export function createConversationTranscriptionSubmitter(deps: Dependencies) {
  const submit = async (
    kind: "audio" | "video",
    url: string,
    mimeType: string | undefined,
    metadata: ElevenLabsTranscriptionWebhookMetadata,
    options: SubmitTranscriptionOptions = {},
  ) => {
    if (!("messageId" in metadata))
      throw new Error("Conversation transcription requires a message identity");
    const access = await deps.resolveAccess(metadata.workspaceId);
    // Reserve before downloading and converting the media: a refused
    // reservation (allowance used up) must not cost a download and an ffmpeg run.
    const reservation =
      access.credentialSource === "platform"
        ? await deps.reserve({
            workspaceId: metadata.workspaceId,
            actionId: `media-analysis:${metadata.messageId}`,
            operationId: "transcription-submit",
            provider: "elevenlabs",
            maxCostMicros: MAX_COST_MICROS,
          })
        : null;
    let prepared: Awaited<ReturnType<typeof prepareConversationTranscription>>;
    try {
      prepared = await (deps.prepare ?? prepareConversationTranscription)(
        url,
        options,
      );
      if (
        prepared.fileBuffer.length > MAX_BYTES ||
        !(prepared.durationSeconds > 0) ||
        prepared.durationSeconds > MAX_SECONDS
      ) {
        throw new Error("Media exceeds the conversation transcription limit");
      }
    } catch (error) {
      if (reservation) await deps.settle(reservation, 0);
      throw error;
    }
    const claimed = await deps.claimSubmission({
      workspaceId: metadata.workspaceId,
      conversationId: metadata.conversationId,
      messageId: metadata.messageId,
      credentialSource: access.credentialSource,
      sourceId: access.sourceId ?? null,
    });
    if (!claimed) {
      if (reservation) await deps.settle(reservation, 0);
      throw new Error(
        "Transcription was already submitted. Reconcile its existing result before retrying.",
      );
    }
    const provider =
      kind === "video"
        ? (deps.submitVideo ?? submitElevenLabsVideoTranscriptionFromUrl)
        : (deps.submitAudio ?? submitElevenLabsAudioTranscriptionFromUrl);
    // Send the inspected bytes: a remote URL could change after its duration check.
    const result = await provider(url, "audio/wav", metadata, {
      ...options,
      fileBuffer: prepared.fileBuffer,
      apiKey: access.apiKey,
      modelId:
        access.credentialSource === "platform" ? "scribe_v2" : options.modelId,
      allowWebhookFallback: false,
    });
    if (reservation) await deps.settle(reservation, MAX_COST_MICROS);
    return result;
  };
  return {
    submitAudio: (
      url: string,
      mimeType: string | undefined,
      metadata: ElevenLabsTranscriptionWebhookMetadata,
      options?: SubmitTranscriptionOptions,
    ) => submit("audio", url, mimeType, metadata, options),
    submitVideo: (
      url: string,
      mimeType: string | undefined,
      metadata: ElevenLabsTranscriptionWebhookMetadata,
      options?: SubmitTranscriptionOptions,
    ) => submit("video", url, mimeType, metadata, options),
  };
}
