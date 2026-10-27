/**
 * @jest-environment node
 */

import {
  expandStudioSkillPrompt,
  isStudioSkillId,
  STUDIO_SKILL_IDS,
} from "./studio-skill-prompts";

describe("studio-skill-prompts", () => {
  it("covers each retained non-video studio skill with a large backend template", () => {
    for (const skill of STUDIO_SKILL_IDS.filter(
      skill => skill !== "video" && skill !== "character"
    )) {
      expect(isStudioSkillId(skill)).toBe(true);
      const { modelPrompt } = expandStudioSkillPrompt({
        skill,
        variables: { user_prompt: "Studio brief" },
      });
      expect(modelPrompt.length).toBeGreaterThan(400);
      expect(modelPrompt).toContain("Studio brief");
    }
  });

  it("expands image prompts with variables and keeps user brief separate", () => {
    const result = expandStudioSkillPrompt({
      skill: "image",
      variables: {
        user_prompt: "Warm coffee cup on marble",
        aspect_ratio: "4:5",
      },
    });
    expect(result.userPrompt).toBe("Warm coffee cup on marble");
    expect(result.modelPrompt).toContain("Warm coffee cup on marble");
    expect(result.modelPrompt).toContain("4:5");
    expect(result.modelPrompt.length).toBeGreaterThan(
      result.userPrompt.length + 200
    );
  });

  it("does not speak the audio production essay for TTS", () => {
    const result = expandStudioSkillPrompt({
      skill: "audio",
      variables: {
        user_prompt: "Thanks for ordering. Your courier is nearby.",
        audio_mode: "text_to_speech",
      },
    });
    expect(result.modelPrompt).toBe(
      "Thanks for ordering. Your courier is nearby."
    );
  });

  it("expands sound-effect audio into a rich design brief", () => {
    const result = expandStudioSkillPrompt({
      skill: "audio",
      variables: {
        user_prompt: "soft product reveal chime",
        audio_mode: "sound_effect",
      },
    });
    expect(result.modelPrompt.toLowerCase()).toContain("sound");
    expect(result.modelPrompt.length).toBeGreaterThan(200);
  });

});
