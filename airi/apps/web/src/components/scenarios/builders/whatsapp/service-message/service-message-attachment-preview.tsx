"use client";

import { cn } from "@/lib/utils";
import type { ScenarioActionAttachment } from "@icecore/scenario-contracts";
import { FileUp, Mic, Music2 } from "lucide-react";
import { resolveScenarioMediaDisplayUrl } from "../../media-display-url";
import { ScenarioMediaPlaceholder } from "../../scenario-media-placeholder";

type AttachmentPreviewProps = {
  attachment: ScenarioActionAttachment | undefined;
  carousel: boolean;
  mediaTypeLabel: string;
  deliverAsVoice: boolean;
};

function AudioAttachmentPreview({
  attachment,
  src,
  mediaTypeLabel,
  deliverAsVoice,
}: Omit<AttachmentPreviewProps, "carousel" | "attachment"> & {
  attachment: ScenarioActionAttachment;
  src: string | null;
}) {
  return (
    <div className="flex min-h-24 w-full flex-col justify-center gap-2 bg-black/[0.04] px-3 py-3 dark:bg-white/[0.06]">
      {/* Until its display URL arrives, the same player waits unloaded. */}
      <audio
        src={src ?? undefined}
        controls
        preload="metadata"
        className="nodrag nopan w-full"
        onPointerDown={event => event.stopPropagation()}
        aria-label={mediaTypeLabel}
        data-testid={src ? undefined : "whatsapp-service-media-pending"}
      />
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[#667781] dark:text-[#8696a0]">
        {deliverAsVoice ? (
          <Mic className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <Music2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span className="truncate">
          {attachment.fileName || mediaTypeLabel}
        </span>
      </span>
    </div>
  );
}

/**
 * The attached media as the message shows it. Media still waiting for its
 * display URL shows a placeholder in its frame: a carousel card's fixed
 * height, or the full height of the single-media frame, which most photos
 * and videos fill at the message's width.
 */
export function ServiceMessageAttachmentPreview({
  attachment,
  carousel,
  mediaTypeLabel,
  deliverAsVoice,
}: AttachmentPreviewProps) {
  const src = resolveScenarioMediaDisplayUrl(attachment);
  const sizeClass = carousel ? "h-24" : "max-h-44";
  const visual =
    attachment?.mediaType === "image" || attachment?.mediaType === "video";
  if (visual && !src) {
    return (
      <ScenarioMediaPlaceholder
        label={mediaTypeLabel}
        className={cn("w-full", carousel ? "h-24" : "h-44")}
        testId="whatsapp-service-media-pending"
      />
    );
  }
  if (attachment?.mediaType === "image") {
    return (
      // Signed / ephemeral preview URLs are not stable Next/Image sources.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src ?? undefined}
        alt={mediaTypeLabel}
        loading="lazy"
        decoding="async"
        className={cn("w-full object-cover", sizeClass)}
      />
    );
  }
  if (attachment?.mediaType === "video") {
    return (
      <video
        src={src ?? undefined}
        controls
        playsInline
        preload="metadata"
        className={cn("nodrag nopan w-full bg-black object-cover", sizeClass)}
        onPointerDown={event => event.stopPropagation()}
        aria-label={mediaTypeLabel}
      />
    );
  }
  if (attachment?.mediaType === "audio") {
    return (
      <AudioAttachmentPreview
        attachment={attachment}
        src={src}
        mediaTypeLabel={mediaTypeLabel}
        deliverAsVoice={deliverAsVoice}
      />
    );
  }
  return (
    <div className="flex min-h-24 w-full items-center gap-2 bg-black/[0.04] px-3 py-4 dark:bg-white/[0.06]">
      <FileUp
        className="h-5 w-5 shrink-0 text-[#667781] dark:text-[#8696a0]"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-xs text-[#111b21] dark:text-[#e9edef]">
        {attachment?.fileName || mediaTypeLabel}
      </span>
    </div>
  );
}
