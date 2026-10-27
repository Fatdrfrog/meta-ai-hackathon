/**
 * Backend-only Studio skill prompt templates.
 * Users type a short brief in the UI; routes expand it here before calling providers.
 * Never expose these templates (or expanded strings) in client copy.
 */

import {
  isStudioSkillId,
  STUDIO_SKILL_IDS,
  type StudioSkillId,
} from "@/lib/creative-assets/studio-skills";

export { isStudioSkillId, STUDIO_SKILL_IDS };
export type { StudioSkillId };

export type StudioSkillPromptId = Exclude<StudioSkillId, "video" | "character">;

export type StudioSkillPromptVariables = {
  user_prompt: string;
  aspect_ratio?: string;
  duration_seconds?: string | number;
  resolution?: string;
  mode?: string;
  reference_count?: string | number;
  target_language?: string;
  audio_mode?: string;
  avatar_mode?: string;
};

const STUDIO_SKILL_PROMPT_TEMPLATES: Record<StudioSkillPromptId, string> = {
  image: `
You are a senior commercial photographer and AI image art director producing campaign-ready stills for WhatsApp, Instagram, and paid social.

USER BRIEF (treat as creative intent, not literal camera instructions):
"""
{{user_prompt}}
"""

ASPECT RATIO: {{aspect_ratio}}

PRODUCTION BRIEF — render a single finished image that satisfies all of the following:

1) SUBJECT & HERO
- Make the core subject from the brief unmistakable, sharp, and commercially desirable.
- Prefer one clear hero focus; avoid cluttered multi-subject chaos unless the brief demands a scene.
- If the brief is product-oriented, stage the product as the optical center with premium material fidelity (texture, speculars, edges).
- If the brief is lifestyle/people, keep faces natural, flattering, and culturally neutral unless a locale is specified.

2) LIGHTING & CAMERA LANGUAGE
- Use intentional lighting: soft key + controlled fill, gentle rim where it sells form, no harsh clipping.
- Choose a believable focal length and depth of field; keep critical detail crisp.
- Avoid plastic HDR, oversharpening, and fake "AI glow".

3) COMPOSITION & SAFE AREAS
- Compose for {{aspect_ratio}} with breathing room for captions/UI overlays.
- Keep important subject mass inside a safe central ~70% frame; avoid edge amputation.
- Prefer clean negative space on one side when the brief implies copy/CTA later.

4) COLOR & FINISH
- Tasteful, modern color grade; skin and product colors stay believable.
- Contrast is punchy but not crushed; blacks hold detail.
- No watermarks, logos, UI chrome, or random text unless the brief explicitly asks for typography.

5) QUALITY BAR
- Photoreal or premium illustrated finish matching the brief's implied style.
- No extra fingers, warped packaging, melted typography, or duplicated props.
- Output should look like a finished creative ready to drop into a funnel or ad.

Deliver ONLY the visual described by this production brief. Do not narrate.
`.trim(),

  banner: `
You are an art director specializing in performance ad banners and WhatsApp/story creatives with copy-safe framing.

USER BRIEF:
"""
{{user_prompt}}
"""

ASPECT RATIO: {{aspect_ratio}}

BANNER PRODUCTION SYSTEM:

1) LAYOUT INTENT
- Design a single ad-ready frame at {{aspect_ratio}}.
- Establish a clear visual hierarchy: hero subject → supporting environment → reserved copy zones.
- Leave deliberate empty/low-detail zones for headline (prefer upper/left or center-left) and CTA (prefer lower-right or bottom band), unless the brief specifies otherwise.

2) OFFER & PRODUCT CLARITY
- If an offer/product is implied, make it instantly readable at mobile size.
- Product/hero must remain sharp and high-contrast against background.
- Avoid busy patterns behind likely text regions.

3) STYLE
- Clean, contemporary commercial aesthetic; brand-agnostic premium look.
- Soft gradients or subtle environmental depth ok; no cluttered collage.
- High contrast CTA zone with simple geometric calm.

4) TEXT POLICY
- Do NOT invent long headlines or fake brand names.
- At most, tiny illegible placeholder letterforms are acceptable if needed for realism; prefer no text.
- Never render watermarks, URLs, or QR codes unless requested.

5) TECHNICAL
- Edge-to-edge composition, no mock device frames unless requested.
- Export-ready sharpness, balanced exposure, no banding.

Render one finished banner image matching this system. No captions in the response.
`.trim(),

  morph: `
You are directing a before→after morph / first-last frame interpolation for commercial storytelling.

USER TRANSITION BRIEF:
"""
{{user_prompt}}
"""

DURATION: {{duration_seconds}} seconds
RESOLUTION: {{resolution}}

MORPH SYSTEM:

1) IDENTITY CONTINUITY
- First frame = BEFORE state; last frame = AFTER state.
- Preserve subject identity, camera perspective, and major geometry between endpoints.
- Morph should feel like a real transformation or reveal, not a random dream dissolve.

2) TIMING ({{duration_seconds}}s)
- Ease in from the before state, accelerate through the meaningful change, ease out into the after hold.
- Avoid stuttering loops or oscillating back to before.

3) VISUAL LANGUAGE
- Prefer soft daylight / clean commercial lighting unless brief specifies otherwise.
- Keep textures coherent (surfaces, fabrics, packaging) during the transition.
- Minimize liquid/face artifacts; prioritize structural clarity.

4) STORY READ
- A viewer should understand the before/after benefit without text.
- The midpoint should already telegraph the improvement/reveal.

Output a precise morph prompt that a first+last-frame video model can execute.
`.trim(),

  audio: `
You are a senior audio director for short marketing voiceovers and sound design.

USER BRIEF:
"""
{{user_prompt}}
"""

AUDIO MODE: {{audio_mode}}
TARGET LANGUAGE: {{target_language}}
DURATION HINT: {{duration_seconds}} seconds

AUDIO SYSTEM:

IF AUDIO MODE is text_to_speech:
- The user brief IS the spoken script. Preserve wording; only lightly normalize punctuation for speech clarity.
- Delivery: warm, clear, confident, natural pacing; no cartoon voices unless asked.
- Suitable for WhatsApp follow-ups and short ads.

IF AUDIO MODE is sound_effect:
- Expand the brief into a concrete SFX design: sources, envelope (attack/body/decay), space (room/outdoor), and mix notes.
- Keep it short-form friendly (mobile speakers), no muddy low-end overload.
- Describe one cohesive effect, not a full music track, unless the brief asks for music.

IF AUDIO MODE is transcript, subtitles, or dub:
- Treat the brief as operational intent for processing existing media.
- For dub: target language {{target_language}}; keep meaning faithful and mouth-timing friendly.
- For subtitles/transcript: prioritize clarity and accurate phrasing.

Return the final provider-facing audio prompt/script only (no meta commentary).
`.trim(),

  avatar: `
You are directing a talking-head avatar / lip-sync performance for social and WhatsApp creatives.

USER SCRIPT / INTENT:
"""
{{user_prompt}}
"""

AVATAR MODE: {{avatar_mode}}
RESOLUTION: {{resolution}}

VISUAL PERFORMANCE SYSTEM (for the video model — NOT text-to-speech copy):

1) SUBJECT
- Preserve the portrait identity exactly (face, hair, skin, wardrobe cues from the source image).
- Natural talking-head framing, eyes toward camera, stable head base with subtle live motion.

2) PERFORMANCE
- Conversational, trustworthy energy matching the script's intent.
- Micro-expressions and gentle nods; avoid exaggerated cartoon acting.
- Mouth motion must feel synced and clean; no jittery face warp.

3) LOOK
- Soft beauty lighting, clean background separation, premium but approachable.
- {{resolution}} sharpness; flattering skin texture without plastic smoothing.

4) MODE NOTES
- image_script: performance should match a spoken marketing script vibe.
- image_audio: lock motion to the provided speech audio; prioritize lip sync fidelity.

Return a compact visual direction prompt for the avatar video model. Do NOT rewrite the spoken script here.
`.trim(),
};

function asVarString(
  value: string | number | undefined,
  fallback = ""
): string {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

export function renderStudioSkillTemplate(
  template: string,
  variables: StudioSkillPromptVariables
): string {
  const map: Record<string, string> = {
    user_prompt: asVarString(variables.user_prompt),
    aspect_ratio: asVarString(variables.aspect_ratio, "9:16"),
    duration_seconds: asVarString(variables.duration_seconds, "5"),
    resolution: asVarString(variables.resolution, "1080P"),
    mode: asVarString(variables.mode, "default"),
    reference_count: asVarString(variables.reference_count, "1"),
    target_language: asVarString(variables.target_language, "en"),
    audio_mode: asVarString(variables.audio_mode, "text_to_speech"),
    avatar_mode: asVarString(variables.avatar_mode, "image_script"),
  };

  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => {
      const normalized = key.toLowerCase();
      return map[normalized] ?? "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function expandStudioSkillPrompt(params: {
  skill: StudioSkillPromptId;
  variables: StudioSkillPromptVariables;
  /** Hard cap for provider APIs with short prompt limits. */
  maxLength?: number;
}): {
  userPrompt: string;
  modelPrompt: string;
  skill: StudioSkillPromptId;
} {
  const userPrompt = asVarString(params.variables.user_prompt);
  const template = STUDIO_SKILL_PROMPT_TEMPLATES[params.skill];
  let modelPrompt = renderStudioSkillTemplate(template, {
    ...params.variables,
    user_prompt: userPrompt,
  });

  // TTS/dub: speak the user's words, not the production essay.
  if (
    params.skill === "audio" &&
    (params.variables.audio_mode === "text_to_speech" ||
      params.variables.audio_mode === "dub" ||
      params.variables.audio_mode === "transcript" ||
      params.variables.audio_mode === "subtitles")
  ) {
    modelPrompt = userPrompt;
  }

  const maxLength = params.maxLength;
  if (
    typeof maxLength === "number" &&
    Number.isFinite(maxLength) &&
    maxLength > 40 &&
    modelPrompt.length > maxLength
  ) {
    modelPrompt = `${modelPrompt.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
  }

  return {
    userPrompt,
    modelPrompt,
    skill: params.skill,
  };
}
