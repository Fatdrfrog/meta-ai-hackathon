"use client";

import type { ScenarioActionNodeEnrichment } from "../../../view/node-enrichment/types";
import {
  isScenarioRequestErrorWithCode,
  resolveScenarioRequestErrorMessage,
} from "../../../view/scenario-request-error-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  classifyWhatsAppUploadMedia,
  getWhatsAppOfficialMediaMaxBytes,
  isWhatsAppVoiceEligibleFile,
  WHATSAPP_OFFICIAL_MEDIA_ACCEPT,
  WHATSAPP_VOICE_NOTE_ACCEPT,
} from "@/lib/whatsapp/media-types";
import type { ScenarioActionAttachment } from "@icecore/scenario-contracts";
import { ImagePlus, Loader2, Mic, Music2, RefreshCw, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { ScenarioCollapsibleSection } from "../../../scenario-collapsible-section";
import { ScenarioInfoHint } from "../../../scenario-info-hint";
import { readScenarioMediaIdentity } from "../../media-display-url";
import { ServiceMessageAttachmentPreview } from "./service-message-attachment-preview";
import { WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS } from "./service-message-labels";

function mediaTypeLabelKey(
  mediaType: ScenarioActionAttachment["mediaType"] | undefined
): string {
  return mediaType &&
    mediaType in WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS
    ? WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS[
        mediaType as keyof typeof WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS
      ]
    : WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS.document;
}

/**
 * Shared media slot for standalone messages, interactive headers and cards.
 * Standalone media can opt into voice-note delivery + ElevenLabs TTS.
 */
export function ServiceMessageMediaField({
  attachment,
  upload,
  generateVoice,
  removeLabel,
  uploadLabel,
  dropHint,
  error,
  fieldKey = "attachment",
  onChange,
  accept = WHATSAPP_OFFICIAL_MEDIA_ACCEPT,
  allowAudio = true,
  deliverAsVoice = false,
  onDeliverAsVoiceChange,
  voiceScriptDefault = "",
  carousel = false,
  compactEmpty = false,
}: {
  attachment?: ScenarioActionAttachment;
  upload?: ScenarioActionNodeEnrichment["uiMedia"]["upload"];
  generateVoice?: ScenarioActionNodeEnrichment["uiMedia"]["generateVoice"];
  removeLabel: string;
  uploadLabel: string;
  dropHint?: string;
  error?: string;
  fieldKey?: string;
  onChange: (
    attachment: ScenarioActionAttachment | undefined,
    options?: { deliverAsVoice?: boolean }
  ) => void;
  accept?: string;
  /** When false, audio/sticker uploads are rejected (interactive headers). */
  allowAudio?: boolean;
  deliverAsVoice?: boolean;
  onDeliverAsVoiceChange?: (value: boolean) => void;
  voiceScriptDefault?: string;
  carousel?: boolean;
  /** Optional media stays a small attachment action until a file is chosen. */
  compactEmpty?: boolean;
}) {
  const t = useTranslations("Scenarios");
  const format = useFormatter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const sendAsLabelId = useId();
  const voiceNeedsOggId = useId();
  const voiceScriptId = useId();
  const voiceIdInputId = useId();
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [voiceScript, setVoiceScript] = useState(voiceScriptDefault);
  const [voiceId, setVoiceId] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  // Invalidate requests on removal, replacement or unmount. The builder keys
  // this field by format and document so a completion cannot restore old UI.
  // A signed URL arriving for the same stored media is not a replacement.
  const operationId = useRef(0);
  const operationPending = useRef(false);
  const attachmentIdentity = readScenarioMediaIdentity(attachment);
  useEffect(() => {
    operationPending.current = false;
    setUploading(false);
    setGenerating(false);
    return () => {
      operationId.current += 1;
    };
  }, [attachmentIdentity]);
  const hasPreview = Boolean(attachment?.url);
  const compactEmptySlot = compactEmpty && !hasPreview;
  const voiceMode = hasPreview && deliverAsVoice;
  const canUpload = Boolean(upload) && !uploading && !generating;
  const isAudio = attachment?.mediaType === "audio";
  const voiceEligible = isWhatsAppVoiceEligibleFile({
    mimeType: attachment?.mimeType,
    fileName: attachment?.fileName,
    url: attachment?.url,
  });
  const supportsVoice = allowAudio && Boolean(onDeliverAsVoiceChange);
  // "Send as" only means something once an audio file is attached.
  const showSendAs = supportsVoice && hasPreview && isAudio;
  const showVoiceGenerator =
    supportsVoice && Boolean(generateVoice) && (!hasPreview || voiceMode);
  const fileAccept =
    voiceMode && onDeliverAsVoiceChange ? WHATSAPP_VOICE_NOTE_ACCEPT : accept;
  const mediaTypeLabel = t(mediaTypeLabelKey(attachment?.mediaType));
  const carouselMediaUnsupported = t(
    "whatsappServiceCarouselMediaUnsupported",
    {
      imageMaxSize: getWhatsAppOfficialMediaMaxBytes("image") / (1024 * 1024),
      videoMaxSize: getWhatsAppOfficialMediaMaxBytes("video") / (1024 * 1024),
    }
  );

  const handleFiles = async (files: File[]) => {
    const file = files[0];
    if (!file || !upload || !canUpload || operationPending.current) return;
    const requestId = ++operationId.current;
    operationPending.current = true;
    setUploading(true);
    setGenerateError(null);
    setRejectError(null);
    try {
      const uploaded = await upload(file, { persist: false });
      if (requestId !== operationId.current) return;
      if (!uploaded) return;
      if (
        carousel &&
        uploaded.mediaType !== "image" &&
        uploaded.mediaType !== "video"
      ) {
        setRejectError(carouselMediaUnsupported);
        return;
      }
      if (
        !allowAudio &&
        (uploaded.mediaType === "audio" || uploaded.mediaType === "sticker")
      ) {
        setRejectError(t("whatsappServiceMediaAudioNotAllowedHere"));
        return;
      }
      const asVoice =
        uploaded.mediaType === "audio" &&
        voiceMode &&
        isWhatsAppVoiceEligibleFile({
          mimeType: uploaded.mimeType,
          fileName: uploaded.fileName,
          url: uploaded.url,
        });
      onChange(uploaded, asVoice ? { deliverAsVoice: true } : undefined);
    } catch (error) {
      if (requestId === operationId.current) {
        let message = resolveScenarioRequestErrorMessage(
          error,
          t,
          "actionImageUploadFailed"
        );
        const classification = classifyWhatsAppUploadMedia({
          fileName: file.name,
          mimeType: file.type,
        });
        if (classification.mediaType) {
          const maxBytes = getWhatsAppOfficialMediaMaxBytes(
            classification.mediaType
          );
          if (file.size > maxBytes) {
            const isMegabytes = maxBytes >= 1024 * 1024;
            const maxSize = format.number(
              maxBytes / (isMegabytes ? 1024 * 1024 : 1024),
              {
                style: "unit",
                unit: isMegabytes ? "megabyte" : "kilobyte",
                unitDisplay: "short",
              }
            );
            message = t("whatsappServiceMediaFileTooLarge", { maxSize });
          }
        }
        if (
          carousel &&
          isScenarioRequestErrorWithCode(
            error,
            "scenario_asset_upload_unsupported_file"
          )
        ) {
          message = carouselMediaUnsupported;
        }
        setRejectError(message);
      }
    } finally {
      if (requestId === operationId.current) {
        operationPending.current = false;
        setUploading(false);
      }
    }
  };

  const openPicker = () => {
    if (canUpload) inputRef.current?.click();
  };

  const handleGenerateVoice = async () => {
    if (
      !generateVoice ||
      !voiceScript.trim() ||
      uploading ||
      generating ||
      operationPending.current
    )
      return;
    const requestId = ++operationId.current;
    operationPending.current = true;
    setGenerating(true);
    setGenerateError(null);
    setRejectError(null);
    try {
      const generated = await generateVoice({
        text: voiceScript.trim(),
        ...(voiceId.trim() ? { voiceId: voiceId.trim() } : {}),
      });
      if (requestId !== operationId.current) return;
      if (!generated) {
        setGenerateError(t("whatsappServiceMediaElevenLabsRequired"));
        return;
      }
      onChange(generated, { deliverAsVoice: true });
    } catch (error) {
      if (requestId !== operationId.current) return;
      setGenerateError(
        error instanceof Error
          ? error.message
          : t("whatsappServiceMediaElevenLabsRequired")
      );
    } finally {
      if (requestId === operationId.current) {
        operationPending.current = false;
        setGenerating(false);
      }
    }
  };

  const displayError = rejectError || error;
  const sendAsValue = deliverAsVoice ? "voice" : "file";
  const sendAsTopic = t(
    deliverAsVoice
      ? "whatsappServiceMediaVoiceNoteBadge"
      : "whatsappServiceMediaBasicAudioBadge"
  );
  const voiceGeneratorTitle = t("whatsappServiceMediaVoiceNoteBadge");

  return (
    <div className="w-full space-y-2" data-sm-field={fieldKey}>
      <div
        data-testid="whatsapp-service-media-dropzone"
        className={cn(
          "w-full",
          displayError && "rounded-md ring-1 ring-destructive/70"
        )}
        onDragOver={event => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={event => {
          event.preventDefault();
          setIsDragOver(false);
          void handleFiles(Array.from(event.dataTransfer.files ?? []));
        }}
      >
        <label className="sr-only" htmlFor={inputId}>
          {uploadLabel}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="sr-only"
          type="file"
          accept={fileAccept}
          disabled={!canUpload}
          tabIndex={-1}
          onChange={event => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void handleFiles(files);
          }}
        />

        {hasPreview ? (
          <div
            className={cn(
              "group relative w-full overflow-hidden rounded-md border transition-colors",
              isDragOver
                ? "border-[#00a884] ring-2 ring-[#00a884]/30"
                : "border-black/10 dark:border-white/10"
            )}
          >
            <ServiceMessageAttachmentPreview
              attachment={attachment}
              carousel={carousel}
              mediaTypeLabel={mediaTypeLabel}
              deliverAsVoice={deliverAsVoice}
            />

            <div className="flex items-center gap-1 border-t bg-background p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="nodrag nopan h-8 min-w-0 flex-1 gap-1.5 px-2 text-[11px]"
                disabled={!canUpload}
                aria-label={t("whatsappServiceReplaceMedia")}
                title={t("whatsappServiceReplaceMedia")}
                onPointerDown={event => event.stopPropagation()}
                onClick={openPicker}
              >
                {uploading || generating ? (
                  <Loader2
                    className="h-3.5 w-3.5 shrink-0 animate-spin"
                    aria-hidden
                  />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
                <span className="truncate">
                  {uploading
                    ? t("uploading")
                    : t("whatsappServiceReplaceMedia")}
                </span>
              </Button>

              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="nodrag nopan h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                title={removeLabel}
                aria-label={removeLabel}
                onPointerDown={event => event.stopPropagation()}
                onClick={() => {
                  operationId.current += 1;
                  operationPending.current = false;
                  setUploading(false);
                  setGenerating(false);
                  setRejectError(null);
                  onChange(undefined);
                }}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            data-testid="whatsapp-service-media-add-zone"
            className={cn(
              "nodrag nopan flex w-full cursor-pointer select-none items-center justify-center gap-1.5 rounded-md border border-dashed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              compactEmptySlot
                ? "min-h-10 flex-row px-3 py-2"
                : carousel
                  ? "h-24 flex-col px-4 py-2"
                  : "min-h-28 flex-col px-4 py-6",
              isDragOver
                ? "border-[#00a884] bg-[#00a884]/5 text-[#00a884] dark:bg-[#00a884]/10"
                : "border-[#667781]/35 bg-black/[0.03] text-[#667781] hover:border-[#667781]/55 hover:bg-black/[0.05] dark:bg-white/[0.04] dark:text-[#8696a0] dark:hover:bg-white/[0.07]",
              !canUpload && "cursor-not-allowed opacity-60"
            )}
            aria-label={uploadLabel}
            aria-disabled={!canUpload}
            title={
              compactEmptySlot && dropHint
                ? `${uploadLabel}: ${dropHint}`
                : uploadLabel
            }
            onPointerDown={event => event.stopPropagation()}
            onClick={openPicker}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openPicker();
              }
            }}
          >
            {uploading ? (
              <Loader2
                className={cn(
                  "animate-spin text-current",
                  compactEmptySlot ? "h-4 w-4" : "h-6 w-6"
                )}
                aria-hidden
              />
            ) : (
              <ImagePlus
                className={cn(
                  "text-current",
                  compactEmptySlot ? "h-4 w-4" : "h-6 w-6"
                )}
                aria-hidden
              />
            )}
            <span className="text-[12px] font-medium text-current">
              {uploading ? t("uploading") : uploadLabel}
            </span>
            {dropHint ? (
              <span
                className={
                  compactEmptySlot
                    ? "sr-only"
                    : "text-center text-[11px] text-current/75"
                }
              >
                {dropHint}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {showSendAs ? (
        <div
          className="space-y-1"
          data-testid="whatsapp-service-voice-controls"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              id={sendAsLabelId}
              className="text-[11px] font-medium text-muted-foreground"
            >
              {t("whatsappServiceMediaAudioDeliveryLabel")}
            </span>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={sendAsValue}
              disabled={uploading || generating}
              aria-labelledby={sendAsLabelId}
              className="nodrag nopan nokey"
              onValueChange={next => {
                // A second click on the active item would clear the value.
                if (next === "voice" || next === "file") {
                  if (next !== sendAsValue)
                    onDeliverAsVoiceChange?.(next === "voice");
                }
              }}
            >
              <ToggleGroupItem
                value="file"
                className="h-7 flex-none gap-1 px-2 text-[11px]"
              >
                <Music2 className="size-3.5" aria-hidden />
                {t("whatsappServiceMediaBasicAudioBadge")}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="voice"
                className="h-7 flex-none gap-1 px-2 text-[11px]"
                disabled={!voiceEligible}
                aria-describedby={voiceEligible ? undefined : voiceNeedsOggId}
              >
                <Mic className="size-3.5" aria-hidden />
                {t("whatsappServiceMediaVoiceNoteBadge")}
              </ToggleGroupItem>
            </ToggleGroup>
            <ScenarioInfoHint
              label={t("infoHintLabel", { topic: sendAsTopic })}
            >
              {t(
                deliverAsVoice
                  ? "whatsappServiceMediaVoiceHint"
                  : "whatsappServiceMediaBasicAudioHint"
              )}
            </ScenarioInfoHint>
          </div>
          {voiceEligible ? null : (
            <p
              id={voiceNeedsOggId}
              className="text-[11px] leading-snug text-muted-foreground"
            >
              {t("whatsappServiceMediaVoiceNeedsOgg")}
            </p>
          )}
        </div>
      ) : null}

      {showVoiceGenerator ? (
        <ScenarioCollapsibleSection
          variant="inline"
          title={voiceGeneratorTitle}
          info={{
            label: t("infoHintLabel", { topic: voiceGeneratorTitle }),
            text: t("whatsappServiceMediaGenerateVoiceInfo"),
          }}
          data-testid="whatsapp-service-voice-generator"
        >
          <div className="space-y-1.5 pt-1">
            <Label htmlFor={voiceScriptId} className="sr-only">
              {t("whatsappServiceMediaVoiceScriptLabel")}
            </Label>
            <Textarea
              id={voiceScriptId}
              className="nodrag nowheel min-h-[64px] text-[11px]"
              value={voiceScript}
              disabled={uploading || generating}
              placeholder={t("whatsappServiceMediaVoiceScriptPlaceholder")}
              onPointerDown={event => event.stopPropagation()}
              onChange={event => setVoiceScript(event.target.value)}
            />
            <ScenarioCollapsibleSection
              variant="inline"
              title={t("whatsappServiceMore")}
              defaultOpen={Boolean(voiceId)}
              keepMounted
            >
              <div className="grid gap-1 pt-1">
                <Label
                  htmlFor={voiceIdInputId}
                  className="text-[11px] font-normal text-muted-foreground"
                >
                  {t("whatsappServiceMediaVoiceIdPlaceholder")}
                </Label>
                <Input
                  id={voiceIdInputId}
                  className="nodrag h-8 text-[11px]"
                  value={voiceId}
                  disabled={uploading || generating}
                  onPointerDown={event => event.stopPropagation()}
                  onChange={event => setVoiceId(event.target.value)}
                />
              </div>
            </ScenarioCollapsibleSection>
            <Button
              type="button"
              size="sm"
              className="nodrag nopan h-8 w-full gap-1.5 text-[11px]"
              disabled={uploading || generating || !voiceScript.trim()}
              onPointerDown={event => event.stopPropagation()}
              onClick={() => void handleGenerateVoice()}
            >
              {generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Mic className="h-3.5 w-3.5" aria-hidden />
              )}
              {t("whatsappServiceMediaGenerateVoice")}
            </Button>
            {generateError ? (
              <p className="text-[11px] leading-snug text-destructive">
                {generateError}
              </p>
            ) : null}
          </div>
        </ScenarioCollapsibleSection>
      ) : null}
      {displayError ? (
        <p role="alert" className="text-[10px] leading-snug text-destructive">
          {displayError}
        </p>
      ) : null}
    </div>
  );
}
