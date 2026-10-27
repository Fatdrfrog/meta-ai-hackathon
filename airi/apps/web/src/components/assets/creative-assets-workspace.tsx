"use client";

import { CreativeAssetsMarketingTemplates } from "@/components/assets/creative-assets-marketing-templates";
import { CreativeAssetStorageStatus } from "@/components/assets/creative-asset-storage-status";
import {
  CreativeAssetsStudioComposer,
  ensureCharacterImageTags,
  STUDIO_CHARACTER_REFERENCE_MAX,
  type StudioBannerAspectRatio,
  type StudioCharacterRatio,
} from "@/components/assets/creative-assets-studio-composer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import {
  fetchCreativeAssetStatuses,
  readJsonResponse,
  requireQueuedAsset,
} from "@/lib/creative-assets/creative-asset-client-response";
import type { MarketingTemplate } from "@/lib/creative-assets/marketing-templates";
import {
  resolveStudioGenerationBlocker,
  selectStudioSkill,
  stripStudioSkillTokens,
  type StudioComposerDraft,
  type StudioGenerationBlocker,
} from "@/lib/creative-assets/studio-composer-state";
import type { StudioSkillId } from "@/lib/creative-assets/studio-skills";
import {
  getOrCreateVideoGenerationIdempotencyKey,
  retireVideoGenerationIdempotencyKey,
} from "@/lib/creative-assets/video-generation-idempotency";
import type { PublicVideoGeneration } from "@/lib/higgsfield/creative-asset-serialization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getAiriCreativeAssetDraftStorageKey,
  normalizeAiriCreativeAssetDrafts,
  type AiriCreativeAssetDraft,
} from "@/lib/airi-chats/creative-asset-draft";
import {
  collectGreenScreenSourceAssetIds,
  isAiriGreenScreenAsset,
  isRetryableAiriGreenScreenAsset,
} from "@/lib/creative-assets/green-screen";
import { cn } from "@/lib/utils";
import { uploadGcsResumableAsset } from "@/lib/google/gcs-resumable-upload";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  FileText,
  Film,
  ImageIcon,
  Loader2,
  RefreshCcw,
  Search,
  Trash2,
  Upload,
  Video,
  Volume2,
  WandSparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { toast } from "sonner";
import useSWR from "swr";

export type CreativeAsset = {
  id: string;
  workspaceId: string;
  kind: "image" | "video" | "audio" | "text";
  source:
    | "uploaded"
    | "higgsfield"
    | "google"
    | "elevenlabs"
    | "wan"
    | "happyhorse"
    | "alibaba"
    | "edited";
  provider?:
    | "higgsfield"
    | "google"
    | "elevenlabs"
    | "wan"
    | "happyhorse"
    | "alibaba"
    | "airi"
    | null;
  status: "queued" | "in_progress" | "complete" | "failed" | "nsfw";
  prompt?: string | null;
  modelId?: string | null;
  sourceAssetId?: string | null;
  url?: string | null;
  storageProvider?: "gcs" | "supabase" | null;
  bucket?: string | null;
  path?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  error?: string | null;
  createdAt?: string | null;
  generation?: PublicVideoGeneration | null;
};

type CreativeAssetsWorkspaceProps = {
  workspaceId: string;
  higgsfieldConfigured: boolean;
  openAiriAssetDraftOnMount?: boolean;
  generationProvider?: "higgsfield" | "google" | null;
  freeGenerations?: FreeGenerationState | null;
  elevenLabsConfigured?: boolean;
  elevenLabsDisabledReason?: "source_required" | "server_unconfigured" | null;
  higgsfieldDisabledReason?: "source_required" | "server_unconfigured" | null;
  higgsfieldIntegrationUrl?: string;
  elevenLabsIntegrationUrl?: string;
  wanAvatarConfigured?: boolean;
  wanMorphConfigured?: boolean;
  happyHorseConfigured?: boolean;
  alibabaImageConfigured?: boolean;
};

type FreeGenerationState = {
  configured: boolean;
  limit: number;
  used: number;
  remaining: number;
};

type AssetsPayload = {
  assets?: CreativeAsset[];
  duplicate?: boolean;
  greenScreenSourceAssetIds?: string[];
  higgsfieldConfigured?: boolean;
  generationProvider?: "higgsfield" | "google" | null;
  elevenLabsConfigured?: boolean;
  elevenLabsDisabledReason?: "source_required" | "server_unconfigured" | null;
  freeGenerations?: FreeGenerationState | null;
  higgsfieldDisabledReason?: "source_required" | "server_unconfigured" | null;
};

type CreativeAssetDirectUpload = {
  provider: "gcs";
  assetId: string;
  bucket: string;
  path: string;
  uploadUrl: string;
  method: "PUT";
  mode?: "single";
  headers?: Record<string, string>;
  kind: CreativeAsset["kind"];
  mimeType: string;
  fileName: string;
  fileSize: number;
};

type CreativeAssetUploadInitiatePayload = {
  upload?: CreativeAssetDirectUpload;
};

type CanvaTemplate = {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  createUrl: string | null;
};

type CanvaTemplatesPayload = {
  status?: "ok" | "connection_needed" | "reconnect_required" | "error";
  items?: CanvaTemplate[];
  connectUrl?: string | null;
};
type CanvaTemplatesKey = readonly ["canva-templates", string, string];

type AssetKindFilter = "all" | "image" | "video" | "audio" | "text";
type StudioDurationSkill = "video" | "character" | "morph" | "audio";
type WanAvatarMode = "image_audio" | "image_script";
type ElevenLabsMode =
  | "text_to_speech"
  | "sound_effect"
  | "transcript"
  | "subtitles"
  | "dub";
type AssetStatusFilter =
  | "all"
  | "queued"
  | "in_progress"
  | "complete"
  | "failed"
  | "nsfw";
type UploadOptions = {
  imageOnly?: boolean;
  selectForVideo?: boolean;
  selectForAvatar?: boolean;
  appendAsCharacterReference?: boolean;
  selectForMorphFirst?: boolean;
  selectForMorphLast?: boolean;
};

type WorkspaceEpochToken = {
  workspaceId: string;
  active: boolean;
};

type StudioPromptPreset = {
  title: string;
  prompt: string;
};

type TranslationFn = (
  key: string,
  values?: Record<string, number | string>
) => string;

const IMAGE_PROMPT_PRESETS: StudioPromptPreset[] = [
  {
    title: "Product photo",
    prompt: "Restaurant product photo with clean lighting",
  },
  {
    title: "Social story",
    prompt: "Vertical social story image with appetizing food styling",
  },
  {
    title: "Campaign visual",
    prompt: "Premium campaign visual with space for copy",
  },
];

const VIDEO_PROMPT_PRESETS: StudioPromptPreset[] = [
  {
    title: "Camera push",
    prompt: "Slow camera push with subtle steam and motion",
  },
  {
    title: "Lifestyle",
    prompt: "Handheld lifestyle movement with natural light",
  },
  {
    title: "Product reveal",
    prompt: "Smooth product reveal for a WhatsApp campaign",
  },
];

const AUDIO_PROMPT_PRESETS: StudioPromptPreset[] = [
  {
    title: "Warm voiceover",
    prompt: "Warm 12 second voiceover for a WhatsApp follow-up",
  },
  {
    title: "Reveal chime",
    prompt: "Short product reveal chime with soft ambience",
  },
  {
    title: "Spanish dub",
    prompt: "Spanish dub for a customer success follow-up",
  },
];

const BANNER_PROMPT_PRESETS: StudioPromptPreset[] = [
  {
    title: "Bold offer",
    prompt:
      "Bold offer banner with clean product hero and space for headline on the left",
  },
  {
    title: "WhatsApp CTA",
    prompt:
      "WhatsApp campaign banner, soft gradient, high-contrast CTA zone bottom-right",
  },
  {
    title: "Launch banner",
    prompt:
      "Premium launch banner, centered product, subtle light streaks, ad-ready framing",
  },
];

const CHARACTER_PROMPT_PRESETS: StudioPromptPreset[] = [
  {
    title: "UGC present",
    prompt:
      "The person from [Image 1] presents the product from [Image 2] in a vertical 9:16 UGC ad with natural handheld motion",
  },
  {
    title: "Cafe walk",
    prompt:
      "Keep the look of [Image 1] while walking through a bright cafe and showing [Image 2] to camera",
  },
  {
    title: "Multi-angle",
    prompt:
      "Multi-angle product story: [Image 1] as hero character and [Image 2] as the featured item, TikTok pacing",
  },
];

const MORPH_PROMPT_PRESETS: StudioPromptPreset[] = [
  {
    title: "Clean morph",
    prompt:
      "Smooth morph from the messy before state into the clean after state, soft daylight, social-ad pacing",
  },
  {
    title: "Gentle push",
    prompt:
      "Before/after transition with a gentle camera push, keep subject identity consistent between frames",
  },
  {
    title: "Package open",
    prompt:
      "Product reveal morph: start from the closed package first frame and end on the opened hero last frame",
  },
];

const GOOGLE_VIDEO_DURATION_OPTIONS = [4, 6, 8] as const;

function compatibleGoogleVideoDuration(value: string): string {
  const duration = Number(value);
  return GOOGLE_VIDEO_DURATION_OPTIONS.includes(duration as 4 | 6 | 8)
    ? String(duration)
    : "6";
}

const DEFAULT_CANVA_TEMPLATE_QUERY = "WhatsApp campaign follow up creative";
function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return "";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function isImageUpload(file: File): boolean {
  return (
    file.type.startsWith("image/") || /\.(gif|jpe?g|png|webp)$/i.test(file.name)
  );
}

const STUDIO_GENERATION_BLOCKER_TRANSLATION_KEYS: Record<
  Exclude<StudioGenerationBlocker, null>,
  string
> = {
  setup_required: "studioGenerationBlockerSetupRequired",
  prompt_required: "studioGenerationBlockerPromptRequired",
  source_image_required: "studioGenerationBlockerSourceImageRequired",
  source_media_required: "studioGenerationBlockerSourceMediaRequired",
  character_reference_required:
    "studioGenerationBlockerCharacterReferenceRequired",
  morph_frames_required: "studioGenerationBlockerMorphFramesRequired",
  morph_frames_must_differ: "studioGenerationBlockerMorphFramesMustDiffer",
  duration_invalid: "studioGenerationBlockerDurationInvalid",
  avatar_portrait_required: "studioGenerationBlockerAvatarPortraitRequired",
  avatar_audio_required: "studioGenerationBlockerAvatarAudioRequired",
  avatar_voice_required: "studioGenerationBlockerAvatarVoiceRequired",
};

function statusLabel(
  status: CreativeAsset["status"],
  t: TranslationFn
): string {
  if (status === "in_progress") return t("inProgress");
  return t(status);
}

function statusBadgeClass(status: CreativeAsset["status"]): string {
  if (status === "complete") return "bg-emerald-500/10 text-emerald-700";
  if (status === "failed" || status === "nsfw") {
    return "bg-destructive/10 text-destructive";
  }
  return "bg-amber-500/10 text-amber-700";
}

function assetKindLabel(kind: CreativeAsset["kind"], t: TranslationFn): string {
  if (kind === "video") return t("videoKind");
  if (kind === "audio") return t("audioKind");
  if (kind === "text") return t("textKind");
  return t("imageKind");
}

function assetSourceLabel(
  source: CreativeAsset["source"],
  t: TranslationFn
): string {
  switch (source) {
    case "higgsfield":
      return t("sourceHiggsfield");
    case "google":
      return t("sourceGoogle");
    case "elevenlabs":
      return t("sourceElevenLabs");
    case "wan":
      return t("sourceWan");
    case "happyhorse":
      return t("sourceHappyHorse");
    case "alibaba":
      return t("sourceAlibaba");
    case "edited":
      return t("sourceEdited");
    case "uploaded":
      return t("sourceUpload");
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function assetTitle(asset: CreativeAsset): string {
  return asset.fileName || asset.prompt || asset.id;
}

function formatAssetAge(
  createdAt: string | null | undefined,
  t: TranslationFn
): string {
  if (!createdAt) return "";
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return t("justNow");
  if (minutes < 60) return t("minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("hoursAgo", { count: hours });
  return t("daysAgo", { count: Math.round(hours / 24) });
}

function assetMatchesSearch(asset: CreativeAsset, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    asset.fileName,
    asset.prompt,
    asset.kind,
    asset.source,
    asset.status,
    asset.modelId,
  ].some(value =>
    String(value || "")
      .toLowerCase()
      .includes(normalized)
  );
}

function mergeAsset(current: CreativeAsset[], nextAsset: CreativeAsset) {
  const exists = current.some(asset => asset.id === nextAsset.id);
  if (!exists) return [nextAsset, ...current];
  return current.map(asset => (asset.id === nextAsset.id ? nextAsset : asset));
}

function assetKindIcon(kind: CreativeAsset["kind"]) {
  if (kind === "video") return Film;
  if (kind === "audio") return Volume2;
  if (kind === "text") return FileText;
  return ImageIcon;
}

function replaceAsset(
  current: CreativeAsset[],
  previousAssetId: string,
  nextAsset: CreativeAsset
) {
  const withoutDuplicate = current.filter(asset => asset.id !== nextAsset.id);
  if (!withoutDuplicate.some(asset => asset.id === previousAssetId)) {
    return [nextAsset, ...withoutDuplicate];
  }
  return withoutDuplicate.map(asset =>
    asset.id === previousAssetId ? nextAsset : asset
  );
}

function mergeTrackingIds(current: string[], assets: CreativeAsset[]) {
  const next = new Set(current);
  for (const asset of assets) {
    if (asset.status === "queued" || asset.status === "in_progress") {
      next.add(asset.id);
    }
  }
  return Array.from(next);
}

function mergeGreenScreenSourceAssetIds(
  current: string[],
  sourceAssetIds: string[]
) {
  const next = new Set(current);
  for (const sourceAssetId of sourceAssetIds) {
    const normalized = sourceAssetId.trim();
    if (normalized) next.add(normalized);
  }
  return Array.from(next);
}

function formatCreativeAssetUploadError(
  error: unknown,
  t: (key: string) => string
): string {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("maximum size exceeded") ||
    (message.includes("413") && normalized.includes("size"))
  ) {
    return t("assetUploadTooLarge");
  }
  return error instanceof Error ? error.message : "Upload failed";
}

async function fetchCanvaTemplates([
  ,
  workspaceId,
  query,
]: CanvaTemplatesKey): Promise<CanvaTemplatesPayload> {
  return readJsonResponse<CanvaTemplatesPayload>(
    await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scenario-generator/canva/templates`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      }
    )
  );
}

function readAiriCreativeAssetDraftsFromStorage(workspaceId: string) {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage?.getItem(
      getAiriCreativeAssetDraftStorageKey(workspaceId)
    );
    if (!raw) return [];
    return normalizeAiriCreativeAssetDrafts(JSON.parse(raw));
  } catch {
    return [];
  }
}

function draftGenerationTab(draft: AiriCreativeAssetDraft): StudioSkillId {
  if (draft.kind === "audio_asset") return "audio";
  if (draft.kind === "visual_asset" && draft.mode === "image_to_video") {
    return "video";
  }
  return "image";
}

function draftProviderLabel(draft: AiriCreativeAssetDraft) {
  switch (draft.provider) {
    case "elevenlabs":
      return "ElevenLabs";
    case "higgsfield":
      return "Higgsfield";
    case "google":
      return "Google";
    case "alibaba":
      return "Alibaba";
    case "wan":
      return "Wan";
    case "canva":
      return "Canva";
    default: {
      const _exhaustive: never = draft.provider;
      return _exhaustive;
    }
  }
}

function GenerationUnavailableNotice(props: {
  generationDisabledReason: "source_required" | "server_unconfigured" | null;
  higgsfieldIntegrationUrl?: string;
  t: TranslationFn;
}) {
  const { t } = props;

  return (
    <Alert className="mt-4 rounded-xl" data-testid="generation-source-alert">
      <AlertTitle>{t("generationUnavailableTitle")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{t("generationUnavailableDescription")}</p>
        {props.generationDisabledReason === "source_required" &&
        props.higgsfieldIntegrationUrl ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-md px-2 text-[11px]"
            asChild
          >
            <Link href={props.higgsfieldIntegrationUrl}>
              {t("openIntegrations")}
            </Link>
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function CreativeAssetsWorkspace(props: CreativeAssetsWorkspaceProps) {
  return <CreativeAssetsWorkspaceContent key={props.workspaceId} {...props} />;
}

function CreativeAssetsWorkspaceContent({
  workspaceId,
  higgsfieldConfigured,
  openAiriAssetDraftOnMount = false,
  generationProvider = null,
  elevenLabsConfigured = false,
  higgsfieldDisabledReason = null,
  higgsfieldIntegrationUrl,
  elevenLabsIntegrationUrl,
  wanAvatarConfigured = false,
  wanMorphConfigured = false,
  happyHorseConfigured = false,
  alibabaImageConfigured = false,
  // react-doctor-disable-next-line react-doctor/prefer-useReducer -- state domains update independently
}: CreativeAssetsWorkspaceProps) {
  const t = useTranslations("CreativeAssetsWorkspace");
  const translationsRef = useRef(t);
  const [activeTab, setActiveTab] = useState<"studio" | "library">("studio");
  const [assets, setAssets] = useState<CreativeAsset[]>([]);
  const [wanAvatarAvailable, setWanAvatarAvailable] =
    useState(wanAvatarConfigured);
  const [wanMorphAvailable, setWanMorphAvailable] =
    useState(wanMorphConfigured);
  const [happyHorseAvailable, setHappyHorseAvailable] =
    useState(happyHorseConfigured);
  const [alibabaImageAvailable, setAlibabaImageAvailable] = useState(
    alibabaImageConfigured
  );
  const [generationAvailable, setGenerationAvailable] =
    useState(higgsfieldConfigured);
  const [generationProviderState, setGenerationProviderState] = useState<
    "higgsfield" | "google" | null
  >(generationProvider);
  const [generationDisabledReason, setGenerationDisabledReason] = useState<
    "source_required" | "server_unconfigured" | null
  >(higgsfieldDisabledReason);
  const [elevenLabsAvailable, setElevenLabsAvailable] =
    useState(elevenLabsConfigured);
  const [airiCreativeDrafts] = useState<AiriCreativeAssetDraft[]>(() =>
    openAiriAssetDraftOnMount
      ? readAiriCreativeAssetDraftsFromStorage(workspaceId)
      : []
  );
  const initialAiriCreativeDraft = airiCreativeDrafts[0] || null;
  const initialCanvaCreativeDraft =
    airiCreativeDrafts.find(draft => draft.kind === "canva_design") || null;
  const [activeAiriDraftId, setActiveAiriDraftId] = useState<string>(
    () => initialAiriCreativeDraft?.id || ""
  );
  const [studioDraft, setStudioDraft] = useState<StudioComposerDraft>(() => ({
    skill: initialAiriCreativeDraft
      ? draftGenerationTab(initialAiriCreativeDraft)
      : "image",
    prompt: initialAiriCreativeDraft?.prompt ?? "",
  }));
  const [canvaTemplateQuery, setCanvaTemplateQuery] = useState(
    () => initialCanvaCreativeDraft?.canvaQuery || DEFAULT_CANVA_TEMPLATE_QUERY
  );
  const [sourceImageAssets, setSourceImageAssets] = useState<CreativeAsset[]>(
    []
  );
  const [sourceMediaAssets, setSourceMediaAssets] = useState<CreativeAsset[]>(
    []
  );
  const [isLoadingSourceImageAssets, setIsLoadingSourceImageAssets] =
    useState(true);
  const [sourceImageError, setSourceImageError] = useState(false);
  const [isLoadingSourceMediaAssets, setIsLoadingSourceMediaAssets] =
    useState(true);
  const [sourceMediaError, setSourceMediaError] = useState(false);
  const [trackingAssetIds, setTrackingAssetIds] = useState<string[]>([]);
  const [greenScreenSourceAssetIds, setGreenScreenSourceAssetIds] = useState<
    string[]
  >([]);
  const [kindFilter, setKindFilter] = useState<AssetKindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<AssetStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [libraryError, setLibraryError] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [isGeneratingElevenLabs, setIsGeneratingElevenLabs] = useState(false);
  const [isGeneratingAvatar, setIsGeneratingAvatar] = useState(false);
  const [wanAvatarMode, setWanAvatarMode] =
    useState<WanAvatarMode>("image_script");
  const [avatarImageAssetId, setAvatarImageAssetId] = useState("");
  const [avatarAudioAssetId, setAvatarAudioAssetId] = useState("");
  const [avatarResolution, setAvatarResolution] = useState<"720P" | "1080P">(
    "1080P"
  );
  const [retryingAssetIds, setRetryingAssetIds] = useState<string[]>([]);
  const [duplicateChargeRetryAsset, setDuplicateChargeRetryAsset] =
    useState<CreativeAsset | null>(null);
  const [editingAssetIds, setEditingAssetIds] = useState<string[]>([]);
  const [deletingAssetIds, setDeletingAssetIds] = useState<string[]>([]);
  const [bannerAspectRatio, setBannerAspectRatio] =
    useState<StudioBannerAspectRatio>("16:9");
  const [videoSourceAssetId, setVideoSourceAssetId] = useState("");
  const [characterReferenceAssetIds, setCharacterReferenceAssetIds] = useState<
    string[]
  >([]);
  const [characterRatio, setCharacterRatio] =
    useState<StudioCharacterRatio>("9:16");
  const [isGeneratingCharacter, setIsGeneratingCharacter] = useState(false);
  const [morphFirstFrameAssetId, setMorphFirstFrameAssetId] = useState("");
  const [morphLastFrameAssetId, setMorphLastFrameAssetId] = useState("");
  const [isGeneratingMorph, setIsGeneratingMorph] = useState(false);
  const [elevenLabsMode, setElevenLabsMode] = useState<ElevenLabsMode>(() =>
    initialAiriCreativeDraft?.kind === "audio_asset" &&
    initialAiriCreativeDraft.mode === "sound_effect"
      ? "sound_effect"
      : "text_to_speech"
  );
  const [elevenLabsSourceAssetId, setElevenLabsSourceAssetId] = useState("");
  const [elevenLabsTargetLanguage, setElevenLabsTargetLanguage] =
    useState("es");
  const [durationBySkill, setDurationBySkill] = useState<
    Record<StudioDurationSkill, string>
  >({
    video: generationProvider === "google" && !happyHorseConfigured ? "6" : "5",
    character: "5",
    morph: "5",
    audio: "5",
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sourceImageInputRef = useRef<HTMLInputElement | null>(null);
  const avatarImageInputRef = useRef<HTMLInputElement | null>(null);
  const characterImageInputRef = useRef<HTMLInputElement | null>(null);
  const morphImageInputRef = useRef<HTMLInputElement | null>(null);
  const libraryRequestIdRef = useRef(0);
  const sourceImageRequestIdRef = useRef(0);
  const sourceMediaRequestIdRef = useRef(0);
  const videoIdempotencyKeysRef = useRef(new Map<string, string>());
  const workspaceEpochRef = useRef<WorkspaceEpochToken>({
    workspaceId,
    active: true,
  });
  const renderWorkspaceEpoch = workspaceEpochRef.current;
  const isCurrentWorkspaceEpoch = useCallback(
    (token: WorkspaceEpochToken) =>
      workspaceEpochRef.current === token && token.active,
    []
  );

  useLayoutEffect(() => {
    renderWorkspaceEpoch.active = true;
    return () => {
      renderWorkspaceEpoch.active = false;
    };
  }, [renderWorkspaceEpoch]);

  useLayoutEffect(() => {
    translationsRef.current = t;
  }, [t]);

  const loadAssets = useCallback(async () => {
    const workspaceEpoch = renderWorkspaceEpoch;
    const requestId = ++libraryRequestIdRef.current;
    setIsLoading(true);
    setLibraryError(false);
    try {
      const params = new URLSearchParams();
      if (kindFilter !== "all") params.set("kind", kindFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const payload = await readJsonResponse<AssetsPayload>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/assets?${params.toString()}`,
          { cache: "no-store" }
        )
      );
      if (
        requestId !== libraryRequestIdRef.current ||
        !isCurrentWorkspaceEpoch(workspaceEpoch)
      ) {
        return;
      }
      const nextAssets = payload.assets || [];
      setAssets(nextAssets);
      setGreenScreenSourceAssetIds(
        mergeGreenScreenSourceAssetIds(
          payload.greenScreenSourceAssetIds || [],
          collectGreenScreenSourceAssetIds(nextAssets)
        )
      );
      if (typeof payload.higgsfieldConfigured === "boolean") {
        setGenerationAvailable(payload.higgsfieldConfigured);
      }
      if ("generationProvider" in payload) {
        setGenerationProviderState(payload.generationProvider || null);
      }
      if ("higgsfieldDisabledReason" in payload) {
        setGenerationDisabledReason(payload.higgsfieldDisabledReason || null);
      }
      if (typeof payload.elevenLabsConfigured === "boolean") {
        setElevenLabsAvailable(payload.elevenLabsConfigured);
      }
      setTrackingAssetIds(current => mergeTrackingIds(current, nextAssets));
    } catch {
      if (
        requestId !== libraryRequestIdRef.current ||
        !isCurrentWorkspaceEpoch(workspaceEpoch)
      ) {
        return;
      }
      setLibraryError(true);
    } finally {
      if (
        requestId === libraryRequestIdRef.current &&
        isCurrentWorkspaceEpoch(workspaceEpoch)
      ) {
        setIsLoading(false);
      }
    }
  }, [
    isCurrentWorkspaceEpoch,
    kindFilter,
    renderWorkspaceEpoch,
    statusFilter,
    workspaceId,
  ]);

  const loadSourceImageAssets = useCallback(async () => {
    const workspaceEpoch = renderWorkspaceEpoch;
    const requestId = ++sourceImageRequestIdRef.current;
    setIsLoadingSourceImageAssets(true);
    setSourceImageError(false);
    try {
      const params = new URLSearchParams({
        kind: "image",
        status: "complete",
        limit: "80",
        surface: "picker",
      });
      const payload = await readJsonResponse<{ assets?: CreativeAsset[] }>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/assets?${params.toString()}`,
          { cache: "no-store" }
        )
      );
      if (
        requestId !== sourceImageRequestIdRef.current ||
        !isCurrentWorkspaceEpoch(workspaceEpoch)
      ) {
        return;
      }
      setSourceImageAssets(payload.assets || []);
    } catch {
      if (
        requestId !== sourceImageRequestIdRef.current ||
        !isCurrentWorkspaceEpoch(workspaceEpoch)
      ) {
        return;
      }
      setSourceImageError(true);
    } finally {
      if (
        requestId === sourceImageRequestIdRef.current &&
        isCurrentWorkspaceEpoch(workspaceEpoch)
      ) {
        setIsLoadingSourceImageAssets(false);
      }
    }
  }, [isCurrentWorkspaceEpoch, renderWorkspaceEpoch, workspaceId]);

  const loadSourceMediaAssets = useCallback(async () => {
    const workspaceEpoch = renderWorkspaceEpoch;
    const requestId = ++sourceMediaRequestIdRef.current;
    setIsLoadingSourceMediaAssets(true);
    setSourceMediaError(false);
    try {
      const fetchSourceMedia = async (kind: "audio" | "video") => {
        const params = new URLSearchParams({
          kind,
          status: "complete",
          limit: "100",
          surface: "picker",
        });
        return readJsonResponse<{ assets?: CreativeAsset[] }>(
          await fetch(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/assets?${params.toString()}`,
            { cache: "no-store" }
          )
        );
      };
      const results = await Promise.allSettled([
        fetchSourceMedia("audio"),
        fetchSourceMedia("video"),
      ]);
      if (
        requestId !== sourceMediaRequestIdRef.current ||
        !isCurrentWorkspaceEpoch(workspaceEpoch)
      ) {
        return;
      }
      const nextAssetsForKind = (
        result: PromiseSettledResult<{ assets?: CreativeAsset[] }>,
        kind: "audio" | "video",
        current: CreativeAsset[]
      ) => {
        if (result.status === "rejected") {
          return current.filter(asset => asset.kind === kind);
        }
        return (result.value.assets || []).filter(
          asset =>
            asset.kind === kind && asset.status === "complete" && asset.url
        );
      };
      setSourceMediaAssets(current => {
        const mediaById = new Map<string, CreativeAsset>();
        for (const asset of [
          ...nextAssetsForKind(results[0], "audio", current),
          ...nextAssetsForKind(results[1], "video", current),
        ]) {
          mediaById.set(asset.id, asset);
        }
        return Array.from(mediaById.values());
      });
      setSourceMediaError(results.some(result => result.status === "rejected"));
    } catch {
      if (
        requestId !== sourceMediaRequestIdRef.current ||
        !isCurrentWorkspaceEpoch(workspaceEpoch)
      ) {
        return;
      }
      setSourceMediaError(true);
    } finally {
      if (
        requestId === sourceMediaRequestIdRef.current &&
        isCurrentWorkspaceEpoch(workspaceEpoch)
      ) {
        setIsLoadingSourceMediaAssets(false);
      }
    }
  }, [isCurrentWorkspaceEpoch, renderWorkspaceEpoch, workspaceId]);

  useEffect(() => {
    void loadAssets();
    return () => {
      libraryRequestIdRef.current += 1;
    };
  }, [loadAssets]);

  useEffect(() => {
    void loadSourceImageAssets();
    void loadSourceMediaAssets();
    return () => {
      sourceImageRequestIdRef.current += 1;
      sourceMediaRequestIdRef.current += 1;
    };
  }, [loadSourceImageAssets, loadSourceMediaAssets]);

  const { data: canvaTemplatesPayload } = useSWR<
    CanvaTemplatesPayload,
    Error,
    CanvaTemplatesKey
  >(["canva-templates", workspaceId, canvaTemplateQuery], fetchCanvaTemplates, {
    dedupingInterval: 0,
    revalidateOnFocus: false,
    revalidateOnMount: true,
  });
  const canvaTemplates =
    canvaTemplatesPayload?.status === "ok"
      ? (canvaTemplatesPayload.items ?? [])
      : [];
  const canvaConnectUrl = canvaTemplatesPayload?.connectUrl ?? null;

  const applyAiriCreativeDraft = useCallback(
    (draft: AiriCreativeAssetDraft) => {
      setActiveAiriDraftId(draft.id);

      if (draft.kind === "canva_design") {
        setCanvaTemplateQuery(draft.canvaQuery || DEFAULT_CANVA_TEMPLATE_QUERY);
        return;
      }

      if (draft.kind === "visual_asset") {
        const nextTab = draftGenerationTab(draft);
        setStudioDraft(
          selectStudioSkill({
            draft: { skill: nextTab, prompt: draft.prompt },
            nextSkill: nextTab,
            mention: null,
          }).draft
        );
        return;
      }

      setStudioDraft(
        selectStudioSkill({
          draft: { skill: "audio", prompt: draft.prompt },
          nextSkill: "audio",
          mention: null,
        }).draft
      );
      setElevenLabsMode(
        draft.mode === "sound_effect" ? "sound_effect" : "text_to_speech"
      );
    },
    []
  );

  useEffect(() => {
    if (trackingAssetIds.length === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void (async () => {
        const workspaceEpoch = renderWorkspaceEpoch;
        if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
        try {
          const polledAssets = await fetchCreativeAssetStatuses<CreativeAsset>({
            workspaceId,
            assetIds: trackingAssetIds,
            signal: controller.signal,
          });
          if (cancelled || !isCurrentWorkspaceEpoch(workspaceEpoch)) return;
          const received = new Map(
            polledAssets.map(asset => [asset.id, asset])
          );
          const nextTracking: string[] = [];
          for (const trackingAssetId of trackingAssetIds) {
            const asset = received.get(trackingAssetId);
            if (!asset) {
              nextTracking.push(trackingAssetId);
              continue;
            }
            setAssets(current => mergeAsset(current, asset));
            if (isAiriGreenScreenAsset(asset)) {
              setGreenScreenSourceAssetIds(current =>
                mergeGreenScreenSourceAssetIds(current, [asset.sourceAssetId])
              );
            }
            if (asset.kind === "image" && asset.status === "complete") {
              setSourceImageAssets(current => mergeAsset(current, asset));
            }
            if (
              (asset.kind === "audio" || asset.kind === "video") &&
              asset.status === "complete"
            ) {
              setSourceMediaAssets(current => mergeAsset(current, asset));
            }
            if (asset.status === "queued" || asset.status === "in_progress") {
              nextTracking.push(asset.id);
            }
          }
          setTrackingAssetIds(Array.from(new Set(nextTracking)));
        } catch {
          if (cancelled || !isCurrentWorkspaceEpoch(workspaceEpoch)) return;
          setTrackingAssetIds([...trackingAssetIds]);
        }
      })();
    }, 4000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [
    isCurrentWorkspaceEpoch,
    renderWorkspaceEpoch,
    trackingAssetIds,
    workspaceId,
  ]);

  const imageAssets = useMemo(
    () =>
      sourceImageAssets.filter(
        asset =>
          asset.kind === "image" && asset.status === "complete" && asset.url
      ),
    [sourceImageAssets]
  );

  const audioAssets = useMemo(
    () =>
      sourceMediaAssets.filter(
        asset =>
          asset.kind === "audio" && asset.status === "complete" && asset.url
      ),
    [sourceMediaAssets]
  );

  useEffect(() => {
    setWanAvatarAvailable(wanAvatarConfigured);
  }, [wanAvatarConfigured]);

  useEffect(() => {
    setWanMorphAvailable(wanMorphConfigured);
  }, [wanMorphConfigured]);

  useEffect(() => {
    setHappyHorseAvailable(happyHorseConfigured);
  }, [happyHorseConfigured]);

  useEffect(() => {
    setAlibabaImageAvailable(alibabaImageConfigured);
  }, [alibabaImageConfigured]);

  const activeAiriDraft = useMemo(
    () =>
      airiCreativeDrafts.find(draft => draft.id === activeAiriDraftId) ||
      airiCreativeDrafts[0] ||
      null,
    [activeAiriDraftId, airiCreativeDrafts]
  );

  const greenScreenSourceAssetIdSet = useMemo(
    () =>
      new Set(
        mergeGreenScreenSourceAssetIds(
          greenScreenSourceAssetIds,
          collectGreenScreenSourceAssetIds(assets)
        )
      ),
    [assets, greenScreenSourceAssetIds]
  );

  const visibleAssets = useMemo(
    () => assets.filter(asset => assetMatchesSearch(asset, searchQuery)),
    [assets, searchQuery]
  );

  const assetSummary = useMemo(
    () => ({
      total: assets.length,
    }),
    [assets]
  );

  const handleUploadFiles = async (
    files: FileList | File[] | null,
    options: UploadOptions = {}
  ) => {
    const [file] = Array.from(files || []);
    if (!file) return;
    if (options.imageOnly && !isImageUpload(file)) {
      toast.error(t("sourceImageOnly"));
      return;
    }
    const workspaceEpoch = renderWorkspaceEpoch;
    setIsUploading(true);
    try {
      const uploadEndpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/upload`;
      const initiated =
        await readJsonResponse<CreativeAssetUploadInitiatePayload>(
          await fetch(uploadEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "initiate",
              assetId: crypto.randomUUID().replaceAll("-", "").slice(0, 24),
              fileName: file.name,
              mimeType: file.type,
              fileSize: file.size,
            }),
          })
        );
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      const upload = initiated.upload;
      if (
        upload?.provider !== "gcs" ||
        !upload.bucket ||
        !upload.path ||
        !upload.uploadUrl
      ) {
        throw new Error("Upload target was not created");
      }

      await uploadGcsResumableAsset({ file, upload });
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;

      const payload = await readJsonResponse<{ asset?: CreativeAsset }>(
        await fetch(uploadEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "complete",
            provider: upload.provider,
            assetId: upload.assetId,
            bucket: upload.bucket,
            path: upload.path,
            kind: upload.kind,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            fileSize: upload.fileSize,
          }),
        })
      );
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      if (payload.asset) {
        const asset = payload.asset as CreativeAsset;
        setAssets(current => mergeAsset(current, asset));
        if (asset.kind === "image" && asset.status === "complete") {
          setSourceImageAssets(current => mergeAsset(current, asset));
          if (options.selectForVideo) {
            setVideoSourceAssetId(asset.id);
          }
          if (options.selectForAvatar) {
            setAvatarImageAssetId(asset.id);
          }
          if (options.appendAsCharacterReference) {
            setCharacterReferenceAssetIds(current => {
              if (current.includes(asset.id)) return current;
              if (current.length >= STUDIO_CHARACTER_REFERENCE_MAX) {
                return current;
              }
              return [...current, asset.id];
            });
          }
          if (options.selectForMorphFirst) {
            setMorphFirstFrameAssetId(asset.id);
          }
          if (options.selectForMorphLast) {
            setMorphLastFrameAssetId(asset.id);
          }
        }
        if (
          (asset.kind === "audio" || asset.kind === "video") &&
          asset.status === "complete"
        ) {
          setSourceMediaAssets(current => mergeAsset(current, asset));
        }
      }
      toast.success(
        options.appendAsCharacterReference
          ? t("characterReferenceUploaded")
          : options.selectForVideo
            ? t("sourceImageUploaded")
            : options.selectForAvatar
              ? t("avatarPortraitUploaded")
              : t("assetUploaded")
      );
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(formatCreativeAssetUploadError(error, t));
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
        if (sourceImageInputRef.current) sourceImageInputRef.current.value = "";
        if (avatarImageInputRef.current) avatarImageInputRef.current.value = "";
        if (characterImageInputRef.current) {
          characterImageInputRef.current.value = "";
        }
        if (morphImageInputRef.current) morphImageInputRef.current.value = "";
      }
    }
  };

  const clearSubmittedStudioPrompt = (submittedDraft: StudioComposerDraft) => {
    setStudioDraft(current =>
      current.skill === submittedDraft.skill &&
      current.prompt === submittedDraft.prompt
        ? { ...current, prompt: "" }
        : current
    );
  };

  const handleGenerateImage = async (options: {
    aspectRatio?: string;
    skill: "image" | "banner";
    successKey?: string;
  }) => {
    if (studioDraft.skill !== options.skill) return;
    const submittedDraft = studioDraft;
    const prompt = stripStudioSkillTokens(studioDraft.prompt);
    if (!prompt) return;
    const workspaceEpoch = renderWorkspaceEpoch;
    setIsGeneratingImage(true);
    try {
      const useAlibaba = alibabaImageAvailable;
      const endpoint = useAlibaba
        ? `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/alibaba`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/higgsfield`;
      const payload = await readJsonResponse<
        AssetsPayload & { asset?: CreativeAsset }
      >(
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "text_to_image",
            prompt,
            aspectRatio: options.aspectRatio || "9:16",
            skill: options.skill,
          }),
        })
      );
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      if (payload.asset) {
        const asset = payload.asset as CreativeAsset;
        setAssets(current => mergeAsset(current, asset));
        setTrackingAssetIds(current => mergeTrackingIds(current, [asset]));
      }
      if ("generationProvider" in payload) {
        setGenerationProviderState(payload.generationProvider || null);
      }
      clearSubmittedStudioPrompt(submittedDraft);
      toast.success(t(options.successKey || "imageGenerationQueued"));
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(
        error instanceof Error ? error.message : "Failed to generate image"
      );
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setIsGeneratingImage(false);
      }
    }
  };

  const handleGenerateBanner = async () => {
    await handleGenerateImage({
      aspectRatio: bannerAspectRatio,
      skill: "banner",
      successKey: "bannerGenerationQueued",
    });
  };

  // One Idempotency-Key per endpoint and body, retired only once the server
  // returns a queued asset.
  const postIdempotentVideoGeneration = async (
    endpoint: string,
    body: unknown
  ) => {
    const serializedBody = JSON.stringify(body);
    const idempotencyKey = getOrCreateVideoGenerationIdempotencyKey(
      videoIdempotencyKeysRef.current,
      endpoint,
      serializedBody
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: serializedBody,
    });
    const payload = await readJsonResponse<
      AssetsPayload & { asset?: CreativeAsset }
    >(response);
    const asset = requireQueuedAsset(payload);
    retireVideoGenerationIdempotencyKey(
      videoIdempotencyKeysRef.current,
      endpoint,
      serializedBody
    );
    return { payload, asset };
  };

  const withRetryingAsset = async (
    asset: CreativeAsset,
    run: (workspaceEpoch: WorkspaceEpochToken) => Promise<void>
  ) => {
    const workspaceEpoch = renderWorkspaceEpoch;
    setRetryingAssetIds(current => Array.from(new Set([...current, asset.id])));
    try {
      await run(workspaceEpoch);
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(
        error instanceof Error ? error.message : t("retryUnavailable")
      );
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setRetryingAssetIds(current => current.filter(id => id !== asset.id));
      }
    }
  };

  const handleGenerateVideo = async () => {
    if (studioDraft.skill !== "video") return;
    const submittedDraft = studioDraft;
    const prompt = stripStudioSkillTokens(studioDraft.prompt);
    if (!prompt) return;
    if (!happyHorseAvailable && !videoSourceAssetId) return;
    const duration =
      !happyHorseAvailable && generationProviderState === "google"
        ? compatibleGoogleVideoDuration(durationBySkill.video)
        : durationBySkill.video;
    const workspaceEpoch = renderWorkspaceEpoch;
    setIsGeneratingVideo(true);
    try {
      const useHappyHorse = happyHorseAvailable;
      const happyHorseMode = videoSourceAssetId
        ? "image_to_video"
        : "text_to_video";
      const endpoint = useHappyHorse
        ? `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/happyhorse`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/higgsfield`;
      const body = useHappyHorse
        ? {
            mode: happyHorseMode,
            prompt,
            sourceAssetId: videoSourceAssetId || undefined,
            duration: Number(duration) || 5,
            ratio: "9:16",
            resolution: "1080P",
            skill: "video",
          }
        : {
            mode: "image_to_video",
            prompt,
            sourceAssetId: videoSourceAssetId,
            duration: Number(duration) || 5,
            skill: "video",
          };
      const { payload, asset } = await postIdempotentVideoGeneration(
        endpoint,
        body
      );
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      setAssets(current => mergeAsset(current, asset));
      setTrackingAssetIds(current => mergeTrackingIds(current, [asset]));
      if ("generationProvider" in payload) {
        setGenerationProviderState(payload.generationProvider || null);
      }
      clearSubmittedStudioPrompt(submittedDraft);
      toast.success(t("videoGenerationQueued"));
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(
        error instanceof Error ? error.message : "Failed to generate video"
      );
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setIsGeneratingVideo(false);
      }
    }
  };

  const handleGenerateCharacter = async () => {
    if (studioDraft.skill !== "character") return;
    const submittedDraft = studioDraft;
    if (!happyHorseAvailable) return;
    const basePrompt = stripStudioSkillTokens(studioDraft.prompt);
    if (!basePrompt || characterReferenceAssetIds.length < 1) return;
    const duration = durationBySkill.character;
    const prompt = ensureCharacterImageTags(
      basePrompt,
      characterReferenceAssetIds.length
    );
    const workspaceEpoch = renderWorkspaceEpoch;
    setIsGeneratingCharacter(true);
    try {
      const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/happyhorse`;
      const body = {
        mode: "reference_to_video",
        prompt,
        referenceAssetIds: characterReferenceAssetIds,
        duration: Number(duration) || 5,
        ratio: characterRatio,
        resolution: "1080P",
        skill: "character",
      };
      const { asset } = await postIdempotentVideoGeneration(endpoint, body);
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      setAssets(current => mergeAsset(current, asset));
      setTrackingAssetIds(current => mergeTrackingIds(current, [asset]));
      clearSubmittedStudioPrompt(submittedDraft);
      toast.success(t("characterGenerationQueued"));
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(
        error instanceof Error ? error.message : t("characterGenerationFailed")
      );
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setIsGeneratingCharacter(false);
      }
    }
  };

  const handleGenerateMorph = async () => {
    if (studioDraft.skill !== "morph") return;
    const submittedDraft = studioDraft;
    if (!wanMorphAvailable) return;
    const prompt = stripStudioSkillTokens(studioDraft.prompt);
    if (
      !prompt ||
      !morphFirstFrameAssetId ||
      !morphLastFrameAssetId ||
      morphFirstFrameAssetId === morphLastFrameAssetId
    ) {
      return;
    }
    const duration = durationBySkill.morph;
    const workspaceEpoch = renderWorkspaceEpoch;
    setIsGeneratingMorph(true);
    try {
      const payload = await readJsonResponse<
        AssetsPayload & { asset?: CreativeAsset }
      >(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/wan-morph`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt,
              firstFrameAssetId: morphFirstFrameAssetId,
              lastFrameAssetId: morphLastFrameAssetId,
              duration: Number(duration) || 5,
              resolution: "1080P",
              skill: "morph",
            }),
          }
        )
      );
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      if (payload.asset) {
        const asset = payload.asset as CreativeAsset;
        setAssets(current => mergeAsset(current, asset));
        setTrackingAssetIds(current => mergeTrackingIds(current, [asset]));
      }
      clearSubmittedStudioPrompt(submittedDraft);
      toast.success(t("morphGenerationQueued"));
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(
        error instanceof Error ? error.message : t("morphGenerationFailed")
      );
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setIsGeneratingMorph(false);
      }
    }
  };

  const handleGenerateElevenLabs = async () => {
    if (studioDraft.skill !== "audio") return;
    const submittedDraft = studioDraft;
    const prompt = stripStudioSkillTokens(studioDraft.prompt);
    const usesText =
      elevenLabsMode === "text_to_speech" || elevenLabsMode === "sound_effect";
    if ((usesText && !prompt) || (!usesText && !elevenLabsSourceAssetId))
      return;
    const duration = durationBySkill.audio;
    const workspaceEpoch = renderWorkspaceEpoch;
    setIsGeneratingElevenLabs(true);
    try {
      const requestBody: Record<string, unknown> = {
        mode: elevenLabsMode,
        skill: "audio",
      };
      if (
        elevenLabsMode === "text_to_speech" ||
        elevenLabsMode === "sound_effect"
      ) {
        requestBody[elevenLabsMode === "text_to_speech" ? "text" : "prompt"] =
          prompt;
        requestBody.duration = Number(duration) || undefined;
      } else {
        requestBody.sourceAssetId = elevenLabsSourceAssetId;
        if (elevenLabsMode === "dub") {
          requestBody.targetLanguage = elevenLabsTargetLanguage.trim() || "es";
        }
      }

      const payload = await readJsonResponse<
        AssetsPayload & { asset?: CreativeAsset }
      >(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/elevenlabs`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          }
        )
      );
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      if (payload.asset) {
        const nextAsset = payload.asset as CreativeAsset;
        setAssets(current => mergeAsset(current, nextAsset));
        setTrackingAssetIds(current => mergeTrackingIds(current, [nextAsset]));
        if (isAiriGreenScreenAsset(nextAsset)) {
          setGreenScreenSourceAssetIds(current =>
            mergeGreenScreenSourceAssetIds(current, [nextAsset.sourceAssetId])
          );
        }
        if (
          (nextAsset.kind === "audio" || nextAsset.kind === "video") &&
          nextAsset.status === "complete"
        ) {
          setSourceMediaAssets(current => mergeAsset(current, nextAsset));
        }
      }
      if (typeof payload.elevenLabsConfigured === "boolean") {
        setElevenLabsAvailable(payload.elevenLabsConfigured);
      }
      clearSubmittedStudioPrompt(submittedDraft);
      toast.success(t("elevenLabsGenerationQueued"));
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(
        error instanceof Error ? error.message : t("elevenLabsGenerationFailed")
      );
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setIsGeneratingElevenLabs(false);
      }
    }
  };

  const handleGenerateAvatar = async () => {
    if (studioDraft.skill !== "avatar") return;
    const submittedDraft = studioDraft;
    const script = stripStudioSkillTokens(studioDraft.prompt);
    if (!avatarImageAssetId) return;
    if (wanAvatarMode === "image_audio" && !avatarAudioAssetId) return;
    if (wanAvatarMode === "image_script" && script.length < 3) return;

    const workspaceEpoch = renderWorkspaceEpoch;
    setIsGeneratingAvatar(true);
    try {
      const requestBody: Record<string, unknown> = {
        mode: wanAvatarMode,
        imageAssetId: avatarImageAssetId,
        resolution: avatarResolution,
        skill: "avatar",
      };
      if (wanAvatarMode === "image_audio") {
        requestBody.audioAssetId = avatarAudioAssetId;
      } else {
        requestBody.script = script;
      }

      const payload = await readJsonResponse<{ asset?: CreativeAsset }>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/wan`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          }
        )
      );
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      if (payload.asset) {
        const asset = payload.asset as CreativeAsset;
        setAssets(current => mergeAsset(current, asset));
        setTrackingAssetIds(current => mergeTrackingIds(current, [asset]));
      }
      clearSubmittedStudioPrompt(submittedDraft);
      toast.success(t("avatarGenerationQueued"));
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(
        error instanceof Error ? error.message : t("avatarGenerationFailed")
      );
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setIsGeneratingAvatar(false);
      }
    }
  };

  const deleteAssetById = async (assetId: string) => {
    await readJsonResponse<{ success?: boolean }>(
      await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`,
        { method: "DELETE" }
      )
    );
  };

  const queueGreenScreenEdit = async (
    sourceAssetId: string,
    retryAssetId?: string
  ) => {
    return readJsonResponse<AssetsPayload & { asset?: CreativeAsset }>(
      await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(sourceAssetId)}/edits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "green_screen",
            ...(retryAssetId ? { retryAssetId } : {}),
          }),
        }
      )
    );
  };

  const handleMakeGreenScreen = async (asset: CreativeAsset) => {
    if (
      asset.kind !== "video" ||
      asset.status !== "complete" ||
      !asset.url ||
      asset.source === "edited" ||
      greenScreenSourceAssetIdSet.has(asset.id)
    ) {
      return;
    }

    const workspaceEpoch = renderWorkspaceEpoch;
    setEditingAssetIds(current => Array.from(new Set([...current, asset.id])));
    try {
      const payload = await queueGreenScreenEdit(asset.id);
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      if (payload.asset) {
        const nextAsset = payload.asset as CreativeAsset;
        setAssets(current => mergeAsset(current, nextAsset));
        setTrackingAssetIds(current => mergeTrackingIds(current, [nextAsset]));
        if (isAiriGreenScreenAsset(nextAsset)) {
          setGreenScreenSourceAssetIds(current =>
            mergeGreenScreenSourceAssetIds(current, [nextAsset.sourceAssetId])
          );
        }
      }
      if (payload.duplicate) {
        toast.error(t("greenScreenAlreadyExistsTooltip"));
      } else {
        toast.success(t("greenScreenQueued"));
      }
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(
        error instanceof Error ? error.message : t("greenScreenFailed")
      );
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setEditingAssetIds(current => current.filter(id => id !== asset.id));
      }
    }
  };

  const retryContractVideo = async (
    asset: CreativeAsset,
    acknowledgePossibleDuplicateCharge: boolean
  ) => {
    const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(asset.id)}/retry`;
    const requestBody = acknowledgePossibleDuplicateCharge
      ? { acknowledgePossibleDuplicateCharge: true }
      : {};
    await withRetryingAsset(asset, async workspaceEpoch => {
      const { asset: child } = await postIdempotentVideoGeneration(
        endpoint,
        requestBody
      );
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      setAssets(current => mergeAsset(current, child));
      setTrackingAssetIds(current => mergeTrackingIds(current, [child]));
      toast.success(t("retryQueued"));
    });
  };

  const handleRetryAsset = async (asset: CreativeAsset) => {
    if (asset.generation?.contractVersion === 1) {
      const requiresDuplicateChargeAcknowledgement =
        asset.generation.requiresDuplicateChargeAcknowledgement;
      if (asset.status !== "failed" || asset.generation.canRetry !== true) {
        toast.error(t("retryUnavailable"));
        return;
      }
      if (requiresDuplicateChargeAcknowledgement) {
        setDuplicateChargeRetryAsset(asset);
        return;
      }
      await retryContractVideo(asset, false);
      return;
    }

    const prompt = asset.prompt?.trim() || "";
    if (
      asset.status === "failed" &&
      isRetryableAiriGreenScreenAsset(asset) &&
      asset.sourceAssetId
    ) {
      const sourceAssetId = asset.sourceAssetId;
      await withRetryingAsset(asset, async workspaceEpoch => {
        const payload = await queueGreenScreenEdit(sourceAssetId, asset.id);
        if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
        if (payload.asset) {
          const nextAsset = payload.asset as CreativeAsset;
          await deleteAssetById(asset.id);
          if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
          setAssets(current => replaceAsset(current, asset.id, nextAsset));
          if (isAiriGreenScreenAsset(nextAsset)) {
            setGreenScreenSourceAssetIds(current =>
              mergeGreenScreenSourceAssetIds(current, [nextAsset.sourceAssetId])
            );
          }
          setTrackingAssetIds(current =>
            mergeTrackingIds(
              current.filter(id => id !== asset.id),
              [nextAsset]
            )
          );
        }
        toast.success(t("retryQueued"));
      });
      return;
    }

    if (
      asset.status !== "failed" ||
      (asset.source !== "higgsfield" &&
        asset.source !== "google" &&
        asset.source !== "alibaba") ||
      !prompt
    ) {
      toast.error(t("retryUnavailable"));
      return;
    }

    const requestBody: Record<string, unknown> = {
      mode: asset.kind === "video" ? "image_to_video" : "text_to_image",
      prompt,
      skill: asset.kind === "video" ? "video" : "image",
    };
    if (asset.kind === "video") {
      if (!asset.sourceAssetId) {
        toast.error(t("retryUnavailable"));
        return;
      }
      requestBody.sourceAssetId = asset.sourceAssetId;
    }

    const retryEndpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/higgsfield`;

    await withRetryingAsset(asset, async workspaceEpoch => {
      const payload = await readJsonResponse<
        AssetsPayload & { asset?: CreativeAsset }
      >(
        await fetch(retryEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        })
      );
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      if (payload.asset) {
        const nextAsset = payload.asset as CreativeAsset;
        await deleteAssetById(asset.id);
        if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
        setAssets(current => replaceAsset(current, asset.id, nextAsset));
        setTrackingAssetIds(current =>
          mergeTrackingIds(
            current.filter(id => id !== asset.id),
            [nextAsset]
          )
        );
      }
      if ("generationProvider" in payload) {
        setGenerationProviderState(payload.generationProvider || null);
      }
      toast.success(t("retryQueued"));
    });
  };

  const handleDeleteAsset = async (asset: CreativeAsset) => {
    if (asset.status === "queued" || asset.status === "in_progress") return;
    if (!window.confirm(t("deleteAssetConfirm"))) return;

    const workspaceEpoch = renderWorkspaceEpoch;
    setDeletingAssetIds(current => Array.from(new Set([...current, asset.id])));
    try {
      await deleteAssetById(asset.id);
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      setAssets(current =>
        current.filter(candidate => candidate.id !== asset.id)
      );
      setSourceImageAssets(current =>
        current.filter(candidate => candidate.id !== asset.id)
      );
      setSourceMediaAssets(current =>
        current.filter(candidate => candidate.id !== asset.id)
      );
      setTrackingAssetIds(current => current.filter(id => id !== asset.id));
      if (videoSourceAssetId === asset.id) setVideoSourceAssetId("");
      setCharacterReferenceAssetIds(current =>
        current.filter(id => id !== asset.id)
      );
      if (morphFirstFrameAssetId === asset.id) setMorphFirstFrameAssetId("");
      if (morphLastFrameAssetId === asset.id) setMorphLastFrameAssetId("");
      if (elevenLabsSourceAssetId === asset.id) setElevenLabsSourceAssetId("");
      if (isAiriGreenScreenAsset(asset)) {
        const sourceAssetId = asset.sourceAssetId.trim();
        const hasAnotherDerivative = assets.some(
          candidate =>
            candidate.id !== asset.id &&
            isAiriGreenScreenAsset(candidate) &&
            candidate.sourceAssetId.trim() === sourceAssetId
        );
        if (!hasAnotherDerivative) {
          setGreenScreenSourceAssetIds(current =>
            current.filter(id => id !== sourceAssetId)
          );
        }
      }
      toast.success(t("assetDeleted"));
    } catch (error) {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(error instanceof Error ? error.message : t("deleteFailed"));
    } finally {
      if (isCurrentWorkspaceEpoch(workspaceEpoch)) {
        setDeletingAssetIds(current => current.filter(id => id !== asset.id));
      }
    }
  };

  const handleUseImageForVideo = (asset: CreativeAsset) => {
    if (asset.kind !== "image" || asset.status !== "complete" || !asset.url) {
      return;
    }
    setSourceImageAssets(current => mergeAsset(current, asset));
    setVideoSourceAssetId(asset.id);
    setStudioDraft(
      current =>
        selectStudioSkill({
          draft: current,
          nextSkill: "video",
          mention: null,
        }).draft
    );
    toast.success(t("sourceImageSelected"));
  };

  const copyAssetUrl = async (asset: CreativeAsset) => {
    if (!asset.url) return;
    const workspaceEpoch = renderWorkspaceEpoch;
    try {
      await navigator.clipboard.writeText(asset.url);
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.success(t("assetUrlCopied"));
    } catch {
      if (!isCurrentWorkspaceEpoch(workspaceEpoch)) return;
      toast.error(t("assetUrlCopyFailed"));
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    if (isUploading) return;
    void handleUploadFiles(event.dataTransfer.files);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDragActive(true);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsDragActive(false);
  };

  const studioIsGenerating =
    studioDraft.skill === "image" || studioDraft.skill === "banner"
      ? isGeneratingImage
      : studioDraft.skill === "video"
        ? isGeneratingVideo
        : studioDraft.skill === "character"
          ? isGeneratingCharacter
          : studioDraft.skill === "morph"
            ? isGeneratingMorph
            : studioDraft.skill === "audio"
              ? isGeneratingElevenLabs
              : isGeneratingAvatar;

  const videoGenerationAvailable = generationAvailable || happyHorseAvailable;
  const imageGenerationAvailable = alibabaImageAvailable || generationAvailable;
  const skillAvailability: Record<StudioSkillId, boolean> = {
    image: imageGenerationAvailable,
    banner: imageGenerationAvailable,
    video: videoGenerationAvailable,
    character: happyHorseAvailable,
    morph: wanMorphAvailable,
    audio: elevenLabsAvailable,
    avatar: wanAvatarAvailable,
  };
  const durationSkill: StudioDurationSkill | null =
    studioDraft.skill === "video" ||
    studioDraft.skill === "character" ||
    studioDraft.skill === "morph" ||
    studioDraft.skill === "audio"
      ? studioDraft.skill
      : null;
  const videoDurationOptions =
    !happyHorseAvailable && generationProviderState === "google"
      ? GOOGLE_VIDEO_DURATION_OPTIONS
      : undefined;
  const currentDuration = durationSkill
    ? durationSkill === "video" && videoDurationOptions
      ? compatibleGoogleVideoDuration(durationBySkill[durationSkill])
      : durationBySkill[durationSkill]
    : "5";
  const currentDurationMax =
    studioDraft.skill === "video"
      ? happyHorseAvailable
        ? 15
        : 8
      : studioDraft.skill === "character" || studioDraft.skill === "morph"
        ? 15
        : studioDraft.skill === "audio"
          ? 30
          : undefined;
  const studioGenerationBlocker = resolveStudioGenerationBlocker({
    skill: studioDraft.skill,
    prompt: studioDraft.prompt,
    available: skillAvailability[studioDraft.skill],
    duration: currentDuration,
    durationMax: currentDurationMax,
    durationOptions:
      studioDraft.skill === "video" ? videoDurationOptions : undefined,
    // HappyHorse also supports text-to-video, so a source is optional in that mode.
    videoSourceAssetId: happyHorseAvailable
      ? videoSourceAssetId || "text-to-video"
      : videoSourceAssetId,
    characterReferenceCount: characterReferenceAssetIds.length,
    morphFirstFrameAssetId,
    morphLastFrameAssetId,
    elevenLabsMode,
    elevenLabsSourceAssetId,
    avatarImageAssetId,
    avatarAudioAssetId,
    wanAvatarMode,
    elevenLabsAvailable,
  });
  const showSourceImageStatus =
    studioDraft.skill === "video" ||
    studioDraft.skill === "character" ||
    studioDraft.skill === "morph" ||
    studioDraft.skill === "avatar";
  const showSourceMediaStatus =
    (studioDraft.skill === "audio" &&
      elevenLabsMode !== "text_to_speech" &&
      elevenLabsMode !== "sound_effect") ||
    (studioDraft.skill === "avatar" && wanAvatarMode === "image_audio");
  const studioGenerationBlockerText = studioGenerationBlocker
    ? t(STUDIO_GENERATION_BLOCKER_TRANSLATION_KEYS[studioGenerationBlocker])
    : null;
  const studioGenerateDisabled =
    studioIsGenerating || Boolean(studioGenerationBlocker);

  const studioGenerateLabel =
    studioDraft.skill === "image"
      ? t("generateImage")
      : studioDraft.skill === "banner"
        ? t("generateBanner")
        : studioDraft.skill === "video"
          ? t("generateVideo")
          : studioDraft.skill === "character"
            ? t("generateCharacter")
            : studioDraft.skill === "morph"
              ? t("generateMorph")
              : studioDraft.skill === "audio"
                ? t("elevenLabsGenerate")
                : t("generateAvatar");

  const handleStudioGenerate = () => {
    if (studioDraft.skill === "image") {
      void handleGenerateImage({ skill: "image" });
    } else if (studioDraft.skill === "banner") void handleGenerateBanner();
    else if (studioDraft.skill === "video") void handleGenerateVideo();
    else if (studioDraft.skill === "character") void handleGenerateCharacter();
    else if (studioDraft.skill === "morph") void handleGenerateMorph();
    else if (studioDraft.skill === "audio") void handleGenerateElevenLabs();
    else void handleGenerateAvatar();
  };

  const handleReferenceVideoAssetCreated = useCallback(
    (asset: CreativeAsset) => {
      if (
        asset.workspaceId !== workspaceId ||
        !isCurrentWorkspaceEpoch(renderWorkspaceEpoch)
      )
        return;
      setAssets(current => mergeAsset(current, asset));
      setTrackingAssetIds(current =>
        mergeTrackingIds(
          current.filter(id => id !== asset.id),
          [asset]
        )
      );
      if (asset.kind === "video" && asset.status === "complete") {
        setSourceMediaAssets(current => mergeAsset(current, asset));
      }
    },
    [isCurrentWorkspaceEpoch, renderWorkspaceEpoch, workspaceId]
  );

  const applyMarketingTemplate = useCallback(
    (template: MarketingTemplate) => {
      setActiveTab("studio");
      setStudioDraft(
        selectStudioSkill({
          draft: { skill: template.skill, prompt: template.prompt },
          nextSkill: template.skill,
          mention: null,
        }).draft
      );
      if (template.skill === "video") {
        if (template.durationSeconds) {
          setDurationBySkill(current => ({
            ...current,
            video: videoDurationOptions
              ? compatibleGoogleVideoDuration(String(template.durationSeconds))
              : String(template.durationSeconds),
          }));
        }
      } else if (template.skill === "audio") {
        if (template.audioMode) setElevenLabsMode(template.audioMode);
      } else {
        if (template.avatarMode) setWanAvatarMode(template.avatarMode);
        if (template.avatarResolution) {
          setAvatarResolution(template.avatarResolution);
        }
      }
      toast.success(
        translationsRef.current("marketingTemplatesApplied", {
          title: template.title,
        })
      );
    },
    [videoDurationOptions]
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background [scrollbar-gutter:stable]">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,video/3gpp,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,text/plain,text/vtt,.srt,application/json"
        onChange={event => void handleUploadFiles(event.target.files)}
      />

      <Tabs
        value={activeTab}
        onValueChange={value =>
          setActiveTab(value === "library" ? "library" : "studio")
        }
        className="flex h-full min-h-0 flex-col gap-0"
      >
        <div className="border-b px-4 lg:px-6">
          <TabsList className="h-auto w-full justify-start gap-1 rounded-none bg-transparent p-0">
            <TabsTrigger
              value="studio"
              data-testid="assets-tab-studio"
              className="h-auto flex-none rounded-none border-b-2 border-transparent px-3 py-2.5 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              <WandSparkles className="h-4 w-4" />
              {t("studioTab")}
            </TabsTrigger>
            <TabsTrigger
              value="library"
              data-testid="assets-tab-library"
              className="h-auto flex-none rounded-none border-b-2 border-transparent px-3 py-2.5 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              <ImageIcon className="h-4 w-4" />
              {t("libraryTab")}
            </TabsTrigger>
          </TabsList>
          <CreativeAssetStorageStatus workspaceId={workspaceId} />
        </div>

        <TabsContent
          value="studio"
          className="mt-0 min-h-0 flex-1 overflow-y-auto"
        >
          {activeAiriDraft ? (
            <section className="border-b bg-primary/5 px-4 py-3 lg:px-6">
              <div className="flex min-w-0 flex-wrap items-start gap-3">
                <div className="mt-0.5 rounded-md bg-primary/10 p-1.5 text-primary">
                  <WandSparkles className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold">
                      {t("airiDraftTitle")}
                    </h2>
                    <Badge variant="secondary" className="rounded-md">
                      {t("airiDraftProvider", {
                        provider: draftProviderLabel(activeAiriDraft),
                      })}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("airiDraftDescription")}
                  </div>
                  <div className="mt-1 text-sm font-medium">
                    {activeAiriDraft.title}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {activeAiriDraft.summary}
                  </p>
                  {airiCreativeDrafts.length > 1 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {airiCreativeDrafts.map(draft => {
                        const active = draft.id === activeAiriDraft.id;
                        return (
                          <Button
                            key={draft.id}
                            type="button"
                            variant={active ? "default" : "outline"}
                            size="sm"
                            className="h-7 rounded-md px-2 text-[11px]"
                            onClick={() => applyAiriCreativeDraft(draft)}
                          >
                            {active ? t("airiDraftActive") : t("airiDraftUse")}
                            <span className="ml-1 max-w-32 truncate">
                              {draft.title}
                            </span>
                          </Button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <CreativeAssetsStudioComposer
            t={t}
            draft={studioDraft}
            onDraftChange={setStudioDraft}
            skillAvailability={skillAvailability}
            generationBlockerText={studioGenerationBlockerText}
            onGenerate={handleStudioGenerate}
            isGenerating={studioIsGenerating}
            generateDisabled={studioGenerateDisabled}
            generateLabel={studioGenerateLabel}
            imageAssets={imageAssets}
            audioAssets={audioAssets}
            mediaAssets={sourceMediaAssets}
            videoSourceAssetId={videoSourceAssetId}
            onVideoSourceAssetIdChange={setVideoSourceAssetId}
            duration={currentDuration}
            onDurationChange={value => {
              if (!durationSkill) return;
              setDurationBySkill(current => ({
                ...current,
                [durationSkill]: value,
              }));
            }}
            elevenLabsMode={elevenLabsMode}
            onElevenLabsModeChange={setElevenLabsMode}
            elevenLabsSourceAssetId={elevenLabsSourceAssetId}
            onElevenLabsSourceAssetIdChange={setElevenLabsSourceAssetId}
            elevenLabsTargetLanguage={elevenLabsTargetLanguage}
            onElevenLabsTargetLanguageChange={setElevenLabsTargetLanguage}
            elevenLabsAvailable={elevenLabsAvailable}
            wanAvatarMode={wanAvatarMode}
            onWanAvatarModeChange={setWanAvatarMode}
            avatarImageAssetId={avatarImageAssetId}
            onAvatarImageAssetIdChange={setAvatarImageAssetId}
            avatarAudioAssetId={avatarAudioAssetId}
            onAvatarAudioAssetIdChange={setAvatarAudioAssetId}
            avatarResolution={avatarResolution}
            onAvatarResolutionChange={setAvatarResolution}
            wanAvatarAvailable={wanAvatarAvailable}
            generationAvailable={imageGenerationAvailable}
            videoGenerationAvailable={videoGenerationAvailable}
            videoDurationMax={happyHorseAvailable ? 15 : 8}
            videoDurationOptions={videoDurationOptions}
            videoSourceOptional={happyHorseAvailable}
            characterReferenceAssetIds={characterReferenceAssetIds}
            onCharacterReferenceAssetIdsChange={setCharacterReferenceAssetIds}
            characterRatio={characterRatio}
            onCharacterRatioChange={setCharacterRatio}
            characterAvailable={happyHorseAvailable}
            onUploadCharacterReference={files =>
              void handleUploadFiles(files, {
                imageOnly: true,
                appendAsCharacterReference: true,
              })
            }
            characterImageInputRef={characterImageInputRef}
            morphFirstFrameAssetId={morphFirstFrameAssetId}
            onMorphFirstFrameAssetIdChange={setMorphFirstFrameAssetId}
            morphLastFrameAssetId={morphLastFrameAssetId}
            onMorphLastFrameAssetIdChange={setMorphLastFrameAssetId}
            morphAvailable={wanMorphAvailable}
            onUploadMorphFirstFrame={files =>
              void handleUploadFiles(files, {
                imageOnly: true,
                selectForMorphFirst: true,
              })
            }
            onUploadMorphLastFrame={files =>
              void handleUploadFiles(files, {
                imageOnly: true,
                selectForMorphLast: true,
              })
            }
            morphImageInputRef={morphImageInputRef}
            morphPresets={MORPH_PROMPT_PRESETS}
            bannerAspectRatio={bannerAspectRatio}
            onBannerAspectRatioChange={setBannerAspectRatio}
            bannerPresets={BANNER_PROMPT_PRESETS}
            isUploading={isUploading}
            onUploadSourceImage={files =>
              void handleUploadFiles(files, {
                imageOnly: true,
                selectForVideo: true,
              })
            }
            sourceImageInputRef={sourceImageInputRef}
            onUploadAvatarPortrait={files =>
              void handleUploadFiles(files, {
                imageOnly: true,
                selectForAvatar: true,
              })
            }
            avatarImageInputRef={avatarImageInputRef}
            imagePresets={IMAGE_PROMPT_PRESETS}
            videoPresets={VIDEO_PROMPT_PRESETS}
            audioPresets={AUDIO_PROMPT_PRESETS}
            characterPresets={CHARACTER_PROMPT_PRESETS}
            footer={
              <div className="mt-4 space-y-3">
                {showSourceImageStatus && isLoadingSourceImageAssets ? (
                  <div
                    role="status"
                    className="flex items-center gap-2 rounded-xl border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("sourceImagesLoading")}
                  </div>
                ) : null}
                {showSourceImageStatus && sourceImageError ? (
                  <Alert
                    className="rounded-xl"
                    data-testid="source-images-error"
                  >
                    <AlertDescription className="flex items-center justify-between gap-3">
                      <span>{t("sourceImagesLoadFailed")}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 rounded-md px-2 text-[11px]"
                        onClick={() => void loadSourceImageAssets()}
                      >
                        {t("retry")}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {showSourceMediaStatus && isLoadingSourceMediaAssets ? (
                  <div
                    role="status"
                    className="flex items-center gap-2 rounded-xl border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("sourceMediaLoading")}
                  </div>
                ) : null}
                {showSourceMediaStatus && sourceMediaError ? (
                  <Alert
                    className="rounded-xl"
                    data-testid="source-media-error"
                  >
                    <AlertDescription className="flex items-center justify-between gap-3">
                      <span>{t("sourceMediaLoadFailed")}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 rounded-md px-2 text-[11px]"
                        onClick={() => void loadSourceMediaAssets()}
                      >
                        {t("retry")}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {!happyHorseAvailable && studioDraft.skill === "character" ? (
                  <Alert className="rounded-xl">
                    <AlertTitle>{t("characterUnavailableTitle")}</AlertTitle>
                    <AlertDescription>
                      {t("characterUnavailableDescription")}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {!wanMorphAvailable && studioDraft.skill === "morph" ? (
                  <Alert className="rounded-xl">
                    <AlertTitle>{t("morphUnavailableTitle")}</AlertTitle>
                    <AlertDescription>
                      {t("morphUnavailableDescription")}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {!elevenLabsAvailable && studioDraft.skill === "audio" ? (
                  <Alert className="rounded-xl">
                    <AlertTitle className="line-clamp-none">
                      {t("elevenLabsUnavailableTitle")}
                    </AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>{t("elevenLabsUnavailableDescription")}</p>
                      {elevenLabsIntegrationUrl ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 rounded-md px-2 text-[11px]"
                          asChild
                        >
                          <Link href={elevenLabsIntegrationUrl}>
                            {t("openElevenLabsIntegration")}
                          </Link>
                        </Button>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {!wanAvatarAvailable && studioDraft.skill === "avatar" ? (
                  <Alert className="rounded-xl">
                    <AlertTitle>{t("avatarUnavailableTitle")}</AlertTitle>
                    <AlertDescription>
                      {t("avatarUnavailableDescription")}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {(studioDraft.skill === "image" ||
                  studioDraft.skill === "banner" ||
                  studioDraft.skill === "video") &&
                !imageGenerationAvailable ? (
                  <GenerationUnavailableNotice
                    generationDisabledReason={generationDisabledReason}
                    higgsfieldIntegrationUrl={higgsfieldIntegrationUrl}
                    t={t}
                  />
                ) : null}
              </div>
            }
          />

          <div className="space-y-6 px-4 pb-6 lg:px-6">
            <CreativeAssetsMarketingTemplates
              workspaceId={workspaceId}
              t={t}
              onApply={applyMarketingTemplate}
              onAssetCreated={handleReferenceVideoAssetCreated}
            />

            {canvaTemplates.length === 0 && canvaConnectUrl ? (
              <Alert className="rounded-xl">
                <AlertTitle>{t("canvaTemplatesTitle")}</AlertTitle>
                <AlertDescription>{t("canvaConnectHint")}</AlertDescription>
              </Alert>
            ) : null}

            {canvaTemplates.length > 0 ? (
              <section className="space-y-3 rounded-xl border bg-card p-4">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold">
                      {t("canvaTemplatesTitle")}
                    </h2>
                    <div className="text-xs text-muted-foreground">
                      {t("canvaTemplatesDescription")}
                    </div>
                  </div>
                  <Badge variant="secondary" className="shrink-0 rounded-md">
                    {t("sourceCanva")}
                  </Badge>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {canvaTemplates.slice(0, 4).map(template => (
                    <article
                      key={template.id}
                      className="overflow-hidden rounded-xl border bg-card"
                    >
                      <div className="flex aspect-[4/3] items-center justify-center bg-muted/40">
                        {template.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={template.thumbnailUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <ImageIcon className="h-7 w-7 text-muted-foreground" />
                        )}
                      </div>
                      <div className="space-y-2 p-3">
                        <div className="line-clamp-2 min-h-9 text-sm font-medium">
                          {template.title}
                        </div>
                        {template.createUrl ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 w-full rounded-md"
                            asChild
                          >
                            <Link
                              href={template.createUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink className="mr-2 h-3.5 w-3.5" />
                              {t("openCanvaTemplate")}
                            </Link>
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent
          value="library"
          className="relative mt-0 min-h-0 flex-1 overflow-y-auto"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragActive ? (
            <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/85 text-sm font-medium shadow-lg backdrop-blur-sm">
              <Upload className="mr-2 h-4 w-4" />
              {t("dropToUpload")}
            </div>
          ) : null}
          <main className="p-4 lg:p-6">
            <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-md"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {isUploading ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-3.5 w-3.5" />
                )}
                {t("uploadAsset")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 rounded-md"
                onClick={() => void loadAssets()}
                aria-label={t("refreshAssets")}
              >
                <RefreshCcw
                  className={cn("h-4 w-4", isLoading ? "animate-spin" : "")}
                />
              </Button>
            </div>

            <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2 rounded-md border bg-background p-3 shadow-sm">
              <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.target.value)}
                  placeholder={t("searchAssets")}
                  className="h-8 rounded-md pl-8"
                />
              </div>
              <Select
                value={kindFilter}
                onValueChange={value => setKindFilter(value as AssetKindFilter)}
              >
                <SelectTrigger
                  aria-label={t("mediaKind")}
                  className="h-8 w-[130px] rounded-md"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("allMedia")}</SelectItem>
                  <SelectItem value="image">{t("images")}</SelectItem>
                  <SelectItem value="video">{t("videos")}</SelectItem>
                  <SelectItem value="audio">{t("audio")}</SelectItem>
                  <SelectItem value="text">{t("textAssets")}</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={statusFilter}
                onValueChange={value =>
                  setStatusFilter(value as AssetStatusFilter)
                }
              >
                <SelectTrigger
                  aria-label={t("assetStatus")}
                  className="h-8 w-[130px] rounded-md"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("allStates")}</SelectItem>
                  <SelectItem value="complete">{t("complete")}</SelectItem>
                  <SelectItem value="queued">{t("queued")}</SelectItem>
                  <SelectItem value="in_progress">{t("inProgress")}</SelectItem>
                  <SelectItem value="failed">{t("failed")}</SelectItem>
                  <SelectItem value="nsfw">{t("nsfw")}</SelectItem>
                </SelectContent>
              </Select>
              <div className="min-w-0 flex-1" />
              <div className="text-xs text-muted-foreground">
                {t("shownCount", {
                  shown: visibleAssets.length,
                  total: assetSummary.total,
                })}
              </div>
            </div>

            {libraryError ? (
              <Alert className="mb-4 rounded-md" role="alert">
                <AlertTitle>{t("assetsLoadFailed")}</AlertTitle>
                <AlertDescription className="flex items-center justify-between gap-3">
                  <span>{t("assetsLoadFailed")}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 rounded-md"
                    onClick={() => void loadAssets()}
                  >
                    {t("retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            {isLoading && visibleAssets.length === 0 ? (
              <div
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
                aria-label={t("loadingAssets")}
              >
                {Array.from({ length: 8 }).map((_, index) => (
                  <div
                    key={index}
                    className="overflow-hidden rounded-md border bg-background"
                  >
                    <Skeleton className="aspect-[4/3] w-full rounded-none" />
                    <div className="space-y-2 p-3">
                      <Skeleton className="h-4 w-4/5" />
                      <Skeleton className="h-3 w-3/5" />
                      <Skeleton className="h-8 w-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {!isLoading && visibleAssets.length === 0 ? (
              <div className="flex min-h-64 flex-col items-center justify-center rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                <ImageIcon className="mb-3 h-7 w-7" />
                <div className="text-sm font-medium text-foreground">
                  {searchQuery ? t("noAssetsFound") : t("emptyAssetsTitle")}
                </div>
                <div className="mt-1 max-w-sm text-xs leading-relaxed">
                  {searchQuery
                    ? t("emptySearchDescription")
                    : t("emptyAssetsDescription")}
                </div>
                {searchQuery ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-7 rounded-md"
                    onClick={() => setSearchQuery("")}
                  >
                    {t("clearSearch")}
                  </Button>
                ) : (
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-md"
                      disabled={isUploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="mr-2 h-3.5 w-3.5" />
                      {t("uploadAsset")}
                    </Button>
                    {!imageGenerationAvailable && higgsfieldIntegrationUrl ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 rounded-md"
                        asChild
                      >
                        <Link href={higgsfieldIntegrationUrl}>
                          {t("openIntegrations")}
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            {visibleAssets.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {visibleAssets.map(asset => {
                  const KindIcon = assetKindIcon(asset.kind);
                  const assetAge = formatAssetAge(asset.createdAt, t);
                  const generation = asset.generation;
                  const isContractVideo = generation?.contractVersion === 1;
                  const contractVideoRetryable =
                    isContractVideo && generation.canRetry === true;
                  const legacyRetryable =
                    ((asset.source === "higgsfield" ||
                      asset.source === "google") &&
                      Boolean(asset.prompt)) ||
                    isRetryableAiriGreenScreenAsset(asset);
                  const canRetry =
                    asset.status === "failed" &&
                    (isContractVideo
                      ? contractVideoRetryable
                      : legacyRetryable);
                  const isRetrying = retryingAssetIds.includes(asset.id);
                  const canDelete =
                    asset.status !== "queued" && asset.status !== "in_progress";
                  const isDeleting = deletingAssetIds.includes(asset.id);
                  const canUseForVideo =
                    asset.kind === "image" &&
                    asset.status === "complete" &&
                    Boolean(asset.url);
                  const canOfferGreenScreen =
                    asset.kind === "video" &&
                    asset.status === "complete" &&
                    Boolean(asset.url) &&
                    asset.source !== "edited";
                  const canOpenEditor =
                    asset.kind === "video" &&
                    asset.status === "complete" &&
                    Boolean(asset.url);
                  const hasGreenScreenDerivative =
                    canOfferGreenScreen &&
                    greenScreenSourceAssetIdSet.has(asset.id);
                  const canMakeGreenScreen =
                    canOfferGreenScreen && !hasGreenScreenDerivative;
                  const greenScreenDisabledTooltip = hasGreenScreenDerivative
                    ? t("greenScreenAlreadyExistsTooltip")
                    : "";
                  const isEditing = editingAssetIds.includes(asset.id);
                  const isVideoSource = videoSourceAssetId === asset.id;

                  return (
                    <article
                      key={asset.id}
                      data-testid={`asset-${asset.id}`}
                      className={cn(
                        "group overflow-hidden rounded-md border bg-background transition-colors hover:border-primary/40",
                        isVideoSource
                          ? "border-primary/70 ring-1 ring-primary/30"
                          : ""
                      )}
                    >
                      <div className="relative flex aspect-[4/3] items-center justify-center bg-muted/40">
                        {asset.status === "complete" && asset.url ? (
                          asset.kind === "image" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={asset.url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : asset.kind === "video" ? (
                            <video
                              src={asset.url}
                              className="h-full w-full object-cover"
                              controls
                              preload="metadata"
                            />
                          ) : asset.kind === "audio" ? (
                            <div className="flex w-full flex-col items-center gap-3 px-4">
                              <Volume2 className="h-8 w-8 text-muted-foreground" />
                              <audio
                                src={asset.url}
                                className="w-full"
                                controls
                                preload="metadata"
                              />
                            </div>
                          ) : (
                            <div className="flex flex-col items-center gap-2 px-4 text-center">
                              <FileText className="h-8 w-8 text-muted-foreground" />
                              <div className="line-clamp-2 text-xs text-muted-foreground">
                                {asset.mimeType || t("textKind")}
                              </div>
                            </div>
                          )
                        ) : asset.status === "queued" ||
                          asset.status === "in_progress" ? (
                          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
                        ) : asset.kind === "video" ? (
                          <Video className="h-7 w-7 text-muted-foreground" />
                        ) : asset.kind === "audio" ? (
                          <Volume2 className="h-7 w-7 text-muted-foreground" />
                        ) : asset.kind === "text" ? (
                          <FileText className="h-7 w-7 text-muted-foreground" />
                        ) : (
                          <ImageIcon className="h-7 w-7 text-muted-foreground" />
                        )}
                        {asset.status === "queued" ||
                        asset.status === "in_progress" ? (
                          <div className="absolute bottom-2 left-2 rounded-md bg-background/90 px-2 py-1 text-xs shadow-sm">
                            {statusLabel(asset.status, t)}
                          </div>
                        ) : null}
                      </div>
                      <div className="space-y-2 p-3">
                        <div className="flex min-w-0 items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {assetTitle(asset)}
                            </div>
                            <div className="mt-0.5 flex min-w-0 flex-wrap gap-1 text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1">
                                <KindIcon className="h-3 w-3" />
                                {assetKindLabel(asset.kind, t)}
                              </span>
                              <span>{assetSourceLabel(asset.source, t)}</span>
                              {asset.fileSize ? (
                                <span>{formatBytes(asset.fileSize)}</span>
                              ) : null}
                              {assetAge ? <span>{assetAge}</span> : null}
                            </div>
                          </div>
                          <Badge
                            variant="secondary"
                            className={cn(
                              "shrink-0",
                              statusBadgeClass(asset.status)
                            )}
                          >
                            {statusLabel(asset.status, t)}
                          </Badge>
                        </div>
                        {asset.error ? (
                          <div className="line-clamp-2 text-xs text-destructive">
                            {asset.error}
                          </div>
                        ) : null}
                        {asset.prompt && asset.fileName ? (
                          <div className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                            {asset.prompt}
                          </div>
                        ) : null}
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                          {canRetry ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="col-span-2 h-8 rounded-md"
                              disabled={isRetrying}
                              onClick={() => void handleRetryAsset(asset)}
                            >
                              {isRetrying ? (
                                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCcw className="mr-2 h-3.5 w-3.5" />
                              )}
                              {t("tryAgain")}
                            </Button>
                          ) : null}
                          {canUseForVideo ? (
                            <Button
                              type="button"
                              variant={isVideoSource ? "secondary" : "outline"}
                              size="sm"
                              className="col-span-2 h-8 rounded-md"
                              onClick={() => handleUseImageForVideo(asset)}
                            >
                              {isVideoSource ? (
                                <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                              ) : (
                                <Video className="mr-2 h-3.5 w-3.5" />
                              )}
                              {isVideoSource
                                ? t("selectedForVideo")
                                : t("useForVideo")}
                            </Button>
                          ) : null}
                          {canOpenEditor ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="col-span-2 h-8 rounded-md"
                              asChild
                            >
                              <Link
                                href={`/panel/w/${workspaceId}/assets/${asset.id}/editor`}
                              >
                                <Film className="mr-2 h-3.5 w-3.5" />
                                {t("openEditor")}
                              </Link>
                            </Button>
                          ) : null}
                          {canOfferGreenScreen ? (
                            hasGreenScreenDerivative ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      className="col-span-2 block"
                                      title={greenScreenDisabledTooltip}
                                    >
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-8 w-full rounded-md"
                                        disabled
                                      >
                                        <WandSparkles className="mr-2 h-3.5 w-3.5" />
                                        {t("makeGreenScreen")}
                                      </Button>
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-xs">
                                    {greenScreenDisabledTooltip}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="col-span-2 h-8 rounded-md"
                                disabled={!canMakeGreenScreen || isEditing}
                                onClick={() =>
                                  void handleMakeGreenScreen(asset)
                                }
                              >
                                {isEditing ? (
                                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <WandSparkles className="mr-2 h-3.5 w-3.5" />
                                )}
                                {t("makeGreenScreen")}
                              </Button>
                            )
                          ) : null}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 min-w-0 rounded-md"
                            disabled={!asset.url}
                            onClick={() => void copyAssetUrl(asset)}
                          >
                            <Copy className="mr-2 h-3.5 w-3.5" />
                            <span className="truncate">{t("copyUrl")}</span>
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="h-8 w-8 rounded-md text-muted-foreground hover:text-destructive"
                            aria-label={t("deleteAsset")}
                            disabled={!canDelete || isDeleting}
                            onClick={() => void handleDeleteAsset(asset)}
                          >
                            {isDeleting ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </main>
        </TabsContent>
      </Tabs>
      {duplicateChargeRetryAsset ? (
        <AlertDialog
          open
          onOpenChange={open => {
            if (!open) setDuplicateChargeRetryAsset(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("retryPossibleDuplicateTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("retryPossibleDuplicateDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("retryPossibleDuplicateCancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const asset = duplicateChargeRetryAsset;
                  setDuplicateChargeRetryAsset(null);
                  void retryContractVideo(asset, true);
                }}
              >
                {t("retryPossibleDuplicateConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
