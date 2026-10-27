"use client";

import {
  formatAudioPlayerTime,
  type MediaLoadErrorInfo,
} from "@/components/ui/audio-player";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { formatConversationAttachmentFileSize } from "@/lib/conversation-attachments";
import { cn } from "@/lib/utils";
import {
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

// A stalled request fires neither `canplaythrough`/`loadeddata` nor an error,
// so the loading overlay would stay up forever. After this long we surface an
// error with a direct link instead.
const VIDEO_LOAD_TIMEOUT_MS = 20000;

// The thumbnail takes the clip's own shape, like a chat app's video bubble:
// narrower for portrait clips and never taller than this.
const PREVIEW_MAX_HEIGHT_PX = 360;
const DEFAULT_PREVIEW_ASPECT_RATIO = 4 / 5;

type VideoErrorKey =
  | "loadFailed"
  | "networkError"
  | "decodeError"
  | "formatUnsupported"
  | "playFailed"
  | "tooSlow";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; aspectRatio: number | null; duration: number | null }
  | { status: "error"; error: VideoErrorKey };

// Fire `onStall` after `ms` unless the load has settled by then. Returns a
// clear function; both video load effects share it.
function armStallTimer(
  ms: number,
  isStalled: () => boolean,
  onStall: () => void
): () => void {
  const id = setTimeout(() => {
    if (isStalled()) onStall();
  }, ms);
  return () => clearTimeout(id);
}

/**
 * The message for a failed load, or null for an aborted one: changing the
 * source aborts the old load, and that is not a failure to show.
 */
function describeVideoError(error: MediaError | null): VideoErrorKey | null {
  if (!error) return "loadFailed";
  switch (error.code) {
    case error.MEDIA_ERR_ABORTED:
      return null;
    case error.MEDIA_ERR_NETWORK:
      return "networkError";
    case error.MEDIA_ERR_DECODE:
      return "decodeError";
    // Browsers report a missing file (404) with the same code as an
    // unsupported format, so neither is named.
    default:
      return "loadFailed";
  }
}

function previewWidthPx(aspectRatio: number): number {
  const width = aspectRatio < 0.9 ? 220 : aspectRatio > 1.1 ? 300 : 260;
  return Math.round(Math.min(width, PREVIEW_MAX_HEIGHT_PX * aspectRatio));
}

function readPreviewState(video: HTMLVideoElement): PreviewState {
  return {
    status: "ready",
    aspectRatio:
      video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : null,
    duration: Number.isFinite(video.duration) ? video.duration : null,
  };
}

function OpenVideoLink({
  src,
  className,
}: {
  src: string;
  className?: string;
}) {
  const t = useTranslations("ConversationDetailView.videoPlayer");
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("text-xs hover:underline", className)}
    >
      {t("openInNewTab")}
    </a>
  );
}

interface VideoPlayerProps {
  src: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  isPlatformMessage?: boolean;
  onLoadError?: (info: MediaLoadErrorInfo) => void;
}

const CONTROL_BUTTON_CLASS_NAME =
  "h-7 w-7 sm:h-8 sm:w-8 border-0 flex-shrink-0 bg-black/50 hover:bg-black/70 text-white";
const CONTROLS_AUTO_HIDE_MS = 3000;

// Video Player Controls Component (used in dialog)
function VideoPlayerControls({
  videoRef,
  containerRef,
  isPlatformMessage,
  onTogglePlayback,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  isPlatformMessage: boolean;
  onTogglePlayback: () => Promise<void>;
}) {
  const t = useTranslations("ConversationDetailView.videoPlayer");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPlayingRef = useRef(false);

  // Show the controls; while playing they hide again after a pause in
  // pointer activity unless the pointer rests over them.
  const revealControls = useCallback((autoHide: boolean) => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
    setShowControls(true);
    if (autoHide && isPlayingRef.current) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, CONTROLS_AUTO_HIDE_MS);
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Initialize volume state from video element
    setVolume(video.volume);
    setIsMuted(video.muted);
    isPlayingRef.current = !video.paused;

    const updateTime = () => setCurrentTime(video.currentTime);
    const updateDuration = () => setDuration(video.duration);
    const handlePlay = () => {
      isPlayingRef.current = true;
      setIsPlaying(true);
      revealControls(true);
    };
    // Reaching the end fires "pause" before "ended".
    const handlePause = () => {
      isPlayingRef.current = false;
      setIsPlaying(false);
      revealControls(false);
    };
    const handleVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
    };

    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("loadedmetadata", updateDuration);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("volumechange", handleVolumeChange);
    document.addEventListener("fullscreenchange", handleFullscreenChange);

    const handleMouseMove = () => revealControls(true);

    const container = containerRef.current;
    container?.addEventListener("mousemove", handleMouseMove);

    return () => {
      video.removeEventListener("timeupdate", updateTime);
      video.removeEventListener("loadedmetadata", updateDuration);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("volumechange", handleVolumeChange);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      container?.removeEventListener("mousemove", handleMouseMove);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [videoRef, containerRef, revealControls]);

  const handleSeek = (value: number[]) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value[0];
    setCurrentTime(value[0]);
  };

  const handleVolumeChange = (value: number[]) => {
    const video = videoRef.current;
    if (!video) return;
    const newVolume = value[0];
    video.volume = newVolume;
    setVolume(newVolume);
    setIsMuted(newVolume === 0);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isMuted) {
      video.volume = volume || 0.5;
      setIsMuted(false);
    } else {
      video.volume = 0;
      setIsMuted(true);
    }
  };

  const skipBackward = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, video.currentTime - 10);
  };

  const skipForward = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(video.duration, video.currentTime + 10);
  };

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;

    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // Fullscreen API not supported or user denied permission
    }
  };

  return (
    <div
      className="absolute inset-0 flex flex-col"
      onMouseEnter={() => revealControls(false)}
      onMouseLeave={() => revealControls(true)}
    >
      {/* Controls Overlay */}
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-t transition-opacity duration-300 pointer-events-none",
          isPlatformMessage
            ? "from-black/60 via-transparent to-transparent"
            : "from-black/80 via-black/40 to-transparent",
          showControls ? "opacity-100" : "opacity-0"
        )}
      />

      {/* Bottom Controls */}
      <div className="absolute bottom-0 left-0 right-0 p-2 sm:p-3 space-y-1.5 sm:space-y-2 pointer-events-auto">
        {/* Progress Bar */}
        <div className="flex items-center gap-1 sm:gap-2 min-w-0">
          <span
            className={cn(
              "text-xs tabular-nums text-right flex-shrink-0",
              "w-[2rem] sm:w-[2.5rem]",
              "text-white"
            )}
          >
            {formatAudioPlayerTime(currentTime)}
          </span>
          <Slider
            value={[currentTime]}
            max={duration || 100}
            step={0.1}
            onValueChange={handleSeek}
            className="flex-1 min-w-0"
          />
          <span
            className={cn(
              "text-xs tabular-nums flex-shrink-0",
              "w-[2rem] sm:w-[2.5rem]",
              "text-white"
            )}
          >
            {formatAudioPlayerTime(duration)}
          </span>
        </div>

        {/* Control Buttons */}
        <div className="flex items-center gap-1 sm:gap-2 min-w-0 overflow-hidden">
          {/* Play/Pause Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void onTogglePlayback()}
            aria-label={isPlaying ? t("pause") : t("play")}
            className="h-8 w-8 sm:h-10 sm:w-10 rounded-full border-0 flex-shrink-0 bg-black/50 hover:bg-black/70 text-white"
          >
            {isPlaying ? (
              <Pause className="h-4 w-4 sm:h-5 sm:w-5" />
            ) : (
              <Play className="h-4 w-4 sm:h-5 sm:w-5" />
            )}
          </Button>

          {/* Skip Backward */}
          <Button
            variant="ghost"
            size="icon"
            onClick={skipBackward}
            aria-label={t("skipBack")}
            className={CONTROL_BUTTON_CLASS_NAME}
          >
            <SkipBack className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          </Button>

          {/* Skip Forward */}
          <Button
            variant="ghost"
            size="icon"
            onClick={skipForward}
            aria-label={t("skipForward")}
            className={CONTROL_BUTTON_CLASS_NAME}
          >
            <SkipForward className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          </Button>

          {/* Volume Control */}
          <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0 ml-auto">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleMute}
              aria-label={isMuted ? t("unmute") : t("mute")}
              className={CONTROL_BUTTON_CLASS_NAME}
            >
              {isMuted ? (
                <VolumeX className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              ) : (
                <Volume2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              )}
            </Button>
            <div className="hidden sm:flex items-center gap-1.5 w-[80px] min-w-0">
              <Slider
                value={[isMuted ? 0 : volume]}
                max={1}
                step={0.01}
                onValueChange={handleVolumeChange}
                className="flex-1 min-w-0"
              />
            </div>
          </div>

          {/* Fullscreen Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleFullscreen}
            aria-label={
              isFullscreen ? t("exitFullscreen") : t("enterFullscreen")
            }
            className={CONTROL_BUTTON_CLASS_NAME}
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function VideoPlayer({
  src,
  mimeType,
  fileName,
  fileSize,
  isPlatformMessage = false,
  onLoadError,
}: VideoPlayerProps) {
  const t = useTranslations("ConversationDetailView.videoPlayer");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  // The thumbnail and the dialog load separately, so opening the dialog never
  // puts the thumbnail behind it back into its loading state.
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const [dialogError, setDialogError] = useState<VideoErrorKey | null>(null);
  const [isDialogLoading, setIsDialogLoading] = useState(true);
  const [isDialogPlaying, setIsDialogPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogVideoRef = useRef<HTMLVideoElement>(null);
  // The dialog portal mounts its video after the effects of the render that
  // opened it, so the load effect waits for the element itself.
  const [dialogVideo, setDialogVideo] = useState<HTMLVideoElement | null>(null);
  const attachDialogVideo = useCallback((video: HTMLVideoElement | null) => {
    dialogVideoRef.current = video;
    setDialogVideo(video);
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasTriedAutoplayRef = useRef(false);
  const playbackRevisionRef = useRef(0);
  const loadErrorReasonRef = useRef<"timeout" | "error">("error");
  const loadErrorReportedRef = useRef(false);
  const hasLoadError = preview.status === "error" || dialogError !== null;

  // Report a load failure once per failed attempt, so a stuck player stops
  // being invisible to error tracking. The guard makes re-runs from an inline
  // `onLoadError` prop no-ops.
  useEffect(() => {
    if (hasLoadError) {
      if (!loadErrorReportedRef.current) {
        loadErrorReportedRef.current = true;
        onLoadError?.({ reason: loadErrorReasonRef.current, mimeType });
      }
    } else {
      loadErrorReportedRef.current = false;
    }
  }, [hasLoadError, mimeType, onLoadError]);

  // Each opening starts the dialog's load and autoplay afresh.
  const openDialog = () => {
    setIsDialogLoading(true);
    setDialogError(null);
    setIsDialogPlaying(false);
    hasTriedAutoplayRef.current = false;
    setIsDialogOpen(true);
  };

  const beginDialogPlayback = useCallback((video: HTMLVideoElement) => {
    const revision = ++playbackRevisionRef.current;
    const source = video.src;
    return () =>
      revision === playbackRevisionRef.current &&
      dialogVideoRef.current === video &&
      video.src === source;
  }, []);

  const toggleDialogPlayback = async () => {
    const video = dialogVideoRef.current;
    if (!video) return;
    const isCurrentPlayback = beginDialogPlayback(video);

    try {
      if (video.paused || video.ended) {
        await video.play();
        if (isCurrentPlayback()) {
          setIsDialogPlaying(!video.paused && !video.ended);
        }
      } else {
        video.pause();
        setIsDialogPlaying(false);
      }
    } catch (e) {
      if (!isCurrentPlayback()) return;
      if (e instanceof Error && e.name === "AbortError" && video.paused) return;
      loadErrorReasonRef.current = "error";
      setDialogError(
        e instanceof Error && e.name === "NotSupportedError"
          ? "formatUnsupported"
          : "playFailed"
      );
      setIsDialogLoading(false);
      setIsDialogPlaying(false);
    }
  };

  // Load the thumbnail's metadata (its size, length and first frame)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let clearLoadTimeout = () => {};
    const startLoadTimeout = () => {
      clearLoadTimeout();
      // The metadata never arrived and no error fired: treat the stall as a
      // failure so the thumbnail stops loading forever.
      clearLoadTimeout = armStallTimer(
        VIDEO_LOAD_TIMEOUT_MS,
        () => video.readyState === 0 && !video.error,
        () => {
          loadErrorReasonRef.current = "timeout";
          setPreview({ status: "error", error: "tooSlow" });
        }
      );
    };

    const handleLoadedMetadata = () => {
      clearLoadTimeout();
      setPreview(readPreviewState(video));
    };

    const handleError = () => {
      const error = describeVideoError(video.error);
      if (!error) return;
      clearLoadTimeout();
      loadErrorReasonRef.current = "error";
      setPreview({ status: "error", error });
    };

    const handleLoadStart = () => {
      setPreview({ status: "loading" });
      startLoadTimeout();
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("error", handleError);
    video.addEventListener("loadstart", handleLoadStart);
    // A cached or server-rendered video can have its metadata, or a quick
    // failure, before these listeners exist, and then no event comes to end
    // the loading state.
    if (video.error) {
      handleError();
    } else if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      handleLoadedMetadata();
    } else {
      startLoadTimeout();
    }
    return () => {
      clearLoadTimeout();
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("error", handleError);
      video.removeEventListener("loadstart", handleLoadStart);
    };
  }, [src]);

  // Handle dialog video loading and autoplay with sound
  useEffect(() => {
    // `dialogVideo` only re-runs this once the element mounts; the ref is the
    // same element, which the effect may change (muted, play).
    const video = dialogVideoRef.current;
    if (!isDialogOpen || !dialogVideo || !video) return;

    // Neither `canplaythrough`/`loadeddata` nor an error arrived: surface the
    // stall so the dialog stops loading forever.
    const clearLoadTimeout = armStallTimer(
      VIDEO_LOAD_TIMEOUT_MS,
      () => video.readyState < 2 && !video.error,
      () => {
        loadErrorReasonRef.current = "timeout";
        setDialogError("tooSlow");
        setIsDialogLoading(false);
        setIsDialogPlaying(false);
      }
    );

    const handleCanPlayThrough = async () => {
      clearLoadTimeout();
      setIsDialogLoading(false);

      // Try to autoplay with sound (user interaction required for unmuted autoplay)
      // If that fails, fallback to muted autoplay
      if (!hasTriedAutoplayRef.current) {
        hasTriedAutoplayRef.current = true;
        const isCurrentPlayback = beginDialogPlayback(video);
        try {
          video.muted = false;
          await video.play();
          if (isCurrentPlayback()) {
            setIsDialogPlaying(!video.paused && !video.ended);
          }
        } catch {
          if (!isCurrentPlayback()) return;
          // Browser blocked autoplay with sound, fallback to muted
          video.muted = true;
          try {
            await video.play();
            if (isCurrentPlayback()) {
              setIsDialogPlaying(!video.paused && !video.ended);
            }
          } catch {
            if (!isCurrentPlayback()) return;
            setIsDialogPlaying(false);
          }
        }
      }
    };

    // Play, pause and error state come from the <video> element props: the
    // dialog portal can mount the element after this effect has run.
    video.addEventListener("canplaythrough", handleCanPlayThrough);
    // The thumbnail has often loaded the same file already, and then the
    // event fired before this listener existed.
    if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
      void handleCanPlayThrough();
    }

    return () => {
      playbackRevisionRef.current += 1;
      clearLoadTimeout();
      video.removeEventListener("canplaythrough", handleCanPlayThrough);
    };
  }, [isDialogOpen, src, beginDialogPlayback, dialogVideo]);

  const aspectRatio =
    (preview.status === "ready" && preview.aspectRatio) ||
    DEFAULT_PREVIEW_ASPECT_RATIO;
  const durationLabel =
    preview.status === "ready" && preview.duration !== null
      ? formatAudioPlayerTime(preview.duration)
      : null;
  const sizeLabel = fileSize
    ? formatConversationAttachmentFileSize(fileSize)
    : null;
  const detailsLabel = [durationLabel, sizeLabel].filter(Boolean).join(" · ");

  return (
    <>
      {preview.status === "error" ? (
        <div
          role="group"
          aria-label={t("unavailable")}
          className="flex w-[240px] max-w-full flex-col items-center gap-1.5 rounded-2xl border border-border/60 bg-muted/60 px-4 py-5 text-center"
        >
          <VideoOff
            className="h-6 w-6 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-foreground">
            {t("unavailable")}
          </p>
          {preview.error !== "loadFailed" ? (
            <p className="text-xs text-muted-foreground">{t(preview.error)}</p>
          ) : null}
          <OpenVideoLink src={src} className="text-primary" />
        </div>
      ) : (
        <button
          type="button"
          onClick={openDialog}
          aria-label={
            durationLabel ? `${t("play")} (${durationLabel})` : t("play")
          }
          title={fileName || undefined}
          className="group relative block max-w-full overflow-hidden rounded-2xl bg-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          style={{
            width: `${previewWidthPx(aspectRatio)}px`,
            aspectRatio: String(aspectRatio),
          }}
        >
          {/* "#t" asks every browser, Safari included, for the first frame */}
          <video
            ref={videoRef}
            src={`${src}#t=0.1`}
            preload="metadata"
            className="absolute inset-0 h-full w-full object-cover"
            muted
            playsInline
            aria-hidden="true"
            tabIndex={-1}
          />
          {preview.status === "loading" ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <Loader2
                className="h-6 w-6 animate-spin text-white/70"
                aria-hidden="true"
              />
              <span className="sr-only">{t("loading")}</span>
            </span>
          ) : (
            <>
              <span className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors group-hover:bg-black/25">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm transition-transform group-hover:scale-105">
                  <Play
                    className="ml-0.5 h-5 w-5 text-white"
                    fill="currentColor"
                    aria-hidden="true"
                  />
                </span>
              </span>
              {detailsLabel ? (
                <span className="absolute bottom-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white">
                  {detailsLabel}
                </span>
              ) : null}
            </>
          )}
        </button>
      )}

      {/* Video Player Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent
          className="max-w-[95vw] w-full p-0 bg-black border-0"
          showCloseButton={true}
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">
            {fileName || t("dialogTitle")}
          </DialogTitle>
          <div
            ref={containerRef}
            className="relative w-full bg-black rounded-lg overflow-hidden"
          >
            {dialogError ? (
              <div className="w-full min-h-[400px] h-[400px] flex items-center justify-center">
                <div className="text-center p-4">
                  <p className="text-sm text-white mb-2">{t(dialogError)}</p>
                  <OpenVideoLink src={src} className="text-blue-400" />
                </div>
              </div>
            ) : (
              <div className="relative w-full min-h-[400px] bg-black group/dialog-video">
                {isDialogLoading && (
                  <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80">
                    <Loader2
                      className="h-8 w-8 animate-spin text-white/70"
                      aria-hidden="true"
                    />
                    <span className="sr-only">{t("loading")}</span>
                  </div>
                )}
                <video
                  ref={attachDialogVideo}
                  src={src}
                  preload="auto"
                  className="w-full max-h-[85vh] object-contain min-h-[400px]"
                  playsInline
                  onPlay={() => setIsDialogPlaying(true)}
                  onPause={() => setIsDialogPlaying(false)}
                  onClick={e => {
                    e.stopPropagation();
                    void toggleDialogPlayback();
                  }}
                  onError={event => {
                    const error = describeVideoError(event.currentTarget.error);
                    if (!error) return;
                    loadErrorReasonRef.current = "error";
                    setDialogError(error);
                    setIsDialogLoading(false);
                    setIsDialogPlaying(false);
                  }}
                  onLoadedData={() => {
                    setIsDialogLoading(false);
                  }}
                />
                {!isDialogLoading && (
                  <div
                    className={cn(
                      "absolute inset-0 z-10 flex items-center justify-center pointer-events-none transition-opacity duration-200",
                      isDialogPlaying ? "opacity-70" : "opacity-100"
                    )}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={e => {
                        e.stopPropagation();
                        void toggleDialogPlayback();
                      }}
                      className="pointer-events-auto h-16 w-16 sm:h-20 sm:w-20 rounded-full bg-black/60 hover:bg-black/70 text-white"
                      aria-label={isDialogPlaying ? t("pause") : t("play")}
                    >
                      {isDialogPlaying ? (
                        <Pause className="h-8 w-8 sm:h-10 sm:w-10" />
                      ) : (
                        <Play
                          className="h-8 w-8 sm:h-10 sm:w-10 ml-1"
                          fill="white"
                        />
                      )}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {!dialogError && (
              <VideoPlayerControls
                videoRef={dialogVideoRef}
                containerRef={containerRef}
                isPlatformMessage={isPlatformMessage}
                onTogglePlayback={toggleDialogPlayback}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
