"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AttachmentUploadBatchError } from "@/lib/conversation/attachment-upload";
import {
  getConversationAttachmentAccept,
  partitionConversationAttachmentFiles,
  supportsConversationAttachments,
} from "@/lib/conversation-attachments";
import { resolveTelegramSenderDisplayName } from "@/lib/telegram/message-identity";
import { cn } from "@/lib/utils";
import {
  isMediaMimeType,
  isPdfMedia,
  normalizeMediaMimeType,
} from "@/lib/whatsapp/media-types";
import type { PopulatedMessage } from "@/types/models";
import type { OutboundAttachment } from "@/types/outbound-attachment";
import { buildWhatsAppReplyTextPreview } from "@icecore/shared/lib/whatsapp/message-id";
import {
  FileText,
  Loader2,
  Mic,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import type { ClipboardEvent } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  Control,
  SubmitHandler,
  UseFormHandleSubmit,
  UseFormRegister,
} from "react-hook-form";
import { useWatch } from "react-hook-form";

type ReplyFormValues = { reply: string };
type PendingAttachment = {
  id: string;
  fileName: string;
};
type AttachmentPreviewKind = "image" | "video" | "pdf" | "file";

const PASTED_IMAGE_OPTIMIZATION_MIN_BYTES = 600_000;
const PASTED_IMAGE_MAX_EDGE = 1600;
const PASTED_IMAGE_JPEG_QUALITY = 0.82;

const RECORDER_MIME_CANDIDATES = [
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/webm;codecs=opus",
  "audio/webm",
];

// Instagram only accepts AAC/M4A/WAV/MP4 audio, so Ogg and WebM voice notes
// recorded by Chrome and Firefox would be rejected by Meta.
const INSTAGRAM_RECORDER_MIME_CANDIDATES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/aac",
];

function getRecorderMimeType(channel?: string): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates =
    channel === "instagram"
      ? INSTAGRAM_RECORDER_MIME_CANDIDATES
      : RECORDER_MIME_CANDIDATES;
  return candidates.find(type => MediaRecorder.isTypeSupported(type));
}

const subscribeToRecorderSupport = () => () => {};
const canRecordInstagramVoice = () => Boolean(getRecorderMimeType("instagram"));
const canRecordOnServer = () => false;

function getFileExtension(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

function getAttachmentLabel(attachment: OutboundAttachment): string {
  const fileName = attachment.fileName?.trim();
  return fileName || `${attachment.mediaType} attachment`;
}

function getAttachmentPreviewKind(
  attachment: OutboundAttachment
): AttachmentPreviewKind {
  if (!attachment.url) return "file";

  const fileName = attachment.fileName?.trim().toLowerCase() || "";

  if (
    attachment.mediaType === "image" ||
    isMediaMimeType(attachment.mimeType, "image")
  ) {
    return "image";
  }
  if (
    attachment.mediaType === "video" ||
    isMediaMimeType(attachment.mimeType, "video")
  ) {
    return "video";
  }
  if (
    attachment.mediaType === "document" &&
    isPdfMedia({ mimeType: attachment.mimeType, fileName })
  ) {
    return "pdf";
  }

  return "file";
}

function formatRecordingTime(durationMs: number): string {
  const safe = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(safe / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (safe % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function resizeReplyTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  if (!element.value) {
    element.style.height = "";
    return;
  }
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function isImageFile(file: File | null | undefined): file is File {
  return Boolean(file && isMediaMimeType(file.type, "image"));
}

function getImageExtension(mimeType: string): string {
  const normalized = normalizeMediaMimeType(mimeType);
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/webp") return "webp";
  return "png";
}

function ensurePastedImageFile(file: File, index: number): File {
  if (file.name.trim()) return file;
  const type = file.type || "image/png";
  const extension = getImageExtension(type);
  return new File([file], `pasted-image-${Date.now()}-${index}.${extension}`, {
    type,
    lastModified: file.lastModified || Date.now(),
  });
}

function getPastedImageFiles(clipboardData: DataTransfer): File[] {
  const itemFiles = Array.from(clipboardData.items || [])
    .filter(item => item.kind === "file" && isMediaMimeType(item.type, "image"))
    .map(item => item.getAsFile())
    .filter(isImageFile);

  const files =
    itemFiles.length > 0
      ? itemFiles
      : Array.from(clipboardData.files || []).filter(isImageFile);

  return files.map((file, index) => ensurePastedImageFile(file, index));
}

function getOptimizedImageFileName(fileName: string): string {
  const trimmedName = fileName.trim();
  if (!trimmedName) return `pasted-image-${Date.now()}.jpg`;
  return trimmedName.replace(/\.[^.]+$/, "") + ".jpg";
}

function shouldOptimizePastedImage(file: File): boolean {
  const mimeType = normalizeMediaMimeType(file.type);
  return (
    file.size >= PASTED_IMAGE_OPTIMIZATION_MIN_BYTES &&
    (mimeType === "image/png" ||
      mimeType === "image/jpeg" ||
      mimeType === "image/jpg")
  );
}

async function optimizePastedImageFile(file: File): Promise<File> {
  if (
    !shouldOptimizePastedImage(file) ||
    typeof createImageBitmap === "undefined" ||
    typeof document === "undefined"
  ) {
    return file;
  }

  try {
    const image = await createImageBitmap(file);
    const scale = Math.min(
      1,
      PASTED_IMAGE_MAX_EDGE / Math.max(image.width, image.height)
    );
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      image.close?.();
      return file;
    }

    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    image.close?.();

    const optimizedBlob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, "image/jpeg", PASTED_IMAGE_JPEG_QUALITY);
    });

    if (!optimizedBlob || optimizedBlob.size >= file.size) {
      return file;
    }

    return new File([optimizedBlob], getOptimizedImageFileName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified || Date.now(),
    });
  } catch {
    return file;
  }
}

export function ReplyForm({
  onSubmitReply,
  control,
  handleSubmit,
  register,
  isSubmitting,
  disabled,
  channel,
  attachments,
  onAddAttachments,
  onRemoveAttachment,
  isUploadingAttachments,
  textareaRef,
  onTextChange,
  replyingToMessage,
  onClearReplyTo,
  isInstagramCommentThread,
  instagramReplyMode = "comment",
  onInstagramReplyModeChange,
}: {
  onSubmitReply: SubmitHandler<ReplyFormValues>;
  control: Control<ReplyFormValues>;
  handleSubmit: UseFormHandleSubmit<ReplyFormValues>;
  register: UseFormRegister<ReplyFormValues>;
  isSubmitting: boolean;
  disabled?: boolean;
  channel?: string;
  attachments: OutboundAttachment[];
  onAddAttachments: (
    files: File[],
    options?: { isRetry?: boolean }
  ) => void | Promise<void>;
  onRemoveAttachment: (index: number) => void;
  isUploadingAttachments?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onTextChange?: () => void;
  replyingToMessage?: PopulatedMessage | null;
  onClearReplyTo?: () => void;
  isInstagramCommentThread?: boolean;
  instagramReplyMode?: "comment" | "private";
  onInstagramReplyModeChange?: (mode: "comment" | "private") => void;
}) {
  const t = useTranslations("ConversationDetailView");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const replyField = register("reply");
  const replyFormText = useWatch({
    control,
    name: "reply",
  });
  const supportsAttachments = supportsConversationAttachments({
    channel,
    isInstagramCommentThread,
  });
  const attachmentAccept = getConversationAttachmentAccept({
    channel,
    isInstagramCommentThread,
  });
  const instagramVoiceSupported = useSyncExternalStore(
    subscribeToRecorderSupport,
    canRecordInstagramVoice,
    canRecordOnServer
  );
  const supportsVoiceRecording =
    supportsAttachments && (channel !== "instagram" || instagramVoiceSupported);
  const replyTargetName = replyingToMessage
    ? resolveTelegramSenderDisplayName({
        author: replyingToMessage.author,
        telegramMeta: replyingToMessage.telegramMeta,
        fallback: t("unnamedCustomer"),
      })
    : t("unnamedCustomer");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [isProcessingRecording, setIsProcessingRecording] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  // Files kept from a failed batch so the retry button can resend them without
  // asking the operator to reselect. Null means the error is not retryable.
  const [failedAttachmentFiles, setFailedAttachmentFiles] = useState<
    File[] | null
  >(null);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number>(0);
  const recordingGenerationRef = useRef(0);
  const discardNextRecordingRef = useRef(false);
  const pendingAttachmentIdRef = useRef(0);
  // Pasted, picked and retried files each hold a pending row until settled.
  const isAttachmentBusy =
    Boolean(isUploadingAttachments) || pendingAttachments.length > 0;
  const isComposerLocked = isSubmitting || Boolean(disabled);
  const isComposerBusy = isComposerLocked || isAttachmentBusy;

  const clearAttachmentError = () => {
    setRecordingError(null);
    setFailedAttachmentFiles(null);
  };
  const applyAttachmentError = (error: unknown, fallbackMessage: string) => {
    setRecordingError(error instanceof Error ? error.message : fallbackMessage);
    // Only a batched upload failure keeps its files, so only it is retryable.
    setFailedAttachmentFiles(
      error instanceof AttachmentUploadBatchError ? error.failedFiles : null
    );
  };
  const hasContent =
    Boolean(replyFormText?.trim()) ||
    attachments.length > 0 ||
    pendingAttachments.length > 0;

  useEffect(() => {
    return () => {
      recordingGenerationRef.current += 1;
      // stop() queues onstop; leaving a chat must discard that recording.
      discardNextRecordingRef.current = true;
      if (recordingTimerRef.current) {
        window.clearInterval(recordingTimerRef.current);
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
      mediaStreamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  useEffect(() => {
    resizeReplyTextarea(internalTextareaRef.current);
  }, [replyFormText]);

  const stopRecordingTicker = () => {
    if (!recordingTimerRef.current) return;
    window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
  };

  const startRecordingTicker = () => {
    stopRecordingTicker();
    recordingStartedAtRef.current = Date.now();
    setRecordingMs(0);
    recordingTimerRef.current = window.setInterval(() => {
      setRecordingMs(Date.now() - recordingStartedAtRef.current);
    }, 200);
  };

  const finalizeRecording = () => {
    stopRecordingTicker();
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    setIsRecording(false);
  };

  const startRecording = async () => {
    if (isRecording) return;
    if (!supportsVoiceRecording) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setRecordingError("Audio recording is not supported in this browser.");
      return;
    }

    const recordingGeneration = recordingGenerationRef.current;
    try {
      setRecordingError(null);
      discardNextRecordingRef.current = false;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (recordingGenerationRef.current !== recordingGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      mediaStreamRef.current = stream;

      const mimeType = getRecorderMimeType(channel);
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];

      recorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setRecordingError("Unable to record audio.");
        finalizeRecording();
      };

      recorder.onstop = async () => {
        const discarded = discardNextRecordingRef.current;
        discardNextRecordingRef.current = false;

        const duration = Date.now() - recordingStartedAtRef.current;
        const chunks = recordingChunksRef.current;
        recordingChunksRef.current = [];

        finalizeRecording();

        if (discarded || chunks.length === 0) {
          setRecordingMs(0);
          return;
        }

        const normalizedChunkType = normalizeMediaMimeType(chunks[0]?.type);
        const normalizedRecorderType = normalizeMediaMimeType(mimeType);
        const resolvedMimeType =
          normalizedChunkType || normalizedRecorderType || "audio/webm";
        const blob = new Blob(chunks, { type: resolvedMimeType });
        const extension = getFileExtension(resolvedMimeType);
        const fileName = `voice-${Date.now()}.${extension}`;
        const file = new File([blob], fileName, { type: resolvedMimeType });

        setIsProcessingRecording(true);
        try {
          await onAddAttachments([file]);
          clearAttachmentError();
        } catch (error) {
          applyAttachmentError(error, "Failed to attach recorded audio.");
        } finally {
          setIsProcessingRecording(false);
          setRecordingMs(Math.max(duration, 0));
        }
      };

      recorder.start(200);
      startRecordingTicker();
      setIsRecording(true);
    } catch (error) {
      if (recordingGenerationRef.current !== recordingGeneration) return;
      setRecordingError(
        error instanceof Error
          ? error.message
          : "Microphone permission denied or unavailable."
      );
      finalizeRecording();
    }
  };

  const stopRecording = (discard = false) => {
    if (!mediaRecorderRef.current) return;
    discardNextRecordingRef.current = discard;
    if (mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  };

  const createPendingAttachmentRows = (
    files: File[],
    prefix: string,
    fallbackFileName = "Attachment"
  ) =>
    files.map(file => {
      pendingAttachmentIdRef.current += 1;
      return {
        id: `${prefix}-${Date.now()}-${pendingAttachmentIdRef.current}`,
        fileName: file.name || fallbackFileName,
      };
    });

  const addAttachmentFilesWithPendingState = async (
    files: File[],
    options?: {
      input?: HTMLInputElement | null;
      prefix?: string;
      isRetry?: boolean;
    }
  ) => {
    if (files.length === 0) return;

    // Retry files were already accepted once, so skip re-partitioning them.
    const { accepted, rejected } = options?.isRetry
      ? { accepted: files, rejected: [] as string[] }
      : partitionConversationAttachmentFiles({
          channel,
          files,
          isInstagramCommentThread,
        });
    if (rejected.length > 0) {
      // A validation rejection is not fixable by resending, so drop any pending
      // retry files and show the rejection reason on its own.
      setRecordingError(rejected.join("\n"));
      setFailedAttachmentFiles(null);
    }
    if (accepted.length === 0) {
      if (options?.input) {
        options.input.value = "";
      }
      return;
    }

    const pending = createPendingAttachmentRows(
      accepted,
      options?.prefix || "selected"
    );
    setPendingAttachments(previous => [...previous, ...pending]);

    try {
      await (options?.isRetry
        ? onAddAttachments(accepted, { isRetry: true })
        : onAddAttachments(accepted));
      if (rejected.length === 0) {
        clearAttachmentError();
      }
    } catch (error) {
      applyAttachmentError(error, "Failed to attach file.");
    } finally {
      const pendingIds = new Set(pending.map(attachment => attachment.id));
      setPendingAttachments(previous =>
        previous.filter(attachment => !pendingIds.has(attachment.id))
      );
      if (options?.input) {
        options.input.value = "";
      }
    }
  };

  const handleRetryFailedAttachments = () => {
    if (!failedAttachmentFiles || failedAttachmentFiles.length === 0) return;
    return addAttachmentFilesWithPendingState(failedAttachmentFiles, {
      prefix: "retry",
      isRetry: true,
    });
  };

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!supportsAttachments || isComposerBusy) {
      return;
    }

    const imageFiles = getPastedImageFiles(event.clipboardData);
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    const pending = createPendingAttachmentRows(
      imageFiles,
      "pasted",
      "Pasted image"
    );

    setPendingAttachments(previous => [...previous, ...pending]);
    try {
      const uploadFiles = await Promise.all(
        imageFiles.map(file => optimizePastedImageFile(file))
      );
      await onAddAttachments(uploadFiles);
      clearAttachmentError();
    } catch (error) {
      applyAttachmentError(error, "Failed to attach pasted image.");
    } finally {
      const pendingIds = new Set(pending.map(attachment => attachment.id));
      setPendingAttachments(previous =>
        previous.filter(attachment => !pendingIds.has(attachment.id))
      );
    }
  };

  const showRecordingRow = isRecording || isProcessingRecording;
  const showAttachmentRow =
    attachments.length > 0 || pendingAttachments.length > 0;

  return (
    <form onSubmit={handleSubmit(onSubmitReply)} className="mb-0 min-w-0">
      <div
        data-testid="reply-composer"
        className="overflow-hidden rounded-2xl bg-muted/30 shadow-sm transition-colors focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/50"
      >
        {isInstagramCommentThread && (
          <div className="flex items-center gap-1 border-b border-border/60 px-2.5 py-2">
            {(["comment", "private"] as const).map(mode => (
              <button
                key={mode}
                type="button"
                disabled={isComposerLocked}
                onClick={() => onInstagramReplyModeChange?.(mode)}
                className={cn(
                  "min-h-11 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50 md:min-h-7",
                  instagramReplyMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
                )}
              >
                {mode === "comment"
                  ? t("instagramPublicReply")
                  : t("instagramPrivateReply")}
              </button>
            ))}
          </div>
        )}

        {showAttachmentRow && (
          <div className="flex flex-wrap items-start gap-2 border-b border-border/60 px-2.5 py-2">
            {attachments.map((attachment, index) => {
              const label = getAttachmentLabel(attachment);
              const previewKind = getAttachmentPreviewKind(attachment);
              // The stored url is private; the composer shows the local file.
              const previewSrc = attachment.previewUrl || attachment.url;

              return (
                <div
                  key={`${
                    attachment.url ||
                    attachment.whatsappMediaId ||
                    attachment.fileName ||
                    "attachment"
                  }-${index}`}
                  className="group relative w-28 min-w-0 overflow-hidden rounded-xl bg-background/85 shadow-sm ring-1 ring-border/60"
                >
                  <div className="flex h-20 w-full items-center justify-center overflow-hidden bg-muted/60">
                    {previewKind === "image" && previewSrc ? (
                      <Image
                        src={previewSrc}
                        alt={label}
                        width={112}
                        height={80}
                        unoptimized
                        className="h-full w-full object-cover"
                      />
                    ) : previewKind === "video" && previewSrc ? (
                      <video
                        src={previewSrc}
                        className="h-full w-full object-cover"
                        preload="metadata"
                        muted
                        playsInline
                        aria-label={`Video preview: ${label}`}
                      />
                    ) : previewKind === "pdf" && previewSrc ? (
                      <iframe
                        src={previewSrc}
                        title={`PDF preview: ${label}`}
                        className="pointer-events-none h-full w-full bg-white"
                        tabIndex={-1}
                      />
                    ) : (
                      <FileText className="h-7 w-7 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex min-w-0 items-center gap-1 px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {label}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(index)}
                    disabled={isComposerLocked}
                    className="absolute right-1 top-1 grid size-8 place-items-center rounded-full bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground disabled:opacity-50"
                    aria-label="Remove attachment"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            {pendingAttachments.map(attachment => (
              <div
                key={attachment.id}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-xs text-muted-foreground"
              >
                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                <span className="max-w-[180px] truncate">
                  {attachment.fileName}
                </span>
                <span className="shrink-0">Uploading...</span>
              </div>
            ))}
          </div>
        )}

        {replyingToMessage && onClearReplyTo && (
          <div className="mx-2.5 mt-2 flex items-center justify-between rounded-xl border border-border/70 border-l-primary/70 bg-background/80 px-3 py-2 text-xs">
            <div className="flex min-w-0 flex-col">
              <span className="mb-0.5 font-semibold text-muted-foreground">
                Replying to {replyTargetName}
              </span>
              <span className="truncate text-foreground/80">
                {buildWhatsAppReplyTextPreview(replyingToMessage) ?? "Message"}
              </span>
            </div>
            <button
              type="button"
              onClick={onClearReplyTo}
              className="ml-2 grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear reply target"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="relative flex items-end gap-0.5 p-1 md:gap-1.5 md:p-2">
          {supportsAttachments && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                accept={attachmentAccept}
                onChange={event => {
                  const fileList = event.target.files;
                  if (!fileList || fileList.length === 0) return;
                  void addAttachmentFilesWithPendingState(
                    Array.from(fileList),
                    { input: event.currentTarget }
                  );
                }}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={isComposerBusy}
                onClick={() => fileInputRef.current?.click()}
                className="size-[44px] shrink-0 rounded-full md:size-9"
                aria-label="Attach files"
              >
                {isAttachmentBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </Button>
            </>
          )}

          <div className="relative min-w-0 flex-1">
            <Textarea
              placeholder={t("enterYourReply")}
              aria-label={t("enterYourReply")}
              disabled={isComposerLocked}
              rows={1}
              {...replyField}
              onChange={e => {
                replyField.onChange(e);
                resizeReplyTextarea(e.currentTarget);
                onTextChange?.();
              }}
              className="field-sizing-fixed min-h-11 max-h-[min(140px,30dvh)] resize-none border-0 bg-transparent px-1 py-2.5 text-base leading-6 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 md:min-h-9 md:px-2 md:py-2 md:text-sm md:leading-5"
              onKeyDown={e => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              onPaste={event => void handlePaste(event)}
              ref={el => {
                internalTextareaRef.current = el;
                if (textareaRef) textareaRef.current = el;
                replyField.ref(el);
                resizeReplyTextarea(el);
              }}
            />
          </div>

          {supportsVoiceRecording &&
            !hasContent &&
            !isRecording &&
            !isProcessingRecording && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => void startRecording()}
                disabled={isComposerBusy}
                className="size-[44px] shrink-0 rounded-full md:size-9"
                aria-label="Record voice message"
              >
                <Mic className="h-4 w-4" />
              </Button>
            )}

          {hasContent && (
            <Button
              type="submit"
              size="icon"
              disabled={isComposerBusy}
              className="size-[44px] shrink-0 rounded-full shadow-sm transition-all active:scale-90 md:size-9"
            >
              {isSubmitting || isAttachmentBusy ? (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Send size={14} />
              )}
              <span className="sr-only">{t("send")}</span>
            </Button>
          )}
        </div>

        {showRecordingRow && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-2 py-1.5">
            {isRecording ? (
              <>
                <span className="mr-auto min-w-12 text-xs tabular-nums text-muted-foreground">
                  {formatRecordingTime(recordingMs)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => stopRecording(true)}
                  disabled={isComposerBusy || isProcessingRecording}
                  className="h-11 px-3 md:h-8 md:px-2"
                >
                  Discard
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => stopRecording(false)}
                  disabled={isComposerBusy || isProcessingRecording}
                  className="h-11 px-3 md:h-8 md:px-2"
                >
                  <Square className="mr-1 h-3.5 w-3.5" />
                  Stop
                </Button>
              </>
            ) : (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving...
              </span>
            )}
          </div>
        )}

        {recordingError && (
          <div className="flex items-start justify-between gap-2 px-2 pb-2">
            <p className="whitespace-pre-line text-xs text-destructive">
              {recordingError}
            </p>
            {failedAttachmentFiles && failedAttachmentFiles.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleRetryFailedAttachments()}
                disabled={isSubmitting || isAttachmentBusy}
                className="h-7 shrink-0 px-2 text-xs"
              >
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
