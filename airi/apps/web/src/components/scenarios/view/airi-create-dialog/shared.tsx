"use client";

import type { CreativeAsset } from "@/components/assets/creative-assets-workspace";
import {
  isScenarioGeneratorChannel,
  normalizeScenarioGeneratorChannels,
} from "@icecore/scenario-contracts";
import type {
  ScenarioGeneratorAssetRef,
  ScenarioGeneratorBlueprint,
  ScenarioGeneratorChannel,
  ScenarioGeneratorCreateInput,
  ScenarioGeneratorPresetSeed,
  ScenarioGeneratorSendMode,
} from "@icecore/scenario-contracts";
import type { uploadScenarioActionImage } from "@/lib/scenarios/client";
import {
  FileText,
  Film,
  ImageIcon,
  Mail,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import Image from "next/image";
import { type ReactElement } from "react";
import {
  FUNNEL_TEMPLATE_VERSION,
  type FunnelTemplateDefinition,
  type FunnelTemplateKind,
} from "@/lib/scenario-generator/templates/funnel";
import type { ScenarioSourceInstanceOption } from "../../scenario-onboarding";
import type { AiriScenarioGeneratorDraft } from "@/lib/airi-chats/scenario-generator-draft";

export type AiriFunnelTemplateDefinition = Omit<
  FunnelTemplateDefinition,
  "kind"
> & {
  kind?: FunnelTemplateKind;
};

export type AiriCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates?: AiriFunnelTemplateDefinition[];
  presets?: AiriFunnelTemplateDefinition[];
  isCreating: boolean;
  workspaceId?: string;
  initialDraft?: AiriScenarioGeneratorDraft | null;
  onCreateGeneratedScenario?: (
    input: ScenarioGeneratorCreateInput
  ) => Promise<boolean>;
  sourceIds?: string[];
  connectedSourceMentions?: ScenarioSourceMention[];
  connectedSourceOptions?: ScenarioSourceInstanceOption[];
  hasGoogleCalendar?: boolean;
  higgsfieldUnavailableReason?: string;
};

export type GeneratorStatus =
  | "idle"
  | "planning"
  | "needs_input"
  | "ready"
  | "template_selection"
  | "fetching_templates"
  | "creating"
  | "media_queued"
  | "created"
  | "failed";

export type FollowUpAnswer = {
  question: string;
  answer: string;
};

export type ScenarioSourceMention =
  | ScenarioGeneratorChannel
  | "canva"
  | "higgsfield";

export type AttachmentNotice = {
  assetKey?: string;
  fileName?: string;
  message: string;
};

export type SourceMentionSearch = {
  query: string;
  triggerIndex: number;
  cursorIndex: number;
};

export type SourceMentionRenderContext = "composer" | "message";

export const EMPTY_SOURCE_IDS: string[] = [];
export const EMPTY_SOURCE_MENTIONS: ScenarioSourceMention[] = [];
export const EMPTY_SOURCE_OPTIONS: ScenarioSourceInstanceOption[] = [];
export const SOURCE_MENTION_OPTIONS: Array<{
  id: ScenarioSourceMention;
  label: string;
  icon?: LucideIcon;
  iconSrc?: string;
}> = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    iconSrc: "/whatsapp.svg",
  },
  {
    id: "telegram",
    label: "Telegram",
    iconSrc: "/telegram.svg",
  },
  {
    id: "email",
    label: "Email",
    icon: Mail,
  },
  {
    id: "canva",
    label: "Canva",
    iconSrc: "/canva-icon.svg",
  },
  {
    id: "higgsfield",
    label: "Higgsfield",
    icon: WandSparkles,
  },
];
export const SOURCE_MENTION_TOKEN_PATTERN =
  /(^|[\s([{])@([A-Za-z][A-Za-z0-9_-]*)/g;
export const ACTIVE_SOURCE_MENTION_PATTERN = /(^|[\s([{])@([A-Za-z0-9_-]*)$/;
export function sourceMentionsToChannels(
  mentions: ScenarioSourceMention[]
): ScenarioGeneratorChannel[] {
  return normalizeScenarioGeneratorChannels(mentions);
}

export function isDeliverySourceMention(
  mention: ScenarioSourceMention
): mention is ScenarioGeneratorChannel {
  return isScenarioGeneratorChannel(mention);
}

export function getSourceMentionRole(mention: ScenarioSourceMention) {
  return isDeliverySourceMention(mention) ? "delivery" : "creative";
}

export function resolveSourceMentionToken(token: string) {
  const normalized = token.toLowerCase();
  return (
    SOURCE_MENTION_OPTIONS.find(
      option =>
        option.id.toLowerCase() === normalized ||
        option.label.toLowerCase() === normalized
    ) || null
  );
}

export function getSourceMentionToken(
  option: (typeof SOURCE_MENTION_OPTIONS)[number]
) {
  return `@${option.label}`;
}

export function isSourceMentionSelectable(
  mention: ScenarioSourceMention,
  connectedSourceMentionSet: Set<ScenarioSourceMention>,
  sendMode: ScenarioGeneratorSendMode
) {
  return (
    connectedSourceMentionSet.has(mention) &&
    (mention !== "telegram" || sendMode === "immediate")
  );
}

export function extractSourceMentionsFromPrompt(
  text: string,
  connectedSourceMentionSet: Set<ScenarioSourceMention>,
  sendMode: ScenarioGeneratorSendMode
) {
  const mentions: ScenarioSourceMention[] = [];
  SOURCE_MENTION_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_MENTION_TOKEN_PATTERN.exec(text)) !== null) {
    const option = resolveSourceMentionToken(match[2]);
    if (
      option &&
      isSourceMentionSelectable(
        option.id,
        connectedSourceMentionSet,
        sendMode
      ) &&
      !mentions.includes(option.id)
    ) {
      mentions.push(option.id);
    }
  }
  return mentions;
}

export function stripSourceMentionsFromPrompt(text: string) {
  SOURCE_MENTION_TOKEN_PATTERN.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_MENTION_TOKEN_PATTERN.exec(text)) !== null) {
    const prefix = match[1];
    const token = match[2];
    const option = resolveSourceMentionToken(token);
    const mentionStart = match.index + prefix.length;
    result += text.slice(lastIndex, mentionStart);
    if (!option) {
      result += `@${token}`;
    }
    lastIndex = mentionStart + token.length + 1;
  }
  result += text.slice(lastIndex);
  return result
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function findActiveSourceMentionSearch(
  text: string,
  cursorIndex: number
): SourceMentionSearch | null {
  const beforeCursor = text.slice(0, cursorIndex);
  const match = ACTIVE_SOURCE_MENTION_PATTERN.exec(beforeCursor);
  if (!match) return null;
  return {
    query: match[2],
    triggerIndex: cursorIndex - match[2].length - 1,
    cursorIndex,
  };
}

export function sourceMentionChipClassName(
  context: SourceMentionRenderContext
) {
  return [
    "mx-0.5 inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium leading-none ring-1 align-baseline",
    context === "message"
      ? "bg-primary-foreground/15 text-primary-foreground ring-primary-foreground/30"
      : "bg-cyan-50 text-cyan-800 ring-cyan-200 dark:bg-cyan-950/70 dark:text-cyan-100 dark:ring-cyan-800/70",
  ].join(" ");
}

export function SourceMentionIcon({
  option,
  className,
}: {
  option: (typeof SOURCE_MENTION_OPTIONS)[number];
  className: string;
}) {
  const Icon = option.icon;
  if (option.iconSrc) {
    return (
      <Image
        src={option.iconSrc}
        alt=""
        width={14}
        height={14}
        className={className}
      />
    );
  }
  if (Icon) {
    return <Icon className={className} />;
  }
  return null;
}

export function SourceMentionText({
  text,
  context,
}: {
  text: string;
  context: SourceMentionRenderContext;
}) {
  const parts: ReactElement[] = [];
  let partIndex = 0;
  let lastIndex = 0;
  const pushText = (value: string) => {
    if (!value) return;
    parts.push(<span key={`text-${partIndex++}`}>{value}</span>);
  };

  SOURCE_MENTION_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_MENTION_TOKEN_PATTERN.exec(text)) !== null) {
    const prefix = match[1];
    const token = match[2];
    const option = resolveSourceMentionToken(token);
    const mentionStart = match.index + prefix.length;
    pushText(text.slice(lastIndex, mentionStart));
    if (option) {
      parts.push(
        <span
          key={`mention-${partIndex++}`}
          data-source-mention-chip={option.id}
          data-source-mention-context={context}
          className={sourceMentionChipClassName(context)}
        >
          <SourceMentionIcon option={option} className="h-3.5 w-3.5 shrink-0" />
          <span>{getSourceMentionToken(option)}</span>
        </span>
      );
    } else {
      pushText(`@${token}`);
    }
    lastIndex = mentionStart + token.length + 1;
  }
  pushText(text.slice(lastIndex));
  return parts;
}

export function buildPromptWithAnswers(
  prompt: string,
  answers: FollowUpAnswer[]
) {
  const trimmedPrompt = prompt.trim();
  if (answers.length === 0) return trimmedPrompt;
  return [
    trimmedPrompt,
    "",
    "Follow-up answers:",
    ...answers.map(item => `Q: ${item.question}\nA: ${item.answer}`),
  ].join("\n");
}

export function normalizeGeneratorAssetRef(
  upload: Awaited<ReturnType<typeof uploadScenarioActionImage>>
): ScenarioGeneratorAssetRef {
  return {
    url: upload.url,
    source: "uploaded",
    bucket: upload.bucket,
    path: upload.path,
    mimeType: upload.mimeType,
    fileName: upload.fileName,
  };
}

export function normalizeCreativeAssetRef(
  asset: CreativeAsset
): ScenarioGeneratorAssetRef | null {
  if (asset.status !== "complete" || !asset.url) return null;
  if (
    asset.kind !== "image" &&
    asset.kind !== "video" &&
    asset.kind !== "audio"
  ) {
    return null;
  }

  return {
    id: asset.id,
    kind: asset.kind,
    source: asset.source === "higgsfield" ? "higgsfield" : "uploaded",
    url: asset.url,
    bucket: asset.bucket || undefined,
    path: asset.path || undefined,
    mimeType: inferCreativeAssetMimeType(asset),
    fileName:
      asset.fileName ||
      asset.prompt?.slice(0, 48) ||
      `higgsfield-${asset.kind}`,
  };
}

export function inferCreativeAssetMimeType(
  asset: CreativeAsset
): string | undefined {
  if (asset.mimeType) return asset.mimeType;
  return asset.kind === "video" ? "video/mp4" : "image/jpeg";
}

export function getAttachmentIcon(asset: ScenarioGeneratorAssetRef) {
  if (asset.kind === "image") return ImageIcon;
  if (asset.kind === "video") return Film;
  return FileText;
}

export function formatSourceMentionLabel(mention: ScenarioSourceMention) {
  const option = SOURCE_MENTION_OPTIONS.find(item => item.id === mention);
  return option?.label || mention;
}

export function isPreviewableAttachment(asset: ScenarioGeneratorAssetRef) {
  if (!asset.url) return false;
  if (asset.kind === "image" || asset.kind === "video") return true;
  const mime = asset.mimeType || "";
  return mime.startsWith("image/") || mime.startsWith("video/");
}

export function createAbortError(): Error {
  const error = new Error("Cancelled");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let cleanup = () => {};
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      cleanup();
      reject(createAbortError());
    };
    cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
    };
    const timeoutId = window.setTimeout(() => {
      settled = true;
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export function joinPromptSegments(...segments: string[]) {
  return segments
    .map(segment => segment.trim())
    .filter(Boolean)
    .join("\n");
}

export function getScribeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "error" in error &&
    typeof error.error === "string"
  ) {
    return error.error;
  }
  return fallback;
}

export function attachmentChipClassName(hasWarning: boolean) {
  return [
    "flex h-8 max-w-full items-center gap-1.5 rounded-full px-2 text-xs shadow-sm ring-1",
    hasWarning
      ? "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-100 dark:ring-amber-900/50"
      : "bg-background ring-border",
  ].join(" ");
}

export function buildFunnelTemplateSeed(
  template: AiriFunnelTemplateDefinition
): ScenarioGeneratorPresetSeed {
  return {
    id: template.id,
    version: FUNNEL_TEMPLATE_VERSION,
    segmentKey: template.segmentKey,
    title: template.title,
    description: template.description,
    segmentLabel: template.segmentLabel,
  };
}

/** The localized template request plus the delivery source to mention. */
export function buildPromptForFunnelTemplate(
  templatePrompt: string,
  deliveryMention: ScenarioGeneratorChannel | null
): string {
  return [templatePrompt, deliveryMention ? `@${deliveryMention}` : ""]
    .filter(Boolean)
    .join(" ");
}

export function buildFunnelTemplateBlueprint(params: {
  template: AiriFunnelTemplateDefinition;
  channels: ScenarioGeneratorChannel[];
  recipientSourceSummary: string;
}): ScenarioGeneratorBlueprint {
  const branchId = params.template.segmentKey || params.template.id;
  return {
    summary: `${params.template.title}: ${params.template.description}`,
    campaignName: params.template.mainScenarioName || params.template.title,
    workflowKind: "follow_up_workflow",
    sendMode: "trigger",
    channels: params.channels,
    recipientSourceSummary: params.recipientSourceSummary,
    cohorts: [
      {
        id: branchId,
        label: params.template.segmentLabel,
        branchId,
        count: 0,
      },
    ],
  };
}
