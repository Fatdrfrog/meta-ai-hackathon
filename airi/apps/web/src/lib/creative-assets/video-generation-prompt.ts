import { createHash } from "node:crypto";
import type { CompiledVideoPrompt, VideoGenerationSpec } from "@icecore/temporal";

const PROFILES = {
  happyhorse: { hardLimit: 5000, reserved: 600 },
  higgsfield: { hardLimit: 1200, reserved: 320 },
  google: { hardLimit: 1200, reserved: 320 },
} as const;

const CAMERA_TOKEN =
  /\b(camera|pan|tilt|zoom|dolly|truck|crane|orbit|arc|tracking|handheld|locked[- ]off|static|push in|pull out|rack focus|pov)\b/i;

type VideoPromptProvider = keyof typeof PROFILES;

export type VideoPromptBudget = {
  hardLimit: number;
  reserved: number;
  maxUserPromptLength: number;
};

export class VideoPromptCompileError extends Error {
  constructor(
    readonly code: "prompt_too_long_for_provider" | "prompt_template_exceeds_reserved_budget",
    readonly provider: VideoPromptProvider,
    readonly maxUserPromptLength: number,
    message: string
  ) {
    super(message);
    this.name = "VideoPromptCompileError";
  }
}

export class VideoProviderPromptValidationError extends Error {
  readonly retryable = false;

  constructor(
    readonly maxLength: number,
    message: string,
    readonly code: "prompt_too_long_for_provider" | "prompt_not_canonical" =
      "prompt_too_long_for_provider"
  ) {
    super(message);
    this.name = "VideoProviderPromptValidationError";
  }
}

/** Strict adapters keep the compiler output byte-for-byte unchanged. */
export function assertProviderPrompt(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new VideoProviderPromptValidationError(
      maxLength,
      "Video prompt is required"
    );
  }
  if (value !== value.trim()) {
    throw new VideoProviderPromptValidationError(
      maxLength,
      "Video prompt must not include leading or trailing whitespace",
      "prompt_not_canonical"
    );
  }
  if (value.length > maxLength) {
    throw new VideoProviderPromptValidationError(
      maxLength,
      `Video prompt exceeds the ${maxLength}-character provider limit`
    );
  }
  return value;
}

export function normalizeVideoUserPrompt(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
}

function formatClause(spec: VideoGenerationSpec): string {
  const framing = spec.aspectRatio ? `${spec.aspectRatio} video` : "source-framed video";
  const resolution =
    spec.resolution === "provider_default"
      ? "provider-default resolution"
      : spec.resolution;
  return `Format: ${spec.durationSeconds}-second ${framing} at ${resolution}.`;
}

function modeClauses(spec: VideoGenerationSpec): string[] {
  if (spec.mode === "text_to_video") {
    return [
      "Mode: create one continuous, commercially polished shot with a clear hero subject and stable ending.",
    ];
  }

  if (spec.mode === "reference_to_video") {
    const labels = spec.referenceAssetIds.map((_, index) => `[Image ${index + 1}]`);
    return [
      `Reference images (ordered): ${labels.join(", ")}.`,
      "Mode: treat ordered references as hard identity locks; preserve faces, products, wardrobe, and materials.",
    ];
  }

  return [
    "Mode: preserve the supplied source image identity, composition, and subject while adding natural motion.",
  ];
}

function providerOutputClause(provider: VideoPromptProvider): string {
  switch (provider) {
    case "happyhorse":
      return "Output: one coherent, social-ready video without text overlays or watermarks.";
    case "higgsfield":
      return "Output: natural motion, coherent lighting, stable identity, and no burned-in captions.";
    case "google":
      return "Output: natural motion, stable identity, and no burned-in captions.";
  }
}

function suffixClauses(spec: VideoGenerationSpec, normalizedUserPrompt: string): string[] {
  return [
    formatClause(spec),
    ...modeClauses(spec),
    ...(CAMERA_TOKEN.test(normalizedUserPrompt)
      ? []
      : ["Camera: gentle, steady push-in with a locked subject."]),
    providerOutputClause(spec.provider),
  ];
}

function getBudget(spec: VideoGenerationSpec, normalizedUserPrompt: string): VideoPromptBudget {
  const profile = PROFILES[spec.provider];
  const suffixLength = suffixClauses(spec, normalizedUserPrompt).join("\n").length;
  const separatorLength = suffixLength > 0 ? 1 : 0;
  return {
    hardLimit: profile.hardLimit,
    reserved: profile.reserved,
    maxUserPromptLength: profile.hardLimit - suffixLength - separatorLength,
  };
}

export function hashVideoProviderPrompt(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compileVideoPrompt(spec: VideoGenerationSpec): CompiledVideoPrompt {
  const normalizedUserPrompt = normalizeVideoUserPrompt(spec.userPrompt);
  const profile = PROFILES[spec.provider];
  const suffix = suffixClauses(spec, normalizedUserPrompt);
  const suffixLength = suffix.join("\n").length;
  const budget = getBudget(spec, normalizedUserPrompt);

  if (suffixLength > profile.reserved) {
    throw new VideoPromptCompileError(
      "prompt_template_exceeds_reserved_budget",
      spec.provider,
      budget.maxUserPromptLength,
      `Video prompt clauses exceed the ${profile.reserved}-character reserved budget for ${spec.provider}`
    );
  }
  if (normalizedUserPrompt.length > budget.maxUserPromptLength) {
    throw new VideoPromptCompileError(
      "prompt_too_long_for_provider",
      spec.provider,
      budget.maxUserPromptLength,
      `Video prompt exceeds the ${budget.maxUserPromptLength}-character safe user limit for ${spec.provider}`
    );
  }

  const providerPrompt = [normalizedUserPrompt, ...suffix].join("\n");
  return {
    compilerId: "airi-video-director",
    compilerVersion: 1,
    normalizedUserPrompt,
    providerPrompt,
    providerPromptSha256: hashVideoProviderPrompt(providerPrompt),
    warnings: [],
  };
}
