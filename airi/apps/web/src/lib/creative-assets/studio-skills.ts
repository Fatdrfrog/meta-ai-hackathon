export const STUDIO_SKILL_IDS = [
  "image",
  "banner",
  "video",
  "character",
  "morph",
  "audio",
  "avatar",
] as const;

export type StudioSkillId = (typeof STUDIO_SKILL_IDS)[number];

export function isStudioSkillId(value: unknown): value is StudioSkillId {
  return STUDIO_SKILL_IDS.includes(value as StudioSkillId);
}
