"use client";

import { CreativeAssetPickerDialog } from "@/components/assets/creative-asset-picker-dialog";
import type { CreativeAsset } from "@/components/assets/creative-assets-workspace";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchCreativeAssetStatuses,
  readJsonResponse,
  requireQueuedAsset,
} from "@/lib/creative-assets/creative-asset-client-response";
import {
  MAX_REFERENCE_VIDEO_TITLE_LENGTH,
  type ReferenceVideoPlan,
  type ReferenceVideoPlanInput,
  type ReferenceVideoReference,
} from "@/lib/creative-assets/reference-video/contracts";
import { REFERENCE_VIDEO_RECIPES } from "@/lib/creative-assets/reference-video/recipes";
import {
  CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH,
  CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS,
} from "@icecore/temporal";
import { Check, ExternalLink, Film, ImageIcon, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { MarketingTemplatesTranslationFn } from "./creative-assets-tiktok-inspiration-view";

type SceneDraft = {
  asset: CreativeAsset | null;
  caption: string;
  sourceStart: string;
};
type Props = {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reference?: ReferenceVideoReference;
  onAssetCreated?: (asset: CreativeAsset) => void;
  t: MarketingTemplatesTranslationFn;
};

function recipeText(
  t: MarketingTemplatesTranslationFn,
  recipeId: string,
  key: string
) {
  return t(`referenceVideoRecipes.${recipeId}.${key}`);
}

function initialScenes(
  recipeId: string,
  t: MarketingTemplatesTranslationFn
): SceneDraft[] {
  const recipe = REFERENCE_VIDEO_RECIPES.find(item => item.id === recipeId)!;
  return recipe.scenes.map(scene => ({
    asset: null,
    caption: recipeText(t, recipe.id, `scenes.${scene.id}.caption`),
    sourceStart: "0",
  }));
}

function ScenePreview({
  asset,
  caption,
  sourceStart,
  duration,
  label,
  emptyLabel,
}: {
  asset: CreativeAsset | null;
  caption: string;
  sourceStart: number;
  duration: number;
  label: string;
  emptyLabel: string;
}) {
  const sourceEnd = sourceStart + duration;
  const constrainPlayback = (video: HTMLVideoElement) => {
    if (video.currentTime < sourceStart) video.currentTime = sourceStart;
    if (video.currentTime >= sourceEnd) {
      video.pause();
      if (video.currentTime > sourceEnd) video.currentTime = sourceEnd;
    }
  };
  return (
    <div className="relative flex aspect-[9/16] min-w-0 items-center justify-center overflow-hidden rounded-md bg-black">
      {asset?.url && asset.kind === "image" ? (
        // User-owned signed media URLs use the existing Assets image boundary.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={asset.url}
          alt={label}
          className="h-full w-full object-contain"
        />
      ) : asset?.url && asset.kind === "video" ? (
        <video
          key={`${asset.id}:${sourceStart}:${duration}`}
          src={`${asset.url}#t=${sourceStart},${sourceEnd}`}
          controls
          muted
          playsInline
          preload="metadata"
          aria-label={label}
          className="h-full w-full object-contain"
          onLoadedMetadata={event => constrainPlayback(event.currentTarget)}
          onSeeking={event => constrainPlayback(event.currentTarget)}
          onTimeUpdate={event => constrainPlayback(event.currentTarget)}
          onPlay={event => {
            const video = event.currentTarget;
            if (
              video.currentTime < sourceStart ||
              video.currentTime >= sourceEnd
            )
              video.currentTime = sourceStart;
          }}
        />
      ) : (
        <div className="flex flex-col items-center gap-2 px-4 text-center text-xs text-white/70">
          <ImageIcon aria-hidden="true" className="size-7" />
          <span>{emptyLabel}</span>
        </div>
      )}
      {caption ? (
        <p className="pointer-events-none absolute bottom-[16%] left-1/2 w-max max-w-[86%] -translate-x-1/2 whitespace-pre-line break-words rounded-sm bg-black/70 px-2 py-1.5 text-center text-xs leading-snug text-white">
          {caption}
        </p>
      ) : null}
    </div>
  );
}

function RenderedVideo({
  workspaceId,
  initialAsset,
  onAssetCreated,
  t,
}: {
  workspaceId: string;
  initialAsset: CreativeAsset;
  onAssetCreated?: (asset: CreativeAsset) => void;
  t: MarketingTemplatesTranslationFn;
}) {
  const [asset, setAsset] = useState(initialAsset);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  useEffect(() => {
    if (
      asset.status === "failed" ||
      asset.status === "nsfw" ||
      (asset.status === "complete" && asset.url)
    )
      return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchCreativeAssetStatuses<CreativeAsset>({
        workspaceId,
        assetIds: [asset.id],
        signal: controller.signal,
      })
        .then(assets => {
          if (controller.signal.aborted) return;
          const next = assets.find(
            item => item.id === asset.id && item.workspaceId === workspaceId
          );
          setRefreshFailed(!next || (next.status === "complete" && !next.url));
          if (next) {
            setAsset(next);
            onAssetCreated?.(next);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setRefreshFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setPollVersion(value => value + 1);
        });
    }, 4000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    asset.id,
    asset.status,
    asset.url,
    onAssetCreated,
    pollVersion,
    workspaceId,
  ]);

  const complete = asset.status === "complete" && Boolean(asset.url);
  const failed = asset.status === "failed" || asset.status === "nsfw";
  return (
    <div className="grid gap-4 py-2" data-testid="reference-video-result">
      <div
        role="status"
        className="flex items-center gap-2 text-sm font-medium"
      >
        {complete ? (
          <Check aria-hidden="true" className="size-4 text-emerald-600" />
        ) : failed ? (
          <Film aria-hidden="true" className="size-4" />
        ) : (
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        )}
        {t(
          complete
            ? "referenceVideoComplete"
            : failed
              ? "referenceVideoFailed"
              : "referenceVideoRendering"
        )}
      </div>
      {refreshFailed ? (
        <Alert>
          <AlertDescription>
            {t("referenceVideoRefreshFailed")}
          </AlertDescription>
        </Alert>
      ) : null}
      {failed ? (
        <Alert variant="destructive">
          <AlertDescription>
            {asset.error || t("referenceVideoFailedDescription")}
          </AlertDescription>
        </Alert>
      ) : null}
      {complete ? (
        <>
          <video
            src={asset.url!}
            controls
            playsInline
            preload="metadata"
            aria-label={t("referenceVideoOutputPreview")}
            className="mx-auto max-h-[50vh] w-full max-w-sm rounded-lg bg-black"
          />
          <Button asChild variant="outline">
            <a
              href={asset.url!}
              target="_blank"
              rel="noopener noreferrer"
              download={asset.fileName || "video.mp4"}
            >
              {t("referenceVideoDownload")}
              <ExternalLink data-icon="inline-end" aria-hidden="true" />
            </a>
          </Button>
        </>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {t("referenceVideoSavedToAssets")}
      </p>
    </div>
  );
}

function ReferenceVideoPlanContent({
  workspaceId,
  onOpenChange,
  reference,
  onAssetCreated,
  t,
}: Omit<Props, "open">) {
  const inputId = useId();
  const [recipeId, setRecipeId] = useState(REFERENCE_VIDEO_RECIPES[0].id);
  const [title, setTitle] = useState("");
  const [scenes, setScenes] = useState(() =>
    initialScenes(REFERENCE_VIDEO_RECIPES[0].id, t)
  );
  const [pickerSceneIndex, setPickerSceneIndex] = useState<number | null>(null);
  const [plan, setPlan] = useState<ReferenceVideoPlan | null>(null);
  const [output, setOutput] = useState<CreativeAsset | null>(null);
  const [pending, setPending] = useState<"review" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const recipe = REFERENCE_VIDEO_RECIPES.find(item => item.id === recipeId)!;
  const totalDuration = recipe.scenes.reduce(
    (sum, scene) => sum + scene.duration,
    0
  );
  const missingAssets = scenes.filter(scene => !scene.asset).length;
  const valid =
    title.trim().length > 0 &&
    title.trim().length <= MAX_REFERENCE_VIDEO_TITLE_LENGTH &&
    missingAssets === 0 &&
    scenes.every(
      scene =>
        scene.caption.trim().length <=
          CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH &&
        scene.sourceStart.trim() !== "" &&
        Number.isFinite(Number(scene.sourceStart)) &&
        Number(scene.sourceStart) >= 0 &&
        Number(scene.sourceStart) <=
          CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS
    );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
    };
  }, []);

  const updateScene = (index: number, update: Partial<SceneDraft>) => {
    if (requestRef.current) return;
    setPlan(null);
    setError(null);
    setScenes(current =>
      current.map((scene, position) =>
        position === index ? { ...scene, ...update } : scene
      )
    );
  };

  const submit = async (action: "review" | "approve") => {
    if (requestRef.current || (action === "review" ? !valid : !plan)) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(action);
    setError(null);
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/reference-video-plans`;
      if (action === "review") {
        const input: ReferenceVideoPlanInput = {
          recipeId,
          title: title.trim(),
          ...(reference ? { reference } : {}),
          scenes: scenes.map(scene => ({
            assetId: scene.asset!.id,
            caption: scene.caption.trim(),
            sourceStart:
              scene.asset!.kind === "image" ? 0 : Number(scene.sourceStart),
          })),
        };
        const payload = await readJsonResponse<{ plan?: ReferenceVideoPlan }>(
          await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal: controller.signal,
          })
        );
        if (!mountedRef.current || controller.signal.aborted) return;
        if (
          !payload.plan?.id ||
          !payload.plan.hash ||
          payload.plan.scenes.length !== scenes.length
        )
          throw new Error(t("referenceVideoInvalidResponse"));
        setPlan(payload.plan);
      } else if (plan) {
        const payload = await readJsonResponse<{ asset?: CreativeAsset }>(
          await fetch(`${endpoint}/${encodeURIComponent(plan.id)}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hash: plan.hash }),
            signal: controller.signal,
          })
        );
        if (!mountedRef.current || controller.signal.aborted) return;
        const asset = requireQueuedAsset(payload);
        if (asset.workspaceId !== workspaceId || asset.kind !== "video")
          throw new Error(t("referenceVideoInvalidResponse"));
        setOutput(asset);
        onAssetCreated?.(asset);
      }
    } catch (failure) {
      if (!mountedRef.current) return;
      setError(
        controller.signal.aborted
          ? t("referenceVideoTimeout")
          : failure instanceof Error
            ? failure.message
            : t("referenceVideoRequestFailed")
      );
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) requestRef.current = null;
      if (mountedRef.current) setPending(null);
    }
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={next => {
          if (!next && !requestRef.current) onOpenChange(false);
        }}
      >
        <DialogContent
          showCloseButton={!pending}
          className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
          onInteractOutside={event => event.preventDefault()}
        >
          <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12 text-left">
            <DialogTitle>
              {t(
                output
                  ? "referenceVideoResultTitle"
                  : plan
                    ? "referenceVideoReviewTitle"
                    : "referenceVideoTitle"
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                output
                  ? "referenceVideoSavedToAssets"
                  : "referenceVideoDescription"
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {output ? (
              <RenderedVideo
                workspaceId={workspaceId}
                initialAsset={output}
                onAssetCreated={onAssetCreated}
                t={t}
              />
            ) : (
              <div className="grid gap-5">
                {reference ? (
                  <div className="grid min-w-0 gap-1 rounded-md border bg-muted/30 p-3 text-sm">
                    <span className="text-xs text-muted-foreground">
                      {t("referenceVideoReferenceLabel")}
                    </span>
                    <a
                      href={reference.shareUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-words font-medium underline underline-offset-4"
                    >
                      {reference.title}
                      <ExternalLink
                        className="ml-1 inline size-3"
                        aria-hidden="true"
                      />
                    </a>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("referenceVideoReferenceNotice")}
                    </p>
                  </div>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor={`${inputId}-recipe`}>
                      {t("referenceVideoFormat")}
                    </Label>
                    {plan ? (
                      <p className="text-sm font-medium">
                        {recipeText(t, plan.recipeId, "title")}
                      </p>
                    ) : (
                      <NativeSelect
                        id={`${inputId}-recipe`}
                        value={recipeId}
                        disabled={Boolean(pending)}
                        onChange={event => {
                          if (requestRef.current) return;
                          const next = event.target.value;
                          setRecipeId(next);
                          setScenes(initialScenes(next, t));
                          setPlan(null);
                          setError(null);
                        }}
                      >
                        {REFERENCE_VIDEO_RECIPES.map(item => (
                          <NativeSelectOption key={item.id} value={item.id}>
                            {recipeText(t, item.id, "title")}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {recipeText(t, recipe.id, "description")}
                    </p>
                  </div>
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor={`${inputId}-title`}>
                      {t("referenceVideoBusinessTitle")}
                    </Label>
                    {plan ? (
                      <p className="break-words text-sm font-medium">
                        {plan.title}
                      </p>
                    ) : (
                      <Input
                        id={`${inputId}-title`}
                        value={title}
                        maxLength={MAX_REFERENCE_VIDEO_TITLE_LENGTH}
                        disabled={Boolean(pending)}
                        placeholder={t("referenceVideoBusinessPlaceholder")}
                        onChange={event => {
                          if (requestRef.current) return;
                          setTitle(event.target.value);
                          setPlan(null);
                          setError(null);
                        }}
                      />
                    )}
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">
                      {t("referenceVideoStoryboard")}
                    </h3>
                    <Badge variant="secondary">
                      {t("referenceVideoDuration", {
                        seconds: plan?.duration ?? totalDuration,
                      })}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("referenceVideoPreviewNotice")}
                  </p>
                  <ol className="grid grid-cols-1 gap-4 min-[400px]:grid-cols-2 lg:grid-cols-3">
                    {recipe.scenes.map((slot, index) => {
                      const draft = scenes[index];
                      const reviewed = plan?.scenes[index];
                      const label = recipeText(
                        t,
                        recipe.id,
                        `scenes.${slot.id}.label`
                      );
                      const caption = reviewed?.caption ?? draft.caption;
                      const start =
                        reviewed?.timelineStart ??
                        recipe.scenes
                          .slice(0, index)
                          .reduce((sum, scene) => sum + scene.duration, 0);
                      const duration = reviewed?.duration ?? slot.duration;
                      return (
                        <li
                          key={slot.id}
                          className="min-w-0 space-y-2 rounded-lg border p-3"
                        >
                          <div className="flex items-start justify-between gap-2 text-xs">
                            <h4 className="min-w-0 break-words font-semibold">
                              {index + 1}. {label}
                            </h4>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {start}–{start + duration}s
                            </span>
                          </div>
                          <ScenePreview
                            asset={draft.asset}
                            caption={caption}
                            sourceStart={
                              reviewed?.sourceStart ??
                              (Number(draft.sourceStart) || 0)
                            }
                            duration={duration}
                            label={t("referenceVideoScenePreview", {
                              number: index + 1,
                            })}
                            emptyLabel={t("referenceVideoEmptyScene")}
                          />
                          {draft.asset ? (
                            <p
                              className="truncate text-xs text-muted-foreground"
                              title={draft.asset.fileName || draft.asset.id}
                            >
                              {draft.asset.fileName || draft.asset.id}
                            </p>
                          ) : null}
                          {!plan ? (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="w-full"
                                disabled={Boolean(pending)}
                                onClick={() => setPickerSceneIndex(index)}
                                aria-label={t(
                                  "referenceVideoChooseSceneAsset",
                                  { number: index + 1 }
                                )}
                              >
                                {t(
                                  draft.asset
                                    ? "referenceVideoChangeAsset"
                                    : "referenceVideoChooseAsset"
                                )}
                              </Button>
                              <div className="space-y-1.5">
                                <Label
                                  htmlFor={`${inputId}-caption-${slot.id}`}
                                  className="text-xs"
                                >
                                  {t("referenceVideoCaption", {
                                    number: index + 1,
                                  })}
                                </Label>
                                <Textarea
                                  id={`${inputId}-caption-${slot.id}`}
                                  rows={2}
                                  maxLength={
                                    CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH
                                  }
                                  value={draft.caption}
                                  disabled={Boolean(pending)}
                                  onChange={event =>
                                    updateScene(index, {
                                      caption: event.target.value,
                                    })
                                  }
                                  className="resize-none text-sm"
                                />
                              </div>
                              {draft.asset?.kind === "video" ? (
                                <div className="space-y-1.5">
                                  <Label
                                    htmlFor={`${inputId}-trim-${slot.id}`}
                                    className="text-xs"
                                  >
                                    {t("referenceVideoSourceStart", {
                                      number: index + 1,
                                    })}
                                  </Label>
                                  <Input
                                    id={`${inputId}-trim-${slot.id}`}
                                    type="number"
                                    min={0}
                                    max={
                                      CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS
                                    }
                                    step={0.1}
                                    value={draft.sourceStart}
                                    disabled={Boolean(pending)}
                                    onChange={event =>
                                      updateScene(index, {
                                        sourceStart: event.target.value,
                                      })
                                    }
                                  />
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {t(
                                draft.asset?.kind === "video"
                                  ? "referenceVideoReviewedTrim"
                                  : "referenceVideoReviewedPhoto",
                                {
                                  seconds: duration,
                                  start: reviewed?.sourceStart ?? 0,
                                }
                              )}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </div>
                <Alert>
                  <AlertDescription className="space-y-1">
                    <p className="font-medium">
                      {t("referenceVideoNoAiCharge")}
                    </p>
                    <p>{t("referenceVideoAudioNotice")}</p>
                    <p>{t("referenceVideoClipLengthNotice")}</p>
                  </AlertDescription>
                </Alert>
                {plan ? (
                  <p className="text-sm text-muted-foreground">
                    {t("referenceVideoApprovalNotice")}
                  </p>
                ) : missingAssets > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("referenceVideoMissingAssets", { count: missingAssets })}
                  </p>
                ) : null}
              </div>
            )}
            {error ? (
              <Alert variant="destructive" className="mt-4" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-background px-5 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(pending)}
              onClick={() => onOpenChange(false)}
            >
              {t("referenceVideoClose")}
            </Button>
            {!output && plan ? (
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(pending)}
                onClick={() => {
                  setPlan(null);
                  setError(null);
                }}
              >
                {t("referenceVideoEdit")}
              </Button>
            ) : null}
            {!output ? (
              <Button
                type="button"
                disabled={Boolean(pending) || (!plan && !valid)}
                onClick={() => void submit(plan ? "approve" : "review")}
              >
                {pending ? (
                  <Loader2
                    data-icon="inline-start"
                    aria-hidden="true"
                    className="animate-spin"
                  />
                ) : plan ? (
                  <Check data-icon="inline-start" aria-hidden="true" />
                ) : null}
                {t(
                  pending === "review"
                    ? "referenceVideoPreparing"
                    : pending === "approve"
                      ? "referenceVideoStarting"
                      : plan
                        ? "referenceVideoApprove"
                        : "referenceVideoReview"
                )}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      {pickerSceneIndex !== null ? (
        <CreativeAssetPickerDialog
          key={`${workspaceId}:${pickerSceneIndex}`}
          workspaceId={workspaceId}
          open
          onOpenChange={open => {
            if (!open) setPickerSceneIndex(null);
          }}
          showGenerate={false}
          assetFilter={asset =>
            asset.workspaceId === workspaceId &&
            asset.status === "complete" &&
            Boolean(asset.url) &&
            (asset.kind === "image" || asset.kind === "video")
          }
          onSelect={asset => {
            if (
              asset.workspaceId !== workspaceId ||
              asset.status !== "complete" ||
              !asset.url ||
              (asset.kind !== "image" && asset.kind !== "video")
            )
              return;
            updateScene(pickerSceneIndex, { asset, sourceStart: "0" });
            setPickerSceneIndex(null);
          }}
        />
      ) : null}
    </>
  );
}

export function ReferenceVideoPlanDialog({ open, ...props }: Props) {
  return open ? (
    <ReferenceVideoPlanContent
      key={`${props.workspaceId}:${props.reference?.providerVideoId ?? "original"}`}
      {...props}
    />
  ) : null;
}
