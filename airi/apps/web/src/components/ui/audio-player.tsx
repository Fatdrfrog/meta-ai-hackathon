"use client";

import {
  ComponentProps,
  createContext,
  HTMLProps,
  ReactNode,
  RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { Check, PauseIcon, PlayIcon, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MediaLoadError } from "@/components/ui/media-load-error";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

enum ReadyState {
  HAVE_NOTHING = 0,
  HAVE_METADATA = 1,
  HAVE_CURRENT_DATA = 2,
  HAVE_FUTURE_DATA = 3,
  HAVE_ENOUGH_DATA = 4,
}

enum NetworkState {
  NETWORK_EMPTY = 0,
  NETWORK_IDLE = 1,
  NETWORK_LOADING = 2,
  NETWORK_NO_SOURCE = 3,
}

const UNKNOWN_AUDIO_TIME_LABEL = "--:--";

// A load that neither reaches playable data nor fires a `MediaError` (a stalled
// storage request that returns status 0) would otherwise buffer forever. After
// this long we treat it as failed so the card can offer a retry and a link.
const MEDIA_LOAD_TIMEOUT_MS = 20000;

export interface MediaLoadErrorInfo {
  reason: "timeout" | "error";
  mimeType?: string;
  errorCode?: number;
}

function getFiniteAudioSeconds(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return null;
  }

  return Math.max(0, seconds);
}

export function formatAudioPlayerTime(seconds: number | null | undefined) {
  const finiteSeconds = getFiniteAudioSeconds(seconds);
  if (finiteSeconds === null) {
    return UNKNOWN_AUDIO_TIME_LABEL;
  }

  const hrs = Math.floor(finiteSeconds / 3600);
  const mins = Math.floor((finiteSeconds % 3600) / 60);
  const secs = Math.floor(finiteSeconds % 60);

  const formattedMins = mins < 10 ? `0${mins}` : mins;
  const formattedSecs = secs < 10 ? `0${secs}` : secs;

  return hrs > 0
    ? `${hrs}:${formattedMins}:${formattedSecs}`
    : `${mins}:${formattedSecs}`;
}

type AudioPlayerItem = {
  id: string | number;
  src: string;
};

type AudioPlaybackError = Pick<MediaError, "code" | "message">;

type AudioPlayerApi = {
  ref: RefObject<HTMLAudioElement | null>;
  activeItem: AudioPlayerItem | null;
  duration: number | undefined;
  error: AudioPlaybackError | null;
  hasLoadTimedOut: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
  playbackRate: number;
  isItemActive: (id: string | number | null) => boolean;
  play: (item?: AudioPlayerItem) => Promise<void>;
  pause: () => void;
  seek: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
  retry: () => void;
};

const AudioPlayerContext = createContext<AudioPlayerApi | null>(null);

export function useAudioPlayer(): AudioPlayerApi {
  const api = useContext(AudioPlayerContext);
  if (!api) {
    throw new Error(
      "useAudioPlayer cannot be called outside of AudioPlayerProvider"
    );
  }
  return api;
}

const AudioPlayerTimeContext = createContext<number | null>(null);

function useAudioPlayerTime() {
  const time = useContext(AudioPlayerTimeContext);
  if (time === null) {
    throw new Error(
      "useAudioPlayerTime cannot be called outside of AudioPlayerProvider"
    );
  }
  return time;
}

// Element events after which its state may differ from what was mirrored.
const MEDIA_STATE_EVENTS = [
  "loadstart",
  "loadedmetadata",
  "loadeddata",
  "durationchange",
  "canplay",
  "canplaythrough",
  "progress",
  "waiting",
  "stalled",
  "play",
  "playing",
  "pause",
  "seeked",
  "timeupdate",
  "ratechange",
  "emptied",
  "error",
] as const;

export function AudioPlayerProvider({
  children,
  mimeType,
  onLoadError,
}: {
  children: ReactNode;
  mimeType?: string;
  onLoadError?: (info: MediaLoadErrorInfo) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const itemRef = useRef<AudioPlayerItem | null>(null);
  const playbackRevisionRef = useRef(0);
  const playbackErrorRef = useRef<AudioPlaybackError | null>(null);
  const loadStartedAtRef = useRef<number | null>(null);
  const [readyState, setReadyState] = useState<number>(0);
  const [networkState, setNetworkState] = useState<number>(0);
  const [time, setTime] = useState<number>(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [error, setError] = useState<AudioPlaybackError | null>(null);
  const [hasLoadTimedOut, setHasLoadTimedOut] = useState(false);
  const [activeItem, setActiveItem] = useState<AudioPlayerItem | null>(null);
  const [paused, setPaused] = useState(true);
  const [playbackRate, setPlaybackRateState] = useState<number>(1);

  const loadItem = useCallback((item: AudioPlayerItem) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (item.id === itemRef.current?.id && item.src === itemRef.current?.src) {
      return;
    }
    playbackRevisionRef.current += 1;
    itemRef.current = item;
    setActiveItem(item);
    const currentRate = audio.playbackRate;
    audio.pause();
    audio.currentTime = 0;
    audio.src = item.src;
    loadStartedAtRef.current = null;
    playbackErrorRef.current = null;
    setError(null);
    setPaused(true);
    setHasLoadTimedOut(false);
    audio.load();
    audio.playbackRate = currentRate;
  }, []);

  const play = useCallback(
    async (item?: AudioPlayerItem) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (item) loadItem(item);
      if (!itemRef.current) return;

      const revision = ++playbackRevisionRef.current;
      playbackErrorRef.current = null;
      setError(null);
      try {
        await audio.play();
      } catch (cause) {
        // Pausing, changing source and unmounting intentionally abort a pending
        // play. A late rejection must not overwrite the next item's state.
        if (
          revision !== playbackRevisionRef.current ||
          audioRef.current !== audio
        )
          return;
        const playbackError = audio.error ?? {
          code:
            cause instanceof Error && cause.name === "NotSupportedError"
              ? 4
              : 0,
          message:
            cause instanceof Error ? cause.message : "Audio playback failed",
        };
        playbackErrorRef.current = playbackError;
        setError(playbackError);
        setPaused(true);
      }
    },
    [loadItem]
  );

  const pause = useCallback(() => {
    playbackRevisionRef.current += 1;
    audioRef.current?.pause();
    setPaused(true);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      playbackRevisionRef.current += 1;
      audio?.pause();
    };
  }, []);

  const seek = useCallback((time: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = time;
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    if (!audioRef.current) return;
    audioRef.current.playbackRate = rate;
    setPlaybackRateState(rate);
  }, []);

  const retry = useCallback(() => {
    if (!audioRef.current) return;
    playbackRevisionRef.current += 1;
    loadStartedAtRef.current = null;
    playbackErrorRef.current = null;
    setHasLoadTimedOut(false);
    setError(null);
    audioRef.current.load();
    void play();
  }, [play]);

  const isItemActive = useCallback(
    (id: string | number | null) => {
      return activeItem?.id === id;
    },
    [activeItem]
  );

  // Mirror the element into state once per frame while it plays or loads, and
  // once after any media event otherwise; an idle player schedules nothing.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    let frame: number | null = null;

    const sync = () => {
      frame = null;
      setReadyState(el.readyState);
      setNetworkState(el.networkState);
      setTime(el.currentTime);
      setDuration(el.duration);
      setPaused(el.paused);
      setError(el.error ?? playbackErrorRef.current);
      setPlaybackRateState(el.playbackRate);

      // A stalled request keeps `networkState` on LOADING without ever reaching
      // playable data or firing an error, so we time it out against the wall
      // clock. Any error or playable data clears the timer.
      const loading =
        el.readyState < ReadyState.HAVE_FUTURE_DATA &&
        el.networkState === NetworkState.NETWORK_LOADING;
      if (el.error || el.readyState >= ReadyState.HAVE_FUTURE_DATA) {
        loadStartedAtRef.current = null;
        setHasLoadTimedOut(false);
      } else if (loading) {
        if (loadStartedAtRef.current === null) {
          loadStartedAtRef.current = performance.now();
        } else if (
          performance.now() - loadStartedAtRef.current >
          MEDIA_LOAD_TIMEOUT_MS
        ) {
          setHasLoadTimedOut(true);
        }
      } else {
        loadStartedAtRef.current = null;
      }

      if (!el.paused || loading) frame = requestAnimationFrame(sync);
    };
    const wake = () => {
      if (frame === null) frame = requestAnimationFrame(sync);
    };

    for (const name of MEDIA_STATE_EVENTS) el.addEventListener(name, wake);
    wake();
    return () => {
      for (const name of MEDIA_STATE_EVENTS) {
        el.removeEventListener(name, wake);
      }
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  // Report a load failure once per failed attempt. `loadErrorReportedRef`
  // guards against re-reporting, so listing `onLoadError` (an inline arrow) in
  // the deps only ever re-runs a no-op.
  const loadErrorReportedRef = useRef(false);
  useEffect(() => {
    if (error || hasLoadTimedOut) {
      if (!loadErrorReportedRef.current) {
        loadErrorReportedRef.current = true;
        onLoadError?.({
          reason: error ? "error" : "timeout",
          mimeType,
          errorCode: error?.code,
        });
      }
    } else {
      loadErrorReportedRef.current = false;
    }
  }, [error, hasLoadTimedOut, mimeType, onLoadError]);

  const isPlaying = !paused;
  const isBuffering =
    readyState < ReadyState.HAVE_FUTURE_DATA &&
    networkState === NetworkState.NETWORK_LOADING;

  const api = useMemo<AudioPlayerApi>(
    () => ({
      ref: audioRef,
      duration,
      error,
      hasLoadTimedOut,
      isPlaying,
      isBuffering,
      activeItem,
      playbackRate,
      isItemActive,
      play,
      pause,
      seek,
      setPlaybackRate,
      retry,
    }),
    [
      audioRef,
      duration,
      error,
      hasLoadTimedOut,
      isPlaying,
      isBuffering,
      activeItem,
      playbackRate,
      isItemActive,
      play,
      pause,
      seek,
      setPlaybackRate,
      retry,
    ]
  );

  return (
    <AudioPlayerContext.Provider value={api}>
      <AudioPlayerTimeContext.Provider value={time}>
        <audio ref={audioRef} className="hidden" />
        {children}
      </AudioPlayerTimeContext.Provider>
    </AudioPlayerContext.Provider>
  );
}

export const AudioPlayerProgress = ({
  ...otherProps
}: Omit<
  ComponentProps<typeof SliderPrimitive.Root>,
  "min" | "max" | "value"
>) => {
  const player = useAudioPlayer();
  const time = useAudioPlayerTime();
  const wasPlayingRef = useRef(false);
  const duration = getFiniteAudioSeconds(player.duration);

  return (
    <SliderPrimitive.Root
      {...otherProps}
      value={[time]}
      onValueChange={vals => {
        player.seek(vals[0]);
        otherProps.onValueChange?.(vals);
      }}
      min={0}
      max={duration ?? 0}
      step={otherProps.step || 0.25}
      onPointerDown={e => {
        wasPlayingRef.current = player.isPlaying;
        player.pause();
        otherProps.onPointerDown?.(e);
      }}
      onPointerUp={e => {
        if (wasPlayingRef.current) {
          player.play();
        }
        otherProps.onPointerUp?.(e);
      }}
      className={cn(
        "group/player relative flex h-4 touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        otherProps.className
      )}
      onKeyDown={e => {
        if (e.key === " ") {
          e.preventDefault();
          if (!player.isPlaying) {
            player.play();
          } else {
            player.pause();
          }
        }
        otherProps.onKeyDown?.(e);
      }}
      disabled={duration === null}
    >
      <SliderPrimitive.Track className="bg-muted relative h-[4px] w-full grow overflow-hidden rounded-full">
        <SliderPrimitive.Range className="bg-primary absolute h-full" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className="relative flex h-0 w-0 items-center justify-center opacity-0 group-hover/player:opacity-100 focus-visible:opacity-100 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        data-slot="slider-thumb"
      >
        <div className="bg-foreground absolute size-3 rounded-full" />
      </SliderPrimitive.Thumb>
    </SliderPrimitive.Root>
  );
};

export const AudioPlayerTime = ({
  className,
  ...otherProps
}: HTMLProps<HTMLSpanElement>) => {
  const time = useAudioPlayerTime();
  return (
    <span
      {...otherProps}
      className={cn("text-muted-foreground text-sm tabular-nums", className)}
    >
      {formatAudioPlayerTime(time)}
    </span>
  );
};

export const AudioPlayerDuration = ({
  className,
  ...otherProps
}: HTMLProps<HTMLSpanElement>) => {
  const player = useAudioPlayer();
  return (
    <span
      {...otherProps}
      className={cn("text-muted-foreground text-sm tabular-nums", className)}
    >
      {formatAudioPlayerTime(player.duration)}
    </span>
  );
};

export function AudioPlayerError({
  src,
  className,
}: {
  src?: string;
  className?: string;
}) {
  const player = useAudioPlayer();
  if (!player.error && !player.hasLoadTimedOut) {
    return null;
  }

  return (
    <MediaLoadError
      message="Could not load audio."
      href={src ?? player.activeItem?.src}
      onRetry={player.retry}
      className={cn(
        "flex flex-wrap items-center gap-2 text-xs text-destructive",
        className
      )}
    />
  );
}

interface SpinnerProps {
  className?: string;
}

function Spinner({ className }: SpinnerProps) {
  return (
    <div
      className={cn(
        "border-muted border-t-foreground size-3.5 animate-spin rounded-full border-2",
        className
      )}
      role="status"
      aria-label="Loading"
    >
      <span className="sr-only">Loading...</span>
    </div>
  );
}

interface PlayButtonProps extends React.ComponentProps<typeof Button> {
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  loading?: boolean;
}

const PlayButton = ({
  playing,
  onPlayingChange,
  className,
  onClick,
  loading,
  ...otherProps
}: PlayButtonProps) => {
  return (
    <Button
      {...otherProps}
      onClick={e => {
        onPlayingChange(!playing);
        onClick?.(e);
      }}
      className={cn("relative", className)}
      aria-label={playing ? "Pause" : "Play"}
      type="button"
    >
      {playing ? (
        <PauseIcon
          className={cn("size-4", loading && "opacity-0")}
          aria-hidden="true"
        />
      ) : (
        <PlayIcon
          className={cn("size-4", loading && "opacity-0")}
          aria-hidden="true"
        />
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center rounded-[inherit] backdrop-blur-xs">
          <Spinner />
        </div>
      )}
    </Button>
  );
};

export function AudioPlayerButton({
  item,
  ...otherProps
}: React.ComponentProps<typeof Button> & { item: AudioPlayerItem }) {
  const player = useAudioPlayer();

  return (
    <PlayButton
      {...otherProps}
      playing={player.isItemActive(item.id) && player.isPlaying}
      onPlayingChange={shouldPlay => {
        if (shouldPlay) {
          player.play(item);
        } else {
          player.pause();
        }
      }}
      loading={
        player.isItemActive(item.id) && player.isBuffering && player.isPlaying
      }
    />
  );
}

const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function AudioPlayerSpeed({
  className,
  variant = "ghost",
  size = "icon",
  ...props
}: React.ComponentProps<typeof Button>) {
  const player = useAudioPlayer();
  const currentSpeed = player.playbackRate;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size={size}
          className={cn(className)}
          aria-label="Playback speed"
          {...props}
        >
          <Settings className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[120px]">
        {PLAYBACK_SPEEDS.map(speed => (
          <DropdownMenuItem
            key={speed}
            onClick={() => player.setPlaybackRate(speed)}
            className="flex items-center justify-between"
          >
            <span className={speed === 1 ? "" : "font-mono"}>
              {speed === 1 ? "Normal" : `${speed}x`}
            </span>
            {currentSpeed === speed && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
