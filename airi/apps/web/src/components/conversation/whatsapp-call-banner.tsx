"use client";

import { Button } from "@/components/ui/button";
import type {
  WhatsAppCallMediaConnection,
  WhatsAppCallMediaJoinOptions,
  WhatsAppCallMediaJoinResult,
} from "@/lib/calling/browser-call-media";
import { cn } from "@/lib/utils";
import { Mic, MicOff, PhoneCall, PhoneIncoming, PhoneOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

/** The call-session fields the banner reads from the conversation payload. */
export type WhatsAppCallSessionPreview = {
  _id: string;
  state: string;
  contactName?: string | null;
  contactUsername?: string | null;
  durationSeconds?: number | null;
  errorMessage?: string | null;
  lastProviderUpdateAt?: string | Date | null;
  updatedAt?: string | Date | null;
  latestCommand?: {
    status?: "pending" | "sent" | "failed" | string | null;
    providerError?: unknown;
  } | null;
};

type WhatsAppCallBannerProps = {
  callSessions?: WhatsAppCallSessionPreview[] | null;
  onCallCommand: (
    session: WhatsAppCallSessionPreview,
    action: "accept" | "reject" | "terminate"
  ) => Promise<void>;
  onCallMediaJoin: (
    session: WhatsAppCallSessionPreview,
    options: WhatsAppCallMediaJoinOptions
  ) => Promise<WhatsAppCallMediaJoinResult>;
};

type PendingAction =
  | "accept"
  | "reject"
  | "terminate"
  | "join_media"
  | "toggle_mute"
  | "leave_media";

type MediaUiState =
  | "idle"
  | "connecting"
  | "connected"
  | "muted"
  | "reconnecting"
  | "playback_blocked"
  | "disconnected"
  | "error";

const LIVE_STATES = new Set([
  "incoming",
  "ringing",
  "pre_accepted",
  "accepted",
  "active",
]);

function timestampMs(value: unknown): number {
  if (!value) return 0;
  const time = new Date(value as string | Date).getTime();
  return Number.isFinite(time) ? time : 0;
}

function pickDisplaySession(
  sessions: WhatsAppCallSessionPreview[] | null | undefined
): WhatsAppCallSessionPreview | null {
  const valid = (sessions || []).filter(session => session?._id);
  if (valid.length === 0) return null;

  return [...valid].sort((left, right) => {
    const leftLive = LIVE_STATES.has(left.state) ? 1 : 0;
    const rightLive = LIVE_STATES.has(right.state) ? 1 : 0;
    if (leftLive !== rightLive) return rightLive - leftLive;
    return (
      timestampMs(right.lastProviderUpdateAt || right.updatedAt) -
      timestampMs(left.lastProviderUpdateAt || left.updatedAt)
    );
  })[0];
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function getCallTitleKey(state: string): string {
  switch (state) {
    case "incoming":
      return "callIncomingTitle";
    case "ringing":
      return "callRingingTitle";
    case "pre_accepted":
    case "accepted":
    case "active":
      return "callActiveTitle";
    case "terminated":
      return "callEndedTitle";
    case "missed":
      return "callMissedTitle";
    case "failed":
      return "callFailedTitle";
    default:
      return "callUnknownTitle";
  }
}

function getProviderErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error.trim() || null;
  if (typeof error !== "object" || Array.isArray(error)) return null;

  const record = error as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }

  const nestedError = record.error;
  if (
    nestedError &&
    typeof nestedError === "object" &&
    !Array.isArray(nestedError)
  ) {
    const nestedMessage = (nestedError as Record<string, unknown>).message;
    if (typeof nestedMessage === "string" && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
  }

  return null;
}

function isMediaJoinableState(state: string): boolean {
  return state === "pre_accepted" || state === "accepted" || state === "active";
}

export function WhatsAppCallBanner({
  callSessions,
  onCallCommand,
  onCallMediaJoin,
}: WhatsAppCallBannerProps) {
  const t = useTranslations("ConversationDetailView");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null
  );
  const [mediaState, setMediaState] = useState<MediaUiState>("idle");
  const [mediaErrorText, setMediaErrorText] = useState<string | null>(null);
  const [isMicrophoneMuted, setIsMicrophoneMuted] = useState(false);
  const audioHostRef = useRef<HTMLDivElement | null>(null);
  const mediaConnectionRef = useRef<WhatsAppCallMediaConnection | null>(null);
  const mediaSessionIdRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  const session = pickDisplaySession(callSessions);

  const disconnectMedia = useCallback(
    async (options?: { resetUi?: boolean; nextState?: MediaUiState }) => {
      const connection = mediaConnectionRef.current;
      mediaConnectionRef.current = null;
      mediaSessionIdRef.current = null;
      mutedRef.current = false;
      if (options?.resetUi !== false) {
        setIsMicrophoneMuted(false);
        setMediaErrorText(null);
        setMediaState(options?.nextState || "idle");
      }
      await connection?.disconnect();
    },
    []
  );

  const handleMediaConnectionStateChange = useCallback(
    (
      state: "connected" | "reconnecting" | "playback_blocked" | "disconnected"
    ) => {
      if (state === "disconnected") {
        mediaConnectionRef.current = null;
        mediaSessionIdRef.current = null;
        mutedRef.current = false;
        setIsMicrophoneMuted(false);
        setMediaState("disconnected");
        return;
      }
      if (state === "connected") {
        setMediaState(mutedRef.current ? "muted" : "connected");
        return;
      }
      setMediaState(state);
    },
    []
  );

  const handleMicrophoneMutedChange = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    setIsMicrophoneMuted(muted);
    setMediaState(current =>
      current === "connected" || current === "muted"
        ? muted
          ? "muted"
          : "connected"
        : current
    );
  }, []);

  const sessionId = session?._id || null;
  const sessionCanUseMedia = session
    ? isMediaJoinableState(session.state)
    : false;

  useEffect(() => {
    if (!mediaSessionIdRef.current) return;
    if (!sessionCanUseMedia || mediaSessionIdRef.current !== sessionId) {
      void disconnectMedia({ nextState: "idle" });
    }
  }, [disconnectMedia, sessionCanUseMedia, sessionId]);

  useEffect(() => {
    return () => {
      void disconnectMedia({ resetUi: false });
    };
  }, [disconnectMedia]);

  if (!session) return null;

  const isIncoming =
    session.state === "incoming" || session.state === "ringing";
  const isActive = isMediaJoinableState(session.state);
  const isFailed = session.state === "failed";
  const duration = formatDuration(session.durationSeconds);
  const commandStatus = session.latestCommand?.status || null;
  const hasPendingProviderCommand = commandStatus === "pending";
  const failedCommandMessage =
    commandStatus === "failed"
      ? getProviderErrorMessage(session.latestCommand?.providerError)
      : null;
  const statusText = hasPendingProviderCommand
    ? t("callCommandPendingLabel")
    : commandStatus === "failed"
      ? failedCommandMessage || t("callCommandFailedStatus")
      : isFailed && session.errorMessage
        ? session.errorMessage
        : duration
          ? t("callDurationLabel", { duration })
          : t("callLatestStatusLabel");
  const contactLabel =
    session.contactName || session.contactUsername || t("callUnknownContact");
  const Icon = isFailed ? PhoneOff : isIncoming ? PhoneIncoming : PhoneCall;
  const controlsDisabled = pendingAction !== null || hasPendingProviderCommand;
  const mediaControlsDisabled =
    pendingAction !== null || hasPendingProviderCommand;
  const mediaConnected =
    mediaState === "connected" ||
    mediaState === "muted" ||
    mediaState === "reconnecting" ||
    mediaState === "playback_blocked";
  const mediaStatusText =
    mediaState === "connecting"
      ? t("callMediaConnecting")
      : mediaState === "connected"
        ? t("callMediaConnected")
        : mediaState === "muted"
          ? t("callMediaMuted")
          : mediaState === "reconnecting"
            ? t("callMediaReconnecting")
            : mediaState === "playback_blocked"
              ? t("callMediaPlaybackBlocked")
              : mediaState === "disconnected"
                ? t("callMediaDisconnected")
                : mediaState === "error"
                  ? mediaErrorText || t("callMediaJoinFailed")
                  : null;
  const getJoinFailureText = (
    result: Extract<WhatsAppCallMediaJoinResult, { ok: false }>
  ): string => {
    if (result.reason === "permission_denied") {
      return t("callMediaPermissionDenied");
    }
    if (result.error === "microphone_not_found") {
      return t("callMediaMicrophoneNotFound");
    }
    if (result.error === "microphone_unavailable") {
      return t("callMediaMicrophoneUnavailable");
    }
    if (result.reason === "client_unavailable") {
      return t("callMediaClientUnavailable");
    }
    return result.error || t("callMediaJoinFailed");
  };
  const runCommand = async (action: "accept" | "reject" | "terminate") => {
    setPendingAction(action);
    try {
      if (action === "terminate") {
        await disconnectMedia({ nextState: "disconnected" });
      }
      await onCallCommand(session, action);
    } finally {
      setPendingAction(null);
    }
  };
  const runMediaJoin = async () => {
    if (mediaConnectionRef.current) return;
    setPendingAction("join_media");
    setMediaErrorText(null);
    setMediaState("connecting");
    try {
      const result = await onCallMediaJoin(session, {
        audioElementHost: audioHostRef.current,
        onConnectionStateChange: handleMediaConnectionStateChange,
        onMicrophoneMutedChange: handleMicrophoneMutedChange,
      });
      if (result.ok) {
        mediaConnectionRef.current = result.connection;
        mediaSessionIdRef.current = session._id;
        const muted = result.connection.isMicrophoneMuted();
        mutedRef.current = muted;
        setIsMicrophoneMuted(muted);
        setMediaState(current =>
          current === "playback_blocked"
            ? current
            : muted
              ? "muted"
              : "connected"
        );
      } else {
        setMediaErrorText(getJoinFailureText(result));
        setMediaState("error");
      }
    } finally {
      setPendingAction(null);
    }
  };
  const runMediaMuteToggle = async () => {
    const connection = mediaConnectionRef.current;
    if (!connection) return;
    const nextMuted = !mutedRef.current;
    setPendingAction("toggle_mute");
    try {
      await connection.setMicrophoneMuted(nextMuted);
      mutedRef.current = nextMuted;
      setIsMicrophoneMuted(nextMuted);
      setMediaState(nextMuted ? "muted" : "connected");
    } catch {
      setMediaErrorText(t("callMediaJoinFailed"));
      setMediaState("error");
    } finally {
      setPendingAction(null);
    }
  };
  const runMediaLeave = async () => {
    setPendingAction("leave_media");
    try {
      await disconnectMedia({ nextState: "disconnected" });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <section
      className={cn(
        "mx-1 rounded-md border px-3 py-2.5 shadow-sm",
        isFailed
          ? "border-destructive/25 bg-destructive/5"
          : isIncoming || isActive
            ? "border-emerald-500/25 bg-emerald-500/5"
            : "border-border bg-muted/30"
      )}
      aria-label={t("callBannerAria")}
    >
      <div ref={audioHostRef} className="sr-only" aria-hidden="true" />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm font-medium leading-tight">
                {t(getCallTitleKey(session.state))}
              </p>
              <span className="rounded-full bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {contactLabel}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{statusText}</p>
            {mediaStatusText ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {mediaStatusText}
              </p>
            ) : null}
          </div>
        </div>

        {isIncoming ? (
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              disabled={controlsDisabled}
              aria-label={t("callAcceptAction")}
              onClick={() => void runCommand("accept")}
            >
              {t("callAcceptAction")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={controlsDisabled}
              aria-label={t("callRejectAction")}
              onClick={() => void runCommand("reject")}
            >
              {t("callRejectAction")}
            </Button>
          </div>
        ) : isActive ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {mediaConnected ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={mediaControlsDisabled}
                  aria-label={t(
                    isMicrophoneMuted ? "callUnmuteAction" : "callMuteAction"
                  )}
                  onClick={() => void runMediaMuteToggle()}
                >
                  {isMicrophoneMuted ? (
                    <Mic className="mr-1.5 h-3.5 w-3.5" />
                  ) : (
                    <MicOff className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t(isMicrophoneMuted ? "callUnmuteAction" : "callMuteAction")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={mediaControlsDisabled}
                  aria-label={t("callLeaveMediaAction")}
                  onClick={() => void runMediaLeave()}
                >
                  <PhoneOff className="mr-1.5 h-3.5 w-3.5" />
                  {t("callLeaveMediaAction")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={mediaControlsDisabled || mediaState === "connecting"}
                aria-label={t("callJoinMediaAction")}
                onClick={() => void runMediaJoin()}
              >
                <Mic className="mr-1.5 h-3.5 w-3.5" />
                {t("callJoinMediaAction")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={controlsDisabled}
              aria-label={t("callTerminateAction")}
              onClick={() => void runCommand("terminate")}
            >
              {t("callTerminateAction")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
