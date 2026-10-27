"use client";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MentionTextarea } from "@/components/composer/mention-textarea";
import {
  afterNextPaint,
  getActiveMention,
  type ActiveMention,
} from "@/lib/composer/mention";
import { getTextareaCaretOffset } from "@/lib/composer/textarea-caret";
import {
  detectStudioSkillFromText,
  findStudioSkillTokens,
  selectStudioSkill,
  stripStudioSkillTokens,
  studioSkillToken,
  updateStudioDraftFromInput,
  type StudioComposerDraft,
} from "@/lib/creative-assets/studio-composer-state";
import type { StudioSkillId } from "@/lib/creative-assets/studio-skills";
import { cn } from "@/lib/utils";
import {
  Blend,
  Captions,
  FileText,
  Film,
  ImageIcon,
  LayoutTemplate,
  Loader2,
  Mic2,
  Music2,
  Play,
  Plus,
  Upload,
  UserRound,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";

export type StudioGenerationSkill = StudioSkillId;
export type StudioWanAvatarMode = "image_audio" | "image_script";
export type StudioElevenLabsMode =
  | "text_to_speech"
  | "sound_effect"
  | "transcript"
  | "subtitles"
  | "dub";
export type StudioBannerAspectRatio =
  | "16:9"
  | "1.91:1"
  | "4:5"
  | "1:1"
  | "9:16";
export type StudioCharacterRatio = "9:16" | "16:9" | "1:1" | "4:5" | "3:4";

export const STUDIO_CHARACTER_RATIOS: StudioCharacterRatio[] = [
  "9:16",
  "16:9",
  "1:1",
  "4:5",
  "3:4",
];

export const STUDIO_CHARACTER_REFERENCE_MAX = 9;

export type StudioComposerAsset = {
  id: string;
  kind: "image" | "video" | "audio" | "text";
  url?: string | null;
  fileName?: string | null;
  prompt?: string | null;
  fileSize?: number | null;
};

export type StudioPromptPreset = {
  title: string;
  prompt: string;
};

function presetPrompt(preset: StudioPromptPreset | string): string {
  return typeof preset === "string" ? preset : preset.prompt;
}

function presetTitle(preset: StudioPromptPreset | string): string {
  return typeof preset === "string"
    ? preset.split(" ").slice(0, 3).join(" ")
    : preset.title;
}

type TranslationFn = (
  key: string,
  values?: Record<string, number | string>
) => string;

const SKILL_ORDER: StudioGenerationSkill[] = [
  "image",
  "banner",
  "video",
  "character",
  "morph",
  "audio",
  "avatar",
];

const SKILL_TOKEN_LABEL: Record<StudioGenerationSkill, string> = {
  image: "Image",
  banner: "Banner",
  video: "Video",
  character: "Character",
  morph: "Morph",
  audio: "Voice",
  avatar: "Avatar",
};

const SKILL_ICON: Record<StudioGenerationSkill, LucideIcon> = {
  image: ImageIcon,
  banner: LayoutTemplate,
  video: Film,
  character: UserRound,
  morph: Blend,
  audio: Mic2,
  avatar: WandSparkles,
};

const SKILL_CHIP_CLASS: Record<StudioGenerationSkill, string> = {
  image: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  banner: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  video: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  character: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  morph: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  audio: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  avatar: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
};

export const STUDIO_BANNER_ASPECT_RATIOS: StudioBannerAspectRatio[] = [
  "16:9",
  "1.91:1",
  "4:5",
  "1:1",
  "9:16",
];

const TEXTAREA_MIN_HEIGHT = 88;
const TEXTAREA_MAX_HEIGHT = 220;

function skillToken(skill: StudioGenerationSkill): string {
  return studioSkillToken(skill);
}

export { detectStudioSkillFromText, stripStudioSkillTokens };

/** Append [Image N] tags when the prompt has none (HappyHorse r2v requirement). */
export function ensureCharacterImageTags(
  prompt: string,
  referenceCount: number
): string {
  const cleaned = prompt.trim();
  if (!cleaned || referenceCount < 1) return cleaned;
  if (/\[Image\s*\d+\]/i.test(cleaned)) return cleaned;
  const tags = Array.from(
    { length: Math.min(referenceCount, STUDIO_CHARACTER_REFERENCE_MAX) },
    (_, index) => `[Image ${index + 1}]`
  ).join(", ");
  return `${cleaned} featuring ${tags}`;
}

function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return "";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function renderInputWithSkillMentions(value: string): ReactNode {
  if (!value) return null;

  const parts: ReactNode[] = [];
  let cursor = 0;
  let partIndex = 0;

  for (const match of findStudioSkillTokens(value)) {
    if (match.start > cursor) {
      parts.push(
        <span key={`text-${partIndex++}`}>
          {value.slice(cursor, match.start)}
        </span>
      );
    }
    const Icon = SKILL_ICON[match.skill];
    parts.push(
      <span
        key={`skill-${partIndex++}`}
        className="relative inline-block align-baseline text-transparent"
      >
        {match.token}
        <span
          className={cn(
            "absolute left-0 top-1/2 inline-flex h-[1.35rem] max-w-full -translate-y-1/2 items-center gap-1 overflow-hidden rounded-md px-1.5 text-[12px] font-medium leading-none",
            SKILL_CHIP_CLASS[match.skill]
          )}
        >
          <Icon className="h-3 w-3 shrink-0 opacity-90" aria-hidden="true" />
          <span className="min-w-0 truncate">{match.token.slice(1)}</span>
        </span>
      </span>
    );
    cursor = match.end;
  }

  if (cursor < value.length) {
    parts.push(<span key={`text-${partIndex}`}>{value.slice(cursor)}</span>);
  }

  return parts;
}

export type CreativeAssetsStudioComposerProps = {
  t: TranslationFn;
  draft: StudioComposerDraft;
  onDraftChange: (draft: StudioComposerDraft) => void;
  skillAvailability: Record<StudioSkillId, boolean>;
  generationBlockerText?: string | null;
  onGenerate: () => void;
  isGenerating: boolean;
  generateDisabled: boolean;
  generateLabel: string;
  imageAssets: StudioComposerAsset[];
  audioAssets: StudioComposerAsset[];
  mediaAssets: StudioComposerAsset[];
  videoSourceAssetId: string;
  onVideoSourceAssetIdChange: (id: string) => void;
  duration: string;
  onDurationChange: (value: string) => void;
  elevenLabsMode: StudioElevenLabsMode;
  onElevenLabsModeChange: (mode: StudioElevenLabsMode) => void;
  elevenLabsSourceAssetId: string;
  onElevenLabsSourceAssetIdChange: (id: string) => void;
  elevenLabsTargetLanguage: string;
  onElevenLabsTargetLanguageChange: (value: string) => void;
  elevenLabsAvailable: boolean;
  wanAvatarMode: StudioWanAvatarMode;
  onWanAvatarModeChange: (mode: StudioWanAvatarMode) => void;
  avatarImageAssetId: string;
  onAvatarImageAssetIdChange: (id: string) => void;
  avatarAudioAssetId: string;
  onAvatarAudioAssetIdChange: (id: string) => void;
  avatarResolution: "720P" | "1080P";
  onAvatarResolutionChange: (value: "720P" | "1080P") => void;
  wanAvatarAvailable: boolean;
  generationAvailable: boolean;
  /** Video skill can use HappyHorse even when Higgsfield/Google are off. */
  videoGenerationAvailable?: boolean;
  /** HappyHorse allows 3–15s; Higgsfield stays 3–8. */
  videoDurationMax?: number;
  /** Providers such as Google only accept discrete video durations. */
  videoDurationOptions?: readonly number[];
  /** When true, @Video can run text-to-video without a source image. */
  videoSourceOptional?: boolean;
  characterReferenceAssetIds: string[];
  onCharacterReferenceAssetIdsChange: (ids: string[]) => void;
  characterRatio: StudioCharacterRatio;
  onCharacterRatioChange: (value: StudioCharacterRatio) => void;
  characterAvailable?: boolean;
  onUploadCharacterReference: (files: FileList | File[] | null) => void;
  characterImageInputRef: RefObject<HTMLInputElement | null>;
  morphFirstFrameAssetId: string;
  onMorphFirstFrameAssetIdChange: (id: string) => void;
  morphLastFrameAssetId: string;
  onMorphLastFrameAssetIdChange: (id: string) => void;
  morphAvailable?: boolean;
  onUploadMorphFirstFrame: (files: FileList | File[] | null) => void;
  onUploadMorphLastFrame: (files: FileList | File[] | null) => void;
  morphImageInputRef: RefObject<HTMLInputElement | null>;
  morphPresets?: Array<StudioPromptPreset | string>;
  bannerAspectRatio: StudioBannerAspectRatio;
  onBannerAspectRatioChange: (value: StudioBannerAspectRatio) => void;
  bannerPresets: Array<StudioPromptPreset | string>;
  isUploading: boolean;
  onUploadSourceImage: (files: FileList | File[] | null) => void;
  sourceImageInputRef: RefObject<HTMLInputElement | null>;
  onUploadAvatarPortrait: (files: FileList | File[] | null) => void;
  avatarImageInputRef: RefObject<HTMLInputElement | null>;
  imagePresets: Array<StudioPromptPreset | string>;
  videoPresets: Array<StudioPromptPreset | string>;
  audioPresets: Array<StudioPromptPreset | string>;
  characterPresets?: Array<StudioPromptPreset | string>;
  footer?: ReactNode;
};

export function CreativeAssetsStudioComposer({
  t,
  draft,
  onDraftChange,
  skillAvailability,
  generationBlockerText = null,
  onGenerate,
  isGenerating,
  generateDisabled,
  generateLabel,
  imageAssets,
  audioAssets,
  mediaAssets,
  videoSourceAssetId,
  onVideoSourceAssetIdChange,
  duration,
  onDurationChange,
  elevenLabsMode,
  onElevenLabsModeChange,
  elevenLabsSourceAssetId,
  onElevenLabsSourceAssetIdChange,
  elevenLabsTargetLanguage,
  onElevenLabsTargetLanguageChange,
  elevenLabsAvailable,
  wanAvatarMode,
  onWanAvatarModeChange,
  avatarImageAssetId,
  onAvatarImageAssetIdChange,
  avatarAudioAssetId,
  onAvatarAudioAssetIdChange,
  avatarResolution,
  onAvatarResolutionChange,
  wanAvatarAvailable,
  generationAvailable,
  videoDurationMax = 8,
  videoDurationOptions,
  videoSourceOptional = false,
  characterReferenceAssetIds,
  onCharacterReferenceAssetIdsChange,
  characterRatio,
  onCharacterRatioChange,
  characterAvailable = false,
  onUploadCharacterReference,
  characterImageInputRef,
  morphFirstFrameAssetId,
  onMorphFirstFrameAssetIdChange,
  morphLastFrameAssetId,
  onMorphLastFrameAssetIdChange,
  morphAvailable = false,
  onUploadMorphFirstFrame,
  onUploadMorphLastFrame,
  morphImageInputRef,
  morphPresets = [],
  bannerAspectRatio,
  onBannerAspectRatioChange,
  bannerPresets,
  isUploading,
  onUploadSourceImage,
  sourceImageInputRef,
  onUploadAvatarPortrait,
  avatarImageInputRef,
  imagePresets,
  videoPresets,
  audioPresets,
  characterPresets = [],
  footer,
}: CreativeAssetsStudioComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const promptShellRef = useRef<HTMLDivElement | null>(null);
  const syntheticPickerRef = useRef<{
    prompt: string;
    mentionStart: number;
  } | null>(null);
  const pickerQueryRef = useRef<string | null>(null);
  const pickerListId = "studio-skill-listbox";
  const optionIdPrefix = useId();
  const blockerId = useId();
  const skill = draft.skill;
  const prompt = draft.prompt;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(
    null
  );
  const [pickerHighlight, setPickerHighlight] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [isSourceImageDragActive, setIsSourceImageDragActive] = useState(false);
  const [isCharacterDragActive, setIsCharacterDragActive] = useState(false);
  const [isAvatarDragActive, setIsAvatarDragActive] = useState(false);

  const skillOptions = useMemo(
    () =>
      SKILL_ORDER.map(id => ({
        id,
        label: SKILL_TOKEN_LABEL[id],
        token: skillToken(id),
        available: skillAvailability[id],
        description:
          id === "image"
            ? t("studioSkillImageDescription")
            : id === "banner"
              ? t("studioSkillBannerDescription")
              : id === "video"
                ? t("studioSkillVideoDescription")
                : id === "character"
                  ? t("studioSkillCharacterDescription")
                  : id === "morph"
                    ? t("studioSkillMorphDescription")
                    : id === "audio"
                      ? t("studioSkillVoiceDescription")
                      : t("studioSkillAvatarDescription"),
        tabLabel:
          id === "image"
            ? t("imageTab")
            : id === "banner"
              ? t("bannerTab")
              : id === "video"
                ? t("videoTab")
                : id === "character"
                  ? t("characterTab")
                  : id === "morph"
                    ? t("morphTab")
                    : id === "audio"
                      ? t("audioTab")
                      : t("avatarTab"),
      })),
    [skillAvailability, t]
  );

  const filteredSkillOptions = useMemo(() => {
    const query = (activeMention?.query || "").trim().toLowerCase();
    if (!query) return skillOptions;
    return skillOptions.filter(
      option =>
        option.label.toLowerCase().includes(query) ||
        option.tabLabel.toLowerCase().includes(query) ||
        option.id.includes(query)
    );
  }, [activeMention?.query, skillOptions]);

  const activeOption = pickerOpen
    ? filteredSkillOptions[pickerHighlight]
    : undefined;
  const activeOptionId = activeOption
    ? `${optionIdPrefix}-${activeOption.id}`
    : undefined;

  const selectedVideoSource =
    imageAssets.find(asset => asset.id === videoSourceAssetId) || null;
  const selectedCharacterRefs = characterReferenceAssetIds
    .map(id => imageAssets.find(asset => asset.id === id) || null)
    .filter((asset): asset is StudioComposerAsset => Boolean(asset));
  const selectedMorphFirst =
    imageAssets.find(asset => asset.id === morphFirstFrameAssetId) || null;
  const selectedMorphLast =
    imageAssets.find(asset => asset.id === morphLastFrameAssetId) || null;
  const selectedAvatarImage =
    imageAssets.find(asset => asset.id === avatarImageAssetId) || null;
  const selectedAvatarAudio =
    audioAssets.find(asset => asset.id === avatarAudioAssetId) || null;
  const selectedElevenLabsSource =
    mediaAssets.find(asset => asset.id === elevenLabsSourceAssetId) || null;

  const elevenLabsUsesText =
    elevenLabsMode === "text_to_speech" || elevenLabsMode === "sound_effect";

  const placeholder =
    skill === "image"
      ? t("imagePromptPlaceholder")
      : skill === "banner"
        ? t("bannerPromptPlaceholder")
        : skill === "video"
          ? t("videoPromptPlaceholder")
          : skill === "character"
            ? t("characterPromptPlaceholder")
            : skill === "morph"
              ? t("morphPromptPlaceholder")
              : skill === "audio"
                ? elevenLabsMode === "text_to_speech"
                  ? t("elevenLabsScriptPlaceholder")
                  : t("elevenLabsPromptPlaceholder")
                : t("avatarScriptPlaceholder");

  const updatePickerAnchor = useCallback((target: HTMLTextAreaElement) => {
    try {
      const caret = target.selectionStart ?? target.value.length;
      const offset = getTextareaCaretOffset(target, caret);
      setPickerAnchor({
        top: Math.max(8, offset.top + offset.height),
        left: Math.max(8, Math.min(offset.left, target.clientWidth - 24)),
      });
    } catch {
      setPickerAnchor({ top: 28, left: 12 });
    }
  }, []);

  useLayoutEffect(() => {
    if (!pickerOpen || !textareaRef.current) return;
    updatePickerAnchor(textareaRef.current);
  }, [pickerOpen, prompt, activeMention, updatePickerAnchor]);

  const applySkill = useCallback(
    (nextSkill: StudioGenerationSkill, mention: ActiveMention | null) => {
      const syntheticPicker = syntheticPickerRef.current;
      const mentionStart =
        mention &&
        mention.start > 0 &&
        /[\t ]/.test(draft.prompt[mention.start - 1] ?? "")
          ? mention.start - 1
          : mention?.start;
      const draftWithoutPickerMention = syntheticPicker
        ? { ...draft, prompt: syntheticPicker.prompt }
        : mention
          ? {
              ...draft,
              prompt: `${draft.prompt.slice(0, mentionStart)}${draft.prompt.slice(
                mention.end
              )}`,
            }
          : draft;
      const selected = selectStudioSkill({
        draft: draftWithoutPickerMention,
        nextSkill,
        mention: null,
      });
      onDraftChange(selected.draft);
      syntheticPickerRef.current = null;
      pickerQueryRef.current = null;
      setActiveMention(null);
      setPickerOpen(false);
      setPickerAnchor(null);
      afterNextPaint(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(selected.caret, selected.caret);
      });
    },
    [draft, onDraftChange]
  );

  const openSkillPicker = useCallback(() => {
    if (pickerOpen) {
      textareaRef.current?.focus();
      return;
    }
    const needsSeparator = Boolean(prompt) && !/\s$/.test(prompt);
    const nextValue = prompt ? `${prompt}${needsSeparator ? " " : ""}@` : "@";
    onDraftChange(updateStudioDraftFromInput(draft, nextValue));
    const mention = getActiveMention(nextValue, nextValue.length);
    syntheticPickerRef.current = {
      prompt,
      mentionStart: prompt.length + (needsSeparator ? 1 : 0),
    };
    pickerQueryRef.current = mention?.query ?? null;
    setActiveMention(mention);
    setPickerOpen(true);
    setPickerHighlight(0);
    afterNextPaint(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextValue.length, nextValue.length);
      updatePickerAnchor(el);
    });
  }, [draft, onDraftChange, pickerOpen, prompt, updatePickerAnchor]);

  const rollbackSyntheticPicker = useCallback(() => {
    const syntheticPicker = syntheticPickerRef.current;
    syntheticPickerRef.current = null;
    if (syntheticPicker && draft.prompt !== syntheticPicker.prompt) {
      onDraftChange({ ...draft, prompt: syntheticPicker.prompt });
    }
  }, [draft, onDraftChange]);

  const syncPickerFromTextarea = useCallback(
    (target: HTMLTextAreaElement) => {
      const value = target.value;
      const mention = getActiveMention(
        value,
        target.selectionStart ?? value.length
      );
      const syntheticPicker = syntheticPickerRef.current;
      if (
        syntheticPicker &&
        (!mention || mention.start !== syntheticPicker.mentionStart)
      ) {
        rollbackSyntheticPicker();
        setActiveMention(null);
        setPickerOpen(false);
        setPickerAnchor(null);
        pickerQueryRef.current = null;
        return true;
      }
      setActiveMention(mention);
      if (mention) {
        setPickerOpen(true);
        if (!pickerOpen || pickerQueryRef.current !== mention.query) {
          setPickerHighlight(0);
        }
        pickerQueryRef.current = mention.query;
        updatePickerAnchor(target);
      } else {
        setPickerOpen(false);
        setPickerAnchor(null);
        pickerQueryRef.current = null;
      }
      return false;
    },
    [pickerOpen, rollbackSyntheticPicker, updatePickerAnchor]
  );

  const commitInput = useCallback(
    (target: HTMLTextAreaElement) => {
      if (syncPickerFromTextarea(target)) return;
      onDraftChange(updateStudioDraftFromInput(draft, target.value));
    },
    [draft, onDraftChange, syncPickerFromTextarea]
  );

  const applyPreset = useCallback(
    (preset: StudioPromptPreset | string) => {
      const brief = presetPrompt(preset);
      onDraftChange({
        skill,
        prompt: `${skillToken(skill)}${/^[\r\n]/.test(brief) ? "" : " "}${brief}`,
      });
    },
    [onDraftChange, skill]
  );

  const closeSkillPicker = useCallback(() => {
    rollbackSyntheticPicker();
    pickerQueryRef.current = null;
    setPickerOpen(false);
    setActiveMention(null);
    setPickerAnchor(null);
  }, [rollbackSyntheticPicker]);

  useEffect(() => {
    if (!pickerOpen) return;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        closeSkillPicker();
      }
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
  }, [closeSkillPicker, pickerOpen]);

  useEffect(() => {
    if (!activeOptionId) return;
    document
      .getElementById(activeOptionId)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  const handleSourceImageDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsSourceImageDragActive(true);
  };

  const handleSourceImageDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsSourceImageDragActive(false);
  };

  const handleSourceImageDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsSourceImageDragActive(false);
    if (isUploading) return;
    onUploadSourceImage(event.dataTransfer.files);
  };

  const handleAvatarPortraitDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsAvatarDragActive(false);
    if (isUploading) return;
    onUploadAvatarPortrait(event.dataTransfer.files);
  };

  const GenerateIcon =
    skill === "video"
      ? Play
      : skill === "character"
        ? UserRound
        : skill === "morph"
          ? Blend
          : skill === "audio"
            ? elevenLabsMode === "sound_effect"
              ? Music2
              : elevenLabsMode === "subtitles"
                ? Captions
                : elevenLabsMode === "transcript"
                  ? FileText
                  : Mic2
            : skill === "avatar"
              ? Film
              : skill === "banner"
                ? LayoutTemplate
                : WandSparkles;

  // Keep prompt/@ skill switching available when a provider is offline;
  // only Generate stays disabled via generateDisabled.
  const inputDisabled = isGenerating;

  const [morphUploadSlot, setMorphUploadSlot] = useState<"first" | "last">(
    "first"
  );

  const canAddCharacterRef =
    characterAvailable &&
    characterReferenceAssetIds.length < STUDIO_CHARACTER_REFERENCE_MAX &&
    !isGenerating;

  const addCharacterReference = (assetId: string) => {
    if (!assetId || characterReferenceAssetIds.includes(assetId)) return;
    if (characterReferenceAssetIds.length >= STUDIO_CHARACTER_REFERENCE_MAX) {
      return;
    }
    onCharacterReferenceAssetIdsChange([
      ...characterReferenceAssetIds,
      assetId,
    ]);
  };

  const removeCharacterReference = (assetId: string) => {
    onCharacterReferenceAssetIdsChange(
      characterReferenceAssetIds.filter(id => id !== assetId)
    );
  };

  const moveCharacterReference = (assetId: string, direction: -1 | 1) => {
    const index = characterReferenceAssetIds.indexOf(assetId);
    if (index < 0) return;
    const next = index + direction;
    if (next < 0 || next >= characterReferenceAssetIds.length) return;
    const copy = [...characterReferenceAssetIds];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    onCharacterReferenceAssetIdsChange(copy);
  };

  const insertCharacterImageTag = (index: number) => {
    const tag = `[Image ${index + 1}]`;
    const next = prompt.trim() ? `${prompt.trim()} ${tag}` : tag;
    onDraftChange({ ...draft, prompt: next });
  };

  return (
    <section
      ref={composerRef}
      className="overflow-visible border-b px-4 py-4 lg:px-6"
    >
      <div className="mx-auto w-full max-w-5xl space-y-3 overflow-visible">
        <div className="relative overflow-visible rounded-xl border bg-card p-3 sm:p-4">
          {(skill === "video" ||
            skill === "character" ||
            skill === "avatar") && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {skill === "character" ? (
                <>
                  <input
                    ref={characterImageInputRef}
                    type="file"
                    className="hidden"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    data-testid="character-reference-image-input"
                    onChange={event => {
                      onUploadCharacterReference(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <div
                    data-testid="character-reference-dropzone"
                    className={cn(
                      "flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-dashed bg-muted/30",
                      isCharacterDragActive && "border-primary bg-primary/5",
                      !canAddCharacterRef && "opacity-60"
                    )}
                    onDragEnter={event => {
                      if (!event.dataTransfer.types.includes("Files")) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                      setIsCharacterDragActive(true);
                    }}
                    onDragOver={event => {
                      if (!event.dataTransfer.types.includes("Files")) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                      setIsCharacterDragActive(true);
                    }}
                    onDragLeave={event => {
                      if (
                        event.currentTarget.contains(
                          event.relatedTarget as Node | null
                        )
                      ) {
                        return;
                      }
                      setIsCharacterDragActive(false);
                    }}
                    onDrop={event => {
                      event.preventDefault();
                      event.stopPropagation();
                      setIsCharacterDragActive(false);
                      if (!canAddCharacterRef || isUploading) return;
                      onUploadCharacterReference(event.dataTransfer.files);
                    }}
                  >
                    <button
                      type="button"
                      className="flex h-full w-full items-center justify-center text-muted-foreground"
                      disabled={!canAddCharacterRef || isUploading}
                      aria-label={t("characterReferenceUpload")}
                      aria-describedby={
                        isUploading
                          ? "character-reference-limit character-upload-description"
                          : "character-reference-limit"
                      }
                      onClick={() => characterImageInputRef.current?.click()}
                    >
                      <Upload className="h-4 w-4" />
                    </button>
                  </div>
                  {selectedCharacterRefs.map((asset, index) => (
                    <div
                      key={asset.id}
                      className="relative flex h-16 w-16 flex-col overflow-hidden rounded-xl border bg-muted/20"
                      data-testid={`character-ref-chip-${index + 1}`}
                    >
                      {asset.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={asset.url}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
                          {index + 1}
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/55 px-0.5 py-0.5 text-[9px] text-white">
                        <button
                          type="button"
                          className="px-0.5 disabled:opacity-40"
                          disabled={index === 0}
                          onClick={() => moveCharacterReference(asset.id, -1)}
                          aria-label={t("characterMoveLeft")}
                        >
                          ‹
                        </button>
                        <button
                          type="button"
                          className="font-medium"
                          onClick={() => insertCharacterImageTag(index)}
                        >
                          {t("characterImageLabel", { n: index + 1 })}
                        </button>
                        <button
                          type="button"
                          className="px-0.5 disabled:opacity-40"
                          disabled={
                            index === characterReferenceAssetIds.length - 1
                          }
                          onClick={() => moveCharacterReference(asset.id, 1)}
                          aria-label={t("characterMoveRight")}
                        >
                          ›
                        </button>
                      </div>
                      <button
                        type="button"
                        className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                        onClick={() => removeCharacterReference(asset.id)}
                        aria-label={t("characterRemoveReference")}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  <span
                    id="character-reference-limit"
                    className="text-[11px] text-muted-foreground"
                  >
                    {t("characterReferenceHint", {
                      count: characterReferenceAssetIds.length,
                      max: STUDIO_CHARACTER_REFERENCE_MAX,
                    })}
                  </span>
                  {isUploading ? (
                    <span id="character-upload-description" className="sr-only">
                      {t("uploadInProgressDescription")}
                    </span>
                  ) : null}
                </>
              ) : null}
              {skill === "video" ? (
                <>
                  <input
                    ref={sourceImageInputRef}
                    type="file"
                    className="hidden"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    data-testid="video-source-image-input"
                    onChange={event => {
                      onUploadSourceImage(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  {isUploading ? (
                    <span
                      id="video-source-upload-description"
                      className="sr-only"
                    >
                      {t("uploadInProgressDescription")}
                    </span>
                  ) : null}
                  <div
                    data-testid="video-source-dropzone"
                    className={cn(
                      "flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-dashed bg-muted/30",
                      isSourceImageDragActive && "border-primary bg-primary/5"
                    )}
                    onDragEnter={handleSourceImageDragOver}
                    onDragOver={handleSourceImageDragOver}
                    onDragLeave={handleSourceImageDragLeave}
                    onDrop={handleSourceImageDrop}
                  >
                    {selectedVideoSource?.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={selectedVideoSource.url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <button
                        type="button"
                        className="flex h-full w-full flex-col items-center justify-center gap-0.5 text-muted-foreground"
                        disabled={isUploading}
                        onClick={() => sourceImageInputRef.current?.click()}
                        aria-label={t("uploadSourceImage")}
                        aria-describedby={
                          isUploading
                            ? "video-source-upload-description"
                            : undefined
                        }
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {selectedVideoSource ? (
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isUploading}
                        aria-describedby={
                          isUploading
                            ? "video-source-upload-description"
                            : undefined
                        }
                        onClick={() => sourceImageInputRef.current?.click()}
                      >
                        {t("replaceSourceImage")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isUploading}
                        aria-describedby={
                          isUploading
                            ? "video-source-upload-description"
                            : undefined
                        }
                        onClick={() => onVideoSourceAssetIdChange("")}
                      >
                        {t("removeSourceImage")}
                      </Button>
                    </div>
                  ) : null}
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <div className="font-medium text-foreground">
                      {t("studioProductSlot")}
                    </div>
                    <div className="truncate">
                      {selectedVideoSource
                        ? selectedVideoSource.fileName ||
                          selectedVideoSource.prompt ||
                          selectedVideoSource.id
                        : t("sourceImageDropTitle")}
                    </div>
                  </div>
                </>
              ) : null}

              {skill === "avatar" ? (
                <>
                  <input
                    ref={avatarImageInputRef}
                    type="file"
                    className="hidden"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    data-testid="avatar-portrait-image-input"
                    onChange={event => {
                      onUploadAvatarPortrait(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  {isUploading ? (
                    <span
                      id="avatar-portrait-upload-description"
                      className="sr-only"
                    >
                      {t("uploadInProgressDescription")}
                    </span>
                  ) : null}
                  <div
                    data-testid="avatar-portrait-dropzone"
                    className={cn(
                      "flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-dashed bg-muted/30",
                      isAvatarDragActive && "border-primary bg-primary/5"
                    )}
                    onDragEnter={event => {
                      if (!event.dataTransfer.types.includes("Files")) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                      setIsAvatarDragActive(true);
                    }}
                    onDragOver={event => {
                      if (!event.dataTransfer.types.includes("Files")) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                      setIsAvatarDragActive(true);
                    }}
                    onDragLeave={event => {
                      if (
                        event.currentTarget.contains(
                          event.relatedTarget as Node | null
                        )
                      ) {
                        return;
                      }
                      setIsAvatarDragActive(false);
                    }}
                    onDrop={handleAvatarPortraitDrop}
                    onClick={() => {
                      if (isUploading) return;
                      avatarImageInputRef.current?.click();
                    }}
                  >
                    {selectedAvatarImage?.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={selectedAvatarImage.url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <button
                        type="button"
                        className="flex h-full w-full flex-col items-center justify-center gap-0.5 text-muted-foreground"
                        disabled={isUploading}
                        onClick={event => {
                          event.stopPropagation();
                          avatarImageInputRef.current?.click();
                        }}
                        aria-label={t("avatarPortraitUpload")}
                        aria-describedby={
                          isUploading
                            ? "avatar-portrait-upload-description"
                            : undefined
                        }
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {selectedAvatarImage ? (
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isUploading}
                        aria-describedby={
                          isUploading
                            ? "avatar-portrait-upload-description"
                            : undefined
                        }
                        onClick={() => avatarImageInputRef.current?.click()}
                      >
                        {t("replaceAvatarPortrait")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isUploading}
                        aria-describedby={
                          isUploading
                            ? "avatar-portrait-upload-description"
                            : undefined
                        }
                        onClick={() => onAvatarImageAssetIdChange("")}
                      >
                        {t("removeAvatarPortrait")}
                      </Button>
                    </div>
                  ) : null}
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <div className="font-medium text-foreground">
                      {t("avatarPortrait")}
                    </div>
                    <div className="truncate">
                      {selectedAvatarImage
                        ? selectedAvatarImage.fileName ||
                          selectedAvatarImage.prompt ||
                          selectedAvatarImage.id
                        : t("avatarPortraitUpload")}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          )}

          <div className="relative grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="relative min-w-0" ref={promptShellRef}>
              {pickerOpen ? (
                <div
                  className="absolute z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
                  data-testid="studio-skill-picker"
                  style={{
                    left: pickerAnchor?.left ?? 12,
                    top: pickerAnchor?.top ?? 28,
                    transform: "translateY(0.35rem)",
                  }}
                >
                  <Command shouldFilter={false}>
                    <CommandList className="max-h-72">
                      <CommandGroup
                        id={pickerListId}
                        role="listbox"
                        aria-label={t("studioSkillsGroup")}
                        heading={t("studioSkillsGroup")}
                      >
                        {filteredSkillOptions.map((option, index) => {
                          const Icon = SKILL_ICON[option.id];
                          return (
                            <CommandItem
                              key={option.id}
                              id={`${optionIdPrefix}-${option.id}`}
                              role="option"
                              aria-selected={index === pickerHighlight}
                              aria-disabled={!option.available}
                              value={option.id}
                              onSelect={() =>
                                applySkill(option.id, activeMention)
                              }
                              className={cn(
                                "items-start gap-3 py-2.5",
                                index === pickerHighlight && "bg-accent"
                              )}
                            >
                              <span
                                className={cn(
                                  "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                                  SKILL_CHIP_CLASS[option.id]
                                )}
                              >
                                <Icon className="h-3.5 w-3.5" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block font-medium">
                                  {option.label}
                                  {option.id === skill ? (
                                    <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                                      {t("studioSkillAlreadySelected")}
                                    </span>
                                  ) : null}
                                  {!option.available ? (
                                    <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                                      {t("studioSkillSetupRequired")}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {option.description}
                                </span>
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                      {filteredSkillOptions.length === 0 ? (
                        <CommandEmpty>{t("studioSkillsEmpty")}</CommandEmpty>
                      ) : null}
                    </CommandList>
                  </Command>
                </div>
              ) : null}

              <MentionTextarea
                ref={textareaRef}
                value={prompt}
                onValueChange={(_, target) => commitInput(target)}
                renderValue={renderInputWithSkillMentions}
                minHeight={TEXTAREA_MIN_HEIGHT}
                maxHeight={TEXTAREA_MAX_HEIGHT}
                onClick={event => syncPickerFromTextarea(event.currentTarget)}
                onKeyUp={event => syncPickerFromTextarea(event.currentTarget)}
                onSelect={event => syncPickerFromTextarea(event.currentTarget)}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return;
                  if (pickerOpen) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setPickerHighlight(current =>
                        Math.max(
                          0,
                          Math.min(filteredSkillOptions.length - 1, current + 1)
                        )
                      );
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setPickerHighlight(current => Math.max(0, current - 1));
                      return;
                    }
                    if (event.key === "Enter" || event.key === "Tab") {
                      const option = filteredSkillOptions[pickerHighlight];
                      if (option) {
                        event.preventDefault();
                        applySkill(option.id, activeMention);
                        return;
                      }
                      if (event.key === "Enter") {
                        event.preventDefault();
                        return;
                      }
                      closeSkillPicker();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeSkillPicker();
                    }
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!generateDisabled && !isGenerating) onGenerate();
                  }
                  if (event.key === "Escape") {
                    closeSkillPicker();
                  }
                }}
                placeholder={placeholder}
                rows={4}
                className="relative z-10"
                textareaClassName="min-h-[88px] resize-none border-0 bg-transparent px-3 py-2.5 text-sm leading-6 text-transparent caret-foreground shadow-none focus-visible:ring-0"
                overlayClassName="whitespace-pre-wrap break-words px-3 py-2.5 text-sm leading-6 text-foreground"
                disabled={inputDisabled}
                data-testid="studio-composer-input"
                aria-expanded={pickerOpen}
                aria-controls={pickerOpen ? pickerListId : undefined}
                aria-activedescendant={activeOptionId}
                aria-describedby={generationBlockerText ? blockerId : undefined}
              />
            </div>
            {generationBlockerText ? (
              <p id={blockerId} className="text-xs text-muted-foreground">
                {generationBlockerText}
              </p>
            ) : null}

            <div className="flex shrink-0 items-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 w-11 rounded-xl px-0"
                onClick={openSkillPicker}
                disabled={isGenerating}
                data-testid="studio-composer-skills"
                aria-label={t("studioSkillsGroup")}
              >
                @
              </Button>
              <Button
                type="button"
                className="h-11 rounded-xl px-5"
                disabled={generateDisabled || isGenerating}
                onClick={onGenerate}
                data-testid="studio-composer-generate"
              >
                {isGenerating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <GenerateIcon className="mr-2 h-4 w-4" />
                )}
                {generateLabel}
              </Button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
            {skill === "image"
              ? imagePresets.map(preset => (
                  <Button
                    key={presetTitle(preset)}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-md px-2 text-[11px]"
                    disabled={isGenerating}
                    onClick={() => applyPreset(preset)}
                  >
                    {presetTitle(preset)}
                  </Button>
                ))
              : null}

            {skill === "banner" ? (
              <>
                <div className="min-w-[140px] space-y-1">
                  <Label className="text-[11px]">
                    {t("bannerAspectRatio")}
                  </Label>
                  <Select
                    value={bannerAspectRatio}
                    onValueChange={value =>
                      onBannerAspectRatioChange(
                        value as StudioBannerAspectRatio
                      )
                    }
                    disabled={!generationAvailable || isGenerating}
                  >
                    <SelectTrigger className="h-8 rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STUDIO_BANNER_ASPECT_RATIOS.map(ratio => (
                        <SelectItem key={ratio} value={ratio}>
                          {ratio}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {bannerPresets.map(preset => (
                  <Button
                    key={presetTitle(preset)}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-md px-2 text-[11px]"
                    disabled={isGenerating}
                    onClick={() => applyPreset(preset)}
                  >
                    {presetTitle(preset)}
                  </Button>
                ))}
              </>
            ) : null}

            {skill === "video" ? (
              <div data-testid="video-settings" className="contents">
                <div className="min-w-[180px] space-y-1">
                  <Label className="text-[11px]">
                    {t("selectLibraryImage")}
                  </Label>
                  <Select
                    value={videoSourceAssetId}
                    onValueChange={onVideoSourceAssetIdChange}
                    disabled={imageAssets.length === 0 || isGenerating}
                  >
                    <SelectTrigger className="h-8 rounded-md">
                      <SelectValue placeholder={t("selectLibraryImage")} />
                    </SelectTrigger>
                    <SelectContent>
                      {imageAssets.map(asset => (
                        <SelectItem key={asset.id} value={asset.id}>
                          {asset.fileName || asset.prompt || asset.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-20 space-y-1">
                  <Label
                    className="text-[11px]"
                    htmlFor="studio-video-duration"
                  >
                    {t("seconds")}
                  </Label>
                  {videoDurationOptions?.length ? (
                    <Select
                      value={duration}
                      onValueChange={onDurationChange}
                      disabled={isGenerating}
                    >
                      <SelectTrigger
                        id="studio-video-duration"
                        className="h-8 rounded-md"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {videoDurationOptions.map(option => (
                          <SelectItem key={option} value={String(option)}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id="studio-video-duration"
                      type="number"
                      min={3}
                      max={videoDurationMax}
                      value={duration}
                      onChange={event => onDurationChange(event.target.value)}
                      disabled={isGenerating}
                      className="h-8 rounded-md"
                    />
                  )}
                </div>
                {videoSourceOptional ? (
                  <span className="text-[11px] text-muted-foreground">
                    {t("videoTextToVideoHint")}
                  </span>
                ) : null}
                {videoPresets.map(preset => (
                  <Button
                    key={presetTitle(preset)}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-md px-2 text-[11px]"
                    disabled={isGenerating}
                    onClick={() => applyPreset(preset)}
                  >
                    {presetTitle(preset)}
                  </Button>
                ))}
              </div>
            ) : null}

            {skill === "morph" ? (
              <>
                <input
                  ref={morphImageInputRef}
                  type="file"
                  className="hidden"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  data-testid="morph-frame-image-input"
                  onChange={event => {
                    const files = event.target.files;
                    if (morphUploadSlot === "first") {
                      onUploadMorphFirstFrame(files);
                    } else {
                      onUploadMorphLastFrame(files);
                    }
                    event.target.value = "";
                  }}
                />
                <div className="min-w-[160px] space-y-1">
                  <Label className="text-[11px]">{t("morphFirstFrame")}</Label>
                  <Select
                    value={morphFirstFrameAssetId}
                    onValueChange={onMorphFirstFrameAssetIdChange}
                    disabled={!morphAvailable || imageAssets.length === 0}
                  >
                    <SelectTrigger
                      className="h-8 rounded-md"
                      data-testid="morph-first-frame-select"
                    >
                      <SelectValue placeholder={t("selectLibraryImage")} />
                    </SelectTrigger>
                    <SelectContent>
                      {imageAssets.map(asset => (
                        <SelectItem key={asset.id} value={asset.id}>
                          {asset.fileName || asset.prompt || asset.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-[160px] space-y-1">
                  <Label className="text-[11px]">{t("morphLastFrame")}</Label>
                  <Select
                    value={morphLastFrameAssetId}
                    onValueChange={onMorphLastFrameAssetIdChange}
                    disabled={!morphAvailable || imageAssets.length === 0}
                  >
                    <SelectTrigger
                      className="h-8 rounded-md"
                      data-testid="morph-last-frame-select"
                    >
                      <SelectValue placeholder={t("selectLibraryImage")} />
                    </SelectTrigger>
                    <SelectContent>
                      {imageAssets.map(asset => (
                        <SelectItem key={asset.id} value={asset.id}>
                          {asset.fileName || asset.prompt || asset.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-md px-2 text-[11px]"
                  disabled={!morphAvailable || isUploading}
                  onClick={() => {
                    setMorphUploadSlot("first");
                    afterNextPaint(() => morphImageInputRef.current?.click());
                  }}
                >
                  <Upload className="mr-1.5 h-3 w-3" />
                  {selectedMorphFirst
                    ? t("morphReplaceFirst")
                    : t("morphUploadFirst")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-md px-2 text-[11px]"
                  disabled={!morphAvailable || isUploading}
                  onClick={() => {
                    setMorphUploadSlot("last");
                    afterNextPaint(() => morphImageInputRef.current?.click());
                  }}
                >
                  <Upload className="mr-1.5 h-3 w-3" />
                  {selectedMorphLast
                    ? t("morphReplaceLast")
                    : t("morphUploadLast")}
                </Button>
                <div className="w-20 space-y-1">
                  <Label
                    className="text-[11px]"
                    htmlFor="studio-morph-duration"
                  >
                    {t("seconds")}
                  </Label>
                  <Input
                    id="studio-morph-duration"
                    type="number"
                    min={2}
                    max={15}
                    value={duration}
                    onChange={event => onDurationChange(event.target.value)}
                    disabled={!morphAvailable}
                    className="h-8 rounded-md"
                  />
                </div>
                {morphPresets.map(preset => (
                  <Button
                    key={presetTitle(preset)}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-md px-2 text-[11px]"
                    disabled={isGenerating}
                    onClick={() => applyPreset(preset)}
                  >
                    {presetTitle(preset)}
                  </Button>
                ))}
              </>
            ) : null}

            {skill === "character" ? (
              <>
                <div className="min-w-[180px] space-y-1">
                  <Label className="text-[11px]">
                    {t("characterAddFromLibrary")}
                  </Label>
                  <Select
                    value=""
                    onValueChange={addCharacterReference}
                    disabled={!canAddCharacterRef || imageAssets.length === 0}
                  >
                    <SelectTrigger
                      className="h-8 rounded-md"
                      data-testid="character-add-library"
                    >
                      <SelectValue placeholder={t("selectLibraryImage")} />
                    </SelectTrigger>
                    <SelectContent>
                      {imageAssets
                        .filter(
                          asset =>
                            !characterReferenceAssetIds.includes(asset.id)
                        )
                        .map(asset => (
                          <SelectItem key={asset.id} value={asset.id}>
                            {asset.fileName || asset.prompt || asset.id}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-[120px] space-y-1">
                  <Label className="text-[11px]">{t("characterRatio")}</Label>
                  <Select
                    value={characterRatio}
                    onValueChange={value =>
                      onCharacterRatioChange(value as StudioCharacterRatio)
                    }
                    disabled={!characterAvailable || isGenerating}
                  >
                    <SelectTrigger className="h-8 rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STUDIO_CHARACTER_RATIOS.map(ratio => (
                        <SelectItem key={ratio} value={ratio}>
                          {ratio}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-20 space-y-1">
                  <Label
                    className="text-[11px]"
                    htmlFor="studio-character-duration"
                  >
                    {t("seconds")}
                  </Label>
                  <Input
                    id="studio-character-duration"
                    type="number"
                    min={3}
                    max={15}
                    value={duration}
                    onChange={event => onDurationChange(event.target.value)}
                    disabled={!characterAvailable}
                    className="h-8 rounded-md"
                  />
                </div>
                {characterPresets.map(preset => (
                  <Button
                    key={presetTitle(preset)}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-md px-2 text-[11px]"
                    disabled={isGenerating}
                    onClick={() => applyPreset(preset)}
                  >
                    {presetTitle(preset)}
                  </Button>
                ))}
              </>
            ) : null}

            {skill === "audio" ? (
              <>
                <div className="min-w-[160px] space-y-1">
                  <Label className="text-[11px]">{t("elevenLabsMode")}</Label>
                  <Select
                    value={elevenLabsMode}
                    onValueChange={value =>
                      onElevenLabsModeChange(value as StudioElevenLabsMode)
                    }
                    disabled={!elevenLabsAvailable || isGenerating}
                  >
                    <SelectTrigger className="h-8 rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text_to_speech">
                        {t("elevenLabsVoiceover")}
                      </SelectItem>
                      <SelectItem value="sound_effect">
                        {t("elevenLabsSoundEffect")}
                      </SelectItem>
                      <SelectItem value="transcript">
                        {t("elevenLabsTranscript")}
                      </SelectItem>
                      <SelectItem value="subtitles">
                        {t("elevenLabsSubtitles")}
                      </SelectItem>
                      <SelectItem value="dub">{t("elevenLabsDub")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {!elevenLabsUsesText ? (
                  <div className="min-w-[180px] space-y-1">
                    <Label className="text-[11px]">
                      {t("elevenLabsSourceMedia")}
                    </Label>
                    <Select
                      value={elevenLabsSourceAssetId}
                      onValueChange={onElevenLabsSourceAssetIdChange}
                      disabled={
                        !elevenLabsAvailable ||
                        mediaAssets.length === 0 ||
                        isGenerating
                      }
                    >
                      <SelectTrigger className="h-8 rounded-md">
                        <SelectValue
                          placeholder={t("elevenLabsSelectSourceMedia")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {mediaAssets.map(asset => (
                          <SelectItem key={asset.id} value={asset.id}>
                            {asset.fileName || asset.prompt || asset.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {elevenLabsMode === "dub" ? (
                  <div className="w-24 space-y-1">
                    <Label
                      className="text-[11px]"
                      htmlFor="studio-elevenlabs-lang"
                    >
                      {t("elevenLabsTargetLanguage")}
                    </Label>
                    <Input
                      id="studio-elevenlabs-lang"
                      value={elevenLabsTargetLanguage}
                      onChange={event =>
                        onElevenLabsTargetLanguageChange(event.target.value)
                      }
                      placeholder="es"
                      className="h-8 rounded-md"
                      disabled={!elevenLabsAvailable || isGenerating}
                    />
                  </div>
                ) : null}
                {elevenLabsUsesText
                  ? audioPresets.map(preset => (
                      <Button
                        key={presetTitle(preset)}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 rounded-md px-2 text-[11px]"
                        disabled={isGenerating}
                        onClick={() => applyPreset(preset)}
                      >
                        {presetTitle(preset)}
                      </Button>
                    ))
                  : null}
                {selectedElevenLabsSource ? (
                  <div className="text-[11px] text-muted-foreground">
                    {formatBytes(selectedElevenLabsSource.fileSize) ||
                      t("sourceMediaReady")}
                  </div>
                ) : null}
              </>
            ) : null}

            {skill === "avatar" ? (
              <>
                <div className="min-w-[160px] space-y-1">
                  <Label className="text-[11px]">{t("avatarMode")}</Label>
                  <Select
                    value={wanAvatarMode}
                    onValueChange={value =>
                      onWanAvatarModeChange(value as StudioWanAvatarMode)
                    }
                    disabled={!wanAvatarAvailable || isGenerating}
                  >
                    <SelectTrigger className="h-8 rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="image_script">
                        {t("avatarModeScript")}
                      </SelectItem>
                      <SelectItem value="image_audio">
                        {t("avatarModeAudio")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-[180px] space-y-1">
                  <Label className="text-[11px]">{t("avatarPortrait")}</Label>
                  <Select
                    value={avatarImageAssetId}
                    onValueChange={onAvatarImageAssetIdChange}
                    disabled={
                      !wanAvatarAvailable ||
                      imageAssets.length === 0 ||
                      isGenerating
                    }
                  >
                    <SelectTrigger className="h-8 rounded-md">
                      <SelectValue placeholder={t("selectLibraryImage")} />
                    </SelectTrigger>
                    <SelectContent>
                      {imageAssets.map(asset => (
                        <SelectItem key={asset.id} value={asset.id}>
                          {asset.fileName || asset.prompt || asset.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {wanAvatarMode === "image_audio" ? (
                  <div className="min-w-[180px] space-y-1">
                    <Label className="text-[11px]">{t("avatarAudio")}</Label>
                    <Select
                      value={avatarAudioAssetId}
                      onValueChange={onAvatarAudioAssetIdChange}
                      disabled={
                        !wanAvatarAvailable ||
                        audioAssets.length === 0 ||
                        isGenerating
                      }
                    >
                      <SelectTrigger className="h-8 rounded-md">
                        <SelectValue placeholder={t("avatarSelectAudio")} />
                      </SelectTrigger>
                      <SelectContent>
                        {audioAssets.map(asset => (
                          <SelectItem key={asset.id} value={asset.id}>
                            {asset.fileName || asset.prompt || asset.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedAvatarAudio ? (
                      <div className="text-[11px] text-muted-foreground">
                        {t("avatarAudioLimitHint")}
                      </div>
                    ) : null}
                  </div>
                ) : !elevenLabsAvailable ? (
                  <div className="text-[11px] text-amber-700 dark:text-amber-300">
                    {t("avatarNeedsElevenLabs")}
                  </div>
                ) : null}
                <div className="w-28 space-y-1">
                  <Label className="text-[11px]">{t("avatarResolution")}</Label>
                  <Select
                    value={avatarResolution}
                    onValueChange={value =>
                      onAvatarResolutionChange(value as "720P" | "1080P")
                    }
                    disabled={!wanAvatarAvailable || isGenerating}
                  >
                    <SelectTrigger className="h-8 rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1080P">1080P</SelectItem>
                      <SelectItem value="720P">720P</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : null}
          </div>
        </div>

        {footer}
      </div>
    </section>
  );
}
