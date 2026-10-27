"use client";

import { ImageOffIcon, QrCodeIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

export type WhatsAppQrArtworkProps = {
  workspaceId: string;
  codeId?: string;
  placementName: string;
  detailHref?: string;
};

export function WhatsAppQrArtwork({
  workspaceId,
  codeId,
  placementName,
  detailHref,
}: WhatsAppQrArtworkProps) {
  const t = useTranslations("WhatsAppQr.card");
  if (!codeId) {
    return <ArtworkUnavailable label={t("artworkUnavailable")} />;
  }

  const query = new URLSearchParams({
    workspaceId,
    format: "svg",
    disposition: "inline",
  });
  const source = `/api/whatsapp/qr-entry-points/${encodeURIComponent(codeId)}/artwork?${query.toString()}`;

  return (
    <LoadedArtwork
      key={source}
      source={source}
      detailHref={detailHref}
      openLabel={t("openArtwork", { name: placementName })}
      altLabel={t("artworkAlt", { name: placementName })}
      unavailableLabel={t("artworkUnavailable")}
    />
  );
}

function LoadedArtwork({
  source,
  detailHref,
  openLabel,
  altLabel,
  unavailableLabel,
}: {
  source: string;
  detailHref?: string;
  openLabel: string;
  altLabel: string;
  unavailableLabel: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  if (unavailable) {
    return <ArtworkUnavailable label={unavailableLabel} />;
  }

  const artwork = (
    <>
      {!loaded ? (
        <div
          data-testid="whatsapp-qr-artwork-placeholder"
          className="absolute inset-0 flex size-full items-center justify-center bg-muted/40 text-muted-foreground"
          aria-hidden="true"
        >
          <QrCodeIcon className="size-9" />
        </div>
      ) : null}
      <Image
        src={source}
        alt={altLabel}
        width={320}
        height={320}
        className={`size-full object-contain p-3 transition-opacity duration-200 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        loading="lazy"
        unoptimized
        onLoad={() => setLoaded(true)}
        onError={() => setUnavailable(true)}
      />
    </>
  );

  const className =
    "relative block aspect-square min-w-0 overflow-hidden rounded-lg border bg-muted/30";

  return detailHref ? (
    <Link
      href={detailHref}
      className={`${className} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      aria-label={openLabel}
    >
      {artwork}
    </Link>
  ) : (
    <div className={className}>{artwork}</div>
  );
}

function ArtworkUnavailable({ label }: { label: string }) {
  return (
    <div
      className="flex aspect-square min-w-0 flex-col items-center justify-center gap-2 rounded-lg border bg-muted/30 p-4 text-center text-muted-foreground"
      role="img"
      aria-label={label}
    >
      <span className="relative" aria-hidden="true">
        <QrCodeIcon className="size-9" />
        <ImageOffIcon className="absolute -right-1 -bottom-1 size-4" />
      </span>
      <span className="text-xs">{label}</span>
    </div>
  );
}
