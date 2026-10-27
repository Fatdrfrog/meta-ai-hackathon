import {
  replaceActiveMention,
  type ActiveMention,
} from "@/lib/composer/mention";
import type { StudioSkillId } from "./studio-skills";

const STUDIO_SKILL_TOKEN_PATTERN =
  /(?<!\S)@(Image|Banner|Video|Character|Morph|Voice|Avatar)\b[ \t]?/gi;

const STUDIO_SKILL_TOKEN_LABELS: Record<StudioSkillId, string> = {
  image: "Image",
  banner: "Banner",
  video: "Video",
  character: "Character",
  morph: "Morph",
  audio: "Voice",
  avatar: "Avatar",
};

const STUDIO_SKILL_BY_TOKEN_LABEL: Record<string, StudioSkillId> = {
  image: "image",
  banner: "banner",
  video: "video",
  character: "character",
  morph: "morph",
  voice: "audio",
  avatar: "avatar",
};

export type StudioComposerDraft = {
  skill: StudioSkillId;
  prompt: string;
};

export type StudioGenerationBlocker =
  | "setup_required"
  | "prompt_required"
  | "source_image_required"
  | "source_media_required"
  | "character_reference_required"
  | "morph_frames_required"
  | "morph_frames_must_differ"
  | "duration_invalid"
  | "avatar_portrait_required"
  | "avatar_audio_required"
  | "avatar_voice_required"
  | null;

export type StudioGenerationValidationInput = {
  skill: StudioSkillId;
  prompt: string;
  available: boolean;
  duration: string;
  durationMax?: number;
  durationOptions?: readonly number[];
  videoSourceAssetId?: string;
  characterReferenceCount?: number;
  morphFirstFrameAssetId?: string;
  morphLastFrameAssetId?: string;
  elevenLabsMode?:
    | "text_to_speech"
    | "sound_effect"
    | "transcript"
    | "subtitles"
    | "dub";
  elevenLabsSourceAssetId?: string;
  avatarImageAssetId?: string;
  avatarAudioAssetId?: string;
  wanAvatarMode?: "image_audio" | "image_script";
  elevenLabsAvailable?: boolean;
};

export function studioSkillToken(skill: StudioSkillId): string {
  return `@${STUDIO_SKILL_TOKEN_LABELS[skill]}`;
}

export type StudioSkillTokenMatch = {
  skill: StudioSkillId;
  start: number;
  end: number;
  token: string;
};

export function findStudioSkillTokens(value: string): StudioSkillTokenMatch[] {
  return Array.from(value.matchAll(STUDIO_SKILL_TOKEN_PATTERN), match => {
    const label = match[1] ?? "";
    const token = `@${label}`;
    const start = match.index ?? 0;
    return {
      skill: STUDIO_SKILL_BY_TOKEN_LABEL[label.toLowerCase()],
      start,
      end: start + token.length,
      token,
    };
  });
}

export function detectStudioSkillFromText(value: string): StudioSkillId | null {
  return findStudioSkillTokens(value).at(-1)?.skill ?? null;
}

export function stripStudioSkillTokens(value: string): string {
  return value.replace(STUDIO_SKILL_TOKEN_PATTERN, "");
}

export function selectStudioSkill(params: {
  draft: StudioComposerDraft;
  nextSkill: StudioSkillId;
  mention: ActiveMention | null;
}): { draft: StudioComposerDraft; caret: number } {
  if (!params.draft.prompt && !params.mention) {
    return {
      draft: { skill: params.nextSkill, prompt: "" },
      caret: 0,
    };
  }

  const selected = params.mention
    ? replaceActiveMention({
        value: params.draft.prompt,
        mention: params.mention,
        token: studioSkillToken(params.nextSkill),
      }).value
    : params.draft.prompt;
  const brief = stripStudioSkillTokens(selected);
  const prompt = brief
    ? `${studioSkillToken(params.nextSkill)}${
        /^[\r\n]/.test(brief) ? "" : " "
      }${brief}`
    : studioSkillToken(params.nextSkill);

  return {
    draft: { skill: params.nextSkill, prompt },
    caret: prompt.length,
  };
}

export function updateStudioDraftFromInput(
  current: StudioComposerDraft,
  value: string
): StudioComposerDraft {
  const skill = detectStudioSkillFromText(value);

  return { skill: skill ?? current.skill, prompt: value };
}

function hasValidDuration(
  value: string,
  minimum: number,
  maximum: number
): boolean {
  const duration = Number(value);
  return (
    Number.isFinite(duration) && duration >= minimum && duration <= maximum
  );
}

function hasValidIntegerDuration(
  value: string,
  minimum: number,
  maximum: number
): boolean {
  const duration = Number(value);
  return (
    Number.isInteger(duration) && duration >= minimum && duration <= maximum
  );
}

function hasPrompt(value: string): boolean {
  return stripStudioSkillTokens(value).trim().length >= 3;
}

export function resolveStudioGenerationBlocker(
  input: StudioGenerationValidationInput
): StudioGenerationBlocker {
  if (!input.available) return "setup_required";

  if (input.skill === "image" || input.skill === "banner") {
    return hasPrompt(input.prompt) ? null : "prompt_required";
  }

  if (input.skill === "video") {
    if (!input.videoSourceAssetId) return "source_image_required";
    if (!hasPrompt(input.prompt)) return "prompt_required";
    const duration = Number(input.duration);
    const validDuration = input.durationOptions?.length
      ? Number.isInteger(duration) && input.durationOptions.includes(duration)
      : hasValidIntegerDuration(input.duration, 3, input.durationMax ?? 15);
    return validDuration ? null : "duration_invalid";
  }

  if (input.skill === "character") {
    if ((input.characterReferenceCount ?? 0) < 1) {
      return "character_reference_required";
    }
    if (!hasPrompt(input.prompt)) return "prompt_required";
    return hasValidDuration(input.duration, 3, 15) ? null : "duration_invalid";
  }

  if (input.skill === "morph") {
    if (!input.morphFirstFrameAssetId || !input.morphLastFrameAssetId) {
      return "morph_frames_required";
    }
    if (input.morphFirstFrameAssetId === input.morphLastFrameAssetId) {
      return "morph_frames_must_differ";
    }
    if (!hasPrompt(input.prompt)) return "prompt_required";
    return hasValidDuration(input.duration, 2, 15) ? null : "duration_invalid";
  }

  if (input.skill === "audio") {
    const mode = input.elevenLabsMode ?? "text_to_speech";
    if (mode === "text_to_speech" || mode === "sound_effect") {
      if (!hasPrompt(input.prompt)) return "prompt_required";
      return mode === "sound_effect" && !hasValidDuration(input.duration, 1, 30)
        ? "duration_invalid"
        : null;
    }
    return input.elevenLabsSourceAssetId ? null : "source_media_required";
  }

  if (!input.avatarImageAssetId) return "avatar_portrait_required";
  if (input.wanAvatarMode === "image_audio") {
    return input.avatarAudioAssetId ? null : "avatar_audio_required";
  }
  if (!hasPrompt(input.prompt)) return "prompt_required";
  return input.elevenLabsAvailable ? null : "avatar_voice_required";
}
