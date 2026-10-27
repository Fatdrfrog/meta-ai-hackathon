"use client";

import {
  getPublicTemplateButtons,
  getPublicTemplateCarouselPreviews,
  getPublicTemplateFooter,
  getPublicTemplateText,
  type PublicTemplate,
  type PublicTemplatePreviewButton,
} from "@/lib/landing/public-template-catalog";
import { CarouselCardsScroller } from "@/components/whatsapp/carousel-cards-scroller";
import { isHttpOrHttpsUrl } from "@/lib/media/whatsapp-media-url";
import {
  parseWhatsAppTextFormatting,
  type WhatsAppTextFormatSegment,
} from "@/lib/whatsapp-format";
import {
  CheckCheck,
  ClipboardList,
  FileText,
  ImageIcon,
  Link2,
  MapPin,
  MessageSquare,
  Phone,
  Video,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { createElement, useMemo, useState, type ReactNode } from "react";
import { Bubble, ProductImage } from "./hero-feature-card-previews";
import s from "./template-marketplace.module.css";

function renderFormattedSegments(
  segments: WhatsAppTextFormatSegment[],
  prefix = "message"
): ReactNode[] {
  return segments.map((segment, index) => {
    if (segment.type === "text") return segment.text;
    const key = `${prefix}-${index}`;
    const tag =
      segment.kind === "monospace"
        ? "code"
        : segment.kind === "bold"
          ? "strong"
          : segment.kind === "italic"
            ? "em"
            : "s";
    return createElement(
      tag,
      { key, ...(tag === "code" ? { className: s.previewCode } : {}) },
      segment.kind === "monospace"
        ? segment.text
        : renderFormattedSegments(segment.children, key)
    );
  });
}

export function WhatsAppFormattedMessage({ text }: { text: string }) {
  const content = useMemo(
    () => renderFormattedSegments(parseWhatsAppTextFormatting(text)),
    [text]
  );
  return <span className={s.formattedMessage}>{content}</span>;
}

const BUTTON_ICONS = {
  URL: Link2,
  QUICK_REPLY: MessageSquare,
  PHONE_NUMBER: Phone,
  FLOW: ClipboardList,
} as const;

function PreviewButtons({
  buttons,
}: {
  buttons: readonly PublicTemplatePreviewButton[];
}) {
  return buttons.map((button, index) => {
    const Icon = BUTTON_ICONS[button.type];
    return (
      <div key={`${index}-${button.text}`} className={s.previewButton}>
        <Icon size={14} aria-hidden />
        <span>{button.text}</span>
      </div>
    );
  });
}

/** Public attachments support site paths and HTTP(S), never executable URLs. */
function publicAttachmentUrl(value?: string): string | undefined {
  const url = value?.trim();
  if (!url || /[\\\u0000-\u001f]/.test(url)) return undefined;
  return (url.startsWith("/") && !url.startsWith("//")) || isHttpOrHttpsUrl(url)
    ? url
    : undefined;
}

export function TemplatePreview({
  template,
  compact = false,
}: {
  template: PublicTemplate;
  compact?: boolean;
}) {
  const t = useTranslations();
  const title = getPublicTemplateText(template, "title", t);
  const body = getPublicTemplateText(template, "body", t);
  const buttons = getPublicTemplateButtons(template, t);
  const footer = getPublicTemplateFooter(template, t);
  const carouselPreviews = getPublicTemplateCarouselPreviews(template, t);
  const videoUrl = publicAttachmentUrl(template.videoPath);
  const [failedVideoUrl, setFailedVideoUrl] = useState<string>();
  const documentUrl = publicAttachmentUrl(template.documentPath);
  const media = template.format === "image" || template.format === "carousel";
  const carouselImages =
    template.format === "carousel" ? template.carouselImagePaths : undefined;
  const message = (
    <Bubble outgoing time="10:03">
      <WhatsAppFormattedMessage text={body} />
      {footer && <span className={s.previewMessageFooter}>{footer}</span>}
    </Bubble>
  );
  return (
    <div
      className={[s.preview, compact ? s.compact : ""].join(" ")}
      role="group"
      aria-label={t("LandingDemo.templates.previewLabel")}
    >
      <div className={s.previewBrand}>
        <span aria-hidden>airi.</span>
        <strong>airi.chat</strong>
        <CheckCheck size={16} aria-hidden />
      </div>
      <div className={s.previewMessage}>
        {template.format === "carousel" && message}
        {media &&
          (carouselImages?.length ? (
            <CarouselCardsScroller
              className={s.previewCarousel}
              viewportClassName={s.carouselViewport}
              navigationClassName={s.carouselNavigation}
              previousLabel={t("LandingDemo.templates.carouselPrevious")}
              nextLabel={t("LandingDemo.templates.carouselNext")}
              persistentNavigation
            >
              {carouselImages.map((path, index) => (
                <div
                  key={path}
                  className={s.carouselCard}
                  role="group"
                  aria-label={`${title} ${index + 1}`}
                >
                  <ProductImage src={path} alt="" className={s.previewMedia} />
                  {carouselPreviews?.[index] && (
                    <>
                      <Bubble outgoing>
                        <WhatsAppFormattedMessage
                          text={carouselPreviews[index].body}
                        />
                      </Bubble>
                      <PreviewButtons
                        buttons={carouselPreviews[index].buttons}
                      />
                    </>
                  )}
                </div>
              ))}
            </CarouselCardsScroller>
          ) : template.imagePath ? (
            <ProductImage
              src={template.imagePath}
              alt=""
              className={s.previewMedia}
            />
          ) : (
            <div
              className={s.mediaPlaceholder}
              aria-label={t("LandingDemo.templates.mediaPlaceholder")}
            >
              <ImageIcon size={24} aria-hidden />
              <span>{t("LandingDemo.templates.mediaPlaceholder")}</span>
            </div>
          ))}
        {template.format === "document" &&
          (documentUrl ? (
            <a
              className={s.documentAttachment}
              href={documentUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileText size={26} aria-hidden />
              <span>
                <strong>{template.documentFilename ?? "PDF"}</strong>
                <small>PDF</small>
              </span>
            </a>
          ) : (
            <div className={s.documentAttachment}>
              <FileText size={26} aria-hidden />
              <span>
                <strong>{template.documentFilename ?? "PDF"}</strong>
                <small>{t("LandingDemo.templates.mediaUnavailable")}</small>
              </span>
            </div>
          ))}
        {template.format === "video" &&
          (videoUrl && failedVideoUrl !== videoUrl ? (
            <video
              className={s.previewVideo}
              src={videoUrl}
              poster={publicAttachmentUrl(template.videoPosterPath)}
              controls
              muted
              playsInline
              preload="none"
              aria-label={title}
              onError={() => setFailedVideoUrl(videoUrl)}
            />
          ) : (
            <div className={s.mediaPlaceholder}>
              <Video size={24} aria-hidden />
              <span>{t("LandingDemo.templates.mediaUnavailable")}</span>
            </div>
          ))}
        {template.format === "location" && template.location && (
          <div className={s.locationAttachment}>
            <div className={s.locationMap} aria-hidden>
              <MapPin size={34} />
            </div>
            <div className={s.locationDetails}>
              <strong>{template.location.name}</strong>
              <span>{template.location.address}</span>
              {Number.isFinite(template.location.latitude) &&
                Number.isFinite(template.location.longitude) && (
                  <small>
                    {template.location.latitude.toFixed(5)},{" "}
                    {template.location.longitude.toFixed(5)}
                  </small>
                )}
            </div>
          </div>
        )}
        {template.format !== "carousel" && message}
        <PreviewButtons buttons={buttons} />
      </div>
      {!compact && (
        <p className={s.previewNote}>{t("LandingDemo.templates.sampleNote")}</p>
      )}
    </div>
  );
}
