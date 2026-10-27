/**
 * @jest-environment node
 */

import {
  detectStudioSkillFromText,
  resolveStudioGenerationBlocker,
  selectStudioSkill,
  stripStudioSkillTokens,
  studioSkillToken,
  updateStudioDraftFromInput,
} from "./studio-composer-state";

describe("studio composer state", () => {
  it("carries an exact multiline brief from image to video", () => {
    const result = selectStudioSkill({
      draft: { skill: "image", prompt: "@Image First line\nSecond  line" },
      nextSkill: "video",
      mention: null,
    });
    expect(result.draft).toEqual({
      skill: "video",
      prompt: "@Video First line\nSecond  line",
    });
    expect(result.draft.prompt.match(/@(Image|Video)/g)).toEqual(["@Video"]);
  });

  it("keeps an empty composer empty when switching skills", () => {
    expect(
      selectStudioSkill({
        draft: { skill: "image", prompt: "" },
        nextSkill: "video",
        mention: null,
      })
    ).toEqual({
      draft: { skill: "video", prompt: "" },
      caret: 0,
    });
  });

  it("keeps unrelated multiline boundaries while stripping a skill token", () => {
    expect(
      stripStudioSkillTokens("  @Image First line\nSecond  line  \n")
    ).toBe("  First line\nSecond  line  \n");
  });

  it("keeps per-skill validation reasons explicit", () => {
    expect(
      resolveStudioGenerationBlocker({
        skill: "morph",
        prompt: "@Morph reveal",
        available: true,
        duration: "5",
        morphFirstFrameAssetId: "same",
        morphLastFrameAssetId: "same",
      })
    ).toBe("morph_frames_must_differ");
  });

  it("keeps unknown mentions and repeated whitespace while stripping Studio tokens", () => {
    expect(
      stripStudioSkillTokens("@Image  First line\n@unknown  Second  line")
    ).toBe(" First line\n@unknown  Second  line");
  });

  it("recognizes Studio tokens only at the start or after whitespace", () => {
    expect(detectStudioSkillFromText("foo@Image.com")).toBeNull();
    expect(detectStudioSkillFromText("foo@Image.com then @Video reveal")).toBe(
      "video"
    );
    expect(
      updateStudioDraftFromInput(
        { skill: "image", prompt: "" },
        "contact foo@Video.com"
      )
    ).toEqual({ skill: "image", prompt: "contact foo@Video.com" });
  });

  it("keeps ordinary @ text exact when preparing the provider brief", () => {
    expect(stripStudioSkillTokens("@Image foo@Image.com\nkeep  spacing")).toBe(
      "foo@Image.com\nkeep  spacing"
    );
    expect(stripStudioSkillTokens("foo@Image.com")).toBe("foo@Image.com");
  });

  it("uses the last complete Studio token from typed input", () => {
    expect(
      updateStudioDraftFromInput(
        { skill: "image", prompt: "@Image draft" },
        "@Image first @Video second"
      )
    ).toEqual({ skill: "video", prompt: "@Image first @Video second" });
  });

  it("finds and cleans up adjacent canonical Studio tokens", () => {
    const prompt = "@Image @Video brief";

    expect(
      updateStudioDraftFromInput({ skill: "image", prompt: "" }, prompt)
    ).toEqual({ skill: "video", prompt });
    expect(stripStudioSkillTokens(prompt)).toBe("brief");
    expect(
      selectStudioSkill({
        draft: { skill: "video", prompt },
        nextSkill: "morph",
        mention: null,
      }).draft
    ).toEqual({ skill: "morph", prompt: "@Morph brief" });
  });

  it("returns canonical skill tokens", () => {
    expect(studioSkillToken("audio")).toBe("@Voice");
  });

  it("treats whitespace-only remaining briefs as missing", () => {
    expect(
      resolveStudioGenerationBlocker({
        skill: "image",
        prompt: "@Image \n\t   ",
        available: true,
        duration: "5",
      })
    ).toBe("prompt_required");
  });

  it.each([
    {
      name: "video",
      input: {
        skill: "video" as const,
        videoSourceAssetId: "image-1",
        duration: "16",
      },
    },
    {
      name: "character",
      input: {
        skill: "character" as const,
        characterReferenceCount: 1,
        duration: "16",
      },
    },
    {
      name: "morph",
      input: {
        skill: "morph" as const,
        morphFirstFrameAssetId: "image-1",
        morphLastFrameAssetId: "image-2",
        duration: "16",
      },
    },
    {
      name: "audio",
      input: {
        skill: "audio" as const,
        elevenLabsMode: "sound_effect" as const,
        duration: "31",
      },
    },
  ])("rejects $name durations above the provider maximum", ({ input }) => {
    expect(
      resolveStudioGenerationBlocker({
        ...input,
        prompt: "@Image valid brief",
        available: true,
      })
    ).toBe("duration_invalid");
  });

  it("uses the provider-specific video duration maximum when supplied", () => {
    const input = {
      skill: "video" as const,
      prompt: "@Video valid brief",
      available: true,
      videoSourceAssetId: "image-1",
      durationMax: 8,
    };

    expect(resolveStudioGenerationBlocker({ ...input, duration: "8" })).toBe(
      null
    );
    expect(resolveStudioGenerationBlocker({ ...input, duration: "9" })).toBe(
      "duration_invalid"
    );
    expect(resolveStudioGenerationBlocker({ ...input, duration: "5.5" })).toBe(
      "duration_invalid"
    );
  });

  it("requires an exact provider duration when discrete options are supplied", () => {
    const input = {
      skill: "video" as const,
      prompt: "@Video valid brief",
      available: true,
      videoSourceAssetId: "image-1",
      durationOptions: [4, 6, 8] as const,
    };

    expect(resolveStudioGenerationBlocker({ ...input, duration: "6" })).toBe(
      null
    );
    expect(resolveStudioGenerationBlocker({ ...input, duration: "5" })).toBe(
      "duration_invalid"
    );
  });
});
