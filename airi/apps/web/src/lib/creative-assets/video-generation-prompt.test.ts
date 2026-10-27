/**
 * @jest-environment node
 */

import type { VideoGenerationSpec } from "@icecore/temporal";

import {
  compileVideoPrompt,
  assertProviderPrompt,
  hashVideoProviderPrompt,
  normalizeVideoUserPrompt,
  VideoPromptCompileError,
} from "./video-generation-prompt";

const happyHorseT2V = {
  contractVersion: 1,
  provider: "happyhorse",
  mode: "text_to_video",
  skill: "video",
  userPrompt: "A ceramic coffee cup catches the morning light.",
  modelId: "wanx2.1-t2v-turbo",
  seed: null,
  durationSeconds: 5,
  aspectRatio: "9:16",
  resolution: "720P",
  sourceAssetId: null,
  referenceAssetIds: [],
} satisfies VideoGenerationSpec;

const happyHorseI2V = {
  ...happyHorseT2V,
  mode: "image_to_video",
  aspectRatio: null,
  sourceAssetId: "source-1",
} satisfies VideoGenerationSpec;

const happyHorseR2V = {
  ...happyHorseT2V,
  mode: "reference_to_video",
  skill: "character",
  sourceAssetId: null,
  referenceAssetIds: ["reference-1", "reference-2"],
} satisfies VideoGenerationSpec;

const higgsfieldI2V = {
  ...happyHorseI2V,
  provider: "higgsfield",
  modelId: "higgsfield-ai/dop/standard",
  resolution: "provider_default",
} satisfies VideoGenerationSpec;

const googleI2V = {
  ...happyHorseI2V,
  provider: "google",
  modelId: "veo-3.1-generate-preview",
  durationSeconds: 6,
  aspectRatio: "9:16",
  resolution: "720p",
} satisfies VideoGenerationSpec;

describe("video-generation-prompt", () => {
  it.each([
    [happyHorseT2V, "happyhorse/text_to_video"],
    [happyHorseI2V, "happyhorse/image_to_video"],
    [happyHorseR2V, "happyhorse/reference_to_video"],
    [higgsfieldI2V, "higgsfield/image_to_video"],
    [googleI2V, "google/image_to_video"],
  ] as const)("compiles %s deterministically", (spec, _providerMode) => {
    const first = compileVideoPrompt(spec);
    const second = compileVideoPrompt(spec);

    expect(first).toEqual(second);
    expect(first.providerPrompt).toContain(first.normalizedUserPrompt);
    expect(first.providerPrompt).not.toMatch(/you are|deliver only|response format/i);
    expect(first.providerPromptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    [
      happyHorseT2V,
      [
        "A ceramic coffee cup catches the morning light.",
        "Format: 5-second 9:16 video at 720P.",
        "Mode: create one continuous, commercially polished shot with a clear hero subject and stable ending.",
        "Camera: gentle, steady push-in with a locked subject.",
        "Output: one coherent, social-ready video without text overlays or watermarks.",
      ].join("\n"),
    ],
    [
      happyHorseI2V,
      [
        "A ceramic coffee cup catches the morning light.",
        "Format: 5-second source-framed video at 720P.",
        "Mode: preserve the supplied source image identity, composition, and subject while adding natural motion.",
        "Camera: gentle, steady push-in with a locked subject.",
        "Output: one coherent, social-ready video without text overlays or watermarks.",
      ].join("\n"),
    ],
    [
      happyHorseR2V,
      [
        "A ceramic coffee cup catches the morning light.",
        "Format: 5-second 9:16 video at 720P.",
        "Reference images (ordered): [Image 1], [Image 2].",
        "Mode: treat ordered references as hard identity locks; preserve faces, products, wardrobe, and materials.",
        "Camera: gentle, steady push-in with a locked subject.",
        "Output: one coherent, social-ready video without text overlays or watermarks.",
      ].join("\n"),
    ],
    [
      higgsfieldI2V,
      [
        "A ceramic coffee cup catches the morning light.",
        "Format: 5-second source-framed video at provider-default resolution.",
        "Mode: preserve the supplied source image identity, composition, and subject while adding natural motion.",
        "Camera: gentle, steady push-in with a locked subject.",
        "Output: natural motion, coherent lighting, stable identity, and no burned-in captions.",
      ].join("\n"),
    ],
    [
      googleI2V,
      [
        "A ceramic coffee cup catches the morning light.",
        "Format: 6-second 9:16 video at 720p.",
        "Mode: preserve the supplied source image identity, composition, and subject while adding natural motion.",
        "Camera: gentle, steady push-in with a locked subject.",
        "Output: natural motion, stable identity, and no burned-in captions.",
      ].join("\n"),
    ],
  ] as const)("uses the %s golden provider prompt", (spec, expectedPrompt) => {
    expect(compileVideoPrompt(spec).providerPrompt).toBe(expectedPrompt);
  });

  it("normalizes line endings, unicode, and outer whitespace exactly", () => {
    expect(normalizeVideoUserPrompt("  cafe\u0301\r\nnext\rline  ")).toBe(
      "caf\u00e9\nnext\nline"
    );
  });

  it("uses a default camera clause only when the user brief has no camera direction", () => {
    expect(compileVideoPrompt(happyHorseT2V).providerPrompt).toContain(
      "Camera: gentle, steady push-in with a locked subject."
    );
    expect(
      compileVideoPrompt({
        ...happyHorseT2V,
        userPrompt: "Slow orbit around the ceramic coffee cup.",
      }).providerPrompt
    ).not.toContain("Camera: gentle, steady push-in with a locked subject.");
  });

  it("places image identity and ordered reference locks before camera direction", () => {
    const i2v = compileVideoPrompt(happyHorseI2V).providerPrompt;
    expect(i2v.indexOf("Mode: preserve the supplied source image identity")).toBeLessThan(
      i2v.indexOf("Camera: gentle, steady push-in with a locked subject.")
    );

    const r2v = compileVideoPrompt(happyHorseR2V).providerPrompt;
    expect(r2v.indexOf("Reference images (ordered): [Image 1], [Image 2].")).toBeLessThan(
      r2v.indexOf("Camera: gentle, steady push-in with a locked subject.")
    );
    expect(r2v.indexOf("Mode: treat ordered references as hard identity locks")).toBeLessThan(
      r2v.indexOf("Camera: gentle, steady push-in with a locked subject.")
    );
  });

  it("keeps reference labels in input order", () => {
    expect(compileVideoPrompt(happyHorseR2V).providerPrompt).toContain(
      "Reference images (ordered): [Image 1], [Image 2]."
    );
  });

  it("rejects briefs that would truncate", () => {
    expect(() =>
      compileVideoPrompt({ ...higgsfieldI2V, userPrompt: "x".repeat(1200) })
    ).toThrow(
      expect.objectContaining({
        code: "prompt_too_long_for_provider",
        provider: "higgsfield",
        maxUserPromptLength: expect.any(Number),
      })
    );
  });

  it("hashes the final provider prompt with SHA-256", () => {
    expect(hashVideoProviderPrompt("airi video prompt")).toBe(
      "78ffcaf38e7bc35a21d502ae8a4bfd41ac48c41dd350f5d7808002cd9b67af91"
    );
  });

  it("uses an inspectable compile error", () => {
    try {
      compileVideoPrompt({ ...googleI2V, userPrompt: "x".repeat(1200) });
      throw new Error("Expected compiler to reject a long prompt");
    } catch (error) {
      expect(error).toBeInstanceOf(VideoPromptCompileError);
    }
  });

  it("rejects noncanonical strict adapter prompts before a legacy client can trim them", () => {
    expect(() => assertProviderPrompt(" compiled prompt ", 1200)).toThrow(
      expect.objectContaining({
        code: "prompt_not_canonical",
        message: "Video prompt must not include leading or trailing whitespace",
      })
    );
  });
});
