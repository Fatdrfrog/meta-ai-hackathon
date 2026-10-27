"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FileText, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useId,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { resolveScenarioMediaDisplayUrl } from "../../builders/media-display-url";
import { ReplyOptionTooltip } from "../../builders/reply-option-controls";
import { ScenarioMediaPlaceholder } from "../../builders/scenario-media-placeholder";
import type { ScenarioReplyCtaType, TranslateFn } from "../../types";
import { ScenarioActionLinkFields } from "./assets-fields-links";
import { ScenarioActionReplyCtaFields } from "./assets-fields-reply-cta";
import {
  FIELD_LABEL_CLASS,
  resolveScenarioActionAssetsLayout,
  type ScenarioCtaFlowOption,
} from "./assets-fields-utils";
import {
  useScenarioActionCtaFlowPicker,
  useScenarioActionLinkDraft,
  useScenarioActionPrimaryLinkDraft,
} from "./use-assets-fields-state";

/** Keeps a press on an attachment control from reaching the canvas node. */
function stopPointerPropagation(event: PointerEvent<HTMLElement>) {
  event.stopPropagation();
}

/**
 * Attach button. With `uploadInputId` it is a label for that file input, so
 * the browser opens the picker; otherwise it asks the parent to open one.
 */
function AttachmentUploadTrigger({
  uploadInputId,
  canUploadMore,
  isUploading,
  describedBy,
  onUploadImageClick,
  t,
}: {
  uploadInputId?: string;
  canUploadMore: boolean;
  isUploading: boolean;
  describedBy?: string;
  onUploadImageClick: () => void;
  t: TranslateFn;
}) {
  const uploadContent = (
    <>
      {isUploading ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      )}
      {isUploading ? t("uploading") : t("attachFile")}
    </>
  );

  const handleButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canUploadMore) return;
    onUploadImageClick();
  };

  const handleLabelClick = (event: MouseEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canUploadMore) {
      return;
    }
    if (!uploadInputId) return;
    document.getElementById(uploadInputId)?.click();
  };

  const handleLabelKeyDown = (event: KeyboardEvent<HTMLLabelElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    if (!canUploadMore || !uploadInputId) return;
    document.getElementById(uploadInputId)?.click();
  };

  if (uploadInputId) {
    return (
      <Button
        asChild
        variant="outline"
        size="sm"
        className={cn(
          "nodrag nopan nokey h-7 cursor-pointer px-2 text-[10px]",
          !canUploadMore && "pointer-events-none opacity-50"
        )}
      >
        <label
          htmlFor={canUploadMore ? uploadInputId : undefined}
          role="button"
          tabIndex={canUploadMore ? 0 : -1}
          aria-disabled={!canUploadMore}
          aria-describedby={describedBy}
          data-testid="scenario-action-attachment-upload-trigger"
          onPointerDown={stopPointerPropagation}
          onClick={handleLabelClick}
          onKeyDown={handleLabelKeyDown}
        >
          {uploadContent}
        </label>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onPointerDown={stopPointerPropagation}
      onClick={handleButtonClick}
      disabled={!canUploadMore}
      aria-describedby={describedBy}
      data-testid="scenario-action-attachment-upload-trigger"
      className="nodrag nopan nokey h-7 px-2 text-[10px]"
    >
      {uploadContent}
    </Button>
  );
}

/**
 * An attachment's image or video, or a same-size placeholder while its URL
 * is still a storage ref waiting to be signed.
 */
function AttachmentMedia({
  imageUrl,
  index,
  t,
}: {
  imageUrl: string;
  index: number;
  t: TranslateFn;
}) {
  const normalizedUrl = imageUrl.toLowerCase();
  const displayUrl = resolveScenarioMediaDisplayUrl(imageUrl);
  if (/\.(png|jpe?g|gif|webp)(?:$|[?#])/.test(normalizedUrl)) {
    const label = t("actionFileN", { n: index + 1 });
    return displayUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={displayUrl} alt={label} className="h-16 w-full object-cover" />
    ) : (
      <ScenarioMediaPlaceholder label={label} className="h-16 w-full" />
    );
  }
  if (/\.(mp4|webm|mov)(?:$|[?#])/.test(normalizedUrl)) {
    const label = t("actionVideoN", { n: index + 1 });
    return displayUrl ? (
      <video
        data-testid="scenario-action-video-preview"
        src={displayUrl}
        controls
        className="h-16 w-full bg-black object-cover"
        aria-label={label}
      />
    ) : (
      <ScenarioMediaPlaceholder label={label} className="h-16 w-full" />
    );
  }
  return (
    <div className="flex h-16 items-center justify-center gap-1 text-muted-foreground">
      <FileText className="h-4 w-4" aria-hidden />
      <span className="max-w-[72px] truncate text-[10px]">
        {t("whatsappServiceMediaDocument")}
      </span>
    </div>
  );
}

/** One attachment: an image or video preview, or a document tile. */
function AttachmentPreview({
  imageUrl,
  index,
  onRemoveImageUrl,
  t,
}: {
  imageUrl: string;
  index: number;
  onRemoveImageUrl: (imageUrl: string) => void;
  t: TranslateFn;
}) {
  return (
    <div className="relative overflow-hidden rounded-md border bg-background">
      <ReplyOptionTooltip label={t("actionRemoveFile")}>
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            onRemoveImageUrl(imageUrl);
          }}
          onPointerDown={stopPointerPropagation}
          className="nodrag nopan nokey absolute right-1 top-1 z-10 inline-flex size-6 items-center justify-center rounded-full border bg-background/90 text-muted-foreground hover:text-destructive"
          aria-label={t("actionRemoveFile")}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
        </button>
      </ReplyOptionTooltip>
      <AttachmentMedia imageUrl={imageUrl} index={index} t={t} />
    </div>
  );
}

/** Attachment previews that also take dropped files while under the limit. */
function AttachmentDropzone({
  imageUrls,
  maxImageCount,
  canUploadMore,
  isImageLimitReached,
  onUploadFiles,
  onRemoveImageUrl,
  t,
}: {
  imageUrls: string[];
  maxImageCount: number;
  canUploadMore: boolean;
  isImageLimitReached: boolean;
  onUploadFiles?: (files: File[]) => void;
  onRemoveImageUrl: (imageUrl: string) => void;
  t: TranslateFn;
}) {
  const [isDraggingAttachments, setIsDraggingAttachments] = useState(false);

  const handleAttachmentDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = canUploadMore ? "copy" : "none";
    if (canUploadMore) {
      setIsDraggingAttachments(true);
    }
  };

  const handleAttachmentDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingAttachments(false);
  };

  const handleAttachmentDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingAttachments(false);
    if (!canUploadMore) return;
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 0) return;
    onUploadFiles?.(files);
  };

  return (
    <div
      data-testid="scenario-action-attachment-dropzone"
      onDragOver={handleAttachmentDragOver}
      onDragLeave={handleAttachmentDragLeave}
      onDrop={handleAttachmentDrop}
      className={cn(
        "nodrag space-y-1.5 rounded-md border border-dashed p-2 transition-colors",
        canUploadMore
          ? "bg-background/70 hover:border-primary/40 hover:bg-primary/5"
          : "bg-muted/30",
        isDraggingAttachments && "border-primary/60 bg-primary/10"
      )}
    >
      {imageUrls.length > 0 ? (
        <div className="grid grid-cols-3 gap-1.5">
          {imageUrls.slice(0, maxImageCount).map((imageUrl, index) => (
            <AttachmentPreview
              key={imageUrl}
              imageUrl={imageUrl}
              index={index}
              onRemoveImageUrl={onRemoveImageUrl}
              t={t}
            />
          ))}
        </div>
      ) : null}
      {!isImageLimitReached ? (
        <p className="flex items-center justify-center gap-1.5 py-1 text-center text-[11px] text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5" aria-hidden />
          {t("actionAttachmentDropHint")}
        </p>
      ) : null}
    </div>
  );
}

/** Files and media sent with the action, up to `maxImageCount`. */
function ScenarioActionAttachmentFields({
  fieldId,
  imageUrls,
  maxImageCount,
  isUploadingActionImage,
  uploadInputId,
  onUploadImageClick,
  onUploadFiles,
  onRemoveImageUrl,
}: {
  fieldId: string;
  imageUrls: string[];
  maxImageCount: number;
  isUploadingActionImage: boolean;
  uploadInputId?: string;
  onUploadImageClick: () => void;
  onUploadFiles?: (files: File[]) => void;
  onRemoveImageUrl: (imageUrl: string) => void;
}) {
  const t = useTranslations("Scenarios");
  const attachmentLimitId = `${fieldId}-attachment-limit`;
  const isImageLimitReached = imageUrls.length >= maxImageCount;
  const canUploadMore = !isUploadingActionImage && !isImageLimitReached;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className={FIELD_LABEL_CLASS}>
          {t("actionAttachments")}{" "}
          <span
            className="font-normal tabular-nums"
            data-testid="scenario-action-attachment-count"
          >
            {imageUrls.length}/{maxImageCount}
          </span>
        </p>
        <AttachmentUploadTrigger
          uploadInputId={uploadInputId}
          canUploadMore={canUploadMore}
          isUploading={isUploadingActionImage}
          describedBy={isImageLimitReached ? attachmentLimitId : undefined}
          onUploadImageClick={onUploadImageClick}
          t={t}
        />
      </div>
      <AttachmentDropzone
        imageUrls={imageUrls}
        maxImageCount={maxImageCount}
        canUploadMore={canUploadMore}
        isImageLimitReached={isImageLimitReached}
        onUploadFiles={onUploadFiles}
        onRemoveImageUrl={onRemoveImageUrl}
        t={t}
      />
      {isImageLimitReached ? (
        <p id={attachmentLimitId} className="text-[11px] text-muted-foreground">
          {t("actionAttachmentLimit", { count: maxImageCount })}
        </p>
      ) : null}
    </div>
  );
}

type ScenarioActionAssetsFieldsProps = {
  linkUrls: string[];
  imageUrls: string[];
  maxImageCount?: number;
  isUploadingActionImage: boolean;
  ctaType?: ScenarioReplyCtaType;
  ctaButtonLabel?: string;
  ctaFlowId?: string;
  ctaFlowName?: string;
  ctaFlowOptions?: ScenarioCtaFlowOption[];
  ctaFlowLoading?: boolean;
  hideLinkControls?: boolean;
  /**
   * Hides WhatsApp-style reply CTA (type / flow). Use for Telegram inline-keyboard
   * actions; URL buttons still use `telegramUrlButtonLabel` when links exist.
   */
  hideReplyCtaChrome?: boolean;
  telegramUrlButtonLabel?: string;
  onTelegramUrlButtonLabelChange?: (value: string) => void;
  onAddLinkUrl: (linkUrl: string) => void;
  onReplacePrimaryLinkUrl?: (linkUrl: string) => void;
  onRemoveLinkUrl: (linkUrl: string) => void;
  onCtaTypeChange?: (ctaType: ScenarioReplyCtaType) => void;
  onCtaButtonLabelChange?: (value: string) => void;
  onCtaFlowIdChange?: (flowId: string) => void;
  onCtaFlowOptionsOpen?: (open: boolean) => void;
  uploadInputId?: string;
  onUploadImageClick: () => void;
  onUploadFiles?: (files: File[]) => void;
  onRemoveImageUrl: (imageUrl: string) => void;
};

export function ScenarioActionAssetsFields({
  linkUrls,
  imageUrls,
  maxImageCount = 6,
  isUploadingActionImage,
  ctaType,
  ctaButtonLabel,
  ctaFlowId,
  ctaFlowName,
  ctaFlowOptions,
  ctaFlowLoading = false,
  hideLinkControls = false,
  hideReplyCtaChrome = false,
  telegramUrlButtonLabel,
  onTelegramUrlButtonLabelChange,
  onAddLinkUrl,
  onReplacePrimaryLinkUrl,
  onRemoveLinkUrl,
  onCtaTypeChange,
  onCtaButtonLabelChange,
  onCtaFlowIdChange,
  onCtaFlowOptionsOpen,
  uploadInputId,
  onUploadImageClick,
  onUploadFiles,
  onRemoveImageUrl,
}: ScenarioActionAssetsFieldsProps) {
  const fieldId = useId();
  const linkDraft = useScenarioActionLinkDraft({ linkUrls, onAddLinkUrl });
  const primaryLink = useScenarioActionPrimaryLinkDraft({
    linkUrls,
    onAddLinkUrl,
    onReplacePrimaryLinkUrl,
    onRemoveLinkUrl,
  });
  const flowPicker = useScenarioActionCtaFlowPicker({
    ctaFlowId,
    ctaFlowName,
    ctaFlowOptions,
    ctaFlowLoading,
    onCtaFlowOptionsOpen,
  });
  const layout = resolveScenarioActionAssetsLayout({
    ctaType,
    hideLinkControls,
    hideReplyCtaChrome,
    linkCount: linkUrls.length,
    onCtaTypeChange,
    onCtaButtonLabelChange,
    onCtaFlowIdChange,
    onTelegramUrlButtonLabelChange,
  });

  return (
    <>
      {layout.supportsReplyCta ? (
        <ScenarioActionReplyCtaFields
          fieldId={fieldId}
          ctaType={layout.effectiveCtaType}
          ctaButtonLabel={ctaButtonLabel}
          ctaFlowId={ctaFlowId}
          showInlineLinkInput={layout.showInlineCtaLinkInput}
          primaryLink={primaryLink}
          flowPicker={flowPicker}
          onCtaTypeChange={onCtaTypeChange}
          onCtaButtonLabelChange={onCtaButtonLabelChange}
          onCtaFlowIdChange={onCtaFlowIdChange}
        />
      ) : null}

      {layout.showLinkControls ? (
        <ScenarioActionLinkFields
          fieldId={fieldId}
          linkUrls={linkUrls}
          linkDraft={linkDraft}
          showTelegramUrlLabel={layout.showTelegramUrlLabel}
          telegramUrlButtonLabel={telegramUrlButtonLabel}
          onTelegramUrlButtonLabelChange={onTelegramUrlButtonLabelChange}
          onRemoveLinkUrl={onRemoveLinkUrl}
        />
      ) : null}

      <ScenarioActionAttachmentFields
        fieldId={fieldId}
        imageUrls={imageUrls}
        maxImageCount={maxImageCount}
        isUploadingActionImage={isUploadingActionImage}
        uploadInputId={uploadInputId}
        onUploadImageClick={onUploadImageClick}
        onUploadFiles={onUploadFiles}
        onRemoveImageUrl={onRemoveImageUrl}
      />
    </>
  );
}
