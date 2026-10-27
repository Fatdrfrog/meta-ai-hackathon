import { generateWorkspaceSpeech } from "@/lib/elevenlabs/workspace-speech";
import { WorkspaceAiSpendError } from "@icecore/airi-runtime/workspace-ai-spend";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { storeScenarioAssetBuffer } from "@/lib/scenarios/scenario-asset-storage";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sanitizeStorageFilename } from "@icecore/shared/lib/storage-filename";

type Params = Promise<{ workspaceId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** ElevenLabs OPUS format → audio/ogg for WhatsApp voice notes. */
const WHATSAPP_VOICE_TTS_OUTPUT_FORMAT = "opus_48000_64";

const bodySchema = z.object({
  text: z.string().trim().min(1).max(2500),
  voiceId: z.string().trim().max(200).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Text is required for voice generation" },
        { status: 400 }
      );
    }

    const generated = await generateWorkspaceSpeech({
      workspaceId,
      actionId: `scenario-voice:${crypto.randomUUID()}`,
      text: parsed.data.text,
      voiceId: parsed.data.voiceId,
      outputFormat: WHATSAPP_VOICE_TTS_OUTPUT_FORMAT,
    });

    const mimeType = generated.mimeType.includes("ogg")
      ? "audio/ogg"
      : generated.mimeType;
    if (!mimeType.includes("ogg")) {
      return NextResponse.json(
        {
          error:
            "Voice generation did not return OGG/OPUS audio. Check ElevenLabs output format.",
        },
        { status: 502 }
      );
    }

    const fileName = sanitizeStorageFilename(
      `voice-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.ogg`,
      `voice-${Date.now()}.ogg`
    );
    const stored = await storeScenarioAssetBuffer({
      workspaceId,
      buffer: generated.buffer,
      mimeType,
      fileName,
    });

    return NextResponse.json({
      success: true,
      attachment: {
        url: stored.displayUrl,
        durableUrl: stored.url,
        bucket: stored.bucket,
        path: stored.path,
        mediaType: "audio" as const,
        mimeType,
        fileSize: generated.buffer.byteLength,
        fileName,
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceAiSpendError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "workspace_ai_policy_unavailable" ? 503 : 402 }
      );
    }
    const message =
      error instanceof Error ? error.message : "Failed to generate voice";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
