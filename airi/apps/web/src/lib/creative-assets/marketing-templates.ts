/**
 * Static marketing creative templates for Assets Studio.
 * Shape is DB-ready: later swap this catalog for Mongo/Supabase rows and
 * fill `previewVideoUrl` / `posterUrl` with generated showcase media.
 */

export type MarketingTemplateSkill =
  | "image"
  | "video"
  | "audio"
  | "avatar";

export type MarketingTemplateCategory =
  | "all"
  | "ugc"
  | "product"
  | "avatar"
  | "voice"
  | "story";

export type MarketingTemplate = {
  id: string;
  title: string;
  description: string;
  category: Exclude<MarketingTemplateCategory, "all">;
  skill: MarketingTemplateSkill;
  /** Prompt body without @skill token; UI adds the skill token on apply. */
  prompt: string;
  /** Optional ElevenLabs mode when skill is audio. */
  audioMode?:
    | "text_to_speech"
    | "sound_effect"
    | "transcript"
    | "subtitles"
    | "dub";
  /** Optional Wan avatar mode when skill is avatar. */
  avatarMode?: "image_script" | "image_audio";
  /** Optional video duration seconds (3–8). */
  durationSeconds?: number;
  /** Optional avatar resolution. */
  avatarResolution?: "720P" | "1080P";
  /** Showcase still — fill later with generated template preview. */
  posterUrl?: string | null;
  /** Showcase video — fill later with generated template result. */
  previewVideoUrl?: string | null;
  /** Short badge label e.g. "UGC", "NEW". */
  badge?: string | null;
};

export const MARKETING_TEMPLATE_CATEGORIES: MarketingTemplateCategory[] = [
  "all",
  "ugc",
  "product",
  "avatar",
  "voice",
  "story",
];

export const MARKETING_TEMPLATES: MarketingTemplate[] = [
  {
    id: "ugc-talking-head",
    title: "UGC talking head",
    description: "Casual face-to-camera founder clip for WhatsApp / Reels.",
    category: "ugc",
    skill: "avatar",
    avatarMode: "image_script",
    avatarResolution: "1080P",
    prompt:
      "Hey there — quick update from our team. We just launched something that saves founders hours every week. Stay with me for 10 seconds.",
    badge: "UGC",
    posterUrl: null,
    previewVideoUrl: null,
  },
  {
    id: "ugc-unboxing",
    title: "Unboxing energy",
    description: "First-touch product reveal with handheld motion.",
    category: "ugc",
    skill: "video",
    durationSeconds: 5,
    prompt:
      "Handheld unboxing energy: hands open a clean package, soft natural light, quick cut to product hero, warm lifestyle vibe for social ads.",
    badge: "UGC",
    posterUrl: null,
    previewVideoUrl: null,
  },
  {
    id: "product-showcase",
    title: "Product showcase",
    description: "Clean cinematic push-in for catalog and ads.",
    category: "product",
    skill: "video",
    durationSeconds: 5,
    prompt:
      "Slow camera push on the product with subtle steam and specular highlights, studio lighting, premium commercial pacing.",
    badge: "Product",
    posterUrl: null,
    previewVideoUrl: null,
  },
  {
    id: "product-hero-image",
    title: "Hero product photo",
    description: "Campaign-ready still with space for headline copy.",
    category: "product",
    skill: "image",
    prompt:
      "Premium product hero photo on a soft gradient backdrop, clean lighting, shallow depth of field, space on the right for campaign copy.",
    badge: "Image",
    posterUrl: null,
    previewVideoUrl: null,
  },
  {
    id: "story-vertical",
    title: "Vertical story ad",
    description: "9:16 appetizing / lifestyle still for Stories.",
    category: "story",
    skill: "image",
    prompt:
      "Vertical social story image with appetizing food styling, bright natural light, bold negative space for a short offer line.",
    badge: "Story",
    posterUrl: null,
    previewVideoUrl: null,
  },
  {
    id: "voice-whatsapp-followup",
    title: "WhatsApp voiceover",
    description: "Warm short TTS script for follow-up campaigns.",
    category: "voice",
    skill: "audio",
    audioMode: "text_to_speech",
    prompt:
      "Warm 12 second voiceover: thanks for chatting with us — here is a short next step to book a demo this week. Friendly, clear, no hard sell.",
    badge: "Voice",
    posterUrl: null,
    previewVideoUrl: null,
  },
  {
    id: "avatar-offer-pitch",
    title: "Avatar offer pitch",
    description: "Talking avatar reads a short offer script.",
    category: "avatar",
    skill: "avatar",
    avatarMode: "image_script",
    avatarResolution: "1080P",
    prompt:
      "Hi! This week only we are giving early access to our AI coaching toolkit. Tap below and I will walk you through the first three steps.",
    badge: "Avatar",
    posterUrl: null,
    previewVideoUrl: null,
  },
  {
    id: "ugc-howto",
    title: "How-to tip",
    description: "Tutorial-style talking avatar for tips.",
    category: "ugc",
    skill: "avatar",
    avatarMode: "image_script",
    avatarResolution: "720P",
    prompt:
      "Quick tip: open your inbox, pick one unanswered chat, and let Airi draft the reply. Watch how much faster your team moves.",
    badge: "Tutorial",
    posterUrl: null,
    previewVideoUrl: null,
  },
  {
    id: "sfx-reveal",
    title: "Reveal chime",
    description: "Short SFX bed for product reveals.",
    category: "voice",
    skill: "audio",
    audioMode: "sound_effect",
    prompt:
      "Short product reveal chime with soft ambience, modern and clean, under 3 seconds.",
    badge: "SFX",
    posterUrl: null,
    previewVideoUrl: null,
  },
];

export function listMarketingTemplates(
  category: MarketingTemplateCategory = "all"
): MarketingTemplate[] {
  if (category === "all") return MARKETING_TEMPLATES;
  return MARKETING_TEMPLATES.filter(template => template.category === category);
}
