"use client";

import { AiriMarkdown } from "@/components/ai/airi-markdown";
import { AiriChatRunProgress } from "@/components/ai/airi-chat-run-progress";
import { AiriChatComposer } from "@/components/ai/airi-chat-composer";
import { MetaAdsMcpReconciliationDialog } from "@/components/ai/meta-ads-mcp-reconciliation-dialog";
import { MetaAdsMcpTransactionReviewDialog } from "@/components/ai/meta-ads-mcp-transaction-review-dialog";
import type { CreativeAsset } from "@/components/assets/creative-assets-workspace";
import {
  AiriBuilderIntlProvider,
  AiriPreviewLoadFailure,
} from "@/components/ai/airi-builder-intl-provider";
import type {
  AiriBuilderMode,
  AiriBuilderPendingPatchTarget,
} from "@/components/ai/airi-builder-side-panel";
import {
  AiriLazyBuilderSidePanel,
  preloadAiriBuilderSidePanel,
} from "@/components/ai/airi-lazy-builder-side-panel";
import {
  DEFAULT_AIRI_BUILDER_FLOW_CONFIG,
  DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT,
} from "@/components/ai/airi-builder-defaults";
import { Button } from "@/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ui/conversation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  normalizeAiriBuilderUiState,
  normalizeActiveAiriBuilder,
  normalizeAiriBuilderPatch,
  type ActiveAiriBuilderInput,
  type AiriBuilderPatch,
  type AiriBuilderUiState,
} from "@/lib/airi-chats/builder-state";
import {
  normalizeAiriCampaignPackage,
  type AiriCampaignPackage,
} from "@/lib/airi-chats/marketing-package";
import {
  normalizeAiriOpportunityScan,
  type AiriOpportunityScan,
} from "@/lib/airi-chats/opportunity-scan";
import {
  getAiriBulkCampaignDraftStorageKey,
  normalizeAiriBulkCampaignDraft,
  type AiriBulkCampaignDraft,
} from "@/lib/airi-chats/bulk-campaign-draft";
import {
  getAiriCreativeAssetDraftStorageKey,
  normalizeAiriCreativeAssetDrafts,
  type AiriCreativeAssetDraft,
} from "@/lib/airi-chats/creative-asset-draft";
import { parseAiriCreativeAssetUri } from "@/lib/airi-chats/creative-asset-refs";
import {
  normalizeAiriGeneratedAssetAttachments,
  type AiriGeneratedAssetAttachment,
} from "@/lib/airi-chats/generated-assets";
import {
  AIRI_NEW_THREAD_TITLE_REFRESH_DELAY_MS,
  AiriChatSessionScope,
  readJson,
  sortThreads,
  toAiriChatMessagePage,
  useAiriChatSession,
  type AiriChatAttachmentPayload,
  type AiriChatMessage,
  type AiriChatSessionCallbacks,
  type AiriChatThread,
} from "./use-airi-chat-session";
import {
  isAiriChatMessageStopped,
  readAiriChatMessageMetadata,
} from "./airi-chat-message-metadata";
import { useGeneratedCreativeAsset } from "./use-generated-creative-asset";
import {
  getAiriScenarioGeneratorDraftStorageKey,
  normalizeAiriScenarioGeneratorDraft,
  type AiriScenarioGeneratorDraft,
} from "@/lib/airi-chats/scenario-generator-draft";
import {
  buildAiriChatMetaSkillRef,
  buildAiriChatSourceOptionId,
  type AiriChatSourceOption,
  type AiriChatSourceRef,
} from "@/lib/airi-chats/source-types";
import {
  normalizeAiriWhatsAppTemplateDraft,
  type AiriWhatsAppTemplateDraft,
} from "@/lib/airi-chats/whatsapp-template-drafts";
import {
  type AiriChatResourceReceipt,
  type AiriChatRunEvent,
  type AiriChatRunResource,
} from "@/lib/airi-chats/run-events";
import {
  normalizeAiriChatPendingActions,
  type AiriChatMetaAdsMcpPendingActionV2,
  type AiriChatPendingAction,
} from "@/lib/airi-chats/pending-actions";
import type { PublicMetaAdsMcpExecution } from "@/lib/airi-chats/service";
import {
  metaAdsMcpTransactionV2Schema,
  type MetaAdsMcpTransactionV2,
} from "@/lib/meta-ads/mcp/confirmation-contract";
import { formatCompactRelativeTime } from "@/lib/date-utils";
import { cn } from "@/lib/utils";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { getIntegrationById } from "@/components/integrations/integration-registry";
import { TemplatePhonePreview } from "@/components/whatsapp-templates/template-phone-preview";
import type { WhatsAppTemplateSelectionItem } from "@/lib/whatsapp/templates/selection-utils";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { StickToBottomContext } from "use-stick-to-bottom";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  Archive,
  AlertCircle,
  BarChart3,
  BookOpen,
  ChevronLeft,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  ExternalLink,
  Clock3,
  ImageIcon,
  Megaphone,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  Pin,
  Plus,
  Search,
  Sparkles,
  Video,
  Workflow,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
  type SetStateAction,
} from "react";

export type { AiriChatMessage, AiriChatThread };
export { AIRI_NEW_THREAD_TITLE_REFRESH_DELAY_MS };

type AiriBuilderArtifactRecord = {
  id: string;
  kind: AiriBuilderMode;
  revision: number;
  status: string;
  validation?: unknown;
  externalRefs?: Record<string, unknown> | null;
  snapshot?: {
    templateDraft?: AiriWhatsAppTemplateDraft;
    flowConfig?: WhatsAppFlowConfig;
  };
};

type AiriCampaignArtifactRecord = {
  id: string;
  kind: "marketing_campaign";
  revision: number;
  status: string;
  validation?: unknown;
};

type AiriBuilderArtifactMap = Partial<
  Record<AiriBuilderMode, AiriBuilderArtifactRecord>
>;

type AiriBuilderRenderState = {
  mode: AiriBuilderMode;
  templateDraft: AiriWhatsAppTemplateDraft;
  flowConfig: WhatsAppFlowConfig;
  artifacts: AiriBuilderArtifactMap;
  pendingPatch: AiriBuilderPatch | null;
  /** The artifact a pending patch belongs to, when not the open one. */
  pendingPatchArtifact: AiriBuilderArtifactRecord | null;
  /** What applying the pending patch changes: the open artifact, another
   * known artifact, or none yet (a new one is created for it). */
  pendingPatchTarget: AiriBuilderPendingPatchTarget;
  /** A newer server revision met by autosave; autosave waits on the user. */
  conflict: AiriBuilderArtifactRecord | null;
};

/** Builder saves remembered per artifact until one is acknowledged. */
const MAX_UNACKNOWLEDGED_BUILDER_SAVES = 20;

/** How one builder save ended; "conflict" and "failed" need the user. */
type AiriBuilderSaveOutcome =
  | "saved"
  | "rebased"
  | "conflict"
  | "failed"
  | "aborted";

/** Autosave waits this long after the last builder edit. */
const AIRI_BUILDER_AUTOSAVE_DELAY_MS = 600;

function createDefaultAiriBuilderRenderState(): AiriBuilderRenderState {
  return {
    mode: "whatsapp_template",
    templateDraft: DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT,
    flowConfig: DEFAULT_AIRI_BUILDER_FLOW_CONFIG,
    artifacts: {},
    pendingPatch: null,
    pendingPatchArtifact: null,
    pendingPatchTarget: "open",
    conflict: null,
  };
}

function BuilderToggleButton({
  open,
  className,
  onToggle,
}: {
  open: boolean;
  className?: string;
  onToggle: () => void;
}) {
  const chatT = useTranslations("AiriChat");
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant={open ? "secondary" : "ghost"}
            className={cn("size-9 rounded-full", className)}
            aria-label={chatT("toggleSidePanel")}
            onClick={onToggle}
          >
            {open ? (
              <PanelRightClose className="size-4" />
            ) : (
              <PanelRight className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex items-center gap-2">
          <span>{chatT("toggleSidePanel")}</span>
          <span className="rounded bg-background/20 px-1.5 py-0.5 text-[10px]">
            Ctrl+Alt+B
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function AiriTopRightCloseButton({
  builderOpen,
  className,
  onCloseBuilder,
  onClose,
}: {
  builderOpen: boolean;
  className?: string;
  onCloseBuilder: () => void;
  onClose?: () => void;
}) {
  const chatT = useTranslations("AiriChat");
  if (!onClose) return null;

  if (builderOpen) {
    return (
      <BuilderToggleButton
        open
        className={cn("bg-background/90", className)}
        onToggle={onCloseBuilder}
      />
    );
  }

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={cn("size-9 rounded-full bg-background/90", className)}
      aria-label={chatT("closeSidebar")}
      onClick={onClose}
    >
      <PanelRightClose className="size-4" />
    </Button>
  );
}

/** The desktop page's columns: chat list, thread, and the optional side panel. */
export type AiriDesktopColumnsProps = {
  threadList: ReactNode;
  thread: ReactNode;
  /** The builder or tools panel; null while it is closed. */
  sidePanel: ReactNode | null;
  /** The side panel's width in percent of the page. */
  sidePanelSize: number;
  onSidePanelSizeChange: (size: number) => void;
};

/**
 * Fixed-width columns for a desktop layout without a resizable one. The
 * /airi page passes its resizable columns (airi-page-workspace.tsx), so
 * react-resizable-panels stays in the page's own code and out of the drawer
 * that shares this module, and the page never waits on a separate download.
 */
function AiriStaticDesktopColumns({
  threadList,
  thread,
  sidePanel,
  sidePanelSize,
}: AiriDesktopColumnsProps) {
  return (
    <div className="flex h-full w-full min-w-0">
      <div
        className={cn(
          "h-full min-w-[220px] max-w-[440px] shrink-0",
          sidePanel ? "w-1/5" : "w-1/4"
        )}
      >
        {threadList}
      </div>
      <div className="h-full min-w-0 flex-1">{thread}</div>
      {sidePanel ? (
        <div
          className="h-full min-w-[360px] max-w-[760px] shrink-0"
          style={{ width: `${sidePanelSize}%` }}
        >
          {sidePanel}
        </div>
      ) : null}
    </div>
  );
}

type AiriChatWorkspaceProps = {
  workspaceId: string;
  compact?: boolean;
  initialSource?: "manual" | "onboarding" | "global";
  onClose?: () => void;
  /** The /airi page's desktop columns; fixed-width columns by default. */
  desktopColumns?: ComponentType<AiriDesktopColumnsProps>;
};

type MetaMcpReviewSelection = {
  messageId: string;
  action: AiriChatMetaAdsMcpPendingActionV2;
  transaction: MetaAdsMcpTransactionV2;
};

type MetaMcpReconciliationSelection = {
  messageId: string;
  execution: PublicMetaAdsMcpExecution;
};

type AiriStartCardTone = "data" | "support" | "whatsapp" | "campaign";

type AiriStartCard = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  eyebrow: string;
  tone: AiriStartCardTone;
  selectedSources?: AiriChatSourceRef[];
  /** Integration registry ids shown as stacked brand marks (e.g. canva + whatsapp). */
  iconSourceIds?: string[];
  metric?: string;
  metricLabel?: string;
  /** Shorter label for the chip rows; the title is used when absent. */
  compactTitle?: string;
};

type AiriChatTranslator = ReturnType<typeof useTranslations>;

const AIRI_START_ICON_SOURCE_PRIORITY = [
  "whatsapp",
  "instagram",
  "telegram",
  "email",
  "web_widget",
  "meta_ads",
  "canva",
  "higgsfield",
  "elevenlabs",
  "google_calendar",
] as const;

type AiriStartContext = {
  sourceTypes: Set<string>;
  sourceRefsByType: Map<string, AiriChatSourceRef[]>;
  connectedCount: number;
  conversationChannelCount: number;
  creativeToolCount: number;
  hasWhatsApp: boolean;
  hasMetaAds: boolean;
  metaAdsSkill?: Extract<AiriChatSourceOption, { type?: "source" }>;
  hasWanAvatar: boolean;
  hasDataContext: boolean;
};

const AIRI_CONVERSATION_SOURCE_TYPES = new Set([
  "whatsapp",
  "instagram",
  "telegram",
  "email",
  "web_widget",
  "intercom",
]);
const AIRI_CREATIVE_SOURCE_TYPES = new Set([
  "canva",
  "higgsfield",
  "elevenlabs",
]);
const AIRI_START_MAX_CARDS = 12;

function buildAiriStartFallbackCards(
  chatT: AiriChatTranslator
): AiriStartCard[] {
  return [
    {
      ...airiStartCardCopy(chatT, "product-capabilities"),
      tone: "support",
    },
    {
      ...airiStartCardCopy(chatT, "connect-context"),
      tone: "data",
    },
  ];
}

const MAX_ATTACHMENT_TEXT_CHARS = 8_000;
const MAX_TEXT_ATTACHMENT_BYTES = 160_000;

const TEXT_ATTACHMENT_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "text/csv",
  "text/markdown",
]);

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".md",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const AIRI_MOBILE_LAYOUT_QUERY = "(max-width: 1023px)";
const AIRI_BUILDER_UI_STORAGE_PREFIX = "airi-chat:builder-ui:";
const DEFAULT_AIRI_BUILDER_PANEL_SIZE = 32;
type ResolvedAiriBuilderUiState = Required<AiriBuilderUiState>;
const DEFAULT_AIRI_BUILDER_UI_STATE: ResolvedAiriBuilderUiState = {
  open: false,
  panelSize: DEFAULT_AIRI_BUILDER_PANEL_SIZE,
};
const builderUiMemoryState = new Map<string, ResolvedAiriBuilderUiState>();
const builderUiStoreListeners = new Set<() => void>();

function getAiriMobileLayoutSnapshot() {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") {
    return window.innerWidth < 1024;
  }
  return window.matchMedia(AIRI_MOBILE_LAYOUT_QUERY).matches;
}

function subscribeAiriMobileLayout(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  if (typeof window.matchMedia !== "function") {
    window.addEventListener("resize", onStoreChange);
    return () => window.removeEventListener("resize", onStoreChange);
  }
  const mediaQuery = window.matchMedia(AIRI_MOBILE_LAYOUT_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

/**
 * Phone layout or not; null while unknown (the server render and
 * hydration), when both layouts render and CSS breakpoints pick the visible
 * one, so a phone's first paint is not blank. From then on only one tree is
 * mounted.
 */
function useAiriMobileLayout(): boolean | null {
  return useSyncExternalStore<boolean | null>(
    subscribeAiriMobileLayout,
    getAiriMobileLayoutSnapshot,
    () => null
  );
}

function builderUiStorageKey(workspaceId: string) {
  return `${AIRI_BUILDER_UI_STORAGE_PREFIX}${workspaceId}`;
}

function resolveAiriBuilderUiState(value: unknown): ResolvedAiriBuilderUiState {
  const parsed = normalizeAiriBuilderUiState(value);
  return {
    open: parsed.open,
    panelSize: parsed.panelSize ?? DEFAULT_AIRI_BUILDER_PANEL_SIZE,
  };
}

function readAiriBuilderUiState(
  storageKey: string
): ResolvedAiriBuilderUiState {
  if (typeof window === "undefined") {
    return (
      builderUiMemoryState.get(storageKey) ?? DEFAULT_AIRI_BUILDER_UI_STATE
    );
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw
      ? resolveAiriBuilderUiState(JSON.parse(raw))
      : DEFAULT_AIRI_BUILDER_UI_STATE;
  } catch {
    return (
      builderUiMemoryState.get(storageKey) ?? DEFAULT_AIRI_BUILDER_UI_STATE
    );
  }
}

function serializeAiriBuilderUiState(
  state: ResolvedAiriBuilderUiState
): string {
  return JSON.stringify(state);
}

function parseAiriBuilderUiSnapshot(
  snapshot: string
): ResolvedAiriBuilderUiState {
  try {
    return resolveAiriBuilderUiState(JSON.parse(snapshot));
  } catch {
    return DEFAULT_AIRI_BUILDER_UI_STATE;
  }
}

function getAiriBuilderUiSnapshot(storageKey: string) {
  return serializeAiriBuilderUiState(readAiriBuilderUiState(storageKey));
}

function notifyAiriBuilderUiStore() {
  builderUiStoreListeners.forEach(listener => listener());
}

function writeAiriBuilderUiState(
  storageKey: string,
  state: ResolvedAiriBuilderUiState
) {
  builderUiMemoryState.set(storageKey, state);
  try {
    window.localStorage.setItem(storageKey, serializeAiriBuilderUiState(state));
  } catch {
    // Keep the in-memory state so the current tab remains responsive.
  }
  notifyAiriBuilderUiStore();
}

function subscribeAiriBuilderUiState(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  builderUiStoreListeners.add(onStoreChange);
  const onStorage = (event: StorageEvent) => {
    if (!event.key?.startsWith(AIRI_BUILDER_UI_STORAGE_PREFIX)) return;
    builderUiMemoryState.delete(event.key);
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    builderUiStoreListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function useAiriBuilderUiState(workspaceId: string) {
  const storageKey = builderUiStorageKey(workspaceId);
  const snapshot = useSyncExternalStore(
    subscribeAiriBuilderUiState,
    () => getAiriBuilderUiSnapshot(storageKey),
    () => serializeAiriBuilderUiState(DEFAULT_AIRI_BUILDER_UI_STATE)
  );
  const state = useMemo(() => parseAiriBuilderUiSnapshot(snapshot), [snapshot]);
  const setOpen = useCallback(
    (action: SetStateAction<boolean>) => {
      const current = readAiriBuilderUiState(storageKey);
      const open = typeof action === "function" ? action(current.open) : action;
      writeAiriBuilderUiState(storageKey, { ...current, open });
    },
    [storageKey]
  );
  const setPanelSize = useCallback(
    (action: SetStateAction<number>) => {
      const current = readAiriBuilderUiState(storageKey);
      const panelSize =
        typeof action === "function" ? action(current.panelSize) : action;
      writeAiriBuilderUiState(storageKey, {
        ...current,
        panelSize,
      });
    },
    [storageKey]
  );
  return {
    builderOpen: state.open,
    builderPanelSize: state.panelSize,
    setBuilderOpen: setOpen,
    setBuilderPanelSize: setPanelSize,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function getMessageAiriBuilderPatch(
  metadata: Record<string, unknown> | null | undefined
): AiriBuilderPatch | null {
  return normalizeAiriBuilderPatch(metadata?.airiBuilderPatch);
}

function normalizeAiriBuilderArtifactRecord(
  value: unknown
): AiriBuilderArtifactRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const kind = raw.kind;
  const revision = Number(raw.revision);
  if (
    !id ||
    (kind !== "whatsapp_template" && kind !== "whatsapp_flow") ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    return null;
  }

  const snapshot =
    raw.snapshot && typeof raw.snapshot === "object"
      ? (raw.snapshot as Record<string, unknown>)
      : null;
  const normalizedSnapshot: AiriBuilderArtifactRecord["snapshot"] = {};

  if (kind === "whatsapp_template" && snapshot?.templateDraft) {
    const active = normalizeActiveAiriBuilder({
      kind,
      artifactId: id,
      revision,
      templateDraft: snapshot.templateDraft,
    });
    if (active?.kind === "whatsapp_template") {
      normalizedSnapshot.templateDraft = active.templateDraft;
    }
  }

  if (kind === "whatsapp_flow" && snapshot?.flowConfig) {
    const active = normalizeActiveAiriBuilder({
      kind,
      artifactId: id,
      revision,
      flowConfig: snapshot.flowConfig,
    });
    if (active?.kind === "whatsapp_flow") {
      normalizedSnapshot.flowConfig = active.flowConfig;
    }
  }

  return {
    id,
    kind,
    revision,
    status: typeof raw.status === "string" ? raw.status : "draft",
    validation: raw.validation,
    externalRefs:
      raw.externalRefs && typeof raw.externalRefs === "object"
        ? (raw.externalRefs as Record<string, unknown>)
        : null,
    snapshot:
      normalizedSnapshot.templateDraft || normalizedSnapshot.flowConfig
        ? normalizedSnapshot
        : undefined,
  };
}

function getMessageAiriArtifact(
  metadata: Record<string, unknown> | null | undefined
): AiriBuilderArtifactRecord | null {
  return normalizeAiriBuilderArtifactRecord(metadata?.airiArtifact);
}

/** The artifact id a builder patch names, when the server sends one. */
function getMessageAiriBuilderPatchArtifactId(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const patch = metadata?.airiBuilderPatch;
  if (!patch || typeof patch !== "object") return null;
  const artifactId = (patch as { artifactId?: unknown }).artifactId;
  return typeof artifactId === "string" && artifactId.trim()
    ? artifactId.trim()
    : null;
}

/**
 * A comparable form of a builder snapshot, normalized the way the server
 * stores it, so a snapshot this tab sent matches the revision it created.
 */
function airiBuilderSnapshotFingerprint(
  kind: AiriBuilderMode,
  snapshot: AiriBuilderArtifactRecord["snapshot"]
): string | null {
  const normalized = normalizeAiriBuilderArtifactRecord({
    id: "snapshot",
    kind,
    revision: 0,
    snapshot,
  })?.snapshot;
  const value =
    kind === "whatsapp_template"
      ? normalized?.templateDraft
      : normalized?.flowConfig;
  return value ? stableJson(value) : null;
}

function normalizeAiriCampaignArtifactRecord(
  value: unknown
): AiriCampaignArtifactRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const revision = Number(raw.revision);
  if (
    !id ||
    raw.kind !== "marketing_campaign" ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    return null;
  }

  return {
    id,
    kind: "marketing_campaign",
    revision,
    status: typeof raw.status === "string" ? raw.status : "draft",
    validation: raw.validation,
  };
}

function getMessageCampaignArtifact(
  metadata: Record<string, unknown> | null | undefined
): AiriCampaignArtifactRecord | null {
  return normalizeAiriCampaignArtifactRecord(metadata?.airiCampaignArtifact);
}

function onboardingQuickActionsStorageKey(workspaceId: string) {
  return `airi-chat:onboarding-quick-actions:${workspaceId}`;
}

function hasSeenOnboardingQuickActions(workspaceId: string): boolean {
  const key = onboardingQuickActionsStorageKey(workspaceId);
  try {
    if (window.localStorage?.getItem(key) === "1") return true;
  } catch {
    // Fall back to a cookie for embedded/private browser modes.
  }
  if (typeof document === "undefined") return false;
  const cookieKey = encodeURIComponent(key);
  return document.cookie
    .split(";")
    .map(cookie => cookie.trim())
    .some(cookie => cookie === `${cookieKey}=1`);
}

function isTextLikeAttachment(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (TEXT_ATTACHMENT_TYPES.has(file.type)) return true;
  const lowerName = file.name.toLowerCase();
  return Array.from(TEXT_ATTACHMENT_EXTENSIONS).some(extension =>
    lowerName.endsWith(extension)
  );
}

async function toAttachmentPayload(
  file: File
): Promise<AiriChatAttachmentPayload> {
  const payload = toBasicAttachmentPayload(file);
  if (!isTextLikeAttachment(file) || file.size > MAX_TEXT_ATTACHMENT_BYTES) {
    return payload;
  }

  try {
    const text = await file.text();
    const textExcerpt = text.slice(0, MAX_ATTACHMENT_TEXT_CHARS).trim();
    if (!textExcerpt) return payload;
    return {
      ...payload,
      textExcerpt,
      truncated: text.length > MAX_ATTACHMENT_TEXT_CHARS || undefined,
    };
  } catch {
    return payload;
  }
}

function toBasicAttachmentPayload(file: File): AiriChatAttachmentPayload {
  return {
    name: file.name,
    type: file.type || undefined,
    size: file.size,
    lastModified: file.lastModified || undefined,
  };
}

async function toAttachmentPayloads(
  files: File[],
  creativeAssets: CreativeAsset[] = []
): Promise<AiriChatAttachmentPayload[]> {
  const filePayloads = await Promise.all(
    files.slice(0, 8).map(toAttachmentPayload)
  );
  return [
    ...filePayloads,
    ...creativeAssets.map(toCreativeAssetAttachmentPayload),
  ].slice(0, 8);
}

function toOptimisticAttachmentPayloads(
  files: File[],
  creativeAssets: CreativeAsset[] = []
): AiriChatAttachmentPayload[] {
  return [
    ...files.map(toBasicAttachmentPayload),
    ...creativeAssets.map(toCreativeAssetAttachmentPayload),
  ].slice(0, 8);
}

function toCreativeAssetAttachmentPayload(
  asset: CreativeAsset
): AiriChatAttachmentPayload {
  return {
    name: (asset.fileName || asset.prompt || `${asset.kind} asset`).slice(
      0,
      240
    ),
    type: asset.mimeType || undefined,
    size:
      typeof asset.fileSize === "number" && asset.fileSize >= 0
        ? asset.fileSize
        : 0,
    creativeAssetId: asset.id,
  };
}

function buildOptimisticMessageMetadata(params: {
  selectedSources: AiriChatSourceRef[];
  attachments: AiriChatAttachmentPayload[];
}): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};
  if (params.selectedSources.length > 0) {
    metadata.selectedSources = params.selectedSources;
  }
  if (params.attachments.length > 0) {
    metadata.attachedFiles = params.attachments;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function markOnboardingQuickActionsStorageSeen(workspaceId: string) {
  const key = onboardingQuickActionsStorageKey(workspaceId);
  try {
    window.localStorage?.setItem(key, "1");
  } catch {
    // Fall back to a cookie for embedded/private browser modes.
  }
  if (typeof document !== "undefined") {
    document.cookie = `${encodeURIComponent(key)}=1; path=/; max-age=31536000; SameSite=Lax`;
  }
}

function getMessageSelectedSources(
  metadata: Record<string, unknown> | null | undefined
): AiriChatSourceRef[] {
  return readAiriChatMessageMetadata(metadata, "selectedSources", value => {
    const sources = value?.selectedSources;
    return Array.isArray(sources) ? (sources as AiriChatSourceRef[]) : [];
  });
}

function getMessageSourceIds(
  metadata: Record<string, unknown> | null | undefined
): string[] {
  return readAiriChatMessageMetadata(metadata, "sourceIds", value => {
    const sourceIds = value?.sourceIds;
    return Array.isArray(sourceIds)
      ? sourceIds.filter((id): id is string => typeof id === "string")
      : [];
  });
}

function getMessagePendingActions(
  metadata: Record<string, unknown> | null | undefined
): AiriChatPendingAction[] {
  return readAiriChatMessageMetadata(
    metadata,
    "pendingActions",
    normalizeAiriChatPendingActions
  );
}

function getMessageMetaMcpTransactions(
  metadata: Record<string, unknown> | null | undefined
): MetaAdsMcpTransactionV2[] {
  return readAiriChatMessageMetadata(metadata, "metaMcpPending", value => {
    const transactions = value?.airiMetaAdsMcpPending;
    if (!Array.isArray(transactions)) return [];
    return transactions.flatMap(transaction => {
      const parsed = metaAdsMcpTransactionV2Schema.safeParse(transaction);
      return parsed.success ? [parsed.data] : [];
    });
  });
}

function getMessageMetaMcpExecutions(
  metadata: Record<string, unknown> | null | undefined
): PublicMetaAdsMcpExecution[] {
  const executions = metadata?.airiMetaAdsMcpExecutions;
  return Array.isArray(executions)
    ? (executions as PublicMetaAdsMcpExecution[])
    : [];
}

function applyMetaMcpMutationResult(
  messages: AiriChatMessage[],
  params: {
    sourceMessageId: string;
    mutationId: string;
    assistantMessage: AiriChatMessage;
    executionStatus: "succeeded" | "not_executed" | "outcome_unknown";
    transaction?: MetaAdsMcpTransactionV2;
    execution?: PublicMetaAdsMcpExecution;
  }
): AiriChatMessage[] {
  const updated = messages
    .filter(message => message.id !== params.assistantMessage.id)
    .map(message => {
      if (message.id !== params.sourceMessageId) return message;
      const metadata = { ...(message.metadata || {}) } as Record<
        string,
        unknown
      >;
      const withoutMutation = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return true;
        const record = value as { id?: unknown; mutationId?: unknown };
        return (
          record.id !== params.mutationId &&
          record.mutationId !== params.mutationId
        );
      };
      const retainedExecutions = Array.isArray(
        metadata.airiMetaAdsMcpExecutions
      )
        ? metadata.airiMetaAdsMcpExecutions.filter(withoutMutation)
        : [];
      const fallbackExecution =
        params.executionStatus === "outcome_unknown"
          ? params.execution
            ? { ...params.execution, status: "outcome_unknown" as const }
            : params.transaction
              ? {
                  version: 2 as const,
                  id: params.transaction.id,
                  toolName: params.transaction.tool.name,
                  summary: params.transaction.summary,
                  status: "outcome_unknown" as const,
                  claimedAt: new Date().toISOString(),
                  transaction: params.transaction,
                }
              : null
          : null;
      return {
        ...message,
        metadata: {
          ...metadata,
          airiMetaAdsMcpPending: Array.isArray(metadata.airiMetaAdsMcpPending)
            ? metadata.airiMetaAdsMcpPending.filter(withoutMutation)
            : [],
          airiMetaAdsMcpExecutions: Array.isArray(
            metadata.airiMetaAdsMcpExecutions
          )
            ? fallbackExecution
              ? [...retainedExecutions, fallbackExecution]
              : retainedExecutions
            : fallbackExecution
              ? [fallbackExecution]
              : [],
          pendingActions: Array.isArray(metadata.pendingActions)
            ? metadata.pendingActions.filter(withoutMutation)
            : [],
        },
      };
    });
  return [...updated, params.assistantMessage];
}

function getMessageWhatsAppTemplateDraft(
  metadata: Record<string, unknown> | null | undefined
): AiriWhatsAppTemplateDraft | null {
  return readAiriChatMessageMetadata(metadata, "templateDraft", value =>
    normalizeAiriWhatsAppTemplateDraft(value?.whatsappTemplateDraft)
  );
}

function getMessageCampaignPackage(
  metadata: Record<string, unknown> | null | undefined
): AiriCampaignPackage | null {
  return readAiriChatMessageMetadata(metadata, "campaignPackage", value =>
    normalizeAiriCampaignPackage(value?.airiCampaignPackage)
  );
}

function getMessageOpportunityScan(
  metadata: Record<string, unknown> | null | undefined
): AiriOpportunityScan | null {
  return readAiriChatMessageMetadata(metadata, "opportunityScan", value =>
    normalizeAiriOpportunityScan(value?.airiOpportunityScan)
  );
}

function getMessageScenarioGeneratorDraft(
  metadata: Record<string, unknown> | null | undefined
): AiriScenarioGeneratorDraft | null {
  return readAiriChatMessageMetadata(metadata, "scenarioDraft", value =>
    normalizeAiriScenarioGeneratorDraft(value?.airiScenarioGeneratorDraft)
  );
}

function getMessageBulkCampaignDraft(
  metadata: Record<string, unknown> | null | undefined
): AiriBulkCampaignDraft | null {
  return readAiriChatMessageMetadata(metadata, "bulkCampaignDraft", value =>
    normalizeAiriBulkCampaignDraft(value?.airiBulkCampaignDraft)
  );
}

function getMessageCreativeAssetDrafts(
  metadata: Record<string, unknown> | null | undefined
): AiriCreativeAssetDraft[] {
  return readAiriChatMessageMetadata(metadata, "creativeAssetDrafts", value =>
    normalizeAiriCreativeAssetDrafts(value?.airiCreativeAssetDrafts)
  );
}

function getMessageGeneratedAssetAttachments(
  metadata: Record<string, unknown> | null | undefined
): AiriGeneratedAssetAttachment[] {
  return readAiriChatMessageMetadata(metadata, "generatedAssets", value =>
    normalizeAiriGeneratedAssetAttachments(value?.airiGeneratedAssetAttachments)
  );
}

function getMessageReceipt(
  metadata: Record<string, unknown> | null | undefined
): AiriChatResourceReceipt | null {
  const receipt = metadata?.resourceReceipt;
  if (!receipt || typeof receipt !== "object") return null;
  return receipt as AiriChatResourceReceipt;
}

function resourceCountText(resource: AiriChatRunResource): string {
  if (typeof resource.count === "number") return String(resource.count);
  return resource.detail || "";
}

function MessageSourceReceipt({
  metadata,
}: {
  metadata?: Record<string, unknown> | null;
}) {
  const selectedSources = getMessageSelectedSources(metadata);
  const sourceIds = getMessageSourceIds(metadata);
  if (selectedSources.length === 0 && sourceIds.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1 text-[11px] leading-4 opacity-80">
      {selectedSources.slice(0, 4).map(source => (
        <span
          key={buildAiriChatSourceOptionId(source)}
          className="rounded-full bg-current/10 px-2 py-0.5"
        >
          @{source.label}
        </span>
      ))}
      {sourceIds.length > 0 ? (
        <span className="rounded-full bg-current/10 px-2 py-0.5">
          {sourceIds.length} retrieved
        </span>
      ) : null}
    </div>
  );
}

type ReviewMetaMcpMutationHandler = (params: {
  messageId: string;
  action: AiriChatMetaAdsMcpPendingActionV2;
  transaction: MetaAdsMcpTransactionV2;
}) => void;
type OpenMetaMcpReconciliationHandler = (params: {
  messageId: string;
  execution: PublicMetaAdsMcpExecution;
}) => void;
type SendAiriMessageHandler = (
  content: string,
  selectedSources: AiriChatSourceRef[],
  attachedFiles: File[],
  attachedCreativeAssets?: CreativeAsset[]
) => Promise<boolean> | boolean;

function MessagePendingActions({
  messageId,
  metadata,
  relativeNow,
  confirmingMutationId,
  onReviewMetaMcpMutation,
  onOpenMetaMcpReconciliation,
}: {
  messageId: string;
  metadata?: Record<string, unknown> | null;
  relativeNow: number;
  confirmingMutationId?: string | null;
  onReviewMetaMcpMutation?: ReviewMetaMcpMutationHandler;
  onOpenMetaMcpReconciliation?: OpenMetaMcpReconciliationHandler;
}) {
  const metaT = useTranslations("AiriMetaAds");
  const actions = getMessagePendingActions(metadata);
  const transactions = getMessageMetaMcpTransactions(metadata);
  const unresolvedExecutions = getMessageMetaMcpExecutions(metadata).filter(
    execution =>
      execution.status === "executing" || execution.status === "outcome_unknown"
  );
  if (actions.length === 0 && unresolvedExecutions.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {actions.map(action => {
        if (action.kind === "meta_ads_mcp_mutation") {
          const mutationId = action.mutationId;
          const isConfirming = confirmingMutationId === mutationId;
          if (action.confirmationVersion === 1) {
            return (
              <div
                key={action.id}
                className="flex flex-col items-stretch justify-between gap-3 rounded-xl bg-background/80 px-3 py-2 text-left text-xs shadow-[0_12px_36px_-32px_rgba(15,23,42,0.75)] sm:flex-row sm:items-center"
              >
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium">
                    {metaT("actions.review")}
                  </span>
                  <span className="block break-words text-muted-foreground">
                    {metaT("actions.legacy")}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-auto min-h-8 max-w-full self-start whitespace-normal sm:shrink-0"
                  disabled
                >
                  {metaT("actions.regenerate")}
                </Button>
              </div>
            );
          }
          const transaction = transactions.find(item => item.id === mutationId);
          const reviewState = !transaction
            ? "missing"
            : transaction.transactionDigest !== action.transactionDigest
              ? "mismatched"
              : "ready";
          const description =
            reviewState === "missing"
              ? metaT("actions.missing")
              : reviewState === "mismatched"
                ? metaT("actions.mismatch")
                : action.description;
          return (
            <div
              key={action.id}
              className="flex flex-col items-stretch justify-between gap-3 rounded-xl bg-background/80 px-3 py-2 text-left text-xs shadow-[0_12px_36px_-32px_rgba(15,23,42,0.75)] sm:flex-row sm:items-center"
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium">
                  {metaT("actions.review")}
                </span>
                <span className="block break-words text-muted-foreground">
                  {description}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                className="h-auto min-h-8 max-w-full self-start whitespace-normal sm:shrink-0"
                variant="secondary"
                disabled={
                  !onReviewMetaMcpMutation ||
                  isConfirming ||
                  reviewState !== "ready"
                }
                onClick={() => {
                  if (!transaction || reviewState !== "ready") return;
                  onReviewMetaMcpMutation?.({ messageId, action, transaction });
                }}
              >
                {metaT(isConfirming ? "actions.submitting" : "actions.review")}
              </Button>
            </div>
          );
        }

        return (
          <a
            key={action.id}
            href={action.href}
            className="group flex items-center justify-between gap-3 rounded-xl bg-background/80 px-3 py-2 text-left text-xs shadow-[0_12px_36px_-32px_rgba(15,23,42,0.75)] transition hover:bg-background"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{action.label}</span>
              <span className="block truncate text-muted-foreground">
                {action.description}
              </span>
            </span>
            <ExternalLink className="size-3.5 shrink-0 opacity-60 transition group-hover:opacity-100" />
          </a>
        );
      })}
      {unresolvedExecutions.map(execution => {
        const isReconciling = confirmingMutationId === execution.id;
        const canReconcile =
          execution.status === "outcome_unknown" ||
          relativeNow - Date.parse(execution.claimedAt) >= 5 * 60 * 1_000;
        return (
          <div
            key={execution.id}
            className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-left text-xs"
          >
            <div>
              <p className="font-medium">{metaT("actions.outcome")}</p>
              <p className="mt-0.5 text-muted-foreground">
                {execution.status === "outcome_unknown"
                  ? metaT("actions.unknown")
                  : canReconcile
                    ? metaT("actions.stranded")
                    : metaT("actions.waiting")}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-auto min-h-7 max-w-full whitespace-normal px-2 text-[11px]"
              disabled={
                !onOpenMetaMcpReconciliation || isReconciling || !canReconcile
              }
              onClick={() =>
                onOpenMetaMcpReconciliation?.({ messageId, execution })
              }
            >
              {metaT(isReconciling ? "actions.recording" : "actions.record")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function getTemplateHeaderCreativeAssetId(
  draft: AiriWhatsAppTemplateDraft
): string | null {
  const header = draft.components.find(
    component => component.type === "HEADER" && component.format === "IMAGE"
  );
  if (!header || header.type !== "HEADER") return null;
  return parseAiriCreativeAssetUri(header.example?.header_handle?.[0]);
}

function withResolvedTemplateHeaderCreativeAsset(params: {
  draft: AiriWhatsAppTemplateDraft;
  url: string;
}): AiriWhatsAppTemplateDraft {
  return {
    ...params.draft,
    components: params.draft.components.map(component => {
      if (component.type !== "HEADER" || component.format !== "IMAGE") {
        return component;
      }
      const assetId = parseAiriCreativeAssetUri(
        component.example?.header_handle?.[0]
      );
      if (!assetId) return component;
      return {
        ...component,
        example: {
          ...component.example,
          header_handle: [params.url],
        },
      };
    }),
  };
}

function GeneratedAssetCard({
  attachment,
  workspaceId,
}: {
  attachment: AiriGeneratedAssetAttachment;
  workspaceId: string;
}) {
  const asset = useGeneratedCreativeAsset(workspaceId, attachment.id);
  const status = asset?.status ?? attachment.status;
  const url = asset?.url ?? attachment.url ?? null;
  const error = asset?.error ?? attachment.error ?? null;
  const isComplete = status === "complete" && Boolean(url);
  const isRunning = status === "queued" || status === "in_progress";

  return (
    <div className="overflow-hidden rounded-2xl border bg-background/90 shadow-[0_18px_60px_-44px_rgba(15,23,42,0.8)]">
      <div className="aspect-[4/3] bg-muted/60">
        {isComplete ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url || ""}
            alt={attachment.title}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
            {isRunning ? (
              <Loader2 className="size-5 animate-spin text-primary" />
            ) : (
              <ImageIcon className="size-5 text-muted-foreground" />
            )}
            <span>
              {isRunning
                ? `Generating with ${attachment.providerLabel}...`
                : error || "Image generation did not complete"}
            </span>
          </div>
        )}
      </div>
      <div className="space-y-1 px-3 py-2 text-left">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs font-semibold">
            {attachment.title}
          </p>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase",
              isComplete
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : isRunning
                  ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                  : "bg-destructive/10 text-destructive"
            )}
          >
            {status.replaceAll("_", " ")}
          </span>
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {attachment.target === "whatsapp_template_header"
            ? "WhatsApp template header image"
            : attachment.prompt}
        </p>
        {isComplete && url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Open image
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function MessageGeneratedAssets({
  metadata,
  workspaceId,
}: {
  metadata?: Record<string, unknown> | null;
  workspaceId: string;
}) {
  const attachments = getMessageGeneratedAssetAttachments(metadata);
  if (attachments.length === 0) return null;
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {attachments.map(attachment => (
        <GeneratedAssetCard
          key={attachment.id}
          attachment={attachment}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  );
}

function WhatsAppTemplateDraftCard({
  draft,
  workspaceId,
  artifactId,
  onOpenInBuilder,
}: {
  draft: AiriWhatsAppTemplateDraft;
  workspaceId: string;
  artifactId?: string | null;
  onOpenInBuilder?: (draft: AiriWhatsAppTemplateDraft) => void;
}) {
  const [submitState, setSubmitState] = useState<
    | { status: "idle" }
    | { status: "submitting" }
    | { status: "submitted"; message: string }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const headerCreativeAssetId = useMemo(
    () => getTemplateHeaderCreativeAssetId(draft),
    [draft]
  );
  const headerCreativeAsset = useGeneratedCreativeAsset(
    workspaceId,
    headerCreativeAssetId
  );
  const previewDraft = useMemo(() => {
    if (
      headerCreativeAsset?.status !== "complete" ||
      !headerCreativeAsset.url
    ) {
      return draft;
    }
    return withResolvedTemplateHeaderCreativeAsset({
      draft,
      url: headerCreativeAsset.url,
    });
  }, [draft, headerCreativeAsset?.status, headerCreativeAsset?.url]);
  const template = useMemo<WhatsAppTemplateSelectionItem>(
    () => ({
      name: previewDraft.name,
      language: previewDraft.language,
      status: "PENDING",
      category: previewDraft.category,
      components: previewDraft.components,
      channel: "whatsapp",
    }),
    [previewDraft]
  );

  const submitDraft = useCallback(async () => {
    if (submitState.status === "submitting") return;
    if (!artifactId) {
      setSubmitState({
        status: "error",
        message: "Open this draft in the builder before submitting.",
      });
      return;
    }
    setSubmitState({ status: "submitting" });
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/airi-artifacts/${artifactId}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        artifact?: { status?: string };
      };
      if (!response.ok) {
        throw new Error(
          payload.error || `Template submit failed: ${response.status}`
        );
      }
      setSubmitState({
        status: "submitted",
        message:
          payload.message ||
          `Submitted to Meta${
            payload.artifact?.status ? ` (${payload.artifact.status})` : ""
          }.`,
      });
    } catch (error) {
      setSubmitState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Failed to submit template",
      });
    }
  }, [artifactId, submitState.status, workspaceId]);

  return (
    <div className="mt-4 max-w-md rounded-[1.35rem] bg-background/90 p-3 shadow-[0_20px_70px_-48px_rgba(15,23,42,0.85)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{draft.name}</p>
          <p className="text-xs text-muted-foreground">
            {draft.category} / {draft.language}
          </p>
        </div>
        <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium uppercase text-emerald-700 dark:text-emerald-300">
          Draft
        </span>
      </div>
      <AiriBuilderIntlProvider
        fallback={
          <Skeleton className="mx-auto h-80 w-full max-w-[18.75rem] rounded-[1.5rem]" />
        }
        renderFailure={retry => (
          <AiriPreviewLoadFailure
            className="mx-auto w-full max-w-[18.75rem]"
            onRetry={retry}
          />
        )}
      >
        <TemplatePhonePreview
          template={template}
          mode="card"
          className="mx-auto max-w-[18.75rem]"
        />
      </AiriBuilderIntlProvider>
      {headerCreativeAssetId && headerCreativeAsset?.status !== "complete" ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          {headerCreativeAsset?.status === "failed" ? (
            <AlertCircle className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          )}
          <span>
            {headerCreativeAsset?.status === "failed"
              ? headerCreativeAsset.error || "Header image generation failed"
              : "Generating template header image..."}
          </span>
        </div>
      ) : null}
      {draft.rationale ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {draft.rationale}
        </p>
      ) : null}
      {draft.missingDetails?.length ? (
        <div className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Missing: {draft.missingDetails.join(", ")}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {artifactId ? (
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={submitState.status === "submitting"}
            onClick={() => void submitDraft()}
          >
            {submitState.status === "submitting" ? (
              <Loader2 className="mr-1.5 size-3 animate-spin" />
            ) : null}
            Submit to WhatsApp
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={artifactId ? "ghost" : "default"}
          className="h-8 rounded-full px-2 text-xs"
          onClick={() => onOpenInBuilder?.(draft)}
        >
          Open in builder
        </Button>
      </div>
      {submitState.status === "submitted" || submitState.status === "error" ? (
        <p
          className={cn(
            "mt-2 text-xs",
            submitState.status === "submitted"
              ? "text-emerald-600"
              : "text-destructive"
          )}
        >
          {submitState.message}
        </p>
      ) : null}
    </div>
  );
}
function MessageWhatsAppTemplateDraft({
  metadata,
  workspaceId,
  onOpenInBuilder,
}: {
  metadata?: Record<string, unknown> | null;
  workspaceId: string;
  onOpenInBuilder?: (draft: AiriWhatsAppTemplateDraft) => void;
}) {
  const draft = getMessageWhatsAppTemplateDraft(metadata);
  const artifact = getMessageAiriArtifact(metadata);
  if (!draft) return null;
  return (
    <WhatsAppTemplateDraftCard
      draft={draft}
      workspaceId={workspaceId}
      artifactId={
        artifact?.kind === "whatsapp_template" ? artifact.id : undefined
      }
      onOpenInBuilder={onOpenInBuilder}
    />
  );
}

function campaignStepStatusClass(
  status: AiriCampaignPackage["steps"][number]["status"]
) {
  if (status === "ready") {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "approval_required") {
    return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  if (status === "blocked") {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "bg-muted text-muted-foreground";
}

function CampaignStepIcon({
  status,
}: {
  status: AiriCampaignPackage["steps"][number]["status"];
}) {
  if (status === "ready") {
    return <CheckCircle2 className="mt-0.5 size-4 text-emerald-500" />;
  }
  if (status === "blocked") {
    return <AlertCircle className="mt-0.5 size-4 text-amber-500" />;
  }
  return <Clock3 className="mt-0.5 size-4 text-muted-foreground" />;
}

function CampaignPackageCard({
  packageDraft,
  artifact,
  scenarioDraft,
  bulkCampaignDraft,
  creativeAssetDrafts,
  workspaceId,
}: {
  packageDraft: AiriCampaignPackage;
  artifact: AiriCampaignArtifactRecord | null;
  scenarioDraft: AiriScenarioGeneratorDraft | null;
  bulkCampaignDraft: AiriBulkCampaignDraft | null;
  creativeAssetDrafts: AiriCreativeAssetDraft[];
  workspaceId: string;
}) {
  const chatT = useTranslations("AiriChat");
  const availableTools = Object.values(packageDraft.tools).filter(
    tool => tool.available
  ).length;
  const blockedSteps = packageDraft.steps.filter(
    step => step.status === "blocked"
  ).length;
  const scenarioDraftHref = `/panel/w/${workspaceId}/scenarios?airiCreate=1`;
  const bulkCampaignDraftHref = `/panel/w/${workspaceId}/bulk-campaigns?airiBulkDraft=1`;
  const creativeAssetDraftHref = `/panel/w/${workspaceId}/assets?airiAssetDraft=1`;

  const handleOpenScenarioDraft = useCallback(() => {
    if (!scenarioDraft) return;
    try {
      window.localStorage?.setItem(
        getAiriScenarioGeneratorDraftStorageKey(workspaceId),
        JSON.stringify(scenarioDraft)
      );
    } catch {
      // Handoff persistence is best effort; the link still opens Airi Create.
    }
  }, [scenarioDraft, workspaceId]);

  const handleOpenBulkCampaignDraft = useCallback(() => {
    if (!bulkCampaignDraft) return;
    try {
      window.localStorage?.setItem(
        getAiriBulkCampaignDraftStorageKey(workspaceId),
        JSON.stringify(bulkCampaignDraft)
      );
    } catch {
      // Handoff persistence is best effort; the link still opens bulk campaigns.
    }
  }, [bulkCampaignDraft, workspaceId]);

  const handleOpenCreativeAssetDrafts = useCallback(() => {
    if (creativeAssetDrafts.length === 0) return;
    try {
      window.localStorage?.setItem(
        getAiriCreativeAssetDraftStorageKey(workspaceId),
        JSON.stringify(creativeAssetDrafts)
      );
    } catch {
      // Handoff persistence is best effort; the link still opens assets.
    }
  }, [creativeAssetDrafts, workspaceId]);

  return (
    <div
      data-testid="airi-campaign-package-card"
      className="mt-4 max-w-xl rounded-[1.35rem] bg-background/90 p-3 text-xs shadow-[0_20px_70px_-48px_rgba(15,23,42,0.85)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase text-muted-foreground">
            {chatT("campaign.label")}
          </p>
          <p className="truncate text-sm font-semibold">{packageDraft.title}</p>
          {artifact ? (
            <p
              data-testid="airi-campaign-artifact-badge"
              className="mt-1 text-[11px] text-muted-foreground"
            >
              {chatT("campaign.savedPlan", {
                revision: artifact.revision,
                status: artifact.status,
              })}
            </p>
          ) : null}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-1 text-[10px] font-medium uppercase",
            blockedSteps > 0
              ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          )}
        >
          {blockedSteps > 0
            ? chatT("campaign.blocked", { count: blockedSteps })
            : chatT("campaign.ready")}
        </span>
      </div>

      <div className="mt-3 grid gap-2 rounded-2xl bg-muted/45 p-3">
        <div>
          <p className="text-[11px] font-medium uppercase text-muted-foreground">
            {chatT("campaign.goal")}
          </p>
          <p className="mt-0.5 text-foreground">{packageDraft.goal}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-medium uppercase text-muted-foreground">
              {chatT("campaign.audience")}
            </p>
            <p className="mt-0.5 text-foreground">{packageDraft.audience}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase text-muted-foreground">
              {chatT("campaign.angle")}
            </p>
            <p className="mt-0.5 text-foreground">{packageDraft.angle}</p>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="rounded-full bg-current/10 px-2 py-0.5 text-muted-foreground">
          {chatT("campaign.toolsReady", { count: availableTools })}
        </span>
        {packageDraft.evidence.slice(0, 2).map(item => (
          <span
            key={item}
            className="max-w-full truncate rounded-full bg-current/10 px-2 py-0.5 text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        {packageDraft.steps.slice(0, 8).map(step => {
          const primaryBlocker = step.blockers?.[0];
          const actionLabel =
            step.status === "blocked"
              ? chatT("campaign.connectTool")
              : chatT("campaign.open");
          return (
            <div
              key={step.id}
              className="grid gap-2 rounded-2xl border border-border/70 bg-background/80 p-3"
            >
              <div className="flex items-start gap-2">
                <CampaignStepIcon status={step.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 font-medium text-foreground">
                      {step.title}
                    </p>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                        campaignStepStatusClass(step.status)
                      )}
                    >
                      {chatT(`campaign.stepStatus.${step.status}`)}
                    </span>
                  </div>
                  <p className="mt-1 leading-5 text-muted-foreground">
                    {step.description}
                  </p>
                  {primaryBlocker ? (
                    <p className="mt-1 leading-5 text-amber-700 dark:text-amber-300">
                      {primaryBlocker}
                    </p>
                  ) : null}
                </div>
              </div>
              {step.actionHref ? (
                <a
                  href={step.actionHref}
                  className="ml-6 inline-flex w-fit items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-muted/70"
                >
                  {actionLabel}
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-3 rounded-2xl bg-muted/45 px-3 py-2">
        <p className="text-[11px] font-medium uppercase text-muted-foreground">
          {chatT("campaign.nextAction")}
        </p>
        <p className="mt-0.5 text-foreground">{packageDraft.nextAction}</p>
        {scenarioDraft ||
        bulkCampaignDraft ||
        creativeAssetDrafts.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {scenarioDraft ? (
              <a
                href={scenarioDraftHref}
                onClick={handleOpenScenarioDraft}
                className="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition hover:bg-primary/90"
              >
                {chatT("campaign.openInAiriCreate")}
                <ExternalLink className="size-3" />
              </a>
            ) : null}
            {bulkCampaignDraft ? (
              <a
                href={bulkCampaignDraftHref}
                onClick={handleOpenBulkCampaignDraft}
                className="inline-flex w-fit items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[11px] font-medium text-background transition hover:bg-foreground/90"
              >
                {chatT("campaign.openBulkDraft")}
                <ExternalLink className="size-3" />
              </a>
            ) : null}
            {creativeAssetDrafts.length > 0 ? (
              <a
                href={creativeAssetDraftHref}
                onClick={handleOpenCreativeAssetDrafts}
                className="inline-flex w-fit items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-[11px] font-medium text-foreground transition hover:bg-muted/70"
              >
                {chatT("campaign.openAssetDrafts")}
                <ExternalLink className="size-3" />
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MessageCampaignPackage({
  metadata,
  workspaceId,
}: {
  metadata?: Record<string, unknown> | null;
  workspaceId: string;
}) {
  const packageDraft = getMessageCampaignPackage(metadata);
  if (!packageDraft) return null;
  const artifact = getMessageCampaignArtifact(metadata);
  const scenarioDraft = getMessageScenarioGeneratorDraft(metadata);
  const bulkCampaignDraft = getMessageBulkCampaignDraft(metadata);
  const creativeAssetDrafts = getMessageCreativeAssetDrafts(metadata);
  return (
    <CampaignPackageCard
      packageDraft={packageDraft}
      artifact={artifact}
      scenarioDraft={scenarioDraft}
      bulkCampaignDraft={bulkCampaignDraft}
      creativeAssetDrafts={creativeAssetDrafts}
      workspaceId={workspaceId}
    />
  );
}

function opportunityPriorityClass(
  priority: AiriOpportunityScan["opportunities"][number]["priority"]
): string {
  if (priority === "high") {
    return "border-rose-500/25 bg-rose-500/[0.06] text-rose-700 dark:text-rose-200";
  }
  if (priority === "medium") {
    return "border-amber-500/25 bg-amber-500/[0.07] text-amber-700 dark:text-amber-200";
  }
  return "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-200";
}

function MessageOpportunityScan({
  metadata,
}: {
  metadata?: Record<string, unknown> | null;
}) {
  const scan = getMessageOpportunityScan(metadata);
  if (!scan) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border bg-background/85 text-left shadow-[0_18px_60px_-44px_rgba(15,23,42,0.75)]">
      <div className="border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Opportunity scan
            </div>
            <div className="mt-1 text-sm font-semibold">{scan.title}</div>
          </div>
          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
            {scan.opportunities.length} item
            {scan.opportunities.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{scan.summary}</p>
      </div>
      <div className="divide-y">
        {scan.opportunities.map(opportunity => (
          <div key={opportunity.id} className="space-y-3 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 text-sm font-semibold">
                {opportunity.title}
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
                  opportunityPriorityClass(opportunity.priority)
                )}
              >
                {opportunity.priority}
              </span>
            </div>
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div>
                <div className="font-medium text-foreground/80">Signal</div>
                <div>{opportunity.customerSignal}</div>
              </div>
              <div>
                <div className="font-medium text-foreground/80">Action</div>
                <div>{opportunity.recommendedAction}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {opportunity.recommendedArtifacts.map(artifact => (
                <span
                  key={artifact}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {artifact.replaceAll("_", " ")}
                </span>
              ))}
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              {opportunity.evidence.slice(0, 3).map(item => (
                <div key={item} className="flex gap-2">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
            {opportunity.missingInputs.length > 0 ? (
              <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                Missing: {opportunity.missingInputs.join(", ")}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        Next: {scan.nextAction}
      </div>
    </div>
  );
}

function ResourceReceipt({
  metadata,
}: {
  metadata?: Record<string, unknown> | null;
}) {
  const receipt = getMessageReceipt(metadata);
  const [open, setOpen] = useState(false);
  if (!receipt) return null;

  const kbCount =
    receipt.resources.find(resource => resource.id === "knowledge-base")
      ?.count ?? 0;
  const chatCount =
    receipt.resources.find(resource => resource.id === "customer-chats")
      ?.count ?? 0;
  const summary =
    kbCount > 0 || chatCount > 0
      ? `Used ${kbCount} KB articles and ${chatCount} chats`
      : "No matching workspace context found";

  return (
    <div className="mt-3 rounded-2xl bg-background/70 text-xs text-muted-foreground shadow-[0_12px_38px_-34px_rgba(15,23,42,0.65)]">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        onClick={() => setOpen(current => !current)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
          <span className="truncate">{summary}</span>
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="space-y-1 px-3 pb-3">
          {receipt.resources.slice(0, 8).map(resource => (
            <div
              key={resource.id}
              className="flex items-center justify-between gap-3"
            >
              <span className="truncate">{resource.label}</span>
              <span className="shrink-0">{resourceCountText(resource)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="truncate">Model</span>
            <span className="shrink-0 truncate">{receipt.model || "none"}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="truncate">Duration</span>
            <span className="shrink-0">{receipt.durationMs}ms</span>
          </div>
          {receipt.retryable ? (
            <div className="text-amber-600">Provider was busy; retryable.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AiriThreadRow({
  thread,
  mobile = false,
  disabled = false,
  selected,
  relativeNow,
  onSelect,
  onTogglePinned,
  onArchive,
}: {
  thread: AiriChatThread;
  mobile?: boolean;
  disabled?: boolean;
  selected: boolean;
  relativeNow: number;
  onSelect: (threadId: string) => void;
  onTogglePinned: (thread: AiriChatThread) => void | Promise<void>;
  onArchive: (threadId: string) => void | Promise<void>;
}) {
  const chatT = useTranslations("AiriChat");
  const pinLabel = thread.pinnedAt ? chatT("unpinChat") : chatT("pinChat");
  return (
    <div
      className={cn(
        "group relative flex h-9 min-w-0 items-center rounded-lg px-2",
        selected ? "bg-muted/70" : "hover:bg-muted/50",
        mobile && "h-12 rounded-xl px-0 hover:bg-transparent"
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        disabled={disabled}
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50"
      >
        {!mobile ? (
          <MessageSquare
            className={cn(
              "size-4 shrink-0 text-muted-foreground",
              selected && "text-foreground"
            )}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {thread.title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground group-hover:opacity-0 group-focus-within:opacity-0">
          {formatCompactRelativeTime(thread.updatedAt, relativeNow)}
        </span>
      </button>
      <div className="absolute right-1 hidden items-center gap-0.5 rounded-md bg-background/95 p-0.5 shadow-sm group-hover:flex group-focus-within:flex">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={pinLabel}
          title={pinLabel}
          onClick={() => void onTogglePinned(thread)}
        >
          <Pin
            className={cn(
              "size-3",
              thread.pinnedAt && "fill-current text-foreground"
            )}
          />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={chatT("archiveChat")}
          disabled={disabled}
          title={chatT("archiveChat")}
          onClick={() => void onArchive(thread.id)}
        >
          <Archive className="size-3" />
        </Button>
      </div>
      {mobile ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={chatT("chatActions")}
              className="ml-1 size-8 shrink-0 rounded-full"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void onTogglePinned(thread)}>
              {pinLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={disabled}
              onClick={() => void onArchive(thread.id)}
            >
              {chatT("archiveChat")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

type AiriThreadContentViewState = {
  builderOpen: boolean;
  hasModalClose: boolean;
  error: string | null;
  /** Retries what `error` reports, when it is a failed load. */
  onRetryError: (() => void) | null;
  showEmptyThread: boolean;
  isLoadingMessages: boolean;
  messagesLoadFailed: boolean;
  onRetryMessages: () => void;
  sendBlocked: boolean;
  showOnboardingQuickActions: boolean;
  isSending: boolean;
  isLoadingPrefetchedSources: boolean;
  prefetchedSourceError: string | null;
};

function getAiriStartIconSourceIds(
  context: AiriStartContext,
  preferredTypes: string[],
  max = 3
): string[] {
  const ids: string[] = [];
  for (const sourceType of preferredTypes) {
    if (!context.sourceTypes.has(sourceType)) continue;
    if (!getIntegrationById(sourceType)) continue;
    ids.push(sourceType);
    if (ids.length >= max) break;
  }
  return ids;
}

function AiriStartSourceMarks({ sourceIds }: { sourceIds: string[] }) {
  const integrations = sourceIds
    .map(id => getIntegrationById(id))
    .filter((integration): integration is NonNullable<typeof integration> =>
      Boolean(integration)
    )
    .slice(0, 3);

  if (integrations.length === 0) return null;

  return (
    <span className="flex items-center -space-x-1.5">
      {integrations.map(integration => {
        const sharedClassName =
          "size-4 rounded-[5px] bg-background object-contain ring-1 ring-border/70";
        if (integration.icon.light === integration.icon.dark) {
          return (
            <IntegrationIcon
              key={integration.id}
              integration={integration}
              alt=""
              theme="light"
              className={sharedClassName}
            />
          );
        }
        return (
          <span key={integration.id} className="relative size-4 shrink-0">
            <IntegrationIcon
              integration={integration}
              alt=""
              theme="light"
              className={cn(sharedClassName, "dark:hidden")}
            />
            <IntegrationIcon
              integration={integration}
              alt=""
              theme="dark"
              className={cn(sharedClassName, "hidden dark:block")}
            />
          </span>
        );
      })}
    </span>
  );
}

function AiriStartCardIcon({ card }: { card: AiriStartCard }) {
  const sourceIds = (card.iconSourceIds ?? []).filter(id =>
    Boolean(getIntegrationById(id))
  );
  if (sourceIds.length > 0) {
    return <AiriStartSourceMarks sourceIds={sourceIds} />;
  }
  if (card.id === "knowledge-data") return <BookOpen className="size-4" />;
  if (card.id === "product-capabilities") {
    return <AlertCircle className="size-4" />;
  }
  if (card.id === "bulk-campaign") return <Megaphone className="size-4" />;
  if (card.id === "follow-up-scenario") return <Workflow className="size-4" />;
  if (card.id === "avatar-video") return <Video className="size-4" />;
  if (card.tone === "data") return <BarChart3 className="size-4" />;
  if (card.tone === "whatsapp") return <MessageSquare className="size-4" />;
  return <Sparkles className="size-4" />;
}

function airiStartCardToneClass(tone: AiriStartCardTone): string {
  if (tone === "data") {
    return "border-emerald-500/20 bg-emerald-500/[0.06] hover:bg-emerald-500/[0.09]";
  }
  if (tone === "whatsapp") {
    return "border-teal-500/20 bg-teal-500/[0.055] hover:bg-teal-500/[0.085]";
  }
  if (tone === "campaign") {
    return "border-rose-500/20 bg-rose-500/[0.055] hover:bg-rose-500/[0.085]";
  }
  return "border-sky-500/20 bg-sky-500/[0.055] hover:bg-sky-500/[0.085]";
}

function AiriStartBentoGrid({
  cards,
  disabled,
  compact = false,
  onRunPrompt,
}: {
  cards: AiriStartCard[];
  disabled: boolean;
  compact?: boolean;
  onRunPrompt: (card: AiriStartCard) => void;
}) {
  const chatT = useTranslations("AiriChat");
  if (compact) {
    return (
      <div
        className="w-full space-y-2 text-center"
        aria-label={chatT("suggestedActionsLabel")}
      >
        <div className="text-xs font-medium text-muted-foreground">
          {chatT("tryAiriFor")}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {cards.slice(0, 6).map(card => (
            <Button
              key={card.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              className="h-7 max-w-full rounded-md bg-background px-2 text-[13px] font-medium leading-none shadow-xs"
              onClick={() => onRunPrompt(card)}
            >
              <span className="max-w-52 truncate">
                {card.compactTitle ?? card.title}
              </span>
              {card.metric ? (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  {card.metric}
                </span>
              ) : null}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="grid w-full grid-cols-1 gap-2 text-left sm:grid-cols-2 xl:grid-cols-3"
      aria-label={chatT("suggestedActionsLabel")}
    >
      {cards.map((card, index) => (
        <Button
          key={card.id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "group flex h-auto min-h-28 flex-col items-stretch justify-between whitespace-normal rounded-lg border p-3 text-left shadow-[0_18px_54px_-46px_rgba(15,23,42,0.75)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60",
            airiStartCardToneClass(card.tone),
            index === 0 && card.metric && "sm:col-span-2 xl:col-span-1"
          )}
          onClick={() => onRunPrompt(card)}
        >
          <span className="flex items-start justify-between gap-3">
            <span>
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {card.eyebrow}
              </span>
              <span className="mt-1 block text-sm font-semibold text-foreground">
                {card.title}
              </span>
            </span>
            <span
              className={cn(
                "grid h-8 shrink-0 place-items-center rounded-md bg-background/75 px-1.5 text-muted-foreground shadow-sm transition group-hover:text-foreground",
                (card.iconSourceIds?.length ?? 0) > 1 ? "min-w-10" : "min-w-8"
              )}
            >
              <AiriStartCardIcon card={card} />
            </span>
          </span>
          <span className="mt-3 flex items-end justify-between gap-3">
            <span className="max-w-[15rem] text-xs leading-5 text-muted-foreground">
              {card.description}
            </span>
            {card.metric ? (
              <span className="shrink-0 text-right">
                <span className="block text-xl font-semibold leading-none">
                  {card.metric}
                </span>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  {card.metricLabel}
                </span>
              </span>
            ) : null}
          </span>
        </Button>
      ))}
    </div>
  );
}

function AiriRecentChats({
  workspaceId,
  threads,
  relativeNow,
  onSelectThread,
}: {
  workspaceId: string;
  threads: AiriChatThread[];
  relativeNow: number;
  onSelectThread: (threadId: string) => void;
}) {
  const chatT = useTranslations("AiriChat");
  if (threads.length === 0) return null;

  return (
    <div className="w-full text-left">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">
          {chatT("recentChats")}
        </h3>
        <Button
          asChild
          variant="link"
          size="sm"
          className="h-auto px-0 text-sm font-medium text-foreground"
        >
          <Link href={`/panel/w/${workspaceId}/airi`}>{chatT("viewAll")}</Link>
        </Button>
      </div>
      <div className="space-y-1">
        {threads.slice(0, 4).map(thread => (
          <button
            key={thread.id}
            type="button"
            className="flex h-8 w-full min-w-0 items-center justify-between gap-3 rounded-md px-0 text-left text-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelectThread(thread.id)}
          >
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
            <span className="shrink-0 text-muted-foreground">
              {formatCompactRelativeTime(thread.updatedAt, relativeNow)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AiriPageSidePanel({
  workspaceId,
  startCards,
  threads,
  relativeNow,
  disabled,
  onRunPrompt,
  onSelectThread,
  onNewChat,
  onClose,
}: {
  workspaceId: string;
  startCards: AiriStartCard[];
  threads: AiriChatThread[];
  relativeNow: number;
  disabled: boolean;
  onRunPrompt: (card: AiriStartCard) => void;
  onSelectThread: (threadId: string) => void;
  onNewChat: () => void;
  onClose: () => void;
}) {
  const chatT = useTranslations("AiriChat");
  return (
    <aside
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background dark:bg-black"
      aria-label={chatT("toolsTitle")}
      data-testid="airi-page-side-panel"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b py-0 pl-3 pr-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {chatT("toolsTitle")}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          aria-label={chatT("toggleSidePanel")}
          onClick={onClose}
        >
          <PanelRightClose data-icon="icon" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <section
          className="space-y-2"
          aria-label={chatT("suggestedActionsLabel")}
        >
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {chatT("suggestedActions")}
          </div>
          <div className="space-y-2">
            {startCards.slice(0, 10).map(card => (
              <Button
                key={card.id}
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                className="h-8 w-full justify-between gap-3 rounded-md bg-background px-2 text-left text-[13px] font-medium shadow-xs"
                onClick={() => onRunPrompt(card)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {card.compactTitle ?? card.title}
                </span>
                {card.metric ? (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                    {card.metric}
                  </span>
                ) : null}
              </Button>
            ))}
          </div>
        </section>

        <section className="space-y-2" aria-label={chatT("chatActionsLabel")}>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {chatT("chatSection")}
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 w-full justify-start rounded-md px-2 text-[13px]"
            onClick={onNewChat}
          >
            {chatT("newAiriChat")}
          </Button>
        </section>

        {threads.length > 0 ? (
          <section className="space-y-2" aria-label={chatT("recentChatsLabel")}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {chatT("recentChats")}
              </div>
              <Button
                asChild
                variant="link"
                size="sm"
                className="h-auto px-0 text-xs font-medium"
              >
                <Link href={`/panel/w/${workspaceId}/airi`}>
                  {chatT("viewAll")}
                </Link>
              </Button>
            </div>
            <div className="space-y-1">
              {threads.slice(0, 6).map(thread => (
                <button
                  key={thread.id}
                  type="button"
                  className="flex h-8 w-full min-w-0 items-center justify-between gap-3 rounded-md px-1 text-left text-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onSelectThread(thread.id)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {thread.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatCompactRelativeTime(thread.updatedAt, relativeNow)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function AiriEmptyThreadStart({
  workspaceId,
  isSending,
  compact = false,
  showOnboardingQuickActions,
  startCards,
  recentThreads,
  relativeNow,
  onMarkOnboardingQuickActionsSeen,
  onSelectThread,
  onSendMessage,
}: {
  workspaceId: string;
  isSending: boolean;
  compact?: boolean;
  showOnboardingQuickActions: boolean;
  startCards: AiriStartCard[];
  recentThreads: AiriChatThread[];
  relativeNow: number;
  onMarkOnboardingQuickActionsSeen: () => void;
  onSelectThread: (threadId: string) => void;
  onSendMessage: SendAiriMessageHandler;
}) {
  const chatT = useTranslations("AiriChat");
  const runPrompt = (card: AiriStartCard) => {
    if (showOnboardingQuickActions) {
      onMarkOnboardingQuickActionsSeen();
    }
    void onSendMessage(card.prompt, card.selectedSources ?? [], []);
  };

  return (
    <div
      className={cn(
        "mx-auto flex w-full min-w-0 flex-col items-center text-center",
        compact
          ? "min-h-full max-w-[400px] justify-between gap-6 px-3 pb-3 pt-6"
          : "max-w-4xl gap-5"
      )}
    >
      <div
        className={cn(
          "flex w-full flex-col items-center",
          compact ? "gap-4" : "gap-5"
        )}
      >
        <div
          className={cn(
            "flex items-center justify-center bg-[#cfffe1] text-foreground shadow-[0_14px_40px_-28px_rgba(15,23,42,0.8)] dark:bg-emerald-400/25 dark:text-emerald-100",
            compact ? "size-9 rounded-xl" : "size-11 rounded-2xl"
          )}
        >
          <Sparkles className={compact ? "size-4" : "size-5"} />
        </div>
        <div className="space-y-2">
          <h2
            className={cn(
              "text-balance font-semibold leading-tight",
              compact ? "text-xl" : "text-2xl"
            )}
          >
            {chatT("emptyTitle")}
          </h2>
          <p className="text-balance text-sm text-muted-foreground">
            {chatT("emptyDescription")}
          </p>
        </div>
        <AiriStartBentoGrid
          cards={startCards}
          disabled={isSending}
          compact={compact}
          onRunPrompt={runPrompt}
        />
      </div>
      {compact ? (
        <AiriRecentChats
          workspaceId={workspaceId}
          threads={recentThreads}
          relativeNow={relativeNow}
          onSelectThread={onSelectThread}
        />
      ) : null}
    </div>
  );
}

function AiriThreadLoadingSkeleton() {
  const chatT = useTranslations("AiriChat");
  return (
    <div
      data-testid="airi-thread-loading-skeleton"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-2"
      aria-label={chatT("loadingMessages")}
    >
      <div className="flex justify-end">
        <Skeleton className="h-16 w-[72%] rounded-2xl" />
      </div>
      <div className="flex justify-start">
        <Skeleton className="h-24 w-[82%] rounded-2xl" />
      </div>
      <div className="flex justify-start">
        <Skeleton className="h-12 w-[58%] rounded-2xl" />
      </div>
    </div>
  );
}

type AiriChatMessageRowProps = {
  message: AiriChatMessage;
  workspaceId: string;
  relativeNow: number;
  confirmingMetaMcpMutationId?: string | null;
  onOpenTemplateDraftInBuilder: (draft: AiriWhatsAppTemplateDraft) => void;
  onReviewMetaMcpMutation?: ReviewMetaMcpMutationHandler;
  onOpenMetaMcpReconciliation?: OpenMetaMcpReconciliationHandler;
};

/**
 * One chat message. Memoized: a run event or a streamed answer re-renders
 * the thread, not every earlier message and its cards (whose metadata is
 * parsed once per message, see airi-chat-message-metadata.ts).
 */
const AiriChatMessageRow = memo(function AiriChatMessageRow({
  message,
  workspaceId,
  relativeNow,
  confirmingMetaMcpMutationId,
  onOpenTemplateDraftInBuilder,
  onReviewMetaMcpMutation,
  onOpenMetaMcpReconciliation,
}: AiriChatMessageRowProps) {
  const chatT = useTranslations("AiriChat");
  const isAssistant = message.role === "assistant";
  const stopped = isAssistant && isAiriChatMessageStopped(message.metadata);
  return (
    <div
      className={cn(
        "flex",
        message.role === "user" ? "justify-end" : "justify-start"
      )}
    >
      <div
        className={cn(
          "min-w-0 max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-[0_12px_36px_-32px_rgba(15,23,42,0.6)] [overflow-wrap:anywhere]",
          message.role === "user"
            ? "bg-primary text-primary-foreground"
            : "bg-muted/55"
        )}
      >
        {isAssistant ? (
          <AiriMarkdown content={message.content} />
        ) : (
          <p className="whitespace-pre-wrap">{message.content}</p>
        )}
        {stopped ? (
          <p
            data-testid="airi-answer-stopped"
            className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <CircleStop aria-hidden="true" className="size-3.5 shrink-0" />
            {chatT("answerStopped")}
          </p>
        ) : null}
        {isAssistant ? (
          <MessageWhatsAppTemplateDraft
            metadata={message.metadata}
            workspaceId={workspaceId}
            onOpenInBuilder={onOpenTemplateDraftInBuilder}
          />
        ) : null}
        {isAssistant ? (
          <MessageOpportunityScan metadata={message.metadata} />
        ) : null}
        {isAssistant ? (
          <MessageCampaignPackage
            metadata={message.metadata}
            workspaceId={workspaceId}
          />
        ) : null}
        {isAssistant ? (
          <MessageGeneratedAssets
            metadata={message.metadata}
            workspaceId={workspaceId}
          />
        ) : null}
        <MessageSourceReceipt metadata={message.metadata} />
        <MessagePendingActions
          messageId={message.id}
          metadata={message.metadata}
          relativeNow={relativeNow}
          confirmingMutationId={confirmingMetaMcpMutationId}
          onReviewMetaMcpMutation={onReviewMetaMcpMutation}
          onOpenMetaMcpReconciliation={onOpenMetaMcpReconciliation}
        />
        {isAssistant ? <ResourceReceipt metadata={message.metadata} /> : null}
      </div>
    </div>
  );
});

/** "Load earlier" above a chat's oldest loaded message. */
function AiriLoadEarlierMessages({
  status,
  onLoad,
}: {
  status: "idle" | "loading" | "failed";
  onLoad: () => void;
}) {
  const chatT = useTranslations("AiriChat");
  const loading = status === "loading";
  return (
    <div
      data-testid="airi-load-earlier"
      className="flex flex-col items-center gap-1 text-center"
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 max-w-full gap-1.5 whitespace-normal px-3 text-xs text-muted-foreground"
        disabled={loading}
        aria-busy={loading || undefined}
        onClick={onLoad}
      >
        {loading ? (
          <Loader2
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          />
        ) : null}
        {loading ? chatT("loadingEarlier") : chatT("loadEarlier")}
      </Button>
      {status === "failed" ? (
        <p role="alert" className="text-xs text-destructive">
          {chatT("loadEarlierFailed")}
        </p>
      ) : null}
    </div>
  );
}

function AiriThreadContent({
  workspaceId,
  compact = false,
  viewState,
  messages,
  earlierMessages,
  stopControl,
  liveRunEvents,
  streamingAnswerText,
  startCards,
  recentThreads,
  relativeNow,
  prefetchedSourceOptions,
  confirmingMetaMcpMutationId,
  onToggleBuilder,
  onSourcesRefresh,
  onMarkOnboardingQuickActionsSeen,
  onSelectThread,
  onSendMessage,
  onOpenTemplateDraftInBuilder,
  onReviewMetaMcpMutation,
  onOpenMetaMcpReconciliation,
}: {
  workspaceId: string;
  compact?: boolean;
  viewState: AiriThreadContentViewState;
  messages: AiriChatMessage[];
  /** Older messages to load above the first one, when there are any. */
  earlierMessages?: {
    hasMore: boolean;
    status: "idle" | "loading" | "failed";
    onLoad: () => void;
  };
  /** The composer's Stop while a run answers in this chat. */
  stopControl?: { canStop: boolean; stopping: boolean; onStop: () => void };
  liveRunEvents: AiriChatRunEvent[];
  /** The answer text streamed so far, until the final message replaces it. */
  streamingAnswerText: string | null;
  startCards: AiriStartCard[];
  recentThreads: AiriChatThread[];
  relativeNow: number;
  prefetchedSourceOptions: AiriChatSourceOption[];
  confirmingMetaMcpMutationId?: string | null;
  onToggleBuilder: () => void;
  onSourcesRefresh?: () => void;
  onMarkOnboardingQuickActionsSeen: () => void;
  onSelectThread: (threadId: string) => void;
  onSendMessage: SendAiriMessageHandler;
  onOpenTemplateDraftInBuilder: (draft: AiriWhatsAppTemplateDraft) => void;
  onReviewMetaMcpMutation?: ReviewMetaMcpMutationHandler;
  onOpenMetaMcpReconciliation?: OpenMetaMcpReconciliationHandler;
}) {
  const chatT = useTranslations("AiriChat");
  const {
    builderOpen,
    hasModalClose,
    error,
    onRetryError,
    showEmptyThread,
    isLoadingMessages,
    messagesLoadFailed,
    onRetryMessages,
    sendBlocked,
    showOnboardingQuickActions,
    isSending,
    isLoadingPrefetchedSources,
    prefetchedSourceError,
  } = viewState;
  const showMessages =
    !showEmptyThread && !isLoadingMessages && !messagesLoadFailed;
  const conversationRef = useRef<StickToBottomContext | null>(null);
  const sendAndFollow = useCallback(
    (...args: Parameters<typeof onSendMessage>) => {
      // The conversation follows new output only while the reader is at the
      // bottom; sending a turn brings them back there.
      void conversationRef.current?.scrollToBottom();
      return onSendMessage(...args);
    },
    [onSendMessage]
  );

  return (
    <>
      {!builderOpen && !hasModalClose ? (
        <div
          className={cn(
            "absolute top-2 z-20 flex",
            !compact && "hidden lg:flex",
            "right-3"
          )}
        >
          <BuilderToggleButton open={builderOpen} onToggle={onToggleBuilder} />
        </div>
      ) : null}
      {error && !messagesLoadFailed ? (
        <div
          role="alert"
          className="mx-3 mt-2 flex items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive shadow-sm"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {error}
          </span>
          {onRetryError ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={onRetryError}
            >
              {chatT("retry")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {showMessages ? (
        <Conversation
          contextRef={conversationRef}
          aria-label={chatT("conversationLabel")}
          className="min-h-0 min-w-0 flex-1"
        >
          <ConversationContent className="px-4 py-4">
            <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
              {earlierMessages?.hasMore ? (
                <AiriLoadEarlierMessages
                  status={earlierMessages.status}
                  onLoad={earlierMessages.onLoad}
                />
              ) : null}
              {messages.map(message => (
                <AiriChatMessageRow
                  key={message.id}
                  message={message}
                  workspaceId={workspaceId}
                  relativeNow={relativeNow}
                  confirmingMetaMcpMutationId={confirmingMetaMcpMutationId}
                  onOpenTemplateDraftInBuilder={onOpenTemplateDraftInBuilder}
                  onReviewMetaMcpMutation={onReviewMetaMcpMutation}
                  onOpenMetaMcpReconciliation={onOpenMetaMcpReconciliation}
                />
              ))}
              {streamingAnswerText ? (
                <div className="flex justify-start">
                  <div
                    data-testid="airi-streaming-answer"
                    // Inside the conversation log; the text is replaced up
                    // to 12 times a second. aria-busy alone is ignored by
                    // some screen readers, so this subtree is not a live
                    // region; the final message is the one announcement.
                    aria-live="off"
                    aria-busy="true"
                    className="min-w-0 max-w-[86%] rounded-2xl bg-muted/55 px-4 py-3 text-sm leading-6 shadow-[0_12px_36px_-32px_rgba(15,23,42,0.6)] [overflow-wrap:anywhere]"
                  >
                    <AiriMarkdown content={streamingAnswerText} />
                  </div>
                </div>
              ) : null}
              {hasVisibleAiriChatRunProgress(isSending, liveRunEvents) ? (
                <AiriChatRunProgress events={liveRunEvents} />
              ) : null}
            </div>
          </ConversationContent>
          <ConversationScrollButton
            aria-label={chatT("scrollToLatest")}
            className="bottom-3"
          />
        </Conversation>
      ) : (
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable_both-edges]",
            showEmptyThread &&
              (compact
                ? "flex py-0 [scrollbar-gutter:auto]"
                : "grid place-items-center py-8")
          )}
        >
          {isLoadingMessages ? (
            compact ? (
              <AiriThreadLoadingSkeleton />
            ) : (
              <div className="flex min-h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
                Loading messages...
              </div>
            )
          ) : null}

          {messagesLoadFailed ? (
            <div
              role="alert"
              className="mx-auto flex min-h-full max-w-sm flex-col items-center justify-center gap-3 py-8 text-center text-sm text-muted-foreground"
            >
              <AlertCircle className="size-5 text-destructive" />
              <p className="[overflow-wrap:anywhere]">
                {error || chatT("messagesLoadFailed")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onRetryMessages}
              >
                {chatT("retry")}
              </Button>
            </div>
          ) : null}

          {showEmptyThread ? (
            <AiriEmptyThreadStart
              workspaceId={workspaceId}
              isSending={isSending}
              compact={compact}
              showOnboardingQuickActions={showOnboardingQuickActions}
              startCards={startCards}
              recentThreads={recentThreads}
              relativeNow={relativeNow}
              onMarkOnboardingQuickActionsSeen={
                onMarkOnboardingQuickActionsSeen
              }
              onSelectThread={onSelectThread}
              onSendMessage={onSendMessage}
            />
          ) : null}
        </div>
      )}

      <AiriChatComposer
        workspaceId={workspaceId}
        disabled={isSending || (compact && builderOpen)}
        sendDisabled={sendBlocked}
        autoFocus={!compact || !builderOpen}
        variant={compact ? "compact" : "dock"}
        className={cn("min-w-0 shrink-0", compact && "px-3 py-3")}
        placeholder={chatT("askAiri")}
        prefetchedSourceOptions={prefetchedSourceOptions}
        isLoadingPrefetchedSources={isLoadingPrefetchedSources}
        prefetchedSourceError={prefetchedSourceError}
        onSourcesRefresh={onSourcesRefresh}
        onSend={sendAndFollow}
        running={Boolean(stopControl?.canStop)}
        stopping={stopControl?.stopping}
        onStop={stopControl?.onStop}
      />
    </>
  );
}

function threadMatchesSearch(thread: AiriChatThread, query: string) {
  if (!query.trim()) return true;
  return thread.title.toLowerCase().includes(query.trim().toLowerCase());
}

function hasVisibleAiriChatRunProgress(
  isSending: boolean,
  events: AiriChatRunEvent[]
) {
  return isSending || events.length > 0;
}

function createAiriStartMetricFormatter(locale: string) {
  const formatter = new Intl.NumberFormat(locale === "kz" ? "kk-KZ" : locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  return (value: number) => formatter.format(value);
}

function airiStartCardCopy(
  chatT: AiriChatTranslator,
  id: string
): Pick<
  AiriStartCard,
  "id" | "title" | "description" | "prompt" | "eyebrow" | "compactTitle"
> {
  const key = `start.cards.${id}`;
  return {
    id,
    title: chatT(`${key}.title`),
    description: chatT(`${key}.description`),
    prompt: chatT(`${key}.prompt`),
    eyebrow: chatT(`${key}.eyebrow`),
    compactTitle: chatT.has(`${key}.compactTitle`)
      ? chatT(`${key}.compactTitle`)
      : undefined,
  };
}

function sourceOptionCount(
  sourceOptions: AiriChatSourceOption[],
  optionIds: string[]
): number {
  const optionIdSet = new Set(optionIds);
  return sourceOptions.reduce((total, option) => {
    if (
      !("ref" in option) ||
      option.ref.kind !== "context" ||
      !optionIdSet.has(option.ref.optionId)
    ) {
      return total;
    }
    return total + Math.max(0, Number(option.count || 0));
  }, 0);
}

function connectedSourceCount(sourceOptions: AiriChatSourceOption[]): number {
  return sourceOptions.filter(option => {
    if (!("ref" in option) || option.disabled) return false;
    const { kind } = option.ref;
    return (
      kind === "connector" ||
      kind === "channel_source" ||
      kind === "workspace_source"
    );
  }).length;
}

function getAiriStartSourceRefsByType(
  sourceOptions: AiriChatSourceOption[]
): Map<string, AiriChatSourceRef[]> {
  const sourceRefsByType = new Map<string, AiriChatSourceRef[]>();
  const append = (sourceType: string, ref: AiriChatSourceRef) => {
    const current = sourceRefsByType.get(sourceType) ?? [];
    sourceRefsByType.set(sourceType, [...current, ref]);
  };
  for (const option of sourceOptions) {
    if (!("ref" in option) || option.disabled) continue;
    const { ref } = option;
    if (ref.kind === "connector" && ref.connector === "whatsapp") {
      append("whatsapp", ref);
    }
    if (ref.kind === "workspace_source" || ref.kind === "channel_source") {
      append(String(ref.sourceType), ref);
    }
  }
  return sourceRefsByType;
}

function countMatchingSourceTypes(
  sourceTypes: Set<string>,
  match: Set<string>
): number {
  let count = 0;
  sourceTypes.forEach(sourceType => {
    if (match.has(sourceType)) count += 1;
  });
  return count;
}

function buildAiriStartContext(params: {
  sourceOptions: AiriChatSourceOption[];
  conversationCount: number;
  knowledgeCount: number;
  quickReplyCount: number;
  hasWanAvatar?: boolean;
}): AiriStartContext {
  const sourceRefsByType = getAiriStartSourceRefsByType(params.sourceOptions);
  const sourceTypes = new Set(sourceRefsByType.keys());
  const conversationChannelCount = countMatchingSourceTypes(
    sourceTypes,
    AIRI_CONVERSATION_SOURCE_TYPES
  );
  const creativeToolCount =
    countMatchingSourceTypes(sourceTypes, AIRI_CREATIVE_SOURCE_TYPES) +
    (params.hasWanAvatar ? 1 : 0);
  return {
    sourceTypes,
    sourceRefsByType,
    connectedCount: connectedSourceCount(params.sourceOptions),
    conversationChannelCount,
    creativeToolCount,
    hasWhatsApp: sourceTypes.has("whatsapp"),
    hasMetaAds: sourceTypes.has("meta_ads"),
    metaAdsSkill: params.sourceOptions.find(
      (option): option is Extract<AiriChatSourceOption, { type?: "source" }> =>
        option.type !== "action" &&
        option.ref.kind === "skill" &&
        option.ref.skillId === "meta"
    ),
    hasWanAvatar: Boolean(params.hasWanAvatar),
    hasDataContext:
      params.conversationCount > 0 ||
      params.knowledgeCount > 0 ||
      params.quickReplyCount > 0 ||
      conversationChannelCount > 0,
  };
}

function appendAiriStartCard(
  cards: AiriStartCard[],
  card: AiriStartCard
): void {
  if (cards.some(item => item.id === card.id)) return;
  cards.push(card);
}

function hasAiriStartSource(
  context: AiriStartContext,
  sourceType: string
): boolean {
  return context.sourceTypes.has(sourceType);
}

function getFirstAiriStartSourceRef(
  context: AiriStartContext,
  sourceType: string
): AiriChatSourceRef | null {
  return context.sourceRefsByType.get(sourceType)?.[0] ?? null;
}

function getAiriStartSourceRefs(
  context: AiriStartContext,
  sourceTypes: string[]
): AiriChatSourceRef[] {
  return uniqueAiriStartSourceRefs(
    sourceTypes.flatMap(
      sourceType => context.sourceRefsByType.get(sourceType) ?? []
    )
  );
}

function uniqueAiriStartSourceRefs(
  refs: Array<AiriChatSourceRef | null | undefined>
): AiriChatSourceRef[] {
  const seen = new Set<string>();
  const output: AiriChatSourceRef[] = [];
  for (const ref of refs) {
    if (!ref) continue;
    const id = buildAiriChatSourceOptionId(ref);
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(ref);
  }
  return output;
}

function buildAiriStartScenarioCards(
  context: AiriStartContext,
  chatT: AiriChatTranslator
): AiriStartCard[] {
  const cards: AiriStartCard[] = [];
  const hasSource = (sourceType: string) =>
    hasAiriStartSource(context, sourceType);

  if (context.hasWhatsApp && hasSource("canva")) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "canva-whatsapp-campaign"),
      tone: "campaign",
      iconSourceIds: ["canva", "whatsapp"],
    });
  }

  if (context.hasWhatsApp && context.hasMetaAds) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "click-to-whatsapp-funnel"),
      tone: "campaign",
      iconSourceIds: ["meta_ads", "whatsapp"],
    });
  }

  if (context.hasWhatsApp && context.hasWanAvatar) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "avatar-whatsapp-campaign"),
      tone: "campaign",
      iconSourceIds: ["whatsapp"],
    });
  }

  if (context.hasMetaAds && context.creativeToolCount > 0) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "meta-ads-creative-pack"),
      tone: "campaign",
      iconSourceIds: [
        "meta_ads",
        ...getAiriStartIconSourceIds(
          context,
          ["canva", "higgsfield", "elevenlabs"],
          2
        ),
      ],
    });
  }

  if (context.hasWhatsApp && hasSource("web_widget")) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "website-lead-whatsapp-nurture"),
      tone: "whatsapp",
      iconSourceIds: ["web_widget", "whatsapp"],
    });
  }

  if (context.hasWhatsApp && hasSource("email")) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "email-whatsapp-reactivation"),
      tone: "campaign",
      iconSourceIds: ["email", "whatsapp"],
    });
  }

  if (hasSource("instagram") && hasSource("canva")) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "instagram-canva-content"),
      tone: "campaign",
      iconSourceIds: ["instagram", "canva"],
    });
  }

  if (hasSource("instagram") && context.hasMetaAds) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "instagram-meta-ads-angle"),
      tone: "campaign",
      iconSourceIds: ["instagram", "meta_ads"],
    });
  }

  if (hasSource("canva") && hasSource("higgsfield")) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "canva-higgsfield-visual-pipeline"),
      tone: "campaign",
      iconSourceIds: ["higgsfield", "canva"],
    });
  }

  if (context.hasWhatsApp && hasSource("higgsfield")) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "higgsfield-whatsapp-media"),
      tone: "whatsapp",
      iconSourceIds: ["higgsfield", "whatsapp"],
    });
  }

  if (context.hasWanAvatar && hasSource("elevenlabs")) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "avatar-voice-video"),
      tone: "campaign",
      iconSourceIds: ["elevenlabs"],
    });
  }

  if (context.hasWhatsApp && hasSource("elevenlabs")) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "voice-whatsapp-follow-up"),
      tone: "whatsapp",
      iconSourceIds: ["elevenlabs", "whatsapp"],
    });
  }

  if (
    hasSource("google_calendar") &&
    (context.hasWhatsApp || hasSource("email"))
  ) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "booking-reminder-flow"),
      tone: "support",
      selectedSources: uniqueAiriStartSourceRefs([
        getFirstAiriStartSourceRef(context, "google_calendar"),
        getFirstAiriStartSourceRef(context, "whatsapp"),
        getFirstAiriStartSourceRef(context, "email"),
      ]),
      iconSourceIds: getAiriStartIconSourceIds(
        context,
        ["google_calendar", "whatsapp", "email"],
        3
      ),
    });
  }

  if (context.hasWhatsApp && context.conversationChannelCount > 0) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "manager-capacity-triage"),
      tone: "support",
      selectedSources: uniqueAiriStartSourceRefs([
        getFirstAiriStartSourceRef(context, "whatsapp"),
        getFirstAiriStartSourceRef(context, "telegram"),
        getFirstAiriStartSourceRef(context, "instagram"),
        getFirstAiriStartSourceRef(context, "email"),
        getFirstAiriStartSourceRef(context, "web_widget"),
      ]),
      iconSourceIds: getAiriStartIconSourceIds(
        context,
        ["whatsapp", "telegram", "instagram", "email", "web_widget"],
        3
      ),
    });
  }

  if (
    context.hasWhatsApp &&
    (hasSource("telegram") || hasSource("instagram"))
  ) {
    appendAiriStartCard(cards, {
      ...airiStartCardCopy(chatT, "cross-channel-whatsapp-follow-up"),
      tone: "whatsapp",
      iconSourceIds: [
        "whatsapp",
        ...getAiriStartIconSourceIds(context, ["telegram", "instagram"], 2),
      ],
    });
  }

  return cards;
}

function buildAiriStartCards(params: {
  sourceOptions: AiriChatSourceOption[];
  threadCount: number;
  hasWanAvatar?: boolean;
  metaT: AiriChatTranslator;
  chatT: AiriChatTranslator;
  locale: string;
}): AiriStartCard[] {
  const { chatT } = params;
  const formatMetric = createAiriStartMetricFormatter(params.locale);
  const airiStartMetric = (label: string, value: number) => ({
    metric: formatMetric(value),
    // A compacted count ("1,5 тыс.") agrees with the thousand, not the raw
    // number, so its label takes the plural form of 1000.
    metricLabel: chatT(`start.metricLabels.${label}`, {
      count: value >= 1000 ? 1000 : value,
    }),
  });
  const conversationCount = sourceOptionCount(params.sourceOptions, [
    "conversation_timeline",
  ]);
  const knowledgeCount = sourceOptionCount(params.sourceOptions, [
    "knowledge_base_articles",
    "indexed_public_urls",
    "answer_snippets",
  ]);
  const quickReplyCount = sourceOptionCount(params.sourceOptions, [
    "quick_replies",
  ]);
  const context = buildAiriStartContext({
    sourceOptions: params.sourceOptions,
    conversationCount,
    knowledgeCount,
    quickReplyCount,
    hasWanAvatar: params.hasWanAvatar,
  });
  const dataCards: AiriStartCard[] = [];
  const scenarioCards = buildAiriStartScenarioCards(context, chatT);
  const actionCards: AiriStartCard[] = [];

  if (conversationCount > 0) {
    appendAiriStartCard(dataCards, {
      ...airiStartCardCopy(chatT, "conversation-data"),
      tone: "data",
      ...airiStartMetric("chats", conversationCount),
    });
  }

  if (knowledgeCount > 0) {
    appendAiriStartCard(dataCards, {
      ...airiStartCardCopy(chatT, "knowledge-data"),
      tone: "data",
      ...airiStartMetric("items", knowledgeCount),
    });
  }

  if (quickReplyCount > 0) {
    appendAiriStartCard(dataCards, {
      ...airiStartCardCopy(chatT, "reply-data"),
      tone: "data",
      ...airiStartMetric("replies", quickReplyCount),
    });
  }

  if (context.conversationChannelCount > 0) {
    appendAiriStartCard(dataCards, {
      ...airiStartCardCopy(chatT, "customer-channels"),
      tone: "data",
      selectedSources: getAiriStartSourceRefs(context, [
        "whatsapp",
        "telegram",
        "instagram",
        "email",
        "web_widget",
        "intercom",
      ]),
      iconSourceIds: getAiriStartIconSourceIds(
        context,
        ["whatsapp", "telegram", "instagram", "email", "web_widget"],
        3
      ),
      ...airiStartMetric("channels", context.conversationChannelCount),
    });
  }

  if (context.creativeToolCount > 0) {
    appendAiriStartCard(dataCards, {
      ...airiStartCardCopy(chatT, "creative-stack"),
      tone: "campaign",
      iconSourceIds: getAiriStartIconSourceIds(
        context,
        ["canva", "higgsfield", "elevenlabs"],
        3
      ),
      ...airiStartMetric("tools", context.creativeToolCount),
    });
  }

  if (context.connectedCount > 0) {
    appendAiriStartCard(dataCards, {
      ...airiStartCardCopy(chatT, "connected-sources"),
      tone: "data",
      iconSourceIds: getAiriStartIconSourceIds(
        context,
        [...AIRI_START_ICON_SOURCE_PRIORITY],
        3
      ),
      ...airiStartMetric("sources", context.connectedCount),
    });
  }

  if (params.threadCount > 0) {
    appendAiriStartCard(dataCards, {
      ...airiStartCardCopy(chatT, "saved-chats"),
      tone: "data",
      ...airiStartMetric("chats", params.threadCount),
    });
  }

  if (context.hasWhatsApp) {
    appendAiriStartCard(actionCards, {
      ...airiStartCardCopy(chatT, "whatsapp-template"),
      tone: "whatsapp",
      iconSourceIds: ["whatsapp"],
    });
    appendAiriStartCard(actionCards, {
      ...airiStartCardCopy(chatT, "follow-up-scenario"),
      tone: "whatsapp",
      iconSourceIds: ["whatsapp"],
    });
  }

  if (context.hasWhatsApp || context.hasDataContext || context.hasMetaAds) {
    appendAiriStartCard(actionCards, {
      ...airiStartCardCopy(chatT, "bulk-campaign"),
      tone: "campaign",
      iconSourceIds: getAiriStartIconSourceIds(
        context,
        ["whatsapp", "meta_ads", "email", "instagram"],
        3
      ),
    });
  }

  if (context.hasMetaAds) {
    if (
      context.metaAdsSkill &&
      !context.metaAdsSkill.disabled &&
      (context.metaAdsSkill.metaAdsMcp?.canRead ||
        context.metaAdsSkill.metaAdsMcp?.retryable)
    ) {
      appendAiriStartCard(actionCards, {
        id: "meta-ads-mcp",
        title: params.metaT("starter.title"),
        description: params.metaT(
          context.metaAdsSkill.metaAdsMcp?.retryable
            ? "starter.recheck"
            : context.metaAdsSkill.metaAdsMcp?.canWrite
              ? "starter.management"
              : "starter.reporting"
        ),
        prompt: params.metaT("starter.prompt"),
        eyebrow: chatT("start.cards.meta-ads-mcp.eyebrow"),
        compactTitle: chatT("start.cards.meta-ads-mcp.compactTitle"),
        tone: "campaign",
        selectedSources: [buildAiriChatMetaSkillRef()],
        iconSourceIds: ["meta_ads"],
      });
    }
    appendAiriStartCard(actionCards, {
      id: "meta-ads-plan",
      title: params.metaT("starter.plan.title"),
      description: params.metaT("starter.plan.description"),
      prompt: params.metaT("starter.plan.prompt"),
      eyebrow: chatT("start.cards.meta-ads-plan.eyebrow"),
      tone: "campaign",
      iconSourceIds: ["meta_ads"],
    });
  }

  if (context.hasWanAvatar && !context.hasWhatsApp) {
    appendAiriStartCard(actionCards, {
      ...airiStartCardCopy(chatT, "avatar-video"),
      tone: "campaign",
    });
  }

  if (context.creativeToolCount > 0) {
    appendAiriStartCard(actionCards, {
      ...airiStartCardCopy(chatT, "creative-content"),
      tone: "campaign",
      iconSourceIds: getAiriStartIconSourceIds(
        context,
        ["canva", "higgsfield", "elevenlabs"],
        3
      ),
    });
  }

  if (context.hasDataContext) {
    appendAiriStartCard(actionCards, {
      ...airiStartCardCopy(chatT, "support-gaps"),
      tone: "support",
    });
  }

  const allFallbackCards = buildAiriStartFallbackCards(chatT);
  const fallbackCards =
    context.connectedCount === 0 && params.threadCount === 0
      ? allFallbackCards
      : allFallbackCards.slice(0, 1);

  return [
    ...dataCards.slice(0, 3),
    ...scenarioCards,
    ...actionCards,
    ...fallbackCards,
  ].slice(0, AIRI_START_MAX_CARDS);
}

function getInitialOnboardingQuickActionsVisibility(
  workspaceId: string,
  initialSource: AiriChatWorkspaceProps["initialSource"]
) {
  if (initialSource !== "onboarding") return false;
  try {
    const seen = hasSeenOnboardingQuickActions(workspaceId);
    if (!seen) {
      markOnboardingQuickActionsStorageSeen(workspaceId);
    }
    return !seen;
  } catch {
    return true;
  }
}

type AiriChatSourceOptionsState = {
  requestKey: string | null;
  options: AiriChatSourceOption[];
  isLoading: boolean;
  error: string | null;
};

export function useAiriChatSourceOptions(workspaceId: string) {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestKey = useTransitionOwnerKey(
    `${workspaceId}\u0000${refreshNonce}`
  );
  const [state, setState] = useState<AiriChatSourceOptionsState>({
    requestKey: null,
    options: [],
    isLoading: true,
    error: null,
  });

  const refresh = useCallback(() => {
    setRefreshNonce(value => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const search = new URLSearchParams({
      q: "",
      limit: "100",
      mode: "sources",
    });

    void fetch(
      `/api/workspaces/${workspaceId}/airi-chats/sources?${search.toString()}`,
      { cache: "no-store" }
    )
      .then(response => readJson<{ sources: AiriChatSourceOption[] }>(response))
      .then(payload => {
        if (cancelled) return;
        setState({
          requestKey,
          options: payload.sources || [],
          isLoading: false,
          error: null,
        });
      })
      .catch(error => {
        if (cancelled) return;
        setState({
          requestKey,
          options: [],
          isLoading: false,
          error:
            error instanceof Error ? error.message : "Failed to load sources",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [requestKey, workspaceId]);

  if (state.requestKey !== requestKey) {
    return {
      options: [],
      isLoading: true,
      error: null,
      refresh,
    };
  }

  return {
    options: state.options,
    isLoading: state.isLoading,
    error: state.error,
    refresh,
  };
}

export function AiriChatWorkspace(props: AiriChatWorkspaceProps) {
  // A new workspace owns new drafts and requests, even when revisiting an
  // earlier workspace. Its chats and messages stay cached across mounts.
  return (
    <AiriChatSessionScope>
      <AiriChatWorkspaceSession key={props.workspaceId} {...props} />
    </AiriChatSessionScope>
  );
}

function AiriChatWorkspaceSession({
  workspaceId,
  compact = false,
  initialSource = "manual",
  onClose,
  desktopColumns: DesktopColumns = AiriStaticDesktopColumns,
}: AiriChatWorkspaceProps) {
  const metaT = useTranslations("AiriMetaAds");
  const chatT = useTranslations("AiriChat");
  const locale = useLocale();
  // Filled in below, once the builder and onboarding callbacks exist.
  const sessionCallbacksRef = useRef<AiriChatSessionCallbacks>({
    onTurnStart: () => undefined,
    getActiveBuilder: () => undefined,
    onAssistantMessage: () => undefined,
  });
  const {
    threads,
    setThreads,
    isLoadingThreads,
    threadsLoadError,
    retryThreadsLoad,
    selectedThreadId,
    selectThread: openSessionThread,
    startDraft,
    messages: effectiveMessages,
    isLoadingMessages: effectiveIsLoadingMessages,
    messagesLoadFailed,
    messagesLoadError,
    retryMessagesLoad,
    sendBlocked,
    hasEarlierMessages,
    earlierMessagesStatus,
    loadEarlierMessages,
    updateThreadMessages,
    replaceThreadMessages,
    error,
    setError,
    isSending,
    liveRunEvents,
    clearLiveRunEvents,
    streamingAnswerText: visibleStreamingAnswer,
    canStop,
    isStopping,
    stopRun,
    sendTurn,
    hasAttachedRun,
  } = useAiriChatSession({
    workspaceId,
    initialSource,
    callbacksRef: sessionCallbacksRef,
  });
  const [confirmingMetaMcpMutationId, setConfirmingMetaMcpMutationId] =
    useState<string | null>(null);
  const [metaMcpReview, setMetaMcpReview] =
    useState<MetaMcpReviewSelection | null>(null);
  const [metaMcpReviewState, setMetaMcpReviewState] = useState<
    "ready" | "stale" | "mismatched" | "submitting"
  >("ready");
  const [metaMcpReviewError, setMetaMcpReviewError] = useState<
    string | undefined
  >();
  const [metaMcpReconciliation, setMetaMcpReconciliation] =
    useState<MetaMcpReconciliationSelection | null>(null);
  const [metaMcpReconciliationError, setMetaMcpReconciliationError] = useState<
    string | undefined
  >();
  const metaMcpSubmissionLockRef = useRef(false);
  const [relativeNow, setRelativeNow] = useState(() => Date.now());
  const [mobileView, setMobileView] = useState<"thread" | "list">("thread");
  const [threadSearch, setThreadSearch] = useState("");
  const isAiriMobileLayout = useAiriMobileLayout();
  const [showOnboardingQuickActions, setShowOnboardingQuickActions] = useState(
    () => getInitialOnboardingQuickActionsVisibility(workspaceId, initialSource)
  );
  const sourceOptions = useAiriChatSourceOptions(workspaceId);
  const selectedThreadIdRef = useRef(selectedThreadId);
  selectedThreadIdRef.current = selectedThreadId;
  const { builderOpen, builderPanelSize, setBuilderOpen, setBuilderPanelSize } =
    useAiriBuilderUiState(workspaceId);
  const [builder, setBuilder] = useState(createDefaultAiriBuilderRenderState);
  const builderMode = builder.mode;
  const builderTemplateDraft = builder.templateDraft;
  const builderFlowConfig = builder.flowConfig;
  const builderArtifacts = builder.artifacts;
  const pendingBuilderPatch = builder.pendingPatch;
  const pendingBuilderPatchArtifact = builder.pendingPatchArtifact;
  const pendingBuilderPatchTarget = builder.pendingPatchTarget;
  const builderConflict = builder.conflict;
  const builderArtifactsRef = useRef<AiriBuilderArtifactMap>({});
  const builderDirtyRef = useRef(false);
  // Every snapshot this tab sent per artifact since its last acknowledged
  // save, to tell its own committed saves (requests aborted by a later edit
  // that the server still applied) from someone else's edit.
  const builderSentSnapshotsRef = useRef<Record<string, string[]>>({});
  const builderAutosaveErrorRef = useRef<string | null>(null);
  const builderStateRef = useRef<{
    open: boolean;
    mode: AiriBuilderMode;
    revision: number;
    dirty: boolean;
    artifacts: AiriBuilderArtifactMap;
    templateDraft: AiriWhatsAppTemplateDraft;
    flowConfig: WhatsAppFlowConfig;
  }>({
    open: false,
    mode: "whatsapp_template",
    revision: 0,
    dirty: false,
    artifacts: {},
    templateDraft: DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT,
    flowConfig: DEFAULT_AIRI_BUILDER_FLOW_CONFIG,
  });
  const toggleBuilderOpen = useCallback(() => {
    setBuilderOpen(current => {
      const state = builderStateRef.current;
      const canShowBuilder = Boolean(
        selectedThreadIdRef.current && state.artifacts[state.mode]
      );
      const canShowAiriPageTools = !onClose;
      const nextOpen =
        canShowBuilder || canShowAiriPageTools ? !current : false;
      builderStateRef.current = {
        ...state,
        open: nextOpen,
      };
      return nextOpen;
    });
  }, [onClose, setBuilderOpen]);

  const selectedThread = useMemo(
    () => threads.find(thread => thread.id === selectedThreadId) || null,
    [selectedThreadId, threads]
  );
  const isDraftSelected = selectedThreadId === null;
  // The chat list's failure shows on the start screen until a turn begins.
  const threadsErrorInBanner =
    isDraftSelected && !isSending ? threadsLoadError : null;
  const effectiveError = messagesLoadFailed
    ? messagesLoadError
    : (error ?? threadsErrorInBanner);
  const showEmptyThread =
    !effectiveIsLoadingMessages &&
    !messagesLoadFailed &&
    effectiveMessages.length === 0 &&
    !hasVisibleAiriChatRunProgress(isSending, liveRunEvents);
  const filteredThreads = useMemo(
    () => threads.filter(thread => threadMatchesSearch(thread, threadSearch)),
    [threadSearch, threads]
  );
  const startCards = useMemo(
    () =>
      buildAiriStartCards({
        sourceOptions: sourceOptions.options,
        threadCount: threads.length,
        // The Wan avatar endpoint always reports configured: false, so the
        // drawer no longer probes it (three Supabase round trips) per open.
        hasWanAvatar: false,
        metaT,
        chatT,
        locale,
      }),
    [chatT, locale, metaT, sourceOptions.options, threads.length]
  );
  const mobileTitle = selectedThread?.title || chatT("newThread");
  const hasBuilderArtifact = Boolean(
    selectedThreadId && builderArtifacts[builderMode]
  );
  const builderVisible = builderOpen && hasBuilderArtifact;
  const airiPageToolsVisible = builderOpen && !hasBuilderArtifact && !onClose;
  const rightPanelVisible = builderVisible || airiPageToolsVisible;
  const builderConflictView = useMemo(
    () =>
      builderConflict?.kind === builderMode
        ? {
            revision: builderConflict.revision,
            canTakeLatest: Boolean(builderConflict.snapshot),
          }
        : null,
    [builderConflict, builderMode]
  );
  useEffect(() => {
    // This chat can open the builder: download it before the user does.
    if (hasBuilderArtifact) preloadAiriBuilderSidePanel();
  }, [hasBuilderArtifact]);
  const closeBuilder = useCallback(() => {
    builderStateRef.current = {
      ...builderStateRef.current,
      open: false,
    };
    setBuilderOpen(false);
  }, [setBuilderOpen]);

  useEffect(() => {
    const timer = window.setInterval(() => setRelativeNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    builderStateRef.current = {
      open: builderOpen,
      mode: builderMode,
      revision: builderStateRef.current.revision,
      dirty: builderDirtyRef.current,
      artifacts: builderArtifacts,
      templateDraft: builderTemplateDraft,
      flowConfig: builderFlowConfig,
    };
    builderArtifactsRef.current = builderArtifacts;
  }, [
    builderArtifacts,
    builderFlowConfig,
    builderMode,
    builderOpen,
    builderTemplateDraft,
  ]);

  const resetBuilderArtifacts = useCallback(() => {
    const nextBuilder = createDefaultAiriBuilderRenderState();
    builderArtifactsRef.current = nextBuilder.artifacts;
    builderStateRef.current = {
      ...builderStateRef.current,
      mode: nextBuilder.mode,
      revision: 0,
      dirty: false,
      artifacts: nextBuilder.artifacts,
      templateDraft: nextBuilder.templateDraft,
      flowConfig: nextBuilder.flowConfig,
    };
    setBuilder(nextBuilder);
    builderDirtyRef.current = false;
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!selectedThreadId) {
      return () => {
        cancelled = true;
      };
    }

    const controller = new AbortController();
    const search = new URLSearchParams({
      threadId: selectedThreadId,
      limit: "20",
    });

    void fetch(
      `/api/workspaces/${workspaceId}/airi-artifacts?${search.toString()}`,
      {
        cache: "no-store",
        signal: controller.signal,
      }
    )
      .then(response => readJson<{ artifacts?: unknown[] }>(response))
      .then(payload => {
        if (cancelled) return;
        const artifacts: AiriBuilderArtifactMap = {};
        for (const rawArtifact of payload.artifacts || []) {
          const artifact = normalizeAiriBuilderArtifactRecord(rawArtifact);
          if (artifact) {
            artifacts[artifact.kind] = artifact;
          }
        }

        const templateArtifact = artifacts.whatsapp_template;
        const flowArtifact = artifacts.whatsapp_flow;
        const nextMode: AiriBuilderMode = templateArtifact
          ? "whatsapp_template"
          : flowArtifact
            ? "whatsapp_flow"
            : "whatsapp_template";
        const nextRevision = artifacts[nextMode]?.revision ?? 0;
        const nextTemplateDraft =
          templateArtifact?.snapshot?.templateDraft ??
          DEFAULT_AIRI_BUILDER_TEMPLATE_DRAFT;
        const nextFlowConfig =
          flowArtifact?.snapshot?.flowConfig ??
          DEFAULT_AIRI_BUILDER_FLOW_CONFIG;

        builderArtifactsRef.current = artifacts;
        builderStateRef.current = {
          ...builderStateRef.current,
          mode: nextMode,
          revision: nextRevision,
          dirty: false,
          artifacts,
          templateDraft: nextTemplateDraft,
          flowConfig: nextFlowConfig,
        };
        setBuilder({
          mode: nextMode,
          artifacts,
          pendingPatch: null,
          pendingPatchArtifact: null,
          pendingPatchTarget: "open",
          conflict: null,
          templateDraft: nextTemplateDraft,
          flowConfig: nextFlowConfig,
        });
        builderDirtyRef.current = false;
      })
      .catch(error => {
        if (cancelled) return;
        const isAbort =
          error instanceof DOMException && error.name === "AbortError";
        if (!isAbort) {
          resetBuilderArtifacts();
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [resetBuilderArtifacts, selectedThreadId, workspaceId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey) return;
      if (event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggleBuilderOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleBuilderOpen]);

  const buildActiveBuilderPayload = useCallback(():
    | ActiveAiriBuilderInput
    | undefined => {
    const state = builderStateRef.current;
    if (!state.open) return undefined;
    const artifact = state.artifacts[state.mode];
    if (!artifact) return undefined;
    if (state.mode === "whatsapp_template") {
      return {
        kind: "whatsapp_template",
        artifactId: artifact.id,
        revision: artifact.revision,
        dirty: state.dirty || undefined,
        templateDraft: state.templateDraft,
      };
    }
    return {
      kind: "whatsapp_flow",
      artifactId: artifact.id,
      revision: artifact.revision,
      dirty: state.dirty || undefined,
      flowConfig: state.flowConfig,
    };
  }, []);

  const setActiveBuilderMode = useCallback(
    (mode: AiriBuilderMode) => {
      const artifacts = builderArtifactsRef.current;
      const artifact = artifacts[mode];
      builderStateRef.current = {
        ...builderStateRef.current,
        open: true,
        mode,
        revision: artifact?.revision ?? 0,
        artifacts,
      };
      setBuilder(current => ({ ...current, mode }));
      setBuilderOpen(true);
    },
    [setBuilderOpen]
  );

  const applyBuilderPatch = useCallback(
    (patch: AiriBuilderPatch, artifact?: AiriBuilderArtifactRecord | null) => {
      const nextArtifacts = artifact
        ? {
            ...builderStateRef.current.artifacts,
            [artifact.kind]: artifact,
          }
        : builderStateRef.current.artifacts;
      const nextRevision = artifact?.revision ?? patch.nextRevision;
      const nextState = {
        ...builderStateRef.current,
        open: true,
        mode: patch.kind,
        revision: nextRevision,
        dirty: false,
        artifacts: nextArtifacts,
        templateDraft:
          patch.kind === "whatsapp_template"
            ? patch.snapshot.templateDraft
            : builderStateRef.current.templateDraft,
        flowConfig:
          patch.kind === "whatsapp_flow"
            ? patch.snapshot.flowConfig
            : builderStateRef.current.flowConfig,
      };
      builderStateRef.current = nextState;
      builderArtifactsRef.current = nextArtifacts;
      setBuilderOpen(true);
      builderDirtyRef.current = false;
      setBuilder(current => ({
        ...current,
        mode: patch.kind,
        artifacts: nextArtifacts,
        pendingPatch: null,
        pendingPatchArtifact: null,
        pendingPatchTarget: "open",
        conflict:
          current.conflict?.kind === patch.kind ? null : current.conflict,
        templateDraft:
          patch.kind === "whatsapp_template"
            ? patch.snapshot.templateDraft
            : current.templateDraft,
        flowConfig:
          patch.kind === "whatsapp_flow"
            ? patch.snapshot.flowConfig
            : current.flowConfig,
      }));
    },
    [setBuilderOpen]
  );

  const handleIncomingBuilderPatch = useCallback(
    (metadata: Record<string, unknown> | null | undefined) => {
      const patch = getMessageAiriBuilderPatch(metadata);
      if (!patch) return;
      const artifact = getMessageAiriArtifact(metadata);
      const current = builderStateRef.current;
      const openArtifact = current.artifacts[patch.kind] ?? null;
      const patchArtifactId =
        getMessageAiriBuilderPatchArtifactId(metadata) ??
        (artifact?.kind === patch.kind ? artifact.id : null);
      if (openArtifact && openArtifact.id !== patchArtifactId) {
        // The patch belongs to another artifact (or to none, like a
        // campaign's template draft): never write it into the open one.
        // Offer it instead; applying switches to its artifact when known,
        // and otherwise opens it as a new artifact of its own.
        const targetArtifact =
          artifact?.kind === patch.kind && artifact.id === patchArtifactId
            ? artifact
            : null;
        builderStateRef.current = { ...current, open: true, mode: patch.kind };
        setBuilderOpen(true);
        setBuilder(currentBuilder => ({
          ...currentBuilder,
          mode: patch.kind,
          pendingPatch: patch,
          pendingPatchArtifact: targetArtifact,
          pendingPatchTarget: targetArtifact ? "other" : "new",
        }));
        return;
      }
      const nextArtifacts =
        artifact?.kind === patch.kind
          ? {
              ...builderStateRef.current.artifacts,
              [artifact.kind]: artifact,
            }
          : builderStateRef.current.artifacts;
      builderStateRef.current = {
        ...current,
        open: true,
        mode: patch.kind,
        artifacts: nextArtifacts,
      };
      if (artifact?.kind === patch.kind) {
        builderArtifactsRef.current = nextArtifacts;
      }
      setBuilderOpen(true);
      const currentPatchRevision =
        current.artifacts[patch.kind]?.revision ?? current.revision;
      if (patch.baseRevision === currentPatchRevision) {
        applyBuilderPatch(
          patch,
          artifact?.kind === patch.kind ? artifact : null
        );
        return;
      }
      setBuilder(currentBuilder => ({
        ...currentBuilder,
        mode: patch.kind,
        artifacts: nextArtifacts,
        pendingPatch: patch,
        pendingPatchArtifact: null,
        pendingPatchTarget: "open",
      }));
    },
    [applyBuilderPatch, setBuilderOpen]
  );

  const openingPendingPatchRef = useRef(false);
  /**
   * A patch without an artifact of its own (a campaign's template draft)
   * becomes a new artifact of this thread, so the builder can show it and
   * autosave never writes it over the artifact that was open.
   */
  const openPendingPatchAsNewArtifact = useCallback(
    async (patch: AiriBuilderPatch) => {
      const threadId = selectedThreadIdRef.current;
      if (!threadId || openingPendingPatchRef.current) return;
      openingPendingPatchRef.current = true;
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/airi-artifacts`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId,
              kind: patch.kind,
              snapshot: patch.snapshot,
              changeSummary: "Created from an Airi draft",
            }),
          }
        );
        const payload = (await response.json().catch(() => ({}))) as {
          artifact?: unknown;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(
            payload.error || `Request failed: ${response.status}`
          );
        }
        const created = normalizeAiriBuilderArtifactRecord(payload.artifact);
        if (!created || created.kind !== patch.kind) {
          throw new Error("Airi artifact save returned an invalid record");
        }
        if (selectedThreadIdRef.current !== threadId) return;
        applyBuilderPatch(patch, created);
      } catch {
        setError(chatT("openDraftFailed"));
      } finally {
        openingPendingPatchRef.current = false;
      }
    },
    [applyBuilderPatch, chatT, setError, workspaceId]
  );

  const dismissPendingBuilderPatch = useCallback(() => {
    setBuilder(currentBuilder => ({
      ...currentBuilder,
      pendingPatch: null,
      pendingPatchArtifact: null,
      pendingPatchTarget: "open",
    }));
  }, []);

  const openTemplateDraftInBuilder = useCallback(
    (draft: AiriWhatsAppTemplateDraft) => {
      const current = builderStateRef.current;
      const changed = stableJson(draft) !== stableJson(current.templateDraft);
      const nextRevision = changed ? current.revision + 1 : current.revision;
      builderStateRef.current = {
        ...current,
        open: true,
        mode: "whatsapp_template",
        revision: nextRevision,
        dirty: false,
        templateDraft: draft,
      };
      setBuilder(currentBuilder => ({
        ...currentBuilder,
        mode: "whatsapp_template",
        templateDraft: draft,
        pendingPatch: null,
        pendingPatchArtifact: null,
        pendingPatchTarget: "open",
      }));
      setBuilderOpen(true);
      builderDirtyRef.current = false;
    },
    [setBuilderOpen]
  );

  const handleTemplateDraftChange = useCallback(
    (draft: AiriWhatsAppTemplateDraft) => {
      const current = builderStateRef.current;
      if (stableJson(draft) === stableJson(current.templateDraft)) {
        return;
      }
      builderStateRef.current = {
        ...current,
        mode: "whatsapp_template",
        revision: current.artifacts.whatsapp_template?.revision ?? 0,
        dirty: true,
        templateDraft: draft,
      };
      setBuilder(currentBuilder => ({
        ...currentBuilder,
        mode: "whatsapp_template",
        templateDraft: draft,
      }));
      builderDirtyRef.current = true;
    },
    []
  );

  const handleFlowConfigChange = useCallback((config: WhatsAppFlowConfig) => {
    const current = builderStateRef.current;
    if (stableJson(config) === stableJson(current.flowConfig)) {
      return;
    }
    builderStateRef.current = {
      ...current,
      mode: "whatsapp_flow",
      revision: current.artifacts.whatsapp_flow?.revision ?? 0,
      dirty: true,
      flowConfig: config,
    };
    setBuilder(currentBuilder => ({
      ...currentBuilder,
      mode: "whatsapp_flow",
      flowConfig: config,
    }));
    builderDirtyRef.current = true;
  }, []);

  const markBuilderSaved = useCallback(() => {
    builderStateRef.current = {
      ...builderStateRef.current,
      dirty: false,
    };
    builderDirtyRef.current = false;
  }, []);

  /** Rebases the builder onto a server revision of one of its artifacts. */
  const adoptBuilderArtifact = useCallback(
    (
      artifact: AiriBuilderArtifactRecord,
      options?: { markSavedIfMatching?: boolean }
    ) => {
      const nextArtifacts = {
        ...builderArtifactsRef.current,
        [artifact.kind]: artifact,
      };
      builderArtifactsRef.current = nextArtifacts;
      const state = builderStateRef.current;
      const localFingerprint = airiBuilderSnapshotFingerprint(
        artifact.kind,
        artifact.kind === "whatsapp_template"
          ? { templateDraft: state.templateDraft }
          : { flowConfig: state.flowConfig }
      );
      const matchesServer =
        Boolean(options?.markSavedIfMatching) &&
        Boolean(artifact.snapshot) &&
        localFingerprint ===
          airiBuilderSnapshotFingerprint(artifact.kind, artifact.snapshot);
      builderStateRef.current = {
        ...state,
        revision:
          state.mode === artifact.kind ? artifact.revision : state.revision,
        dirty: matchesServer ? false : state.dirty,
        artifacts: nextArtifacts,
      };
      if (matchesServer) builderDirtyRef.current = false;
      setBuilder(currentBuilder => ({
        ...currentBuilder,
        artifacts: nextArtifacts,
        conflict:
          currentBuilder.conflict?.kind === artifact.kind
            ? null
            : currentBuilder.conflict,
      }));
    },
    []
  );

  /** Conflict choice: save this tab's version over the newer revision. */
  const keepLocalBuilderChanges = useCallback(() => {
    if (!builderConflict) return;
    builderDirtyRef.current = true;
    builderStateRef.current = { ...builderStateRef.current, dirty: true };
    adoptBuilderArtifact(builderConflict);
  }, [adoptBuilderArtifact, builderConflict]);

  /** Conflict choice: drop this tab's edits and load the newer revision. */
  const takeLatestBuilderVersion = useCallback(() => {
    const conflict = builderConflict;
    if (!conflict?.snapshot) return;
    const state = builderStateRef.current;
    const nextArtifacts = {
      ...builderArtifactsRef.current,
      [conflict.kind]: conflict,
    };
    const templateDraft =
      conflict.kind === "whatsapp_template"
        ? (conflict.snapshot.templateDraft ?? state.templateDraft)
        : state.templateDraft;
    const flowConfig =
      conflict.kind === "whatsapp_flow"
        ? (conflict.snapshot.flowConfig ?? state.flowConfig)
        : state.flowConfig;
    builderArtifactsRef.current = nextArtifacts;
    builderStateRef.current = {
      ...state,
      revision:
        state.mode === conflict.kind ? conflict.revision : state.revision,
      dirty: false,
      artifacts: nextArtifacts,
      templateDraft,
      flowConfig,
    };
    builderDirtyRef.current = false;
    setBuilder(currentBuilder => ({
      ...currentBuilder,
      artifacts: nextArtifacts,
      templateDraft,
      flowConfig,
      conflict: null,
    }));
  }, [builderConflict]);

  // The builder save running now (autosave or a flush), so a flush can wait
  // for it, and the autosave debounce still waiting to fire.
  const builderSaveInFlightRef = useRef<Promise<AiriBuilderSaveOutcome> | null>(
    null
  );
  const builderAutosaveTimerRef = useRef<number | null>(null);
  // Read by a flush between renders; a 409 also sets it at once.
  const builderConflictRef = useRef(builderConflict);
  builderConflictRef.current = builderConflict;

  /**
   * Saves one builder snapshot of a thread's artifact (creating the artifact
   * when there is none yet). A 409 holding a snapshot this tab sent rebases
   * onto it; any other 409 pauses autosave as a conflict for the user.
   */
  const saveBuilderSnapshot = useCallback(
    (params: {
      threadId: string;
      mode: AiriBuilderMode;
      artifact: AiriBuilderArtifactRecord | null;
      snapshot: NonNullable<AiriBuilderArtifactRecord["snapshot"]>;
      signal: AbortSignal;
    }): Promise<AiriBuilderSaveOutcome> => {
      const { threadId, mode, artifact, snapshot, signal } = params;
      const snapshotJson = stableJson(snapshot);
      const save = async (): Promise<AiriBuilderSaveOutcome> => {
        const sentFingerprint = artifact
          ? airiBuilderSnapshotFingerprint(mode, snapshot)
          : null;
        if (artifact && sentFingerprint !== null) {
          const sent = builderSentSnapshotsRef.current[artifact.id] ?? [];
          builderSentSnapshotsRef.current[artifact.id] = [
            ...sent.slice(-(MAX_UNACKNOWLEDGED_BUILDER_SAVES - 1)),
            sentFingerprint,
          ];
        }
        const response = await fetch(
          artifact
            ? `/api/workspaces/${workspaceId}/airi-artifacts/${artifact.id}`
            : `/api/workspaces/${workspaceId}/airi-artifacts`,
          {
            method: artifact ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            signal,
            body: JSON.stringify(
              artifact
                ? {
                    baseRevision: artifact.revision,
                    snapshot,
                    changeSummary: "Autosaved from Airi builder",
                  }
                : {
                    threadId,
                    kind: mode,
                    snapshot,
                    changeSummary: "Created from Airi builder",
                  }
            ),
          }
        );
        const payload = (await response.json().catch(() => ({}))) as {
          artifact?: unknown;
          current?: unknown;
          error?: string;
        };
        if (response.status === 409) {
          const current =
            normalizeAiriBuilderArtifactRecord(payload.current) ??
            (artifact ? { ...artifact, snapshot: undefined } : null);
          if (!current) return "failed";
          const serverFingerprint = current.snapshot
            ? airiBuilderSnapshotFingerprint(current.kind, current.snapshot)
            : null;
          const sentFingerprints =
            builderSentSnapshotsRef.current[current.id] ?? [];
          if (
            serverFingerprint !== null &&
            sentFingerprints.includes(serverFingerprint)
          ) {
            // The server already holds something this tab sent (a save
            // aborted by a later edit after it committed): rebase onto it,
            // no conflict. Newer local edits stay dirty and save next.
            adoptBuilderArtifact(current, { markSavedIfMatching: true });
            return "rebased";
          }
          builderConflictRef.current = current;
          setBuilder(currentBuilder => ({
            ...currentBuilder,
            conflict: current,
          }));
          return "conflict";
        }
        if (!response.ok) {
          throw new Error(
            payload.error || `Request failed: ${response.status}`
          );
        }
        const saved = normalizeAiriBuilderArtifactRecord(payload.artifact);
        if (!saved) {
          throw new Error("Airi artifact save returned an invalid record");
        }
        delete builderSentSnapshotsRef.current[saved.id];

        const nextArtifacts = {
          ...builderArtifactsRef.current,
          [saved.kind]: saved,
        };
        builderArtifactsRef.current = nextArtifacts;
        const currentState = builderStateRef.current;
        const currentSnapshotJson =
          mode === "whatsapp_template"
            ? stableJson({ templateDraft: currentState.templateDraft })
            : stableJson({ flowConfig: currentState.flowConfig });
        const isCurrentSnapshotSaved =
          currentState.mode === mode && currentSnapshotJson === snapshotJson;
        builderStateRef.current = {
          ...currentState,
          revision:
            currentState.mode === saved.kind
              ? saved.revision
              : currentState.revision,
          dirty: isCurrentSnapshotSaved ? false : currentState.dirty,
          artifacts: nextArtifacts,
        };
        setBuilder(currentBuilder => ({
          ...currentBuilder,
          artifacts: nextArtifacts,
          conflict:
            currentBuilder.conflict?.kind === saved.kind
              ? null
              : currentBuilder.conflict,
        }));
        if (isCurrentSnapshotSaved) {
          builderDirtyRef.current = false;
        }
        const failedMessage = builderAutosaveErrorRef.current;
        if (failedMessage) {
          builderAutosaveErrorRef.current = null;
          setError(currentError =>
            currentError === failedMessage ? null : currentError
          );
        }
        return "saved";
      };

      const run = save().catch((error): AiriBuilderSaveOutcome => {
        const isAbort =
          error instanceof DOMException && error.name === "AbortError";
        if (isAbort) return "aborted";
        const message =
          error instanceof Error
            ? error.message
            : "Failed to autosave Airi artifact";
        builderAutosaveErrorRef.current = message;
        setError(message);
        return "failed";
      });
      builderSaveInFlightRef.current = run;
      void run.then(() => {
        if (builderSaveInFlightRef.current === run) {
          builderSaveInFlightRef.current = null;
        }
      });
      return run;
    },
    [adoptBuilderArtifact, setError, workspaceId]
  );

  useEffect(() => {
    if (!selectedThreadId || !builderDirtyRef.current) return;
    // Another tab or an Airi turn changed this artifact: autosave waits
    // until the user keeps their version or takes the latest one.
    if (builderConflict?.kind === builderMode) return;

    const mode = builderMode;
    const artifact = builderArtifacts[mode] ?? null;
    const snapshot =
      mode === "whatsapp_template"
        ? { templateDraft: builderTemplateDraft }
        : { flowConfig: builderFlowConfig };
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      builderAutosaveTimerRef.current = null;
      void saveBuilderSnapshot({
        threadId: selectedThreadId,
        mode,
        artifact,
        snapshot,
        signal: controller.signal,
      });
    }, AIRI_BUILDER_AUTOSAVE_DELAY_MS);
    builderAutosaveTimerRef.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (builderAutosaveTimerRef.current === timer) {
        builderAutosaveTimerRef.current = null;
      }
      controller.abort();
    };
  }, [
    builderArtifacts,
    builderConflict,
    builderFlowConfig,
    builderMode,
    builderTemplateDraft,
    saveBuilderSnapshot,
    selectedThreadId,
  ]);

  /**
   * Saves the open artifact's unsaved edits of this kind now, instead of
   * after the autosave delay, before the builder switches away from it.
   * Resolves true once nothing is left unsaved; false when a conflict or a
   * failed save holds the edits (the conflict or error is already shown).
   */
  const flushBuilderAutosave = useCallback(
    async (kind: AiriBuilderMode): Promise<boolean> => {
      const threadId = selectedThreadIdRef.current;
      // A rebase or an edit made during a save leaves newer edits to save.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (builderConflictRef.current?.kind === kind) return false;
        const inFlight = builderSaveInFlightRef.current;
        if (inFlight) {
          const outcome = await inFlight;
          if (outcome === "conflict" || outcome === "failed") return false;
          continue;
        }
        const state = builderStateRef.current;
        if (!builderDirtyRef.current || state.mode !== kind) return true;
        if (!threadId || selectedThreadIdRef.current !== threadId) {
          return false;
        }
        if (builderAutosaveTimerRef.current !== null) {
          window.clearTimeout(builderAutosaveTimerRef.current);
          builderAutosaveTimerRef.current = null;
        }
        const outcome = await saveBuilderSnapshot({
          threadId,
          mode: kind,
          artifact: builderArtifactsRef.current[kind] ?? null,
          snapshot:
            kind === "whatsapp_template"
              ? { templateDraft: state.templateDraft }
              : { flowConfig: state.flowConfig },
          // Not tied to the autosave effect: re-renders must not abort it.
          signal: new AbortController().signal,
        });
        if (outcome === "conflict" || outcome === "failed") return false;
      }
      return (
        !builderDirtyRef.current && builderConflictRef.current?.kind !== kind
      );
    },
    [saveBuilderSnapshot]
  );

  // Applying a patch that switches artifacts first saves the open one.
  const [applyingPendingPatch, setApplyingPendingPatch] = useState(false);
  const applyingPendingPatchRef = useRef(false);
  const pendingBuilderPatchRef = useRef(pendingBuilderPatch);
  pendingBuilderPatchRef.current = pendingBuilderPatch;
  const applyPendingBuilderPatch = useCallback(async () => {
    const patch = pendingBuilderPatch;
    if (!patch || applyingPendingPatchRef.current) return;
    if (pendingBuilderPatchTarget === "open") {
      // Airi's update for the open artifact itself: the user chose it.
      applyBuilderPatch(patch, pendingBuilderPatchArtifact);
      return;
    }
    const threadId = selectedThreadIdRef.current;
    applyingPendingPatchRef.current = true;
    setApplyingPendingPatch(true);
    try {
      // The open artifact's unsaved edits (inside the autosave delay) are
      // saved before it closes. A conflict or a failed save keeps the patch
      // pending, with the conflict or the error shown, for the user to
      // resolve first.
      const saved = await flushBuilderAutosave(patch.kind);
      if (
        !saved ||
        selectedThreadIdRef.current !== threadId ||
        pendingBuilderPatchRef.current !== patch
      ) {
        return;
      }
      if (pendingBuilderPatchTarget === "new") {
        await openPendingPatchAsNewArtifact(patch);
      } else {
        applyBuilderPatch(patch, pendingBuilderPatchArtifact);
      }
    } finally {
      applyingPendingPatchRef.current = false;
      setApplyingPendingPatch(false);
    }
  }, [
    applyBuilderPatch,
    flushBuilderAutosave,
    openPendingPatchAsNewArtifact,
    pendingBuilderPatch,
    pendingBuilderPatchArtifact,
    pendingBuilderPatchTarget,
  ]);
  // Switching to another artifact waits until the open one's conflict is
  // resolved, so neither version of it is lost.
  const pendingPatchBlockedByConflict =
    pendingBuilderPatch !== null &&
    pendingBuilderPatchTarget !== "open" &&
    builderConflict?.kind === pendingBuilderPatch.kind;

  const markOnboardingQuickActionsSeen = useCallback(() => {
    if (initialSource !== "onboarding") return;
    setShowOnboardingQuickActions(false);
    try {
      markOnboardingQuickActionsStorageSeen(workspaceId);
    } catch {
      // Storage can be unavailable in private or embedded browser modes.
    }
  }, [initialSource, workspaceId]);

  const startDraftChat = useCallback(() => {
    if (hasAttachedRun()) return;
    clearLiveRunEvents();
    if (isDraftSelected && effectiveMessages.length === 0 && !isSending) {
      setMobileView("thread");
      return;
    }
    resetBuilderArtifacts();
    setMetaMcpReview(null);
    setMetaMcpReconciliation(null);
    startDraft();
    setMobileView("thread");
  }, [
    clearLiveRunEvents,
    effectiveMessages.length,
    hasAttachedRun,
    isDraftSelected,
    isSending,
    resetBuilderArtifacts,
    startDraft,
  ]);

  const selectThread = useCallback(
    (threadId: string) => {
      if (hasAttachedRun()) return;
      setMobileView("thread");
      if (threadId === selectedThreadIdRef.current) {
        // Already open: keep its history and builder, or retry a failed load.
        if (messagesLoadFailed) retryMessagesLoad();
        return;
      }
      resetBuilderArtifacts();
      setMetaMcpReview(null);
      setMetaMcpReconciliation(null);
      openSessionThread(threadId);
    },
    [
      hasAttachedRun,
      messagesLoadFailed,
      openSessionThread,
      resetBuilderArtifacts,
      retryMessagesLoad,
    ]
  );

  // The banner's Retry reloads the chat list, so it is offered only while
  // the banner shows that failure, never next to a later, unrelated error.
  const retryErrorLoad =
    threadsErrorInBanner !== null && effectiveError === threadsErrorInBanner
      ? retryThreadsLoad
      : null;

  const sendMessage = useCallback(
    (
      contentInput: string,
      selectedSources: AiriChatSourceRef[] = [],
      attachedFiles: File[] = [],
      attachedCreativeAssets: CreativeAsset[] = []
    ): Promise<boolean> =>
      sendTurn({
        content: contentInput,
        selectedSources,
        optimisticMetadata: buildOptimisticMessageMetadata({
          selectedSources,
          attachments: toOptimisticAttachmentPayloads(
            attachedFiles,
            attachedCreativeAssets
          ),
        }),
        prepareAttachments: () =>
          toAttachmentPayloads(attachedFiles, attachedCreativeAssets),
      }),
    [sendTurn]
  );
  sessionCallbacksRef.current = {
    onTurnStart: () => {
      markOnboardingQuickActionsSeen();
      setMobileView("thread");
    },
    getActiveBuilder: buildActiveBuilderPayload,
    onAssistantMessage: handleIncomingBuilderPatch,
  };

  const openMetaMcpReview = useCallback(
    (selection: MetaMcpReviewSelection) => {
      const matches =
        selection.action.mutationId === selection.transaction.id &&
        selection.action.transactionDigest ===
          selection.transaction.transactionDigest;
      setMetaMcpReview(selection);
      setMetaMcpReviewState(matches ? "ready" : "mismatched");
      setMetaMcpReviewError(matches ? undefined : metaT("actions.mismatch"));
    },
    [metaT]
  );

  const openMetaMcpReconciliation = useCallback(
    (selection: MetaMcpReconciliationSelection) => {
      setMetaMcpReconciliation(selection);
      setMetaMcpReconciliationError(undefined);
      setError(null);
    },
    [setError]
  );

  const synchronizeMetaMcpMessages = useCallback(
    async (params: {
      threadId: string;
      messageId: string;
      mutationId: string;
      assistantMessage?: AiriChatMessage;
      executionStatus: "succeeded" | "not_executed" | "outcome_unknown";
      transaction?: MetaAdsMcpTransactionV2;
      execution?: PublicMetaAdsMcpExecution;
    }) => {
      try {
        const payload = await readJson<{
          messages?: AiriChatMessage[];
          hasMore?: unknown;
          activeRun?: unknown;
        }>(
          await fetch(
            `/api/workspaces/${workspaceId}/airi-chats/${params.threadId}/messages`,
            { cache: "no-store" }
          )
        );
        replaceThreadMessages(params.threadId, toAiriChatMessagePage(payload));
      } catch {
        const assistantMessage = params.assistantMessage;
        if (assistantMessage) {
          updateThreadMessages(params.threadId, current =>
            applyMetaMcpMutationResult(current, {
              sourceMessageId: params.messageId,
              mutationId: params.mutationId,
              assistantMessage,
              executionStatus: params.executionStatus,
              transaction: params.transaction,
              execution: params.execution,
            })
          );
        }
        setError(metaT("errors.refresh"));
      }
    },
    [metaT, replaceThreadMessages, setError, updateThreadMessages, workspaceId]
  );

  const confirmMetaMcpMutation = useCallback(async () => {
    const selection = metaMcpReview;
    const threadId = selectedThreadId;
    if (!selection || !threadId || metaMcpSubmissionLockRef.current) return;
    metaMcpSubmissionLockRef.current = true;
    setConfirmingMetaMcpMutationId(selection.action.mutationId);
    setMetaMcpReviewState("submitting");
    setMetaMcpReviewError(undefined);
    setError(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/airi-chats/${threadId}/meta-mcp/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageId: selection.messageId,
            mutationId: selection.action.mutationId,
            transactionDigest: selection.transaction.transactionDigest,
          }),
        }
      );
      const payload = (await response.json().catch(() => ({}))) as {
        assistantMessage?: AiriChatMessage;
        executionStatus?: "succeeded" | "not_executed" | "outcome_unknown";
        error?: string;
      };
      if (!response.ok || !payload.executionStatus) {
        const message = payload.error || metaT("errors.confirm");
        if (response.status === 409) {
          setMetaMcpReviewState("stale");
          setMetaMcpReviewError(`${message} ${metaT("errors.regenerate")}`);
        } else {
          setMetaMcpReviewState("ready");
          setMetaMcpReviewError(message);
        }
        return;
      }

      setMetaMcpReview(null);
      await synchronizeMetaMcpMessages({
        threadId,
        messageId: selection.messageId,
        mutationId: selection.action.mutationId,
        assistantMessage: payload.assistantMessage,
        executionStatus: payload.executionStatus,
        transaction: selection.transaction,
      });
    } catch (err) {
      setMetaMcpReviewState("ready");
      setMetaMcpReviewError(
        err instanceof Error ? err.message : metaT("errors.confirm")
      );
    } finally {
      metaMcpSubmissionLockRef.current = false;
      setConfirmingMetaMcpMutationId(null);
    }
  }, [
    metaT,
    metaMcpReview,
    selectedThreadId,
    setError,
    synchronizeMetaMcpMessages,
    workspaceId,
  ]);

  const reconcileMetaMcpMutation = useCallback(
    async (input: {
      resolution: "succeeded" | "not_executed";
      note: string;
      providerIdentifiers?: Array<{ kind: string; id: string }>;
    }) => {
      const selection = metaMcpReconciliation;
      const threadId = selectedThreadId;
      if (!selection || !threadId || metaMcpSubmissionLockRef.current) return;
      metaMcpSubmissionLockRef.current = true;
      setConfirmingMetaMcpMutationId(selection.execution.id);
      setMetaMcpReconciliationError(undefined);
      setError(null);
      try {
        const transactionDigest =
          selection.execution.version === 2
            ? selection.execution.transaction?.transactionDigest
            : undefined;
        const response = await fetch(
          `/api/workspaces/${workspaceId}/airi-chats/${threadId}/meta-mcp/confirm`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messageId: selection.messageId,
              mutationId: selection.execution.id,
              ...(transactionDigest ? { transactionDigest } : {}),
              resolution: input.resolution,
              note: input.note,
              ...(input.providerIdentifiers?.length
                ? { providerIdentifiers: input.providerIdentifiers }
                : {}),
            }),
          }
        );
        const payload = (await response.json().catch(() => ({}))) as {
          assistantMessage?: AiriChatMessage;
          executionStatus?: "succeeded" | "not_executed" | "outcome_unknown";
          error?: string;
        };
        if (!response.ok || !payload.executionStatus) {
          setMetaMcpReconciliationError(
            payload.error || metaT("errors.record")
          );
          return;
        }

        setMetaMcpReconciliation(null);
        await synchronizeMetaMcpMessages({
          threadId,
          messageId: selection.messageId,
          mutationId: selection.execution.id,
          assistantMessage: payload.assistantMessage,
          executionStatus: payload.executionStatus,
          execution: selection.execution,
          transaction: selection.execution.transaction,
        });
      } catch (err) {
        setMetaMcpReconciliationError(
          err instanceof Error ? err.message : metaT("errors.record")
        );
      } finally {
        metaMcpSubmissionLockRef.current = false;
        setConfirmingMetaMcpMutationId(null);
      }
    },
    [
      metaT,
      metaMcpReconciliation,
      selectedThreadId,
      setError,
      synchronizeMetaMcpMessages,
      workspaceId,
    ]
  );

  const archiveThread = useCallback(
    async (threadId: string) => {
      if (hasAttachedRun()) return;
      const previousThreads = threads;
      const nextThreads = threads.filter(thread => thread.id !== threadId);
      setThreads(nextThreads);
      if (selectedThreadId === threadId) {
        resetBuilderArtifacts();
        startDraft();
        setMobileView("list");
      }
      setError(null);
      try {
        await readJson<{ success: boolean }>(
          await fetch(`/api/workspaces/${workspaceId}/airi-chats/${threadId}`, {
            method: "DELETE",
          })
        );
      } catch (err) {
        setThreads(previousThreads);
        setError(err instanceof Error ? err.message : "Failed to archive chat");
      }
    },
    [
      hasAttachedRun,
      resetBuilderArtifacts,
      selectedThreadId,
      setError,
      setThreads,
      startDraft,
      threads,
      workspaceId,
    ]
  );

  const runStartCardPrompt = useCallback(
    (card: AiriStartCard) => {
      if (showOnboardingQuickActions) {
        markOnboardingQuickActionsSeen();
      }
      closeBuilder();
      void sendMessage(card.prompt, card.selectedSources ?? [], []);
    },
    [
      closeBuilder,
      markOnboardingQuickActionsSeen,
      sendMessage,
      showOnboardingQuickActions,
    ]
  );

  const backToCompactStart = useCallback(() => {
    if (hasAttachedRun()) return;
    closeBuilder();
    startDraftChat();
  }, [closeBuilder, hasAttachedRun, startDraftChat]);

  const togglePinnedThread = useCallback(
    async (thread: AiriChatThread) => {
      const optimisticThread = {
        ...thread,
        pinnedAt: thread.pinnedAt ? null : new Date().toISOString(),
      };
      setThreads(current =>
        sortThreads(
          current.map(item => (item.id === thread.id ? optimisticThread : item))
        )
      );
      try {
        const payload = await readJson<{ thread: AiriChatThread }>(
          await fetch(
            `/api/workspaces/${workspaceId}/airi-chats/${thread.id}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pinned: !thread.pinnedAt }),
            }
          )
        );
        setThreads(current =>
          sortThreads(
            current.map(item =>
              item.id === payload.thread.id ? payload.thread : item
            )
          )
        );
      } catch (err) {
        setThreads(current =>
          sortThreads(
            current.map(item => (item.id === thread.id ? thread : item))
          )
        );
        setError(err instanceof Error ? err.message : "Failed to pin chat");
      }
    },
    [setError, setThreads, workspaceId]
  );

  const metaMcpDialogs = (
    <>
      {metaMcpReview ? (
        <MetaAdsMcpTransactionReviewDialog
          open
          transaction={metaMcpReview.transaction}
          state={metaMcpReviewState}
          error={metaMcpReviewError}
          onOpenChange={open => {
            if (!open && metaMcpReviewState !== "submitting") {
              setMetaMcpReview(null);
              setMetaMcpReviewError(undefined);
            }
          }}
          onConfirm={() => void confirmMetaMcpMutation()}
        />
      ) : null}
      {metaMcpReconciliation ? (
        <MetaAdsMcpReconciliationDialog
          open
          execution={metaMcpReconciliation.execution}
          error={metaMcpReconciliationError}
          submitting={
            confirmingMetaMcpMutationId === metaMcpReconciliation.execution.id
          }
          onOpenChange={open => {
            if (!open && !confirmingMetaMcpMutationId) {
              setMetaMcpReconciliation(null);
            }
          }}
          onSubmit={input => void reconcileMetaMcpMutation(input)}
        />
      ) : null}
    </>
  );

  // The page's chat lists say when they failed to load (not "No chats yet")
  // and offer the same Retry as the banner.
  const threadsLoadErrorNotice =
    threadsLoadError && !isLoadingThreads ? (
      <div
        data-testid="airi-threads-load-error"
        className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground"
      >
        <AlertCircle className="size-4 shrink-0 text-destructive" />
        <p className="min-w-0 [overflow-wrap:anywhere]">{threadsLoadError}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={retryThreadsLoad}
        >
          {chatT("retry")}
        </Button>
      </div>
    ) : null;

  const earlierMessagesView = {
    hasMore: hasEarlierMessages,
    status: earlierMessagesStatus,
    onLoad: () => void loadEarlierMessages(),
  };
  const stopControl = { canStop, stopping: isStopping, onStop: stopRun };
  // The compact, desktop and mobile layouts are mutually exclusive, so each
  // shared element below renders in at most one place.
  const builderPanel = (
    <AiriLazyBuilderSidePanel
      workspaceId={workspaceId}
      mode={builderMode}
      templateArtifactId={builderArtifacts.whatsapp_template?.id}
      templateDraft={builderTemplateDraft}
      flowConfig={builderFlowConfig}
      pendingPatch={pendingBuilderPatch}
      pendingPatchTarget={pendingBuilderPatchTarget}
      pendingPatchBusy={applyingPendingPatch}
      pendingPatchBlocked={pendingPatchBlockedByConflict}
      hasActiveThread={hasBuilderArtifact}
      onModeChange={setActiveBuilderMode}
      onTemplateDraftChange={handleTemplateDraftChange}
      onFlowConfigChange={handleFlowConfigChange}
      onApplyPendingPatch={applyPendingBuilderPatch}
      onDismissPendingPatch={dismissPendingBuilderPatch}
      onSaved={markBuilderSaved}
      conflict={builderConflictView}
      onKeepLocalChanges={keepLocalBuilderChanges}
      onTakeLatestVersion={takeLatestBuilderVersion}
      showCloseButton={!onClose}
      onClose={closeBuilder}
    />
  );
  const pageSidePanel = (
    <AiriPageSidePanel
      workspaceId={workspaceId}
      startCards={startCards}
      threads={threads}
      relativeNow={relativeNow}
      disabled={isSending || sendBlocked}
      onRunPrompt={runStartCardPrompt}
      onSelectThread={threadId => {
        closeBuilder();
        selectThread(threadId);
      }}
      onNewChat={() => {
        closeBuilder();
        startDraftChat();
      }}
      onClose={closeBuilder}
    />
  );
  const renderThreadContent = (builderOpen: boolean, compactLayout?: true) => (
    <AiriThreadContent
      workspaceId={workspaceId}
      compact={compactLayout}
      viewState={{
        builderOpen,
        hasModalClose: Boolean(onClose),
        error: effectiveError,
        onRetryError: retryErrorLoad,
        showEmptyThread,
        isLoadingMessages: effectiveIsLoadingMessages,
        messagesLoadFailed,
        onRetryMessages: retryMessagesLoad,
        sendBlocked,
        showOnboardingQuickActions,
        isSending,
        isLoadingPrefetchedSources: sourceOptions.isLoading,
        prefetchedSourceError: sourceOptions.error,
      }}
      messages={effectiveMessages}
      earlierMessages={earlierMessagesView}
      stopControl={stopControl}
      liveRunEvents={liveRunEvents}
      streamingAnswerText={visibleStreamingAnswer}
      startCards={startCards}
      recentThreads={threads}
      relativeNow={relativeNow}
      prefetchedSourceOptions={sourceOptions.options}
      confirmingMetaMcpMutationId={confirmingMetaMcpMutationId}
      onToggleBuilder={toggleBuilderOpen}
      onSourcesRefresh={sourceOptions.refresh}
      onMarkOnboardingQuickActionsSeen={markOnboardingQuickActionsSeen}
      onSelectThread={selectThread}
      onSendMessage={sendMessage}
      onOpenTemplateDraftInBuilder={openTemplateDraftInBuilder}
      onReviewMetaMcpMutation={openMetaMcpReview}
      onOpenMetaMcpReconciliation={openMetaMcpReconciliation}
    />
  );

  if (compact) {
    return (
      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background dark:bg-black/95">
        {!builderVisible ? (
          <header
            data-testid="airi-compact-header"
            className="flex h-11 shrink-0 items-center gap-2 border-b px-3"
          >
            {selectedThreadId ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 rounded-full"
                aria-label={chatT("backToStart")}
                disabled={isSending}
                onClick={backToCompactStart}
              >
                <ChevronLeft className="size-4" />
              </Button>
            ) : (
              <span className="grid size-8 place-items-center rounded-lg bg-emerald-100 text-emerald-950 dark:bg-emerald-400/20 dark:text-emerald-100">
                <Sparkles className="size-4" />
              </span>
            )}
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">
              {selectedThread?.title || "Airi"}
            </p>
            <AiriTopRightCloseButton
              builderOpen={false}
              className="size-8 bg-transparent"
              onCloseBuilder={closeBuilder}
              onClose={onClose}
            />
          </header>
        ) : null}
        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {builderVisible ? builderPanel : null}
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col",
              builderVisible ? "hidden" : "flex"
            )}
            aria-hidden={builderVisible || undefined}
            inert={builderVisible}
          >
            {renderThreadContent(builderVisible, true)}
          </div>
        </section>

        {builderVisible ? (
          <div className="absolute right-3 top-2 z-[70] flex">
            <AiriTopRightCloseButton
              builderOpen
              className="size-8"
              onCloseBuilder={closeBuilder}
              onClose={onClose}
            />
          </div>
        ) : null}
        {metaMcpDialogs}
      </div>
    );
  }

  return (
    <div className="relative flex h-[calc(100dvh-3rem)] min-h-0 overflow-hidden bg-background lg:flex-row dark:bg-black/95">
      {isAiriMobileLayout === true ? null : (
        <div className="hidden min-w-0 flex-1 lg:block">
          <DesktopColumns
            sidePanelSize={builderPanelSize}
            onSidePanelSizeChange={setBuilderPanelSize}
            threadList={
              <aside className="flex h-full flex-col bg-background/95 shadow-[14px_0_34px_-34px_rgba(15,23,42,0.9)] dark:bg-black">
                <div className="flex items-center px-2 py-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={startDraftChat}
                    disabled={isSending}
                    aria-label={chatT("newAiriChat")}
                    className="h-8 justify-start px-2 text-muted-foreground hover:text-foreground"
                    title={chatT("newChat")}
                  >
                    <MessageSquarePlus className="size-4" />
                    <span>{chatT("newChat")}</span>
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                  {isLoadingThreads && threads.length === 0 ? (
                    <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      {chatT("loadingChats")}
                    </div>
                  ) : null}
                  {threadsLoadErrorNotice}
                  {threads.map(thread => (
                    <AiriThreadRow
                      key={thread.id}
                      thread={thread}
                      selected={selectedThreadId === thread.id}
                      disabled={isSending}
                      relativeNow={relativeNow}
                      onSelect={selectThread}
                      onTogglePinned={togglePinnedThread}
                      onArchive={archiveThread}
                    />
                  ))}
                </div>
              </aside>
            }
            thread={
              <section className="relative flex h-full min-w-0 flex-col">
                {renderThreadContent(rightPanelVisible)}
              </section>
            }
            sidePanel={
              rightPanelVisible
                ? builderVisible
                  ? builderPanel
                  : pageSidePanel
                : null
            }
          />
        </div>
      )}

      {isAiriMobileLayout !== false ? (
        <>
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col lg:hidden",
              mobileView !== "list" && "hidden"
            )}
          >
            <div
              className={cn(
                "flex h-14 shrink-0 items-center justify-between pl-4 pr-4",
                onClose && "pr-14"
              )}
            >
              <div>
                <div className="text-base font-semibold">Airi</div>
                <div className="text-xs text-muted-foreground">
                  {chatT("chatCount", { count: threads.length })}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {!onClose ? (
                  <BuilderToggleButton
                    open={rightPanelVisible}
                    className="size-10 lg:hidden"
                    onToggle={toggleBuilderOpen}
                  />
                ) : null}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={chatT("newChat")}
                  className="size-10 rounded-full"
                  disabled={isSending}
                  onClick={startDraftChat}
                >
                  <Plus className="size-5" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-28 pt-4">
              {isLoadingThreads && threads.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {chatT("loadingChats")}
                </div>
              ) : null}
              {threadsLoadErrorNotice}
              {!isLoadingThreads &&
              !threadsLoadError &&
              filteredThreads.length === 0 ? (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  {chatT("noChatsYet")}
                </div>
              ) : null}
              <div className="space-y-1">
                {filteredThreads.map(thread => (
                  <AiriThreadRow
                    key={thread.id}
                    thread={thread}
                    mobile
                    disabled={isSending}
                    selected={selectedThreadId === thread.id}
                    relativeNow={relativeNow}
                    onSelect={selectThread}
                    onTogglePinned={togglePinnedThread}
                    onArchive={archiveThread}
                  />
                ))}
              </div>
            </div>
            <div className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 bg-background/80 px-5 py-4 backdrop-blur-xl dark:bg-black/80 lg:hidden">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-muted/80 px-4 shadow-[0_18px_50px_-36px_rgba(15,23,42,0.9)]">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  value={threadSearch}
                  onChange={event => setThreadSearch(event.target.value)}
                  placeholder={chatT("searchChats")}
                  className="h-11 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
              </div>
              <Button
                type="button"
                className="h-11 shrink-0 rounded-full px-5"
                disabled={isSending}
                onClick={startDraftChat}
              >
                <MessageSquarePlus className="size-4" />
                {chatT("startChat")}
              </Button>
            </div>
          </div>

          <section
            className={cn(
              "min-w-0 flex-1 flex-col lg:hidden",
              mobileView === "thread" ? "flex" : "hidden"
            )}
          >
            <div
              className={cn(
                "flex h-14 shrink-0 items-center gap-2 pl-3 pr-3 lg:hidden",
                onClose && "pr-14"
              )}
            >
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={chatT("backToChats")}
                disabled={isSending}
                className="size-10 rounded-full"
                onClick={() => setMobileView("list")}
              >
                <ChevronLeft className="size-5" />
              </Button>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                disabled={isSending}
                onClick={() => setMobileView("list")}
              >
                <div className="truncate text-sm font-semibold">
                  {mobileTitle}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {chatT("workspaceAssistant")}
                </div>
              </button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={chatT("newChat")}
                className="size-10 rounded-full"
                disabled={isSending}
                onClick={startDraftChat}
              >
                <MessageSquarePlus className="size-5" />
              </Button>
              {!onClose ? (
                <BuilderToggleButton
                  open={rightPanelVisible}
                  className="size-10 lg:hidden"
                  onToggle={toggleBuilderOpen}
                />
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={chatT("moreChatActions")}
                    className="size-10 rounded-full"
                  >
                    <MoreHorizontal className="size-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {selectedThread ? (
                    <>
                      <DropdownMenuItem
                        onClick={() => void togglePinnedThread(selectedThread)}
                      >
                        {selectedThread.pinnedAt
                          ? chatT("unpinChat")
                          : chatT("pinChat")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={isSending}
                        onClick={() => void archiveThread(selectedThread.id)}
                      >
                        {chatT("archiveChat")}
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      disabled={isSending}
                      onClick={startDraftChat}
                    >
                      {chatT("newChat")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {renderThreadContent(rightPanelVisible)}
          </section>
        </>
      ) : null}

      {builderVisible && isAiriMobileLayout ? (
        <div className="fixed inset-0 z-50 bg-background lg:hidden dark:bg-black">
          {builderPanel}
        </div>
      ) : null}

      {airiPageToolsVisible && isAiriMobileLayout ? (
        <div className="fixed inset-0 z-50 bg-background lg:hidden dark:bg-black">
          {pageSidePanel}
        </div>
      ) : null}

      <div className="absolute right-3 top-2 z-[70] flex">
        <AiriTopRightCloseButton
          builderOpen={builderVisible}
          className="size-10"
          onCloseBuilder={closeBuilder}
          onClose={onClose}
        />
      </div>
      {metaMcpDialogs}
    </div>
  );
}
