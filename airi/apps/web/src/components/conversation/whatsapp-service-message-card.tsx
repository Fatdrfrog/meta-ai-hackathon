"use client";

import { cn } from "@/lib/utils";
import { resolveStoredWhatsAppServiceMessagePreview } from "@icecore/shared/lib/whatsapp/service-message-preview";
import type { StoredWhatsAppServiceMessagePreview } from "@icecore/shared/types/message-preview";
import {
  ExternalLink,
  FileText,
  List,
  MapPin,
  MessageSquare,
  Phone,
  ShoppingBag,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  asNullableRecord,
  readTrimmedString as asText,
} from "@icecore/shared/lib/value-utils";

type UnknownRecord = Record<string, unknown>;

type ServiceCardTranslator = ReturnType<
  typeof useTranslations<"ConversationDetailView">
>;

function asRecords(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.flatMap(item => {
        const record = asNullableRecord(item);
        return record ? [record] : [];
      })
    : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap(item => {
        const text = asText(item);
        return text ? [text] : [];
      })
    : [];
}

function buildCreativeAssetDisplayUrl(params: {
  workspaceId?: string | null;
  url?: string | null;
  bucket?: string | null;
  path?: string | null;
}): string {
  const rawUrl = asText(params.url);
  if (!rawUrl) return "";
  if (!rawUrl.startsWith("gcs://") && !rawUrl.startsWith("gs://")) {
    return rawUrl;
  }

  const workspaceId = asText(params.workspaceId);
  if (!workspaceId) return "";

  const search = new URLSearchParams();
  search.set("url", rawUrl);
  const bucket = asText(params.bucket);
  const path = asText(params.path);
  if (bucket) search.set("bucket", bucket);
  if (path) search.set("path", path);
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/creative-assets/object?${search.toString()}`;
}

function withStableKeys(
  records: UnknownRecord[],
  identity: (record: UnknownRecord) => string
) {
  const occurrences = new Map<string, number>();
  return records.map(record => {
    const base = identity(record) || JSON.stringify(record);
    const occurrence = occurrences.get(base) || 0;
    occurrences.set(base, occurrence + 1);
    return { record, key: `${base}:${occurrence}` };
  });
}

function ServiceRow({
  icon: Icon,
  label,
  description,
  href,
}: {
  icon: LucideIcon;
  label: string;
  description?: string;
  href?: string;
}) {
  const content = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {description ? (
          <span className="block truncate text-[10px] opacity-70">
            {description}
          </span>
        ) : null}
      </span>
      {href ? <ExternalLink className="h-3 w-3 shrink-0 opacity-70" /> : null}
    </>
  );
  const className =
    "flex min-h-8 items-center gap-2 border-t border-border/50 px-2 py-1.5 text-xs";

  return href ? (
    <a
      className={cn(className, "hover:bg-muted/40")}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

function HeaderMedia({
  header,
  workspaceId,
}: {
  header: UnknownRecord;
  workspaceId?: string | null;
}) {
  const attachment = asNullableRecord(header.attachment);
  const url = buildCreativeAssetDisplayUrl({
    workspaceId,
    url: asText(attachment?.url),
    bucket: asText(attachment?.bucket),
    path: asText(attachment?.path),
  });
  const mediaType = asText(attachment?.mediaType);
  if (!url) return null;

  return mediaType === "image" ? (
    // Signed GCS / CDN / proxy URLs are not in next/image remotePatterns.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      className="max-h-48 w-full object-cover"
    />
  ) : mediaType === "video" ? (
    <video
      src={url}
      muted
      playsInline
      preload="metadata"
      controls
      className="max-h-48 w-full object-cover"
      aria-label={asText(attachment?.fileName) || "video"}
    />
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 border-b border-border/50 p-2 text-xs hover:bg-muted/40"
    >
      <FileText className="h-4 w-4" />
      <span className="truncate">
        {asText(attachment?.fileName) || mediaType}
      </span>
    </a>
  );
}

function renderStandardRows(
  command: UnknownRecord,
  kind: string,
  t: ServiceCardTranslator
): ReactNode[] {
  if (kind === "reply_buttons") {
    return asRecords(command.options).map((option, index) => (
      <ServiceRow
        key={`${asText(option.id) || index}`}
        icon={MessageSquare}
        label={asText(option.label)}
      />
    ));
  }
  if (kind === "list") {
    return asRecords(command.sections).flatMap((section, sectionIndex) =>
      asRecords(section.rows).map((row, rowIndex) => (
        <ServiceRow
          key={`${sectionIndex}-${asText(row.id) || rowIndex}`}
          icon={List}
          label={asText(row.title)}
          description={asText(row.description) || undefined}
        />
      ))
    );
  }
  if (kind === "cta_url") {
    return [
      <ServiceRow
        key="cta"
        icon={ExternalLink}
        label={asText(command.buttonLabel)}
        href={asText(command.url)}
      />,
    ];
  }
  if (kind === "flow") {
    const flowConfig = asNullableRecord(command.flowConfig);
    return [
      <ServiceRow
        key="flow"
        icon={Workflow}
        label={asText(flowConfig?.ctaText) || t("whatsappServiceCard.flow")}
      />,
    ];
  }
  if (kind === "location_request") {
    return [
      <ServiceRow
        key="location-request"
        icon={MapPin}
        label={t("whatsappServiceCard.locationRequest")}
      />,
    ];
  }
  if (kind === "request_contact_info") {
    return [
      <ServiceRow
        key="contact-request"
        icon={UserRound}
        label={t("whatsappServiceCard.contactRequest")}
      />,
    ];
  }
  if (kind === "voice_call") {
    return [
      <ServiceRow
        key="voice-call"
        icon={Phone}
        label={
          asText(command.buttonLabel) || t("whatsappServiceCard.voiceCall")
        }
      />,
    ];
  }
  return [];
}

function CarouselCardMedia({
  media,
  workspaceId,
}: {
  media: UnknownRecord | null;
  workspaceId?: string | null;
}) {
  const mediaUrl = buildCreativeAssetDisplayUrl({
    workspaceId,
    url: asText(media?.url),
    bucket: asText(media?.bucket),
    path: asText(media?.path),
  });
  const mediaType = asText(media?.mediaType);
  const fileName = asText(media?.fileName);
  if (!mediaUrl) {
    return (
      <div className="flex h-36 w-full items-center justify-center bg-muted/40 text-[10px] text-muted-foreground">
        {fileName || "Media"}
      </div>
    );
  }

  if (mediaType === "video") {
    return (
      <video
        src={mediaUrl}
        muted
        playsInline
        preload="metadata"
        className="h-36 w-full object-cover"
        aria-label={fileName || "carousel video"}
      />
    );
  }

  // Signed GCS / CDN / proxy URLs are not in next/image remotePatterns.
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={mediaUrl}
      alt={fileName || ""}
      loading="lazy"
      decoding="async"
      className="h-36 w-full object-cover"
    />
  );
}

function CarouselCards({
  command,
  workspaceId,
}: {
  command: UnknownRecord;
  workspaceId?: string | null;
}) {
  const cards = asRecords(command.cards);
  if (cards.length === 0) return null;
  const keyedCards = withStableKeys(cards, card => asText(card.id));
  return (
    <div
      className={cn(
        "flex gap-2 overflow-x-auto overscroll-x-contain px-2 pb-2 pt-0.5",
        "[scrollbar-width:thin]",
        "[&::-webkit-scrollbar]:h-1.5",
        "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
      )}
      data-testid="whatsapp-service-carousel"
    >
      {keyedCards.map(({ record: card, key }) => {
        const media = asNullableRecord(card.media);
        const interaction = asNullableRecord(card.interaction);
        const interactionKind = asText(interaction?.kind);
        const buttonLabel = asText(interaction?.buttonLabel);
        const buttonUrl =
          interactionKind === "url" ? asText(interaction?.url) : "";
        const labels =
          interactionKind === "quick_replies"
            ? asRecords(interaction?.options).flatMap(option => {
                const label = asText(option.label);
                return label ? [label] : [];
              })
            : buttonLabel
              ? [buttonLabel]
              : [];
        return (
          <div
            key={key}
            className="w-[11.5rem] shrink-0 overflow-hidden rounded-lg border border-border/60 bg-background shadow-sm"
          >
            <CarouselCardMedia media={media} workspaceId={workspaceId} />
            {asText(card.bodyText) ? (
              <p className="whitespace-pre-wrap break-words px-2.5 py-2 text-xs leading-snug">
                {asText(card.bodyText)}
              </p>
            ) : null}
            {labels.map((label, labelIndex) =>
              buttonUrl ? (
                <a
                  key={`${label}-${labelIndex}`}
                  href={buttonUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-1 truncate border-t border-border/50 px-2 py-2 text-center text-[11px] font-medium text-primary hover:bg-muted/40"
                >
                  <span className="truncate">{label}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                </a>
              ) : (
                <div
                  key={`${label}-${labelIndex}`}
                  className="truncate border-t border-border/50 px-2 py-2 text-center text-[11px] font-medium text-primary"
                >
                  {label}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

function Contacts({ command }: { command: UnknownRecord }) {
  const contacts = asRecords(command.contacts);
  const keyedContacts = withStableKeys(contacts, contact =>
    [
      asText(contact.formattedName),
      asText(contact.phone),
      asText(contact.email),
    ].join(":")
  );
  return contacts.length > 0 ? (
    <div className="divide-y divide-border/50">
      {keyedContacts.map(({ record: contact, key }) => (
        <div key={key} className="flex items-center gap-2 px-2 py-2 text-xs">
          <UserRound className="h-4 w-4" />
          <span className="truncate">
            {asText(contact.formattedName) || asText(contact.phone)}
          </span>
        </div>
      ))}
    </div>
  ) : null;
}

function Location({ command }: { command: UnknownRecord }) {
  const location = asNullableRecord(command.location);
  if (!location) return null;
  const label =
    asText(location.name) ||
    asText(location.address) ||
    [location.latitude, location.longitude]
      .map(value => String(value ?? "").trim())
      .filter(Boolean)
      .join(", ");
  return label ? (
    <div className="flex items-center gap-2 px-2 py-2 text-xs">
      <MapPin className="h-4 w-4" />
      <span className="truncate">{label}</span>
    </div>
  ) : null;
}

function Commerce({
  command,
  t,
}: {
  command: UnknownRecord;
  t: ServiceCardTranslator;
}) {
  const commerce = asNullableRecord(command.commerce);
  if (!commerce) return null;
  const mode = asText(commerce.mode);
  const productCount =
    mode === "product_carousel"
      ? asStrings(commerce.productRetailerIds).length
      : mode === "multi_product"
        ? asRecords(commerce.sections).reduce(
            (total, section) =>
              total + asStrings(section.productRetailerIds).length,
            0
          )
        : mode === "single_product"
          ? 1
          : 0;
  return (
    <div className="flex items-center gap-2 px-2 py-2 text-xs">
      <ShoppingBag className="h-4 w-4" />
      <span>
        {productCount > 0
          ? t("whatsappServiceCard.productCount", { count: productCount })
          : t("whatsappServiceCard.catalog")}
      </span>
    </div>
  );
}

type ServiceMessageCardPreview = ReturnType<
  typeof resolveStoredWhatsAppServiceMessagePreview
> & { command: UnknownRecord };

/**
 * The stored service message as a card, or null for plain text and media,
 * which the regular message renderer shows.
 */
export function resolveWhatsAppServiceMessageCardPreview(
  stored: StoredWhatsAppServiceMessagePreview | null | undefined
): ServiceMessageCardPreview | null {
  const preview = resolveStoredWhatsAppServiceMessagePreview(stored);
  const { command, kind } = preview;
  return command && kind && kind !== "text" && kind !== "media"
    ? { ...preview, command }
    : null;
}

export function WhatsAppServiceMessageCard({
  preview,
  workspaceId,
}: {
  preview: ServiceMessageCardPreview;
  workspaceId?: string | null;
}) {
  const t = useTranslations("ConversationDetailView");
  const { bodyText: storedBodyText, command, kind } = preview;
  const commerce = asNullableRecord(command.commerce);
  const bodyText = asText(storedBodyText);
  const header = asNullableRecord(command.header);
  const footerText = asText(command.footerText) || asText(commerce?.footerText);
  const rows = renderStandardRows(command, kind, t);
  const isCarousel = kind === "media_carousel";

  return (
    <div
      className={cn(
        "mb-1.5 w-full overflow-hidden rounded-md border border-border/60 bg-background/70",
        isCarousel ? "max-w-[min(100%,26rem)]" : "max-w-[22rem]"
      )}
      data-testid="whatsapp-service-message-card"
    >
      {header?.kind === "media" ? (
        <HeaderMedia header={header} workspaceId={workspaceId} />
      ) : null}
      {header?.kind === "text" && asText(header.text) ? (
        <p className="px-2 pt-2 text-xs font-semibold">{asText(header.text)}</p>
      ) : null}
      {bodyText ? (
        <p className="whitespace-pre-wrap break-words px-2 py-2 text-sm">
          {bodyText}
        </p>
      ) : null}
      {isCarousel ? (
        <CarouselCards command={command} workspaceId={workspaceId} />
      ) : null}
      {kind === "contacts" ? <Contacts command={command} /> : null}
      {kind === "location" ? <Location command={command} /> : null}
      {kind === "commerce" ? <Commerce command={command} t={t} /> : null}
      {rows}
      {footerText ? (
        <p className="border-t border-border/50 px-2 py-1.5 text-[10px] text-muted-foreground">
          {footerText}
        </p>
      ) : null}
    </div>
  );
}
