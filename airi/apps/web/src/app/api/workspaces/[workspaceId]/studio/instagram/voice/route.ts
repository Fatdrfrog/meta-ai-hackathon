import { generateWorkspaceSpeech } from "@/lib/elevenlabs/workspace-speech";
import { WorkspaceAiSpendError } from "@icecore/airi-runtime/workspace-ai-spend";
import { storeScenarioAssetBuffer } from "@/lib/scenarios/scenario-asset-storage";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string }>;

type GenerateVoiceRequest = {
  text?: string;
  language?: string;
};

const AIRI_INSTAGRAM_VOICE_ID = "jqcCZkN6Knx8BJ5TBdYR";

function normalizeLanguage(value?: string): string | undefined {
  if (!value || typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  const aliases: Record<string, string> = {
    english: "en",
    en: "en",
    russian: "ru",
    ru: "ru",
    kazakh: "kk",
    kz: "kk",
    kk: "kk",
    uzbek: "uz",
    uz: "uz",
  };

  return aliases[normalized] || normalized;
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("ogg")) return "ogg";
  return "mp3";
}

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId } = await params;
    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const studioEnabled = await isWorkspaceFeatureEnabled(
      workspaceId,
      "instagram_studio"
    );
    if (!studioEnabled) {
      return NextResponse.json(
        { error: "Instagram Studio is disabled for this workspace" },
        { status: 403 }
      );
    }

    const { data: instagramSource } = await supabase
      .from("sources")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("type", "instagram")
      .limit(1)
      .maybeSingle();

    if (!instagramSource?.id) {
      return NextResponse.json(
        { error: "Instagram is not connected in this workspace" },
        { status: 400 }
      );
    }

    const body = (await request
      .json()
      .catch(() => ({}))) as GenerateVoiceRequest;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 2500) {
      return NextResponse.json(
        { error: "Voice tracks require between 1 and 2500 characters" },
        { status: 400 }
      );
    }

    const speech = await generateWorkspaceSpeech({
      workspaceId,
      actionId: `instagram-voice:${crypto.randomUUID()}`,
      text,
      language: normalizeLanguage(body.language),
      voiceId: AIRI_INSTAGRAM_VOICE_ID,
    });

    const extension = extensionFromMimeType(speech.mimeType);
    const random = crypto.randomBytes(8).toString("hex");
    const fileName = `airi-woman-${Date.now()}-${random}.${extension}`;
    const stored = await storeScenarioAssetBuffer({
      workspaceId,
      buffer: speech.buffer,
      mimeType: speech.mimeType,
      fileName,
    });

    return NextResponse.json({
      success: true,
      url: stored.displayUrl,
      durableUrl: stored.url,
      mimeType: speech.mimeType,
      fileName,
      voiceId: AIRI_INSTAGRAM_VOICE_ID,
      language: normalizeLanguage(body.language) || null,
    });
  } catch (error) {
    if (error instanceof WorkspaceAiSpendError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: error.code === "workspace_ai_policy_unavailable" ? 503 : 402 }
      );
    }

    const message =
      error instanceof Error
        ? error.message
        : "Failed to generate Instagram voice track";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
