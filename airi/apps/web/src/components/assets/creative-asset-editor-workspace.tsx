"use client";

import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isRetryableAiriGreenScreenAsset } from "@/lib/creative-assets/green-screen";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  AudioLines,
  Copy,
  ExternalLink,
  Film,
  Hand,
  ImageIcon,
  Layers3,
  Loader2,
  Magnet,
  Maximize2,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  Scissors,
  Settings2,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import useSWR from "swr";

import type { CreativeAsset } from "./creative-assets-workspace";
import {
  bindTimelineAsset,
  buildTimelineRender,
  findTimelineSplitClip,
  getTimelineDuration,
  isEditableTimelineClip,
  MIN_TIMELINE_SEGMENT_SECONDS,
  moveTimelineClip,
  resolveNextTimelineFrame,
  resolveTimelineFrame,
  shouldPreserveTimelineClips,
  splitTimelineClip,
  trimTimelineClip,
  type TimelineClip,
  type TimelineTrackId,
  type TimelineTrimEdge,
} from "./creative-asset-timeline";

type AssetPayload = {
  asset?: CreativeAsset;
};

type AssetsPayload = {
  assets?: CreativeAsset[];
};

type EditAssetPayload = {
  asset?: CreativeAsset;
  duplicate?: boolean;
  success?: boolean;
};

type CreativeAssetEditorWorkspaceProps = {
  workspaceId: string;
  assetId: string;
};

type PendingTimelineSeek = {
  assetId: string;
  clipId: string;
  sourceTime: number;
  shouldPlay: boolean;
};

type RailItemId = "media" | "tools";
type InspectorTab = "clip" | "bria" | "export";
type MediaFilter = "all" | "video" | "image";
type TrackId = TimelineTrackId;
type OperationId = "green" | "remove" | "replace" | "upscale";

type TimelineHistoryEntry = {
  label: string;
  clips: TimelineClip[];
  selectedClipId: string | null;
  selectedInspectorTab: InspectorTab;
  previewAssetId: string | null;
};

type EditorState = {
  selectedRailItem: RailItemId;
  selectedInspectorTab: InspectorTab;
  selectedClipId: string | null;
  mediaFilter: MediaFilter;
  previewAssetId: string | null;
  activeDragAssetId: string | null;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  timelineZoom: number;
  snapEnabled: boolean;
  proxyEnabled: boolean;
  safeAreaEnabled: boolean;
  operation: OperationId;
  sourceAssetId: string | null;
  sourceDuration: number;
  chunkCount: number;
  clips: TimelineClip[];
  history: TimelineHistoryEntry[];
};

type EditorAction =
  | { type: "set_rail"; value: RailItemId }
  | { type: "set_inspector"; value: InspectorTab }
  | { type: "set_filter"; value: MediaFilter }
  | { type: "set_preview_asset"; assetId: string }
  | { type: "set_drag_asset"; assetId: string | null }
  | { type: "toggle_left_panel" }
  | { type: "toggle_right_panel" }
  | { type: "zoom_in" }
  | { type: "zoom_out" }
  | { type: "toggle_snap" }
  | { type: "toggle_proxy" }
  | { type: "toggle_safe_area" }
  | { type: "set_operation"; value: OperationId }
  | {
      type: "hydrate_source";
      asset: CreativeAsset;
      duration: number;
      chunkCount: number;
    }
  | {
      type: "bind_green_output";
      sourceAssetId: string;
      outputAssetId: string;
    }
  | {
      type: "add_asset_to_track";
      asset: CreativeAsset;
      trackId: TrackId;
      assetDuration?: number;
    }
  | { type: "select_clip"; clipId: string }
  | { type: "split_clip"; time: number }
  | {
      type: "move_clip";
      clipId: string;
      start: number;
    }
  | {
      type: "trim_clip";
      clipId: string;
      edge: TimelineTrimEdge;
      time: number;
    }
  | { type: "duplicate_clip" }
  | { type: "remove_clip" }
  | { type: "undo_timeline" };

const BRIA_EDITOR_CHUNK_SECONDS = 55;
const FALLBACK_EDITOR_DURATION_SECONDS = 82;
const TRACK_IDS: TrackId[] = ["V2", "V1", "A1"];
const MIN_TIMELINE_ZOOM = 100;
const MAX_TIMELINE_ZOOM = 260;
const MAX_EDITOR_HISTORY_ENTRIES = 40;
const trackLabels: Record<TrackId, string> = {
  V2: "Bria",
  V1: "Source",
  A1: "Audio",
};

const railItems: Array<{
  id: RailItemId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { id: "media", label: "Media", icon: Film },
  { id: "tools", label: "Tools", icon: WandSparkles },
];

const briaOperations = [
  { id: "green", label: "Green", icon: Sparkles, enabled: true },
  { id: "remove", label: "Cutout", icon: Scissors, enabled: false },
  { id: "replace", label: "Replace", icon: ImageIcon, enabled: false },
  { id: "upscale", label: "Upscale", icon: ZoomIn, enabled: false },
] satisfies Array<{
  id: OperationId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  enabled: boolean;
}>;

const initialEditorState: EditorState = {
  selectedRailItem: "media",
  selectedInspectorTab: "bria",
  selectedClipId: null,
  mediaFilter: "all",
  previewAssetId: null,
  activeDragAssetId: null,
  leftPanelOpen: true,
  rightPanelOpen: true,
  timelineZoom: 130,
  snapEnabled: true,
  proxyEnabled: true,
  safeAreaEnabled: true,
  operation: "green",
  sourceAssetId: null,
  sourceDuration: FALLBACK_EDITOR_DURATION_SECONDS,
  chunkCount: 1,
  clips: [],
  history: [],
};

const mediaFilters: Array<{ id: MediaFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "image", label: "Still" },
];

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

const fetchJson = async <T,>(url: string): Promise<T> =>
  readJsonResponse<T>(await fetch(url));

function assetTitle(asset: CreativeAsset | null | undefined): string {
  if (!asset) return "Asset editor";
  return asset.fileName || asset.prompt || asset.id;
}

function formatTimecode(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "00:00:00";
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDuration(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "--:--";
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return "";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function statusTone(status: CreativeAsset["status"] | undefined): string {
  if (status === "complete") return "bg-emerald-400/12 text-emerald-300";
  if (status === "failed" || status === "nsfw") {
    return "bg-rose-400/12 text-rose-300";
  }
  return "bg-amber-400/12 text-amber-300";
}

function statusLabel(status: CreativeAsset["status"] | undefined): string {
  if (status === "queued") return "Queued";
  if (status === "in_progress") return "Rendering";
  if (status === "complete") return "Complete";
  if (status === "failed") return "Failed";
  if (status === "nsfw") return "Blocked";
  return "--";
}

function isProcessingAsset(asset: CreativeAsset | null | undefined): boolean {
  return asset?.status === "queued" || asset?.status === "in_progress";
}

function isGreenScreenDerivative(
  asset: CreativeAsset,
  sourceAssetId: string
): boolean {
  return (
    isRetryableAiriGreenScreenAsset(asset) &&
    asset.sourceAssetId === sourceAssetId
  );
}

function isTrackId(value: unknown): value is TrackId {
  return typeof value === "string" && TRACK_IDS.includes(value as TrackId);
}

function createSourceClips(
  asset: CreativeAsset,
  duration: number,
  chunkCount: number
): TimelineClip[] {
  const safeDuration = Math.max(1, duration);
  const chunks = Array.from({ length: chunkCount }, (_, index) => {
    const start = index * BRIA_EDITOR_CHUNK_SECONDS;
    const length = Math.min(
      BRIA_EDITOR_CHUNK_SECONDS,
      Math.max(1, safeDuration - start)
    );
    return {
      id: `chunk-${asset.id}-${index}`,
      assetId: asset.id,
      trackId: "V2" as const,
      label: `C${index + 1}`,
      start,
      sourceStart: start,
      duration: length,
      kind: asset.kind,
      origin: "bria" as const,
      operation: "green" as const,
    };
  });

  return [
    {
      id: `source-${asset.id}`,
      assetId: asset.id,
      trackId: "V1",
      label: "source",
      start: 0,
      sourceStart: 0,
      duration: safeDuration,
      kind: asset.kind,
      origin: "source",
      locked: true,
    },
    ...chunks,
    {
      id: `audio-${asset.id}`,
      assetId: asset.id,
      trackId: "A1",
      label: "wave",
      start: 0,
      sourceStart: 0,
      duration: safeDuration,
      kind: asset.kind,
      origin: "audio",
      locked: true,
    },
  ];
}

function nextClipStart(clips: TimelineClip[], trackId: TrackId): number {
  return clips
    .filter(clip => clip.trackId === trackId)
    .reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
}

function userClipDuration(
  asset: CreativeAsset,
  assetDuration?: number
): number {
  if (asset.kind === "image") return 5;
  if (assetDuration && Number.isFinite(assetDuration)) {
    return Math.max(MIN_TIMELINE_SEGMENT_SECONDS, assetDuration);
  }
  return 12;
}

function timelineSnapshot(
  state: EditorState,
  label: string
): TimelineHistoryEntry {
  return {
    label,
    clips: state.clips,
    selectedClipId: state.selectedClipId,
    selectedInspectorTab: state.selectedInspectorTab,
    previewAssetId: state.previewAssetId,
  };
}

function commitTimelineEdit(
  state: EditorState,
  nextState: EditorState,
  label: string
): EditorState {
  return {
    ...nextState,
    history: [...state.history, timelineSnapshot(state, label)].slice(
      -MAX_EDITOR_HISTORY_ENTRIES
    ),
  };
}

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "set_rail":
      return { ...state, selectedRailItem: action.value };
    case "set_inspector":
      return { ...state, selectedInspectorTab: action.value };
    case "set_filter":
      return { ...state, mediaFilter: action.value };
    case "set_preview_asset":
      return {
        ...state,
        previewAssetId: action.assetId,
        selectedRailItem: "media",
      };
    case "set_drag_asset":
      return { ...state, activeDragAssetId: action.assetId };
    case "toggle_left_panel":
      return { ...state, leftPanelOpen: !state.leftPanelOpen };
    case "toggle_right_panel":
      return { ...state, rightPanelOpen: !state.rightPanelOpen };
    case "zoom_in":
      return {
        ...state,
        timelineZoom: Math.min(MAX_TIMELINE_ZOOM, state.timelineZoom + 30),
      };
    case "zoom_out":
      return {
        ...state,
        timelineZoom: Math.max(MIN_TIMELINE_ZOOM, state.timelineZoom - 30),
      };
    case "toggle_snap":
      return { ...state, snapEnabled: !state.snapEnabled };
    case "toggle_proxy":
      return { ...state, proxyEnabled: !state.proxyEnabled };
    case "toggle_safe_area":
      return { ...state, safeAreaEnabled: !state.safeAreaEnabled };
    case "set_operation":
      return {
        ...state,
        operation: action.value,
        selectedInspectorTab: "bria",
      };
    case "hydrate_source": {
      if (
        state.sourceAssetId === action.asset.id &&
        state.sourceDuration === action.duration &&
        state.chunkCount === action.chunkCount
      ) {
        return state;
      }

      if (
        state.sourceAssetId === action.asset.id &&
        shouldPreserveTimelineClips({
          clips: state.clips,
          sourceAssetId: action.asset.id,
          historyLength: state.history.length,
        })
      ) {
        return {
          ...state,
          sourceDuration: action.duration,
          chunkCount: action.chunkCount,
        };
      }

      const sourceClips = createSourceClips(
        action.asset,
        action.duration,
        action.chunkCount
      );
      const userClips = state.clips.filter(clip => clip.origin === "user");
      const selectedClipStillExists = [...sourceClips, ...userClips].some(
        clip => clip.id === state.selectedClipId
      );
      return {
        ...state,
        sourceAssetId: action.asset.id,
        sourceDuration: action.duration,
        chunkCount: action.chunkCount,
        previewAssetId: state.previewAssetId || action.asset.id,
        selectedClipId: selectedClipStillExists
          ? state.selectedClipId
          : sourceClips[1]?.id || sourceClips[0]?.id || null,
        clips: [...sourceClips, ...userClips],
        history: state.sourceAssetId === action.asset.id ? state.history : [],
      };
    }
    case "bind_green_output": {
      const clips = bindTimelineAsset(state.clips, {
        sourceAssetId: action.sourceAssetId,
        outputAssetId: action.outputAssetId,
        origin: "bria",
      });
      return clips === state.clips ? state : { ...state, clips };
    }
    case "add_asset_to_track": {
      const duration = userClipDuration(action.asset, action.assetDuration);
      const start = state.snapEnabled
        ? Math.round(nextClipStart(state.clips, action.trackId) * 10) / 10
        : nextClipStart(state.clips, action.trackId);
      const clip: TimelineClip = {
        id: `user-${action.asset.id}-${action.trackId}-${Date.now()}`,
        assetId: action.asset.id,
        trackId: action.trackId,
        label: assetTitle(action.asset),
        start,
        sourceStart: 0,
        duration,
        kind: action.asset.kind,
        origin: "user",
        operation: state.operation,
      };
      return commitTimelineEdit(
        state,
        {
          ...state,
          clips: [...state.clips, clip],
          selectedClipId: clip.id,
          selectedInspectorTab: "clip",
          previewAssetId: action.asset.id,
        },
        "Add clip"
      );
    }
    case "select_clip":
      return {
        ...state,
        selectedClipId: action.clipId,
        selectedInspectorTab: "clip",
      };
    case "split_clip": {
      const result = splitTimelineClip({
        clips: state.clips,
        selectedClipId: state.selectedClipId,
        time: action.time,
        snapEnabled: state.snapEnabled,
        newClipId: `clip-cut-${Date.now()}`,
      });
      if (!result) return state;
      return commitTimelineEdit(
        state,
        {
          ...state,
          clips: result.clips,
          selectedClipId: result.selectedClipId,
          selectedInspectorTab: "clip",
        },
        "Cut"
      );
    }
    case "move_clip": {
      const result = moveTimelineClip({
        clips: state.clips,
        clipId: action.clipId,
        start: action.start,
        snapEnabled: state.snapEnabled,
      });
      if (!result) return state;
      return commitTimelineEdit(
        state,
        {
          ...state,
          clips: result.clips,
          selectedClipId: result.selectedClipId,
          selectedInspectorTab: "clip",
        },
        "Move"
      );
    }
    case "trim_clip": {
      const result = trimTimelineClip({
        clips: state.clips,
        clipId: action.clipId,
        edge: action.edge,
        time: action.time,
        snapEnabled: state.snapEnabled,
      });
      if (!result) return state;
      return commitTimelineEdit(
        state,
        {
          ...state,
          clips: result.clips,
          selectedClipId: result.selectedClipId,
          selectedInspectorTab: "clip",
        },
        "Trim"
      );
    }
    case "duplicate_clip": {
      const selected = state.clips.find(
        clip => clip.id === state.selectedClipId
      );
      if (!selected) return state;
      const clone: TimelineClip = {
        ...selected,
        id: `user-${selected.assetId}-${selected.trackId}-${Date.now()}`,
        origin: "user",
        locked: false,
        start: Math.min(
          Math.max(0, state.sourceDuration - selected.duration),
          selected.start + selected.duration
        ),
      };
      return commitTimelineEdit(
        state,
        {
          ...state,
          clips: [...state.clips, clone],
          selectedClipId: clone.id,
          selectedInspectorTab: "clip",
        },
        "Copy"
      );
    }
    case "remove_clip": {
      const selected = state.clips.find(
        clip => clip.id === state.selectedClipId
      );
      if (!selected || selected.locked) return state;
      const clips = state.clips.filter(clip => clip.id !== selected.id);
      return commitTimelineEdit(
        state,
        {
          ...state,
          clips,
          selectedClipId:
            clips.find(clip => !clip.locked && clip.trackId !== "A1")?.id ||
            null,
        },
        "Delete"
      );
    }
    case "undo_timeline": {
      const previous = state.history[state.history.length - 1];
      if (!previous) return state;
      return {
        ...state,
        clips: previous.clips,
        selectedClipId: previous.selectedClipId,
        selectedInspectorTab: previous.selectedInspectorTab,
        previewAssetId: previous.previewAssetId,
        history: state.history.slice(0, -1),
      };
    }
    default:
      return state;
  }
}

export function CreativeAssetEditorWorkspace({
  workspaceId,
  assetId,
}: CreativeAssetEditorWorkspaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const pendingTimelineSeekRef = useRef<PendingTimelineSeek | null>(null);
  const activeTimelineClipRef = useRef<TimelineClip | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [timelinePreviewActive, setTimelinePreviewActive] = useState(true);
  const [assetDurations, setAssetDurations] = useState<Record<string, number>>(
    {}
  );
  const [isQueuingRender, setIsQueuingRender] = useState(false);
  const [renderedDerivativeAsset, setRenderedDerivativeAsset] =
    useState<CreativeAsset | null>(null);
  const [isQueuingTimelineRender, setIsQueuingTimelineRender] = useState(false);
  const [renderedTimelineAsset, setRenderedTimelineAsset] =
    useState<CreativeAsset | null>(null);
  const [queuedTimelineKey, setQueuedTimelineKey] = useState<string | null>(
    null
  );
  const [editorState, dispatch] = useReducer(editorReducer, initialEditorState);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    })
  );

  const assetUrl = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`;
  const libraryUrl = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets?limit=80`;
  const { data, isLoading } = useSWR<AssetPayload>(assetUrl, fetchJson);
  const { data: libraryData, mutate: mutateLibrary } = useSWR<AssetsPayload>(
    libraryUrl,
    fetchJson
  );
  const asset = data?.asset || null;
  const displayDuration =
    duration && Number.isFinite(duration)
      ? duration
      : FALLBACK_EDITOR_DURATION_SECONDS;
  const timelineDuration = useMemo(
    () => getTimelineDuration(editorState.clips, displayDuration),
    [displayDuration, editorState.clips]
  );
  const timelineRender = useMemo(
    () => buildTimelineRender(editorState.clips, timelineDuration),
    [editorState.clips, timelineDuration]
  );
  const timelineKey = useMemo(
    () => JSON.stringify(timelineRender),
    [timelineRender]
  );
  const timelineSourceCount = useMemo(
    () => new Set(timelineRender.clips.map(clip => clip.assetId)).size,
    [timelineRender.clips]
  );
  const timelinePercent =
    timelineDuration > 0
      ? Math.max(0, Math.min(100, (currentTime / timelineDuration) * 100))
      : 0;
  const chunkCount = Math.max(
    1,
    Math.ceil(displayDuration / BRIA_EDITOR_CHUNK_SECONDS)
  );
  const libraryAssets = useMemo(
    () => libraryData?.assets || [],
    [libraryData?.assets]
  );
  const existingGreenScreenDerivative = useMemo(
    () =>
      libraryAssets.find(item => isGreenScreenDerivative(item, assetId)) ||
      null,
    [assetId, libraryAssets]
  );
  const activeDerivativeAsset =
    renderedDerivativeAsset || existingGreenScreenDerivative;
  const derivativePollUrl =
    activeDerivativeAsset && isProcessingAsset(activeDerivativeAsset)
      ? `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(activeDerivativeAsset.id)}`
      : null;
  const { data: derivativePollData } = useSWR<AssetPayload>(
    derivativePollUrl,
    fetchJson,
    {
      refreshInterval: 4_000,
      revalidateOnFocus: true,
    }
  );
  const activeTimelineAsset =
    queuedTimelineKey === timelineKey ? renderedTimelineAsset : null;
  const timelinePollUrl =
    renderedTimelineAsset && isProcessingAsset(renderedTimelineAsset)
      ? `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(renderedTimelineAsset.id)}`
      : null;
  const { data: timelinePollData } = useSWR<AssetPayload>(
    timelinePollUrl,
    fetchJson,
    {
      refreshInterval: 4_000,
      revalidateOnFocus: true,
    }
  );
  const sourceAssets = useMemo(() => {
    const map = new Map<string, CreativeAsset>();
    for (const item of libraryAssets) {
      if (
        item.id === assetId ||
        item.id === activeDerivativeAsset?.id ||
        item.id === renderedTimelineAsset?.id ||
        (item.status === "complete" &&
          (item.kind === "video" || item.kind === "image"))
      ) {
        map.set(item.id, item);
      }
    }
    if (activeDerivativeAsset) {
      map.set(activeDerivativeAsset.id, activeDerivativeAsset);
    }
    if (renderedTimelineAsset) {
      map.set(renderedTimelineAsset.id, renderedTimelineAsset);
    }
    return Array.from(map.values());
  }, [activeDerivativeAsset, assetId, libraryAssets, renderedTimelineAsset]);
  const assetById = useMemo(
    () => new Map(sourceAssets.map(item => [item.id, item])),
    [sourceAssets]
  );
  const filteredSourceAssets = useMemo(
    () =>
      sourceAssets.filter(item => {
        if (editorState.mediaFilter === "all") return true;
        return item.kind === editorState.mediaFilter;
      }),
    [editorState.mediaFilter, sourceAssets]
  );
  const manualPreviewAsset =
    (editorState.previewAssetId && assetById.get(editorState.previewAssetId)) ||
    asset;
  const timelineFrame = useMemo(
    () => resolveTimelineFrame(editorState.clips, currentTime),
    [currentTime, editorState.clips]
  );
  const previewAsset = timelinePreviewActive
    ? (timelineFrame && assetById.get(timelineFrame.clip.assetId)) ||
      (editorState.clips.length === 0 ? asset : null)
    : manualPreviewAsset;
  const activeDragAsset =
    editorState.activeDragAssetId &&
    assetById.get(editorState.activeDragAssetId);
  const selectedClip =
    editorState.clips.find(clip => clip.id === editorState.selectedClipId) ||
    null;
  const selectedClipAsset =
    (selectedClip && assetById.get(selectedClip.assetId)) || asset;
  const canUndoTimeline = editorState.history.length > 0;
  const lastHistoryLabel =
    editorState.history[editorState.history.length - 1]?.label;
  const canRemoveSelectedClip = isEditableTimelineClip(selectedClip);
  const canSplitAtPlayhead =
    timelinePreviewActive &&
    Boolean(
      findTimelineSplitClip(
        editorState.clips,
        editorState.selectedClipId,
        currentTime
      )
    );
  const gridTemplateColumns = [
    "44px",
    editorState.leftPanelOpen ? "300px" : null,
    "minmax(0,1fr)",
    editorState.rightPanelOpen ? "320px" : null,
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (!asset) return;
    if (asset.kind === "video" && !duration) return;
    const sourceDuration = duration || displayDuration;
    dispatch({
      type: "hydrate_source",
      asset,
      duration: sourceDuration,
      chunkCount: Math.max(
        1,
        Math.ceil(sourceDuration / BRIA_EDITOR_CHUNK_SECONDS)
      ),
    });
  }, [asset, displayDuration, duration]);

  useEffect(() => {
    if (
      activeDerivativeAsset?.status !== "complete" ||
      !editorState.sourceAssetId
    ) {
      return;
    }
    dispatch({
      type: "bind_green_output",
      sourceAssetId: assetId,
      outputAssetId: activeDerivativeAsset.id,
    });
  }, [activeDerivativeAsset, assetId, editorState.sourceAssetId]);

  const applyTimelinePosition = useCallback(
    async (seconds: number, shouldPlay: boolean) => {
      const nextTime = Math.max(0, Math.min(seconds, timelineDuration));
      const frame = resolveTimelineFrame(editorState.clips, nextTime);
      const video = videoRef.current;
      setTimelinePreviewActive(true);
      setCurrentTime(nextTime);

      if (!frame) {
        activeTimelineClipRef.current = null;
        pendingTimelineSeekRef.current = null;
        video?.pause();
        setIsPlaying(false);
        return;
      }

      activeTimelineClipRef.current = frame.clip;
      pendingTimelineSeekRef.current = {
        assetId: frame.clip.assetId,
        clipId: frame.clip.id,
        sourceTime: frame.sourceTime,
        shouldPlay,
      };
      if (video?.dataset.assetId !== frame.clip.assetId) return;

      video.currentTime = Math.max(0, frame.sourceTime);
      pendingTimelineSeekRef.current = null;
      if (shouldPlay) {
        try {
          await video.play();
          setIsPlaying(true);
        } catch {
          setIsPlaying(false);
        }
      } else {
        video.pause();
        setIsPlaying(false);
      }
    },
    [editorState.clips, timelineDuration]
  );

  const advanceTimelinePlayback = useCallback(
    (afterTime: number) => {
      const immediateTime = Math.min(timelineDuration, afterTime + 1 / 1000);
      const immediate = resolveTimelineFrame(editorState.clips, immediateTime);
      if (immediate) {
        void applyTimelinePosition(immediateTime, true);
        return;
      }
      const next = resolveNextTimelineFrame(editorState.clips, afterTime);
      if (next && next.timelineTime < timelineDuration) {
        void applyTimelinePosition(next.timelineTime, true);
        return;
      }

      videoRef.current?.pause();
      activeTimelineClipRef.current = null;
      setCurrentTime(timelineDuration);
      setIsPlaying(false);
    },
    [applyTimelinePosition, editorState.clips, timelineDuration]
  );

  const seekTo = useCallback(
    (seconds: number) => {
      void applyTimelinePosition(seconds, false);
    },
    [applyTimelinePosition]
  );

  const togglePlayback = useCallback(async () => {
    const video = videoRef.current;
    if (isPlaying) {
      video?.pause();
      setIsPlaying(false);
      return;
    }

    const frame = resolveTimelineFrame(editorState.clips, currentTime);
    if (frame) {
      await applyTimelinePosition(currentTime, true);
      return;
    }
    const next = resolveNextTimelineFrame(editorState.clips, currentTime);
    if (next) {
      await applyTimelinePosition(next.timelineTime, true);
    }
  }, [applyTimelinePosition, currentTime, editorState.clips, isPlaying]);

  const handleVideoLoadedMetadata = useCallback(
    (video: HTMLVideoElement) => {
      const videoAssetId = video.dataset.assetId;
      const videoDuration = video.duration;
      if (videoAssetId && Number.isFinite(videoDuration) && videoDuration > 0) {
        setAssetDurations(current =>
          current[videoAssetId] === videoDuration
            ? current
            : { ...current, [videoAssetId]: videoDuration }
        );
        if (videoAssetId === asset?.id) setDuration(videoDuration);
      }

      const pending = pendingTimelineSeekRef.current;
      if (!pending || pending.assetId !== videoAssetId) return;
      video.currentTime = Math.max(0, pending.sourceTime);
      pendingTimelineSeekRef.current = null;
      if (pending.shouldPlay) {
        void video.play().catch(() => setIsPlaying(false));
      }
    },
    [asset?.id]
  );

  const handleVideoTimeUpdate = useCallback(
    (video: HTMLVideoElement) => {
      if (!timelinePreviewActive) {
        setCurrentTime(video.currentTime);
        return;
      }
      const clip = activeTimelineClipRef.current;
      if (!clip || video.dataset.assetId !== clip.assetId) return;
      const timelineTime =
        clip.start + Math.max(0, video.currentTime - clip.sourceStart);
      const clipEnd = clip.start + clip.duration;
      if (timelineTime >= clipEnd - 1 / 60) {
        advanceTimelinePlayback(clipEnd);
        return;
      }
      setCurrentTime(Math.min(timelineDuration, timelineTime));
    },
    [advanceTimelinePlayback, timelineDuration, timelinePreviewActive]
  );

  const handleVideoEnded = useCallback(() => {
    const clip = activeTimelineClipRef.current;
    if (timelinePreviewActive && clip) {
      advanceTimelinePlayback(clip.start + clip.duration);
      return;
    }
    setIsPlaying(false);
  }, [advanceTimelinePlayback, timelinePreviewActive]);

  const selectManualPreview = useCallback((previewAssetId: string) => {
    videoRef.current?.pause();
    activeTimelineClipRef.current = null;
    pendingTimelineSeekRef.current = null;
    setTimelinePreviewActive(false);
    setCurrentTime(0);
    setIsPlaying(false);
    dispatch({ type: "set_preview_asset", assetId: previewAssetId });
  }, []);

  const seekTimelineFromClientX = useCallback(
    (clientX: number) => {
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const ratio = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width)
      );
      seekTo(ratio * timelineDuration);
    },
    [seekTo, timelineDuration]
  );

  const handlePlayheadPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      seekTimelineFromClientX(event.clientX);
    },
    [seekTimelineFromClientX]
  );

  const handlePlayheadPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      seekTimelineFromClientX(event.clientX);
    },
    [seekTimelineFromClientX]
  );

  const handlePlayheadPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    []
  );

  const handleSplitAtPlayhead = useCallback(() => {
    if (!canSplitAtPlayhead) {
      toast.error("Move playhead inside an unlocked clip");
      return;
    }
    dispatch({ type: "split_clip", time: currentTime });
  }, [canSplitAtPlayhead, currentTime]);

  const handleRemoveSelectedClip = useCallback(() => {
    if (!canRemoveSelectedClip) return;
    dispatch({ type: "remove_clip" });
  }, [canRemoveSelectedClip]);

  const handleUndoTimeline = useCallback(() => {
    if (!canUndoTimeline) return;
    dispatch({ type: "undo_timeline" });
  }, [canUndoTimeline]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (isTyping) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        if (!canUndoTimeline) return;
        event.preventDefault();
        dispatch({ type: "undo_timeline" });
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        if (!canRemoveSelectedClip) return;
        event.preventDefault();
        dispatch({ type: "remove_clip" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canRemoveSelectedClip, canUndoTimeline]);

  const previewDerivative = useCallback(
    (derivative: CreativeAsset) => {
      if (!derivative.url) return;
      selectManualPreview(derivative.id);
    },
    [selectManualPreview]
  );

  useEffect(() => {
    if (!derivativePollData?.asset) return;
    setRenderedDerivativeAsset(derivativePollData.asset);
    if (!isProcessingAsset(derivativePollData.asset)) {
      void mutateLibrary();
      if (
        derivativePollData.asset.status === "complete" &&
        derivativePollData.asset.url
      ) {
        previewDerivative(derivativePollData.asset);
      }
    }
  }, [derivativePollData?.asset, mutateLibrary, previewDerivative]);

  useEffect(() => {
    if (
      !timelinePollData?.asset ||
      timelinePollData.asset.id !== renderedTimelineAsset?.id
    ) {
      return;
    }
    setRenderedTimelineAsset(timelinePollData.asset);
    if (!isProcessingAsset(timelinePollData.asset)) {
      void mutateLibrary();
      if (
        queuedTimelineKey === timelineKey &&
        timelinePollData.asset.status === "complete" &&
        timelinePollData.asset.url
      ) {
        previewDerivative(timelinePollData.asset);
      }
    }
  }, [
    mutateLibrary,
    previewDerivative,
    queuedTimelineKey,
    renderedTimelineAsset?.id,
    timelineKey,
    timelinePollData?.asset,
  ]);

  const handleRenderDerivative = useCallback(async () => {
    if (!asset) return;
    if (
      asset.kind !== "video" ||
      asset.status !== "complete" ||
      !asset.url ||
      editorState.operation !== "green"
    ) {
      toast.error("Green-screen rendering requires a completed source video");
      return;
    }

    if (activeDerivativeAsset?.status === "complete") {
      previewDerivative(activeDerivativeAsset);
      return;
    }

    if (isProcessingAsset(activeDerivativeAsset)) return;

    setIsQueuingRender(true);
    try {
      const payload = await readJsonResponse<EditAssetPayload>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(asset.id)}/edits`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operation: "green_screen",
              ...(activeDerivativeAsset?.status === "failed"
                ? { retryAssetId: activeDerivativeAsset.id }
                : {}),
            }),
          }
        )
      );
      if (payload.asset) {
        setRenderedDerivativeAsset(payload.asset);
        void mutateLibrary();
        if (payload.asset.status === "complete") {
          previewDerivative(payload.asset);
        }
      }
      toast.success(
        payload.duplicate
          ? "Existing green-screen derivative loaded"
          : "Green-screen render queued"
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to queue render"
      );
    } finally {
      setIsQueuingRender(false);
    }
  }, [
    activeDerivativeAsset,
    asset,
    editorState.operation,
    mutateLibrary,
    previewDerivative,
    workspaceId,
  ]);

  const canRenderGreenScreen =
    asset?.kind === "video" &&
    asset.status === "complete" &&
    Boolean(asset.url) &&
    editorState.operation === "green";
  const renderButtonDisabled =
    !canRenderGreenScreen ||
    isQueuingRender ||
    isProcessingAsset(activeDerivativeAsset);
  const renderButtonLabel = isQueuingRender
    ? "Queueing"
    : isProcessingAsset(activeDerivativeAsset)
      ? "Rendering"
      : activeDerivativeAsset?.status === "complete"
        ? "View output"
        : activeDerivativeAsset?.status === "failed"
          ? "Retry"
          : "Render";
  const canRenderTimeline =
    asset?.kind === "video" &&
    asset.status === "complete" &&
    Boolean(duration) &&
    timelineRender.clips.length > 0 &&
    timelineRender.clips.every(
      clip => assetById.get(clip.assetId)?.status === "complete"
    );
  const timelineRenderDisabled =
    !canRenderTimeline ||
    isQueuingTimelineRender ||
    isProcessingAsset(renderedTimelineAsset);
  const timelineRenderLabel = isQueuingTimelineRender
    ? "Queueing"
    : isProcessingAsset(renderedTimelineAsset)
      ? "Rendering"
      : activeTimelineAsset?.status === "complete"
        ? "View output"
        : activeTimelineAsset?.status === "failed"
          ? "Retry"
          : "Render timeline";

  const handleRenderTimeline = useCallback(async () => {
    if (!asset || !canRenderTimeline) {
      toast.error("Timeline needs completed video clips");
      return;
    }
    if (activeTimelineAsset?.status === "complete") {
      previewDerivative(activeTimelineAsset);
      return;
    }
    if (isProcessingAsset(renderedTimelineAsset)) return;

    const renderKey = timelineKey;
    setIsQueuingTimelineRender(true);
    try {
      const payload = await readJsonResponse<EditAssetPayload>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(asset.id)}/edits`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operation: "timeline_render",
              timeline: timelineRender,
            }),
          }
        )
      );
      if (payload.asset) {
        setQueuedTimelineKey(renderKey);
        setRenderedTimelineAsset(payload.asset);
        void mutateLibrary();
        if (payload.asset.status === "complete") {
          previewDerivative(payload.asset);
        }
      }
      toast.success(
        payload.duplicate
          ? "Existing timeline render loaded"
          : "Timeline render queued"
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to queue timeline render"
      );
    } finally {
      setIsQueuingTimelineRender(false);
    }
  }, [
    activeTimelineAsset,
    asset,
    canRenderTimeline,
    mutateLibrary,
    previewDerivative,
    renderedTimelineAsset,
    timelineKey,
    timelineRender,
    workspaceId,
  ]);
  const completedOutputUrl =
    activeDerivativeAsset?.status === "complete"
      ? activeDerivativeAsset.url || null
      : null;
  const handleCopyOutputUrl = useCallback(async () => {
    if (!completedOutputUrl) return;
    try {
      await navigator.clipboard.writeText(completedOutputUrl);
      toast.success("Output URL copied");
    } catch {
      toast.error("Failed to copy output URL");
    }
  }, [completedOutputUrl]);
  const handleOpenOutput = useCallback(() => {
    if (!completedOutputUrl) return;
    window.open(completedOutputUrl, "_blank", "noopener,noreferrer");
  }, [completedOutputUrl]);
  const completedTimelineOutputUrl =
    activeTimelineAsset?.status === "complete"
      ? activeTimelineAsset.url || null
      : null;
  const handleCopyTimelineOutput = useCallback(async () => {
    if (!completedTimelineOutputUrl) return;
    try {
      await navigator.clipboard.writeText(completedTimelineOutputUrl);
      toast.success("Timeline URL copied");
    } catch {
      toast.error("Failed to copy timeline URL");
    }
  }, [completedTimelineOutputUrl]);
  const handleOpenTimelineOutput = useCallback(() => {
    if (!completedTimelineOutputUrl) return;
    window.open(completedTimelineOutputUrl, "_blank", "noopener,noreferrer");
  }, [completedTimelineOutputUrl]);

  const selectedAssetTitle = assetTitle(asset);
  const isPreviewVideo = previewAsset?.kind === "video";
  const outputPreviewAsset =
    activeTimelineAsset?.status === "complete"
      ? activeTimelineAsset
      : activeDerivativeAsset?.status === "complete"
        ? activeDerivativeAsset
        : null;
  const canPreviewOutput = Boolean(outputPreviewAsset?.url);
  const isOutputPreview =
    !timelinePreviewActive && previewAsset?.id === outputPreviewAsset?.id;
  const previewModeLabel = timelinePreviewActive
    ? "Timeline"
    : isOutputPreview
      ? "Output"
      : "Source";
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const assetIdFromDrag = event.active.data.current?.assetId;
    if (typeof assetIdFromDrag === "string") {
      dispatch({ type: "set_drag_asset", assetId: assetIdFromDrag });
    }
  }, []);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const assetIdFromDrag = event.active.data.current?.assetId;
      const trackId = event.over?.data.current?.trackId;
      const draggedAsset =
        typeof assetIdFromDrag === "string"
          ? assetById.get(assetIdFromDrag)
          : null;
      if (
        draggedAsset &&
        isTrackId(trackId) &&
        (trackId === "V1" || trackId === "V2")
      ) {
        dispatch({
          type: "add_asset_to_track",
          asset: draggedAsset,
          trackId,
          assetDuration: assetDurations[draggedAsset.id],
        });
      }
      dispatch({ type: "set_drag_asset", assetId: null });
    },
    [assetById, assetDurations]
  );
  const handleDragCancel = useCallback(() => {
    dispatch({ type: "set_drag_asset", assetId: null });
  }, []);

  return (
    <div className="flex h-[calc(100svh-36px)] min-h-[680px] flex-col overflow-hidden bg-[#101010] text-zinc-100">
      <header className="flex h-11 shrink-0 items-center border-b border-zinc-800 bg-[#171717] px-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-[4px] text-zinc-300 hover:bg-zinc-800 hover:text-white"
          asChild
        >
          <Link href={`/panel/w/${workspaceId}/assets`} aria-label="Assets">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="ml-2 min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[13px] font-semibold leading-none">
              {selectedAssetTitle}
            </div>
            {asset ? (
              <span
                className={cn(
                  "rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none",
                  statusTone(asset.status)
                )}
              >
                {asset.status}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] leading-none text-zinc-500">
            <span>{asset?.kind || "asset"}</span>
            <span>{formatBytes(asset?.fileSize)}</span>
            <span>{formatDuration(duration || displayDuration)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <ToolIconButton
            label={`Undo${lastHistoryLabel ? ` ${lastHistoryLabel}` : ""}`}
            icon={Undo2}
            disabled={!canUndoTimeline}
            onClick={handleUndoTimeline}
          />
          <ToolIconButton
            label="Panel left"
            icon={PanelLeft}
            active={editorState.leftPanelOpen}
            onClick={() => dispatch({ type: "toggle_left_panel" })}
          />
          <ToolIconButton
            label="Panel right"
            icon={PanelRight}
            active={editorState.rightPanelOpen}
            onClick={() => dispatch({ type: "toggle_right_panel" })}
          />
          <Button
            type="button"
            size="sm"
            className="ml-1 h-8 rounded-[4px] bg-[#ff3366] px-3 text-xs font-semibold text-white shadow-[0_2px_0_#7f102c] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={renderButtonDisabled}
            title={
              canRenderGreenScreen
                ? renderButtonLabel
                : "Green-screen rendering requires a completed source video"
            }
            onClick={() => void handleRenderDerivative()}
          >
            {isQueuingRender || isProcessingAsset(activeDerivativeAsset) ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <WandSparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            {renderButtonLabel}
          </Button>
        </div>
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns }}>
          <nav className="flex min-h-0 flex-col items-center border-r border-zinc-800 bg-[#151515] py-2">
            <div className="flex flex-1 flex-col gap-1">
              {railItems.map(item => (
                <ToolIconButton
                  key={item.id}
                  label={item.label}
                  icon={item.icon}
                  active={editorState.selectedRailItem === item.id}
                  onClick={() => dispatch({ type: "set_rail", value: item.id })}
                />
              ))}
            </div>
            <ToolIconButton label="Import" icon={Upload} disabled />
          </nav>

          {editorState.leftPanelOpen ? (
            <aside className="flex min-h-0 flex-col border-r border-zinc-800 bg-[#1b1b1b]">
              <PanelHeader
                eyebrow={editorState.selectedRailItem}
                title={
                  editorState.selectedRailItem === "media" ? "Bin" : "Palette"
                }
                right={
                  <button
                    type="button"
                    className="rounded-[4px] p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
                    disabled
                    aria-label="Bin options"
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                }
              />
              <div className="grid grid-cols-3 gap-px border-b border-zinc-800 bg-zinc-800 text-[10px] font-medium uppercase text-zinc-500">
                {mediaFilters.map(filter => (
                  <button
                    key={filter.id}
                    type="button"
                    className={cn(
                      "h-7 bg-[#202020] hover:bg-zinc-700 hover:text-zinc-200",
                      editorState.mediaFilter === filter.id &&
                        "bg-zinc-700 text-zinc-100"
                    )}
                    onClick={() =>
                      dispatch({ type: "set_filter", value: filter.id })
                    }
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {editorState.selectedRailItem === "media" ? (
                  <div className="space-y-2">
                    {filteredSourceAssets.length ? (
                      filteredSourceAssets.map(item => (
                        <MediaBinItem
                          key={item.id}
                          asset={item}
                          selected={item.id === previewAsset?.id}
                          onDuration={mediaDuration =>
                            setAssetDurations(current =>
                              current[item.id] === mediaDuration
                                ? current
                                : { ...current, [item.id]: mediaDuration }
                            )
                          }
                          onSelect={() => selectManualPreview(item.id)}
                        />
                      ))
                    ) : (
                      <div className="space-y-2">
                        <Skeleton className="h-24 rounded-[4px] bg-zinc-800" />
                        <Skeleton className="h-24 rounded-[4px] bg-zinc-800" />
                        <Skeleton className="h-24 rounded-[4px] bg-zinc-800" />
                      </div>
                    )}
                  </div>
                ) : (
                  <ToolPalette
                    operation={editorState.operation}
                    onSelectOperation={operation =>
                      dispatch({ type: "set_operation", value: operation })
                    }
                  />
                )}
              </div>
            </aside>
          ) : null}

          <main className="flex min-h-0 flex-col bg-[#0b0b0c]">
            <section className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 bg-[#161616] px-3">
                <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                  <span className="font-mono text-zinc-200">
                    {formatTimecode(currentTime)}
                  </span>
                  <span className="h-1 w-1 rounded-full bg-zinc-700" />
                  <span>{previewModeLabel}</span>
                  <span>1080x1920</span>
                </div>
                <div className="flex items-center gap-1">
                  <PreviewModeButton
                    label="Timeline"
                    active={timelinePreviewActive}
                    onClick={() => seekTo(currentTime)}
                  />
                  <PreviewModeButton
                    label="Source"
                    active={!timelinePreviewActive && !isOutputPreview}
                    disabled={!asset}
                    onClick={() => asset && selectManualPreview(asset.id)}
                  />
                  <PreviewModeButton
                    label="Output"
                    active={isOutputPreview}
                    disabled={!canPreviewOutput}
                    onClick={() =>
                      outputPreviewAsset &&
                      previewDerivative(outputPreviewAsset)
                    }
                  />
                  <div className="mx-1 h-4 w-px bg-zinc-800" />
                  <ToolIconButton label="Pointer" icon={MousePointer2} active />
                  <ToolIconButton label="Hand" icon={Hand} disabled />
                  <ToolIconButton
                    label="Zoom in"
                    icon={ZoomIn}
                    onClick={() => dispatch({ type: "zoom_in" })}
                  />
                  <ToolIconButton
                    label="Zoom out"
                    icon={ZoomOut}
                    onClick={() => dispatch({ type: "zoom_out" })}
                  />
                  <ToolIconButton
                    label="Fullscreen"
                    icon={Maximize2}
                    disabled
                  />
                </div>
              </div>

              <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#080809] p-5">
                <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(0deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:48px_48px]" />
                <div className="relative flex aspect-[9/16] max-h-full w-auto max-w-full items-center justify-center overflow-hidden rounded-[6px] bg-black shadow-[0_0_0_1px_rgba(255,255,255,.08),0_24px_80px_rgba(0,0,0,.55)]">
                  {isLoading ? (
                    <Loader2 className="h-8 w-8 animate-spin text-white/60" />
                  ) : previewAsset?.url && isPreviewVideo ? (
                    <video
                      key={previewAsset.id}
                      ref={videoRef}
                      src={previewAsset.url}
                      data-asset-id={previewAsset.id}
                      className="h-full w-full object-contain"
                      playsInline
                      onLoadedMetadata={event =>
                        handleVideoLoadedMetadata(event.currentTarget)
                      }
                      onTimeUpdate={event =>
                        handleVideoTimeUpdate(event.currentTarget)
                      }
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                      onEnded={handleVideoEnded}
                    />
                  ) : previewAsset?.url && previewAsset.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previewAsset.url}
                      alt=""
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="text-xs text-zinc-500">No source</div>
                  )}
                </div>
              </div>

              <div className="flex h-10 shrink-0 items-center justify-center gap-1 border-y border-zinc-800 bg-[#141414]">
                <TransportButton
                  label="Start"
                  icon={SkipBack}
                  onClick={() => seekTo(0)}
                />
                <TransportButton
                  label={isPlaying ? "Pause" : "Play"}
                  icon={isPlaying ? Pause : Play}
                  active
                  onClick={() => void togglePlayback()}
                />
                <TransportButton
                  label="End"
                  icon={SkipForward}
                  onClick={() => seekTo(timelineDuration)}
                />
                <div className="mx-2 h-5 w-px bg-zinc-800" />
                <span className="font-mono text-[12px] text-zinc-300">
                  {formatTimecode(currentTime)}
                </span>
                <span className="text-[11px] text-zinc-600">/</span>
                <span className="font-mono text-[12px] text-zinc-500">
                  {formatTimecode(timelineDuration)}
                </span>
              </div>
            </section>

            <section className="h-[264px] shrink-0 border-t border-zinc-800 bg-[#111]">
              <div className="flex h-9 items-center justify-between border-b border-zinc-800 px-3">
                <div className="flex items-center gap-1">
                  <ToolIconButton
                    label="Cut at playhead"
                    icon={Scissors}
                    disabled={!canSplitAtPlayhead}
                    onClick={handleSplitAtPlayhead}
                  />
                  <ToolIconButton
                    label="Delete clip"
                    icon={Trash2}
                    disabled={!canRemoveSelectedClip}
                    onClick={handleRemoveSelectedClip}
                  />
                  <ToolIconButton label="Layers" icon={Layers3} disabled />
                  <ToolIconButton label="Audio" icon={AudioLines} disabled />
                  <ToolIconButton
                    label="Snap"
                    icon={Magnet}
                    active={editorState.snapEnabled}
                    onClick={() => dispatch({ type: "toggle_snap" })}
                  />
                </div>
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <span>{chunkCount}x usage</span>
                  <span>{chunkCount} chunks</span>
                  <span>{editorState.timelineZoom}%</span>
                </div>
              </div>
              <div className="grid h-[225px] grid-cols-[58px_minmax(0,1fr)]">
                <div className="border-r border-zinc-800 bg-[#171717] text-[10px] font-medium uppercase text-zinc-500">
                  <div className="h-5 border-b border-zinc-800" />
                  {TRACK_IDS.map(track => (
                    <div
                      key={track}
                      className="flex h-[66px] flex-col items-center justify-center border-b border-zinc-800 leading-none last:border-b-0"
                    >
                      <span className="text-zinc-400">{track}</span>
                      <span className="mt-1 text-[9px] normal-case text-zinc-600">
                        {trackLabels[track]}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="overflow-x-auto overflow-y-hidden">
                  <div
                    ref={timelineRef}
                    className="relative h-full min-w-full"
                    style={{ width: `${editorState.timelineZoom}%` }}
                  >
                    <TimelineRuler duration={timelineDuration} />
                    <button
                      type="button"
                      className="absolute bottom-0 top-0 z-30 w-5 -translate-x-1/2 cursor-ew-resize touch-none"
                      style={{ left: `${timelinePercent}%` }}
                      aria-label="Timeline playhead"
                      onPointerDown={handlePlayheadPointerDown}
                      onPointerMove={handlePlayheadPointerMove}
                      onPointerUp={handlePlayheadPointerUp}
                      onPointerCancel={handlePlayheadPointerUp}
                    >
                      <span className="absolute left-1/2 top-1 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] bg-[#ff3366] shadow-[0_0_12px_rgba(255,51,102,.9)]" />
                      <span className="absolute bottom-0 left-1/2 top-5 w-px -translate-x-1/2 bg-[#ff3366] shadow-[0_0_12px_rgba(255,51,102,.85)]" />
                    </button>
                    <div className="pt-5">
                      {TRACK_IDS.map(trackId => (
                        <DroppableTrackLane
                          key={trackId}
                          trackId={trackId}
                          clips={editorState.clips.filter(
                            clip => clip.trackId === trackId
                          )}
                          selectedClipId={editorState.selectedClipId}
                          duration={timelineDuration}
                          acceptsMedia={trackId === "V1" || trackId === "V2"}
                          onSelectClip={clipId =>
                            dispatch({ type: "select_clip", clipId })
                          }
                          onMoveClip={(clipId, start) =>
                            dispatch({
                              type: "move_clip",
                              clipId,
                              start,
                            })
                          }
                          onTrimClip={(clipId, edge, time) =>
                            dispatch({
                              type: "trim_clip",
                              clipId,
                              edge,
                              time,
                            })
                          }
                        />
                      ))}
                    </div>
                    <div className="pointer-events-none absolute bottom-1 right-2 rounded-[4px] bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                      Drop to V tracks
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </main>

          {editorState.rightPanelOpen ? (
            <aside className="flex min-h-0 flex-col border-l border-zinc-800 bg-[#1b1b1b]">
              <PanelHeader
                eyebrow="Inspector"
                title={editorState.selectedInspectorTab}
                right={
                  <button
                    type="button"
                    className="rounded-[4px] p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
                    disabled
                    aria-label="Inspector options"
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                }
              />
              <div className="grid grid-cols-3 gap-px border-b border-zinc-800 bg-zinc-800 text-[10px] font-medium uppercase text-zinc-500">
                {(["clip", "bria", "export"] as InspectorTab[]).map(tab => (
                  <button
                    key={tab}
                    type="button"
                    className={cn(
                      "h-7 bg-[#202020] hover:bg-zinc-700 hover:text-zinc-200",
                      editorState.selectedInspectorTab === tab &&
                        "bg-zinc-700 text-zinc-100"
                    )}
                    onClick={() =>
                      dispatch({ type: "set_inspector", value: tab })
                    }
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {editorState.selectedInspectorTab === "bria" ? (
                  <BriaInspector
                    chunkCount={chunkCount}
                    operation={editorState.operation}
                    derivative={activeDerivativeAsset}
                    isQueuing={isQueuingRender}
                    renderDisabled={renderButtonDisabled}
                    renderLabel={renderButtonLabel}
                    onSelectOperation={operation =>
                      dispatch({ type: "set_operation", value: operation })
                    }
                    onCopyOutput={() => void handleCopyOutputUrl()}
                    onOpenOutput={handleOpenOutput}
                    onRender={() => void handleRenderDerivative()}
                  />
                ) : editorState.selectedInspectorTab === "clip" ? (
                  <ClipInspector
                    asset={selectedClipAsset}
                    clip={selectedClip}
                    duration={timelineDuration}
                    proxyEnabled={editorState.proxyEnabled}
                    safeAreaEnabled={editorState.safeAreaEnabled}
                    onDuplicate={() => dispatch({ type: "duplicate_clip" })}
                    onRemove={handleRemoveSelectedClip}
                    onToggleProxy={() => dispatch({ type: "toggle_proxy" })}
                    onToggleSafe={() => dispatch({ type: "toggle_safe_area" })}
                  />
                ) : (
                  <ExportInspector
                    asset={
                      isProcessingAsset(renderedTimelineAsset)
                        ? renderedTimelineAsset
                        : activeTimelineAsset
                    }
                    clipCount={timelineRender.clips.length}
                    sourceCount={timelineSourceCount}
                    duration={timelineRender.duration}
                    isQueuing={isQueuingTimelineRender}
                    renderDisabled={timelineRenderDisabled}
                    renderLabel={timelineRenderLabel}
                    onCopyOutput={() => void handleCopyTimelineOutput()}
                    onOpenOutput={handleOpenTimelineOutput}
                    onRender={() => void handleRenderTimeline()}
                  />
                )}
              </div>
            </aside>
          ) : null}
        </div>
        <DragOverlay>
          {activeDragAsset ? (
            <MediaDragOverlay asset={activeDragAsset} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function PanelHeader({
  eyebrow,
  title,
  right,
}: {
  eyebrow: string;
  title: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          {eyebrow}
        </div>
        <div className="truncate text-[13px] font-semibold text-zinc-100">
          {title}
        </div>
      </div>
      {right}
    </div>
  );
}

function ToolIconButton({
  label,
  icon: Icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-[4px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100",
        active &&
          "bg-zinc-800 text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,.08)]",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
      )}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function PreviewModeButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "h-7 rounded-[4px] px-2 text-[11px] font-medium text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100",
        active && "bg-zinc-800 text-zinc-100",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
      )}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function TransportButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-white",
        active && "bg-zinc-800 text-white"
      )}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function MediaBinItem({
  asset,
  selected,
  onDuration,
  onSelect,
}: {
  asset: CreativeAsset;
  selected?: boolean;
  onDuration: (duration: number) => void;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `asset-${asset.id}`,
      data: { type: "asset", assetId: asset.id },
    });

  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      className={cn(
        "group grid w-full grid-cols-[82px_minmax(0,1fr)] overflow-hidden rounded-[5px] border border-zinc-800 bg-[#202020] text-left transition hover:border-zinc-600",
        selected && "border-[#ff3366] bg-[#251820]",
        isDragging && "opacity-45"
      )}
      style={
        transform
          ? {
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
            }
          : undefined
      }
      onClick={onSelect}
    >
      <div className="aspect-video bg-zinc-900">
        {asset.kind === "video" && asset.url ? (
          <video
            src={asset.url}
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={event => {
              const mediaDuration = event.currentTarget.duration;
              if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
                onDuration(mediaDuration);
              }
            }}
          />
        ) : asset.kind === "image" && asset.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-600">
            <ImageIcon className="h-4 w-4" />
          </div>
        )}
      </div>
      <div className="min-w-0 px-2 py-1.5">
        <div className="truncate text-[12px] font-semibold text-zinc-100">
          {assetTitle(asset)}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-zinc-500">
          <span>{asset.kind}</span>
          <span>{formatBytes(asset.fileSize)}</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
          <div
            className={cn(
              "h-full rounded-full",
              selected ? "w-full bg-[#ff3366]" : "w-2/3 bg-zinc-600"
            )}
          />
        </div>
      </div>
    </button>
  );
}

function ToolPalette({
  operation,
  onSelectOperation,
}: {
  operation: OperationId;
  onSelectOperation: (operation: OperationId) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {briaOperations.map(item => {
        const Icon = item.icon;
        const active = item.id === operation;
        return (
          <button
            key={item.label}
            type="button"
            className={cn(
              "flex h-16 flex-col items-center justify-center gap-1 rounded-[5px] border border-zinc-800 bg-[#202020] text-[11px] font-medium text-zinc-400",
              item.enabled && "hover:border-zinc-600 hover:text-zinc-100",
              active && "border-[#ff3366]/70 bg-[#2a1720] text-zinc-100",
              !item.enabled && "cursor-not-allowed opacity-45"
            )}
            disabled={!item.enabled}
            title={item.enabled ? item.label : "Not available in this UI pass"}
            onClick={() => item.enabled && onSelectOperation(item.id)}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function BriaInspector({
  chunkCount,
  operation,
  derivative,
  isQueuing,
  renderDisabled,
  renderLabel,
  onSelectOperation,
  onCopyOutput,
  onOpenOutput,
  onRender,
}: {
  chunkCount: number;
  operation: OperationId;
  derivative: CreativeAsset | null;
  isQueuing: boolean;
  renderDisabled: boolean;
  renderLabel: string;
  onSelectOperation: (operation: OperationId) => void;
  onCopyOutput: () => void;
  onOpenOutput: () => void;
  onRender: () => void;
}) {
  const isProcessing = isProcessingAsset(derivative);
  const hasCompletedOutput =
    derivative?.status === "complete" && Boolean(derivative.url);

  return (
    <div className="space-y-3">
      <section className="space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          Operation
        </div>
        <div className="grid grid-cols-2 gap-2">
          {briaOperations.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "flex h-16 flex-col items-center justify-center gap-1 rounded-[5px] border border-zinc-800 bg-[#202020] text-[11px] font-medium text-zinc-400",
                  item.enabled && "hover:border-zinc-600 hover:text-zinc-100",
                  operation === item.id &&
                    "border-emerald-400/50 bg-emerald-400/10 text-emerald-100"
                )}
                onClick={() => item.enabled && onSelectOperation(item.id)}
                disabled={!item.enabled}
                title={
                  item.enabled ? item.label : "Not available in this UI pass"
                }
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2">
        <InspectorStat label="usage" value={`${chunkCount}x`} />
        <InspectorStat label="chunks" value={String(chunkCount)} />
      </section>

      {derivative ? (
        <section className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            Job
          </div>
          <ControlRow label="State" value={statusLabel(derivative.status)} />
          <ControlRow
            label="Output"
            value={
              derivative.fileSize
                ? formatBytes(derivative.fileSize)
                : derivative.fileName || derivative.id.slice(-6)
            }
          />
          {derivative.error ? (
            <div className="rounded-[4px] border border-rose-400/25 bg-rose-500/10 px-2 py-1.5 text-[11px] leading-snug text-rose-200">
              {derivative.error}
            </div>
          ) : null}
          {hasCompletedOutput ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="flex h-8 items-center justify-center rounded-[4px] border border-zinc-800 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={onCopyOutput}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy URL
              </button>
              <button
                type="button"
                className="flex h-8 items-center justify-center rounded-[4px] border border-zinc-800 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={onOpenOutput}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Open
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          Matte
        </div>
        <ControlRow label="Edge" value="Fine" />
        <ControlRow label="Motion" value="Smooth" />
        <ControlRow label="Codec" value="H.264" />
      </section>

      <button
        type="button"
        className="flex h-9 w-full items-center justify-center rounded-[4px] bg-[#ff3366] text-xs font-semibold text-white shadow-[0_2px_0_#7f102c] hover:bg-[#ff4b78] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#ff3366]"
        disabled={renderDisabled}
        onClick={onRender}
      >
        {isQueuing || isProcessing ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <WandSparkles className="mr-1.5 h-3.5 w-3.5" />
        )}
        {renderLabel === "Render" ? "Render derivative" : renderLabel}
      </button>
    </div>
  );
}

function ClipInspector({
  asset,
  clip,
  duration,
  proxyEnabled,
  safeAreaEnabled,
  onDuplicate,
  onRemove,
  onToggleProxy,
  onToggleSafe,
}: {
  asset: CreativeAsset | null;
  clip: TimelineClip | null;
  duration: number;
  proxyEnabled: boolean;
  safeAreaEnabled: boolean;
  onDuplicate: () => void;
  onRemove: () => void;
  onToggleProxy: () => void;
  onToggleSafe: () => void;
}) {
  return (
    <div className="space-y-3">
      <section className="space-y-2">
        <ControlRow label="Clip" value={clip?.label || "--"} />
        <ControlRow label="Track" value={clip?.trackId || "--"} />
        <ControlRow label="Start" value={formatTimecode(clip?.start || 0)} />
        <ControlRow label="In" value={formatTimecode(clip?.sourceStart || 0)} />
        <ControlRow
          label="Out"
          value={formatTimecode(
            (clip?.sourceStart || 0) + (clip?.duration || 0)
          )}
        />
        <ControlRow
          label="Length"
          value={formatTimecode(clip?.duration || duration)}
        />
        <ControlRow
          label="Op"
          value={clip?.operation || clip?.origin || "--"}
        />
        <ControlRow label="Source" value={asset ? assetTitle(asset) : "--"} />
        <ControlRow label="Size" value={formatBytes(asset?.fileSize) || "--"} />
      </section>
      <section className="space-y-2">
        <MiniToggle
          label="Proxy"
          checked={proxyEnabled}
          onClick={onToggleProxy}
        />
        <MiniToggle
          label="Safe"
          checked={safeAreaEnabled}
          onClick={onToggleSafe}
        />
      </section>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="flex h-9 items-center justify-center rounded-[4px] border border-zinc-800 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
          onClick={onDuplicate}
          disabled={!clip}
        >
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          Copy
        </button>
        <button
          type="button"
          className={cn(
            "flex h-9 items-center justify-center rounded-[4px] border border-zinc-800 text-xs font-semibold text-zinc-300 hover:bg-zinc-800",
            clip?.locked && "cursor-not-allowed opacity-45"
          )}
          onClick={onRemove}
          disabled={!clip || clip.locked}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Remove
        </button>
      </div>
    </div>
  );
}

function ExportInspector({
  asset,
  clipCount,
  sourceCount,
  duration,
  isQueuing,
  renderDisabled,
  renderLabel,
  onCopyOutput,
  onOpenOutput,
  onRender,
}: {
  asset: CreativeAsset | null;
  clipCount: number;
  sourceCount: number;
  duration: number;
  isQueuing: boolean;
  renderDisabled: boolean;
  renderLabel: string;
  onCopyOutput: () => void;
  onOpenOutput: () => void;
  onRender: () => void;
}) {
  const isProcessing = isProcessingAsset(asset);
  const hasCompletedOutput = asset?.status === "complete" && Boolean(asset.url);

  return (
    <div className="space-y-3">
      <section className="space-y-2">
        <ControlRow label="Format" value="MP4" />
        <ControlRow label="Video" value="H.264" />
        <ControlRow label="Audio" value="AAC" />
        <ControlRow label="Length" value={formatDuration(duration)} />
        <ControlRow label="Clips" value={String(clipCount)} />
        <ControlRow label="Sources" value={String(sourceCount)} />
      </section>

      {asset ? (
        <section className="space-y-2 border-t border-zinc-800 pt-3">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            <span>Output</span>
            <span
              className={cn(
                "rounded-[4px] px-1.5 py-0.5",
                statusTone(asset.status)
              )}
            >
              {statusLabel(asset.status)}
            </span>
          </div>
          {asset.error ? (
            <div className="rounded-[4px] border border-rose-400/25 bg-rose-500/10 px-2 py-1.5 text-[11px] leading-snug text-rose-200">
              {asset.error}
            </div>
          ) : null}
          {hasCompletedOutput ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="flex h-8 items-center justify-center rounded-[4px] border border-zinc-800 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={onCopyOutput}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy URL
              </button>
              <button
                type="button"
                className="flex h-8 items-center justify-center rounded-[4px] border border-zinc-800 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={onOpenOutput}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Open
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <button
        type="button"
        className="flex h-9 w-full items-center justify-center rounded-[4px] bg-[#ff3366] text-xs font-semibold text-white shadow-[0_2px_0_#7f102c] hover:bg-[#ff4b78] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#ff3366]"
        disabled={renderDisabled}
        onClick={onRender}
      >
        {isQueuing || isProcessing ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Film className="mr-1.5 h-3.5 w-3.5" />
        )}
        {renderLabel}
      </button>
    </div>
  );
}

function InspectorStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[5px] border border-zinc-800 bg-[#202020] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold leading-none text-zinc-100">
        {value}
      </div>
    </div>
  );
}

function ControlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid h-8 grid-cols-[74px_minmax(0,1fr)] items-center rounded-[4px] border border-zinc-800 bg-[#202020] px-2">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="truncate text-right text-[12px] font-medium text-zinc-200">
        {value}
      </div>
    </div>
  );
}

function MiniToggle({
  label,
  checked,
  onClick,
}: {
  label: string;
  checked?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid h-8 w-full grid-cols-[minmax(0,1fr)_32px] items-center rounded-[4px] border border-zinc-800 bg-[#202020] px-2 text-left"
    >
      <span className="text-[11px] text-zinc-300">{label}</span>
      <span
        className={cn(
          "ml-auto h-4 w-7 rounded-full border border-zinc-700 p-0.5",
          checked && "border-emerald-400/50 bg-emerald-400/15"
        )}
      >
        <span
          className={cn(
            "block h-2.5 w-2.5 rounded-full bg-zinc-600 transition",
            checked && "translate-x-2.5 bg-emerald-300"
          )}
        />
      </span>
    </button>
  );
}

function TimelineRuler({ duration }: { duration: number }) {
  return (
    <div className="absolute inset-x-0 top-0 flex h-5 border-b border-zinc-800 bg-[#151515]">
      {Array.from({ length: 12 }).map((_, index) => (
        <div
          key={index}
          className="relative flex-1 border-r border-zinc-800 last:border-r-0"
        >
          <span className="absolute left-1 top-1 text-[9px] text-zinc-600">
            {index % 2 === 0 ? formatDuration((duration / 12) * index) : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function DroppableTrackLane({
  trackId,
  clips,
  selectedClipId,
  duration,
  acceptsMedia,
  onSelectClip,
  onMoveClip,
  onTrimClip,
}: {
  trackId: TrackId;
  clips: TimelineClip[];
  selectedClipId: string | null;
  duration: number;
  acceptsMedia: boolean;
  onSelectClip: (clipId: string) => void;
  onMoveClip: (clipId: string, start: number) => void;
  onTrimClip: (clipId: string, edge: TimelineTrimEdge, time: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `track-${trackId}`,
    data: { type: "track", trackId },
    disabled: !acceptsMedia,
  });

  return (
    <div
      ref={setNodeRef}
      data-timeline-lane
      className={cn(
        "relative h-[66px] border-b border-zinc-800 bg-[#111]",
        isOver &&
          acceptsMedia &&
          "bg-[#191f1b] shadow-[inset_0_0_0_1px_rgba(52,211,153,.35)]"
      )}
    >
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,.028)_1px,transparent_1px)] bg-[size:64px_100%]" />
      {clips.length ? (
        clips.map(clip => (
          <TimelineSegment
            key={clip.id}
            clip={clip}
            duration={duration}
            selected={clip.id === selectedClipId}
            onSelect={() => onSelectClip(clip.id)}
            onMove={start => onMoveClip(clip.id, start)}
            onTrim={(edge, time) => onTrimClip(clip.id, edge, time)}
          />
        ))
      ) : acceptsMedia ? (
        <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-700">
          Drop
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-800">
          Auto
        </div>
      )}
    </div>
  );
}

function TimelineSegment({
  clip,
  duration,
  selected,
  onSelect,
  onMove,
  onTrim,
}: {
  clip: TimelineClip;
  duration: number;
  selected?: boolean;
  onSelect: () => void;
  onMove: (start: number) => void;
  onTrim: (edge: TimelineTrimEdge, time: number) => void;
}) {
  const dragRef = useRef<{
    startX: number;
    start: number;
    laneWidth: number;
  } | null>(null);
  const trimRef = useRef<{
    edge: TimelineTrimEdge;
    startX: number;
    start: number;
    duration: number;
    laneWidth: number;
  } | null>(null);
  const [draftStart, setDraftStart] = useState<number | null>(null);
  const [draftDuration, setDraftDuration] = useState<number | null>(null);
  const visibleStart = draftStart ?? clip.start;
  const visibleDuration = draftDuration ?? clip.duration;
  const left = `${Math.max(0, (visibleStart / duration) * 100)}%`;
  const width = `${Math.max(3, (visibleDuration / duration) * 100)}%`;
  const editable = isEditableTimelineClip(clip);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    onSelect();
    if (!editable) return;
    const lane = event.currentTarget.closest("[data-timeline-lane]");
    const laneWidth = lane?.getBoundingClientRect().width || 0;
    if (laneWidth <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startX: event.clientX,
      start: clip.start,
      laneWidth,
    };
    setDraftStart(clip.start);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId))
      return;
    const deltaSeconds =
      ((event.clientX - drag.startX) / drag.laneWidth) * duration;
    setDraftStart(Math.max(0, drag.start + deltaSeconds));
  };

  const commitDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    const nextStart = draftStart;
    setDraftStart(null);
    if (!drag || nextStart === null) return;
    if (Math.abs(nextStart - clip.start) >= 0.05) {
      onMove(nextStart);
    }
  };

  const handleTrimPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    edge: TimelineTrimEdge
  ) => {
    if (event.button !== 0 || !editable) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    const lane = event.currentTarget.closest("[data-timeline-lane]");
    const laneWidth = lane?.getBoundingClientRect().width || 0;
    if (laneWidth <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    trimRef.current = {
      edge,
      startX: event.clientX,
      start: clip.start,
      duration: clip.duration,
      laneWidth,
    };
    setDraftStart(clip.start);
    setDraftDuration(clip.duration);
  };

  const handleTrimPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    const trim = trimRef.current;
    if (!trim || !event.currentTarget.hasPointerCapture(event.pointerId))
      return;
    const deltaSeconds =
      ((event.clientX - trim.startX) / trim.laneWidth) * duration;
    if (trim.edge === "start") {
      const nextStart = Math.min(
        trim.start + trim.duration - MIN_TIMELINE_SEGMENT_SECONDS,
        Math.max(trim.start, trim.start + deltaSeconds)
      );
      setDraftStart(nextStart);
      setDraftDuration(trim.duration - (nextStart - trim.start));
      return;
    }
    setDraftDuration(
      Math.max(
        MIN_TIMELINE_SEGMENT_SECONDS,
        Math.min(trim.duration, trim.duration + deltaSeconds)
      )
    );
  };

  const commitTrim = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const trim = trimRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    trimRef.current = null;
    const nextStart = draftStart ?? clip.start;
    const nextDuration = draftDuration ?? clip.duration;
    setDraftStart(null);
    setDraftDuration(null);
    if (!trim) return;
    const edgeTime =
      trim.edge === "start" ? nextStart : nextStart + nextDuration;
    if (
      Math.abs(nextStart - clip.start) >= 0.005 ||
      Math.abs(nextDuration - clip.duration) >= 0.005
    ) {
      onTrim(trim.edge, edgeTime);
    }
  };

  return (
    <div
      className={cn(
        "absolute top-2 z-10 h-12 min-w-10 rounded-[4px] border text-zinc-200 transition",
        clip.origin === "source" && "border-sky-400/40 bg-sky-500/28",
        clip.origin === "bria" && "border-emerald-400/35 bg-emerald-500/22",
        clip.origin === "matte" &&
          "border-fuchsia-300/25 bg-fuchsia-500/18 text-zinc-500",
        clip.origin === "audio" && "border-amber-300/25 bg-amber-400/12",
        clip.origin === "user" && "border-[#ff3366]/55 bg-[#ff3366]/22",
        selected &&
          "z-20 border-white/80 shadow-[0_0_0_1px_rgba(255,255,255,.35),0_0_22px_rgba(255,51,102,.22)]"
      )}
      style={{ left, width }}
      title={clip.label}
    >
      <button
        type="button"
        className={cn(
          "flex h-full w-full touch-none items-center overflow-hidden px-2 text-left text-[10px] font-medium uppercase hover:brightness-125",
          editable ? "cursor-grab active:cursor-grabbing" : "cursor-default"
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={commitDrag}
        onPointerCancel={commitDrag}
      >
        {clip.origin === "audio" ? (
          <span className="flex h-full w-full items-center gap-px overflow-hidden">
            {Array.from({ length: 24 }).map((_, index) => (
              <span
                key={index}
                className="w-0.5 shrink-0 rounded-full bg-amber-200/55"
                style={{ height: `${10 + ((index * 5) % 14)}px` }}
              />
            ))}
          </span>
        ) : (
          <span className="truncate">{clip.label}</span>
        )}
      </button>
      {selected && editable ? (
        <>
          {(["start", "end"] as TimelineTrimEdge[]).map(edge => (
            <button
              key={edge}
              type="button"
              className={cn(
                "absolute bottom-0 top-0 z-30 w-2 cursor-col-resize touch-none bg-white/85 shadow-[0_0_8px_rgba(255,255,255,.35)] hover:bg-white",
                edge === "start"
                  ? "left-0 rounded-l-[3px]"
                  : "right-0 rounded-r-[3px]"
              )}
              aria-label={`Trim ${edge}`}
              onPointerDown={event => handleTrimPointerDown(event, edge)}
              onPointerMove={handleTrimPointerMove}
              onPointerUp={commitTrim}
              onPointerCancel={commitTrim}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

function MediaDragOverlay({ asset }: { asset: CreativeAsset }) {
  return (
    <div className="w-56 overflow-hidden rounded-[6px] border border-[#ff3366]/60 bg-[#202020] shadow-2xl">
      <div className="aspect-video bg-zinc-900">
        {asset.kind === "video" && asset.url ? (
          <video
            src={asset.url}
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
          />
        ) : asset.kind === "image" && asset.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.url} alt="" className="h-full w-full object-cover" />
        ) : null}
      </div>
      <div className="truncate px-2 py-1.5 text-[11px] font-semibold text-zinc-100">
        {assetTitle(asset)}
      </div>
    </div>
  );
}
