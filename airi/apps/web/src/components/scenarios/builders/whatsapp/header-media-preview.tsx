"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { resolveScenarioMediaDisplayUrl } from "../media-display-url";
import { ScenarioMediaPlaceholder } from "../scenario-media-placeholder";

const MEDIA_FRAME_CLASS =
  "max-h-44 w-full rounded-md border border-black/10 object-cover";
const MEDIA_NOTE_CLASS =
  "flex min-w-0 items-center gap-1.5 rounded border border-dashed border-black/15 px-2 py-1 text-[11px] text-[#667781] dark:text-[#8696a0]";

/**
 * A message's header media in the preview. Media still waiting for its
 * display URL shows a placeholder at the frame's full height, which most
 * header photos and videos fill at the message's width.
 */
export function WhatsAppHeaderMediaPreview({
  url,
  format,
  placeholderContent,
  mediaLoading,
  showVideoControls,
  videoPreload,
}: {
  url?: string;
  format?: string;
  /** The media kind's icon and name, for media without a preview. */
  placeholderContent: ReactNode;
  mediaLoading: "eager" | "lazy";
  showVideoControls: boolean;
  videoPreload: "auto" | "metadata" | "none";
}) {
  const t = useTranslations("Scenarios");
  const src = resolveScenarioMediaDisplayUrl(url);
  if (url && (format === "IMAGE" || format === "VIDEO") && !src) {
    return (
      <ScenarioMediaPlaceholder
        label={t(
          format === "IMAGE"
            ? "whatsappTemplateHeaderImage"
            : "whatsappTemplateHeaderVideo"
        )}
        className={`h-44 ${MEDIA_FRAME_CLASS}`}
        testId="whatsapp-template-media-pending"
      />
    );
  }
  if (src && format === "IMAGE") {
    return (
      // Signed Meta/template preview URLs do not expose stable intrinsic
      // dimensions, so render them as plain browser images, not Next/Image.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        data-testid="whatsapp-template-image-preview"
        src={src}
        alt={t("whatsappTemplateHeaderImage")}
        loading={mediaLoading}
        decoding="async"
        className={MEDIA_FRAME_CLASS}
      />
    );
  }
  if (src && format === "VIDEO") {
    return (
      <video
        data-testid="whatsapp-template-video-preview"
        src={src}
        controls={showVideoControls}
        muted={!showVideoControls}
        playsInline
        preload={videoPreload}
        className={`${MEDIA_FRAME_CLASS} bg-black`}
        aria-label={t("whatsappTemplateHeaderVideo")}
      />
    );
  }
  return src ? (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className={`${MEDIA_NOTE_CLASS} underline-offset-2 hover:underline`}
    >
      {placeholderContent}
    </a>
  ) : (
    <p
      data-testid="whatsapp-header-media-placeholder"
      className={MEDIA_NOTE_CLASS}
    >
      {placeholderContent}
    </p>
  );
}
