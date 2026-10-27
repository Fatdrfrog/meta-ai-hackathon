"use client";

import { type CreativeAsset } from "@/components/assets/creative-assets-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchCreativeAssetStatuses,
  readJsonResponse,
  requireQueuedAsset,
} from "@/lib/creative-assets/creative-asset-client-response";
import {
  getOrCreateVideoGenerationIdempotencyKey,
  retireVideoGenerationIdempotencyKey,
} from "@/lib/creative-assets/video-generation-idempotency";
import { cn } from "@/lib/utils";
import {
  Check,
  Film,
  ImageIcon,
  Loader2,
  Play,
  Search,
  Video,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type CreativeAssetPickerDialogProps = {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind?: "image" | "video" | null;
  selectedUrls?: string[];
  showGenerate?: boolean;
  higgsfieldConfigured?: boolean;
  assetFilter?: (asset: CreativeAsset) => boolean;
  onSelect: (asset: CreativeAsset) => void;
};

const IMAGE_PROMPT_PRESETS = [
  "Restaurant product photo with clean lighting",
  "Vertical social story image with appetizing food styling",
  "Premium campaign visual with space for copy",
];

const VIDEO_PROMPT_PRESETS = [
  "Slow camera push with subtle steam and motion",
  "Handheld lifestyle movement with natural light",
  "Smooth product reveal for a WhatsApp campaign",
];

const ASSET_PICKER_CACHE_TTL_MS = 30_000;
const assetPickerCache = new Map<
  string,
  { assets: CreativeAsset[]; expiresAt: number }
>();

function statusClass(status: CreativeAsset["status"]) {
  if (status === "complete") return "bg-emerald-500/10 text-emerald-700";
  if (status === "failed" || status === "nsfw") {
    return "bg-destructive/10 text-destructive";
  }
  return "bg-amber-500/10 text-amber-700";
}

function assetTitle(asset: CreativeAsset): string {
  return asset.fileName || asset.prompt || asset.id;
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

function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return "";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

export function CreativeAssetPickerDialog({
  workspaceId,
  open,
  onOpenChange,
  kind = null,
  selectedUrls = [],
  showGenerate = false,
  higgsfieldConfigured = false,
  assetFilter,
  onSelect,
}: CreativeAssetPickerDialogProps) {
  const [assets, setAssets] = useState<CreativeAsset[]>([]);
  const [pendingAssets, setPendingAssets] = useState<CreativeAsset[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [imagePrompt, setImagePrompt] = useState("");
  const [videoPrompt, setVideoPrompt] = useState("");
  const [sourceAssetId, setSourceAssetId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const loadSeqRef = useRef(0);
  const videoIdempotencyKeysRef = useRef(new Map<string, string>());

  const selectedUrlSet = useMemo(() => new Set(selectedUrls), [selectedUrls]);

  const loadAssets = useCallback(async () => {
    if (!open) return;
    const params = new URLSearchParams({ status: "complete", limit: "80" });
    if (kind && !showGenerate) params.set("kind", kind);
    if (!showGenerate) params.set("surface", "picker");
    const cacheKey = `${workspaceId}:${params.toString()}`;
    const cached = assetPickerCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      setAssets(cached.assets);
      setIsLoading(false);
      return;
    }
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    setIsLoading(true);
    try {
      const payload = await readJsonResponse<{ assets?: CreativeAsset[] }>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/assets?${params.toString()}`,
          { cache: "no-store" }
        )
      );
      if (loadSeqRef.current !== loadSeq) return;
      const nextAssets = payload.assets || [];
      setAssets(nextAssets);
      assetPickerCache.set(cacheKey, {
        assets: nextAssets,
        expiresAt: Date.now() + ASSET_PICKER_CACHE_TTL_MS,
      });
    } catch (error) {
      if (loadSeqRef.current !== loadSeq) return;
      toast.error(
        error instanceof Error ? error.message : "Failed to load assets"
      );
    } finally {
      if (loadSeqRef.current === loadSeq) {
        setIsLoading(false);
      }
    }
  }, [kind, open, showGenerate, workspaceId]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    if (!open || pendingAssets.length === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void (async () => {
        const settled: CreativeAsset[] = [];
        const nextPending: CreativeAsset[] = [];
        try {
          const polledAssets = await fetchCreativeAssetStatuses<CreativeAsset>({
            workspaceId,
            assetIds: pendingAssets.map(asset => asset.id),
            signal: controller.signal,
          });
          if (cancelled) return;
          const received = new Map(
            polledAssets.map(asset => [asset.id, asset])
          );
          for (const pending of pendingAssets) {
            const asset = received.get(pending.id) || pending;
            if (asset.status === "complete") {
              settled.push(asset);
            } else if (
              asset.status === "queued" ||
              asset.status === "in_progress"
            ) {
              nextPending.push(asset);
            } else {
              toast.error(asset.error || "Higgsfield generation failed");
            }
          }
        } catch {
          if (cancelled) return;
          nextPending.push(...pendingAssets);
        }
        if (settled.length > 0) {
          setAssets(current => [...settled, ...current]);
          if (showGenerate) {
            for (const asset of settled) {
              if (
                asset.url &&
                (!kind || asset.kind === kind) &&
                (!assetFilter || assetFilter(asset)) &&
                !selectedUrlSet.has(asset.url)
              ) {
                onSelect(asset);
              }
            }
            toast.success("Generated asset is ready");
          }
        }
        setPendingAssets(nextPending);
      })();
    }, 4000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [
    kind,
    assetFilter,
    onSelect,
    open,
    pendingAssets,
    selectedUrlSet,
    showGenerate,
    workspaceId,
  ]);

  const imageAssets = assets.filter(
    asset => asset.kind === "image" && asset.status === "complete" && asset.url
  );
  const selectedSourceAsset = imageAssets.find(
    asset => asset.id === sourceAssetId
  );
  const visibleAssets = assets.filter(asset => {
    if (kind && asset.kind !== kind) return false;
    if (!assetMatchesSearch(asset, searchQuery)) return false;
    if (assetFilter && !assetFilter(asset)) return false;
    return asset.status === "complete" && Boolean(asset.url);
  });

  const generateAsset = async (mode: "text_to_image" | "image_to_video") => {
    const prompt = (
      mode === "text_to_image" ? imagePrompt : videoPrompt
    ).trim();
    if (!prompt) return;
    if (mode === "image_to_video" && !sourceAssetId) return;
    if (mode === "text_to_image") setIsGeneratingImage(true);
    if (mode === "image_to_video") setIsGeneratingVideo(true);
    try {
      const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/generate/higgsfield`;
      const body = JSON.stringify({
        mode,
        prompt,
        ...(mode === "image_to_video" ? { sourceAssetId } : {}),
      });
      const idempotencyKey =
        mode === "image_to_video"
          ? getOrCreateVideoGenerationIdempotencyKey(
              videoIdempotencyKeysRef.current,
              endpoint,
              body
            )
          : null;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body,
      });
      const payload = await readJsonResponse<{ asset?: CreativeAsset }>(
        response
      );
      if (mode === "image_to_video") {
        const asset = requireQueuedAsset(payload);
        retireVideoGenerationIdempotencyKey(
          videoIdempotencyKeysRef.current,
          endpoint,
          body
        );
        setPendingAssets(current => [asset, ...current]);
      } else {
        const asset = payload.asset;
        if (asset) setPendingAssets(current => [asset, ...current]);
      }
      if (mode === "text_to_image") setImagePrompt("");
      if (mode === "image_to_video") setVideoPrompt("");
      toast.success("Higgsfield generation queued");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to generate asset"
      );
    } finally {
      setIsGeneratingImage(false);
      setIsGeneratingVideo(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-h-[88vh] overflow-hidden p-0",
          showGenerate ? "max-w-5xl" : "max-w-3xl"
        )}
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>
            {kind === "video"
              ? "Choose video asset"
              : kind === "image"
                ? "Choose image asset"
                : "Choose assets"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Select a completed workspace image or video asset.
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            "min-h-0 overflow-hidden",
            showGenerate &&
              "grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px]"
          )}
        >
          <div className="min-h-[360px] overflow-y-auto p-4">
            <div className="mb-3 flex min-w-0 items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.target.value)}
                  placeholder="Search assets"
                  className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
              <div className="shrink-0 text-xs text-muted-foreground">
                {visibleAssets.length}
              </div>
            </div>
            {isLoading && visibleAssets.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading assets
              </div>
            ) : null}
            {!isLoading && visibleAssets.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center rounded-md border border-dashed px-4 text-center text-sm text-muted-foreground">
                <ImageIcon className="mb-2 h-6 w-6" />
                <span>No completed assets</span>
                {searchQuery ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-7 rounded-md"
                    onClick={() => setSearchQuery("")}
                  >
                    Clear search
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3">
              {visibleAssets.map((asset, assetIndex) => {
                const selected = Boolean(
                  asset.url && selectedUrlSet.has(asset.url)
                );
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className={cn(
                      "overflow-hidden rounded-md border bg-background text-left transition-colors",
                      selected
                        ? "border-primary ring-2 ring-primary/30"
                        : "hover:border-primary/50"
                    )}
                    onClick={() => onSelect(asset)}
                  >
                    <div className="relative flex aspect-[4/3] items-center justify-center bg-muted/40">
                      {asset.url && asset.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={asset.url}
                          alt=""
                          loading={assetIndex < 6 ? "eager" : "lazy"}
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      ) : asset.url ? (
                        <video
                          src={asset.url}
                          className="h-full w-full object-cover"
                          preload="none"
                          muted
                          playsInline
                        />
                      ) : asset.kind === "video" ? (
                        <Video className="h-7 w-7 text-muted-foreground" />
                      ) : (
                        <ImageIcon className="h-7 w-7 text-muted-foreground" />
                      )}
                      {selected ? (
                        <div className="absolute right-2 top-2 rounded-full bg-primary p-1 text-primary-foreground shadow-sm">
                          <Check className="h-3.5 w-3.5" />
                        </div>
                      ) : null}
                    </div>
                    <div className="space-y-1 p-2">
                      <div className="min-w-0 truncate text-xs font-medium">
                        {assetTitle(asset)}
                      </div>
                      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        {asset.kind === "video" ? (
                          <Film className="h-3 w-3" />
                        ) : (
                          <ImageIcon className="h-3 w-3" />
                        )}
                        <span>{asset.kind}</span>
                        {asset.fileSize ? (
                          <span>{formatBytes(asset.fileSize)}</span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          {showGenerate ? (
            <aside className="min-h-0 overflow-y-auto border-t p-4 md:border-l md:border-t-0">
              <Tabs defaultValue="image" className="gap-3">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="image">Image</TabsTrigger>
                  <TabsTrigger value="video">Video</TabsTrigger>
                </TabsList>
                <TabsContent value="image" className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="picker-image-prompt">Prompt</Label>
                    <Textarea
                      id="picker-image-prompt"
                      rows={4}
                      value={imagePrompt}
                      disabled={!higgsfieldConfigured}
                      onChange={event => setImagePrompt(event.target.value)}
                      placeholder="Describe the image, scene, lighting, and composition."
                      className="resize-none"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {IMAGE_PROMPT_PRESETS.map(preset => (
                      <Button
                        key={preset}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 rounded-md px-2 text-[11px]"
                        disabled={!higgsfieldConfigured}
                        onClick={() => setImagePrompt(preset)}
                      >
                        {preset.split(" ").slice(0, 3).join(" ")}
                      </Button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    className="w-full rounded-md"
                    disabled={
                      !higgsfieldConfigured ||
                      isGeneratingImage ||
                      imagePrompt.trim().length < 3
                    }
                    onClick={() => void generateAsset("text_to_image")}
                  >
                    {isGeneratingImage ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <WandSparkles className="mr-2 h-4 w-4" />
                    )}
                    Generate image
                  </Button>
                </TabsContent>
                <TabsContent value="video" className="space-y-3">
                  <div className="space-y-2">
                    <Label>Source image</Label>
                    <Select
                      value={sourceAssetId}
                      onValueChange={setSourceAssetId}
                      disabled={
                        !higgsfieldConfigured || imageAssets.length === 0
                      }
                    >
                      <SelectTrigger className="rounded-md">
                        <SelectValue placeholder="Select image" />
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
                  {selectedSourceAsset?.url ? (
                    <div className="overflow-hidden rounded-md border bg-muted/30">
                      <div className="aspect-[4/3] bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={selectedSourceAsset.url}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <div className="truncate px-2 py-1.5 text-xs text-muted-foreground">
                        {assetTitle(selectedSourceAsset)}
                      </div>
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    <Label htmlFor="picker-video-prompt">Motion</Label>
                    <Textarea
                      id="picker-video-prompt"
                      rows={4}
                      value={videoPrompt}
                      disabled={!higgsfieldConfigured}
                      onChange={event => setVideoPrompt(event.target.value)}
                      placeholder="Describe camera movement, subject motion, and pacing."
                      className="resize-none"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {VIDEO_PROMPT_PRESETS.map(preset => (
                      <Button
                        key={preset}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 rounded-md px-2 text-[11px]"
                        disabled={!higgsfieldConfigured}
                        onClick={() => setVideoPrompt(preset)}
                      >
                        {preset.split(" ").slice(0, 3).join(" ")}
                      </Button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    className="w-full rounded-md"
                    disabled={
                      !higgsfieldConfigured ||
                      isGeneratingVideo ||
                      !sourceAssetId ||
                      videoPrompt.trim().length < 3
                    }
                    onClick={() => void generateAsset("image_to_video")}
                  >
                    {isGeneratingVideo ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="mr-2 h-4 w-4" />
                    )}
                    Generate video
                  </Button>
                </TabsContent>
              </Tabs>
              {pendingAssets.length > 0 ? (
                <div className="mt-4 space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    Generating
                  </div>
                  {pendingAssets.map(asset => (
                    <div
                      key={asset.id}
                      className="flex min-w-0 items-center gap-2 rounded-md border p-2 text-xs"
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {assetTitle(asset)}
                      </span>
                      <Badge
                        className={statusClass(asset.status)}
                        variant="secondary"
                      >
                        {asset.status === "in_progress"
                          ? "Processing"
                          : "Queued"}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : null}
              {!higgsfieldConfigured ? (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                  Higgsfield generation is not configured.
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
