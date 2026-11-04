"use client";

// "Out on Meta" (studio v3; it replaces v2's "Made from your shelf"): one
// row of receipts for what actually exists at Meta, newest first. An
// Instagram post that went live, the Click-to-WhatsApp ad once it's made
// (paused or running), and a WhatsApp carousel and order form once they
// reached Meta. Each has its picture, what it is, where it went, the time,
// its status and its link. A receipt opens its tile's workbench. Ads that
// never went out stay reachable by opening their tile again. It shows
// nothing while nothing is out.

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  productTemplateOfCtwa,
  productTemplateOfPost,
  type ProductTemplateStamp,
} from "@/lib/products/templates";
import type {
  ProductAdRecord,
  ProductAdPostRecord,
  ProductKitRecord,
  ProductsMadeResponse,
} from "@/lib/products/types";
import { ExternalLink, Globe, MessageCircle } from "lucide-react";
import { useId, useMemo } from "react";
import { templateHref, whatsAppFlowsHref } from "./kit-links";
import { ctwaRunState } from "./product-ctwa-panel";
import styles from "./product-made-list.module.css";
import { useProductsMade } from "./use-product-kits";

const COPY = PRODUCTS_COPY.outOnMeta;
const STAMPS = PRODUCTS_COPY.gallery.stamps;

/** What the page gives the row. */
export type MadeListProps = {
  workspaceId: string;
  /**
   * A receipt of an ad's post or WhatsApp ad: that ad's workbench
   * (?ad=<adId>), on the tile it went out from when that's known.
   */
  onOpenAd: (adId: string, templateId: string | null) => void;
  /** Kept from v2's list for the page's mount; Out on Meta makes nothing itself. */
  onMakeAd?: (productIds: string[]) => void;
  /** A kit's receipt: the WhatsApp chat tile with its products. */
  onOpenKit?: (kit: ProductKitRecord) => void;
};

/** One thing out on Meta. */
export type OutOnMetaReceipt = {
  key: string;
  /** What it is: Reel, Story, Post, Carousel, WhatsApp ad, Carousel + form. */
  what: string;
  /** Where it went: Instagram, Facebook, WhatsApp. */
  where: string;
  at: string;
  stamp: ProductTemplateStamp;
  statusLabel?: string;
  /** The tile it went out from, for the page's stamps. */
  templateId: string | null;
  thumb: string | null;
  href: string | null;
  /** Its link opens airi's own page, not Meta's. */
  internal: boolean;
  open: { kind: "ad"; adId: string } | { kind: "kit"; kit: ProductKitRecord };
};

const posterOf = (ad: ProductAdRecord) =>
  ad.video?.posterUrl ??
  ad.stills.statusUrl ??
  ad.products[0]?.imageUrl ??
  null;

const pictureOf = (
  ad: ProductAdRecord,
  post: Pick<ProductAdPostRecord, "destination" | "still" | "slides">
) => {
  const choice = post.still ?? post.slides[0];
  if (!choice) return posterOf(ad);
  const format = post.destination === "story" ? "story" : "feed";
  return (
    ad.stills.templates?.find(
      still =>
        still.kind === choice.kind &&
        still.format === format &&
        still.productId === choice.productId &&
        (!choice.colourway || still.colourway === choice.colourway)
    )?.url ??
    (choice.kind === "room" &&
    format === "feed" &&
    choice.productId === ad.products[0]?.productId
      ? ad.stills.feedUrl
      : null) ??
    ad.products.find(product => product.productId === choice.productId)
      ?.imageUrl ??
    ad.products[0]?.imageUrl ??
    null
  );
};

/** The stamp of a WhatsApp carousel and order form, from Meta's verdict. */
function kitStamp(kit: ProductKitRecord): ProductTemplateStamp | null {
  const carousel = kit.parts.carousel;
  if (carousel?.state === "submitted") {
    const status = carousel.metaStatus ?? "";
    if (status === "APPROVED") return "approved";
    if (["REJECTED", "PAUSED", "DISABLED"].includes(status)) return "failed";
    return "in_review";
  }
  if (kit.parts.orderForm?.state === "ready") return "live";
  return null;
}

/** Everything out on Meta, newest first. */
export function outOnMeta(
  workspaceId: string,
  made: Pick<ProductsMadeResponse, "ads" | "kits">
): OutOnMetaReceipt[] {
  const receipts: OutOnMetaReceipt[] = [];
  for (const ad of made.ads) {
    for (const post of ad.meta?.posts ?? []) {
      if (post.state !== "published") continue;
      receipts.push({
        key: `post-${ad.id}-${post.id}`,
        what: COPY.kinds[post.destination],
        where: COPY.places.instagram,
        at: post.publishedAt ?? post.requestedAt,
        stamp: "live",
        templateId: productTemplateOfPost(post)?.id ?? null,
        thumb:
          post.still || post.slides.length > 0
            ? pictureOf(ad, post)
            : posterOf(ad),
        href: post.permalink,
        internal: false,
        open: { kind: "ad", adId: ad.id },
      });
    }
    const ctwa = ad.meta?.ctwa ?? null;
    if (ctwa && (ctwa.state === "paused" || ctwa.state === "running")) {
      const run = ctwaRunState(ctwa);
      receipts.push({
        key: `ctwa-${ad.id}-${ctwa.attempt}`,
        what: COPY.kinds.ctwa,
        where: COPY.places.facebook,
        at: ad.requestedAt,
        stamp:
          run === "running"
            ? "live"
            : run === "in_review" || run === "unknown"
              ? "in_review"
              : run === "disapproved"
                ? "failed"
                : "paused",
        templateId: productTemplateOfCtwa(ctwa).id,
        ...(run === "unknown"
          ? { statusLabel: PRODUCTS_COPY.ctwa.checkingMeta }
          : {}),
        thumb:
          ctwa.asset === "picture"
            ? pictureOf(ad, {
                destination: "post",
                still: {
                  kind: "room",
                  productId: ad.products[0]?.productId ?? null,
                },
                slides: [],
              })
            : posterOf(ad),
        href: ctwa.adsManagerUrl,
        internal: false,
        open: { kind: "ad", adId: ad.id },
      });
    }
  }
  for (const kit of made.kits) {
    const stamp = kitStamp(kit);
    if (!stamp) continue;
    const template = kit.parts.carousel?.templateName ?? null;
    receipts.push({
      key: `kit-${kit.id}`,
      what: COPY.kinds.kit,
      where: COPY.places.whatsapp,
      at: kit.createdAt,
      stamp,
      templateId: "chat_kit",
      thumb: null,
      href:
        kit.parts.carousel?.state === "submitted"
          ? templateHref(workspaceId, template)
          : whatsAppFlowsHref(workspaceId),
      internal: true,
      open: { kind: "kit", kit },
    });
  }
  return receipts.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const TONES: Record<ProductTemplateStamp, string> = {
  live: "ok",
  approved: "ok",
  in_review: "neutral",
  paused: "neutral",
  failed: "danger",
};

/** The row. It shows nothing while nothing is out on Meta. */
export function MadeList({ workspaceId, onOpenAd, onOpenKit }: MadeListProps) {
  const titleId = useId();
  const made = useProductsMade(workspaceId);
  const receipts = useMemo(
    () => (made.data ? outOnMeta(workspaceId, made.data) : []),
    [made.data, workspaceId]
  );

  if (!made.data) {
    if (!made.error) return null;
    return (
      <div role="alert" className={styles.error}>
        <span>{COPY.loadError}</span>
        <Button size="sm" variant="outline" onClick={() => void made.mutate()}>
          {COPY.retry}
        </Button>
      </div>
    );
  }
  if (receipts.length === 0) return null;

  return (
    <section aria-labelledby={titleId} className={styles.out}>
      <h2 id={titleId} className={styles.title}>
        <Globe aria-hidden="true" />
        {COPY.title}
      </h2>
      <ul className={styles.receipts}>
        {receipts.map(receipt => {
          const name = `${receipt.what} · ${receipt.where}`;
          const canOpen = receipt.open.kind === "ad" || onOpenKit !== undefined;
          const body = (
            <>
              <span className={styles.thumb} aria-hidden="true">
                {receipt.thumb ? (
                  // Signed storage links; next/image would need every bucket host.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={receipt.thumb} alt="" draggable={false} />
                ) : receipt.open.kind === "kit" ? (
                  <MessageCircle />
                ) : null}
              </span>
              <span className={styles.what}>
                <strong>{receipt.what}</strong>
                <span className={styles.where}>
                  {` · ${receipt.where} · ${COPY.clock(receipt.at)}`}
                </span>
              </span>
            </>
          );
          return (
            <li key={receipt.key} className={styles.receipt}>
              {canOpen ? (
                <button
                  type="button"
                  className={styles.open}
                  aria-label={COPY.open(name)}
                  onClick={() => {
                    if (receipt.open.kind === "ad")
                      onOpenAd(receipt.open.adId, receipt.templateId);
                    else onOpenKit?.(receipt.open.kit);
                  }}
                >
                  {body}
                </button>
              ) : (
                <span className={styles.open}>{body}</span>
              )}
              <span className={styles.stamp} data-tone={TONES[receipt.stamp]}>
                {receipt.statusLabel ?? STAMPS[receipt.stamp]}
              </span>
              {receipt.href ? (
                <a
                  className={styles.link}
                  href={receipt.href}
                  {...(receipt.internal
                    ? {}
                    : { target: "_blank", rel: "noopener noreferrer" })}
                  aria-label={COPY.link(name)}
                >
                  <ExternalLink aria-hidden="true" />
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Out on Meta" by its v3 name. */
export const OutOnMeta = MadeList;
