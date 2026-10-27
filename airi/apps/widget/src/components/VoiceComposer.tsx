import { Circle, Square } from "lucide-react";
import { useEffect, useRef, useState } from "preact/hooks";

import { AttachIcon, SendUpArrowIcon } from "../assets/icons";
import { getMobileFileAccept, shouldUseCapture } from "../lib/mobile";
import { cn } from "../lib/utils";
import { MicSelector } from "./ui/mic-selector";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const VALID_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];
const RECORDER_MIME_CANDIDATES = [
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/webm;codecs=opus",
  "audio/webm",
];

export interface VoiceClipPayload {
  file: File;
  durationMs: number;
  deviceId?: string;
  mimeType: string;
}

interface VoiceComposerProps {
  onSend?: (
    message: string,
    imageFile?: File,
    voiceClip?: VoiceClipPayload,
  ) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function getRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return RECORDER_MIME_CANDIDATES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

function getFileExtension(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

function normalizeMimeType(mimeType: string | undefined | null): string {
  if (!mimeType) return "";
  return mimeType.split(";")[0]?.trim().toLowerCase() || "";
}

function formatRecordingTime(durationMs: number): string {
  const safe = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(safe / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (safe % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export const VoiceComposer = ({
  onSend,
  placeholder = "Your message...",
  disabled = false,
  className,
}: VoiceComposerProps) => {
  const [message, setMessage] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [selectedMicId, setSelectedMicId] = useState<string>("");
  const [isMicMuted, setIsMicMuted] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number>(0);
  const discardNextRecordingRef = useRef(false);
  const isMountedRef = useRef(true);
  const recordingRequestIdRef = useRef(0);
  const isStartingRecordingRef = useRef(false);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const nextHeight = Math.min(textareaRef.current.scrollHeight, 120);
      textareaRef.current.style.height = `${nextHeight}px`;
      textareaRef.current.style.overflowY = "hidden";
    }
  }, [message]);

  useEffect(() => {
    if (!errorText) return;
    const timer = window.setTimeout(() => setErrorText(null), 4500);
    return () => window.clearTimeout(timer);
  }, [errorText]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      recordingRequestIdRef.current += 1;
      isStartingRecordingRef.current = false;
      discardNextRecordingRef.current = true;
      finalizeRecording();
    };
  }, []);

  const processImageFile = (file: File) => {
    setErrorText(null);

    if (!VALID_IMAGE_TYPES.includes(file.type)) {
      setErrorText("Please upload JPG, PNG, GIF, or WebP.");
      return;
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      setErrorText("Image is too large. Max size is 5MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      setImagePreview(event.target?.result as string);
    };
    reader.readAsDataURL(file);
    setImageFile(file);
  };

  const handleFileSelect = (event: Event) => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) processImageFile(file);
    target.value = "";
  };

  const clearImage = () => {
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSendText = () => {
    if (!onSend) return;
    if (!message.trim() && !imageFile) return;
    onSend(message.trim(), imageFile ?? undefined);
    setMessage("");
    setImageFile(null);
    setImagePreview(null);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSendText();
    }
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) processImageFile(file);
  };

  const handlePaste = (event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let index = 0; index < items.length; index += 1) {
      if (!items[index].type.includes("image")) continue;
      event.preventDefault();
      const file = items[index].getAsFile();
      if (file) processImageFile(file);
      break;
    }
  };

  const startRecordingTicker = () => {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
    }
    recordingStartedAtRef.current = Date.now();
    setRecordingMs(0);
    recordingTimerRef.current = window.setInterval(() => {
      setRecordingMs(Date.now() - recordingStartedAtRef.current);
    }, 200);
  };

  const stopRecordingTicker = () => {
    if (!recordingTimerRef.current) return;
    window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
  };

  const finalizeRecording = () => {
    stopRecordingTicker();
    const recorder = mediaRecorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    if (isMountedRef.current) setIsRecording(false);
  };

  const startRecording = async () => {
    if (
      disabled ||
      isRecording ||
      isStartingRecordingRef.current ||
      mediaRecorderRef.current ||
      !isMountedRef.current
    )
      return;
    if (isMicMuted) {
      setErrorText("Microphone is muted. Unmute before recording.");
      return;
    }
    if (!onSend) {
      setErrorText("Voice sending is not configured.");
      return;
    }

    const requestId = ++recordingRequestIdRef.current;
    isStartingRecordingRef.current = true;
    setIsStartingRecording(true);
    try {
      setErrorText(null);
      discardNextRecordingRef.current = false;

      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(selectedMicId ? { deviceId: { exact: selectedMicId } } : {}),
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });
      if (
        !isMountedRef.current ||
        requestId !== recordingRequestIdRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStreamRef.current = stream;

      const mimeType = getRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (mediaRecorderRef.current !== recorder) return;
        if (event.data && event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        if (mediaRecorderRef.current !== recorder || !isMountedRef.current)
          return;
        console.error("Voice recorder error:", event);
        setErrorText("Unable to record audio with the selected microphone.");
        discardNextRecordingRef.current = true;
        finalizeRecording();
      };

      recorder.onstop = () => {
        if (mediaRecorderRef.current !== recorder || !isMountedRef.current)
          return;
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

        const normalizedChunkType = normalizeMimeType(chunks[0]?.type);
        const normalizedRecorderType = normalizeMimeType(mimeType);
        const resolvedMimeType =
          normalizedChunkType || normalizedRecorderType || "audio/webm";
        const blob = new Blob(chunks, { type: resolvedMimeType });
        const extension = getFileExtension(resolvedMimeType);
        const fileName = `voice-${Date.now()}.${extension}`;
        const file = new File([blob], fileName, { type: resolvedMimeType });

        onSend("", undefined, {
          file,
          durationMs: Math.max(duration, 0),
          deviceId: selectedMicId || undefined,
          mimeType: resolvedMimeType,
        });
        setRecordingMs(0);
      };

      recorder.start(200);
      startRecordingTicker();
      setIsRecording(true);
    } catch (error) {
      if (!isMountedRef.current || requestId !== recordingRequestIdRef.current)
        return;
      console.error("Failed to start recording:", error);
      setErrorText(
        error instanceof Error
          ? error.message
          : "Microphone permission denied or unavailable.",
      );
      finalizeRecording();
    } finally {
      if (requestId === recordingRequestIdRef.current) {
        isStartingRecordingRef.current = false;
        if (isMountedRef.current) setIsStartingRecording(false);
      }
    }
  };

  const stopRecording = (discard = false) => {
    if (!mediaRecorderRef.current) return;
    discardNextRecordingRef.current = discard;
    if (mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  };

  const canSendText =
    (message.trim() || imageFile) &&
    !disabled &&
    !isRecording &&
    !isStartingRecording;

  return (
    <div
      className={cn(
        "chat-input-card",
        isDragging && "chat-input-card--dragging",
        "elv-conversation-bar",
        className,
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {errorText && (
        <div className="composer-error">
          <span>{errorText}</span>
          <button
            type="button"
            className="composer-error-dismiss"
            onClick={() => setErrorText(null)}
            aria-label="Dismiss"
          >
            x
          </button>
        </div>
      )}

      {imagePreview && (
        <div className="image-preview-container">
          <img src={imagePreview} alt="Preview" className="image-preview" />
          <button
            type="button"
            className="image-preview-remove"
            onClick={clearImage}
            aria-label="Remove image"
          >
            x
          </button>
        </div>
      )}

      {isRecording && (
        <div className="elv-recording-strip">
          <div className="elv-orb elv-orb--recording">
            <div className="elv-orb-ring elv-orb-ring--a" />
            <div className="elv-orb-ring elv-orb-ring--b" />
            <div className="elv-orb-core" />
          </div>
          <div className="elv-recording-meta">
            <span className="elv-recording-title">Recording</span>
            <span className="elv-recording-time">
              {formatRecordingTime(recordingMs)}
            </span>
          </div>
          <button
            type="button"
            className="elv-recording-btn"
            onClick={() => stopRecording(true)}
            disabled={disabled}
          >
            Discard
          </button>
          <button
            type="button"
            className="elv-recording-btn elv-recording-btn--primary"
            onClick={() => stopRecording(false)}
            disabled={disabled}
          >
            Stop & Send
          </button>
        </div>
      )}

      <div className="chat-input-inner">
        <div className="chat-input-field-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept={getMobileFileAccept()}
            capture={shouldUseCapture() ? "environment" : undefined}
            onChange={handleFileSelect}
            style={{ display: "none" }}
            aria-label="Upload image"
          />
          <textarea
            ref={textareaRef}
            className="chat-input-field"
            value={message}
            onInput={(event) =>
              setMessage((event.target as HTMLTextAreaElement).value)
            }
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            rows={1}
            disabled={disabled || isRecording || isStartingRecording}
            aria-label="Your message"
          />
        </div>

        <div className="chat-input-toolbar">
          <div className="chat-input-toolbar-icons">
            <button
              type="button"
              className="chat-input-toolbar-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || isRecording || isStartingRecording}
              aria-label="Attach"
              title="Attach image (5MB max)"
            >
              <AttachIcon />
            </button>
            <MicSelector
              value={selectedMicId}
              onValueChange={setSelectedMicId}
              muted={isMicMuted}
              onMutedChange={setIsMicMuted}
              disabled={disabled || isRecording || isStartingRecording}
              className="chat-input-mic-selector"
            />
            <button
              type="button"
              className={cn(
                "chat-input-toolbar-btn",
                isRecording && "chat-input-toolbar-btn--recording",
              )}
              disabled={disabled || isStartingRecording}
              onClick={() =>
                isRecording ? stopRecording(false) : startRecording()
              }
              aria-label={isRecording ? "Stop recording" : "Start recording"}
              title={isRecording ? "Stop recording" : "Start recording"}
            >
              {isRecording ? (
                <Square className="h-4 w-4" />
              ) : (
                <Circle className="h-4 w-4" />
              )}
            </button>
          </div>
          <button
            type="button"
            className="chat-input-send"
            onClick={handleSendText}
            disabled={!canSendText}
            aria-label="Send message"
            title="Send"
          >
            <SendUpArrowIcon />
          </button>
        </div>
      </div>

      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">Drop image here</div>
        </div>
      )}
    </div>
  );
};
