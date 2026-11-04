"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  productTemplateOfPost,
  type ProductTemplate,
} from "@/lib/products/templates";
import {
  PRODUCT_AD_CAPTION_HASHTAGS_MAX,
  PRODUCT_AD_CAPTION_MAX,
  type ProductAdPostDestination,
  type ProductAdPostRecord,
  type ProductAdPublishRequest,
  type ProductAdRecord,
  type ProductAdStillChoice,
  type ProductsErrorCode,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { Globe, Instagram } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  loadAdPost,
  PRODUCT_META_POLL_MS,
  PRODUCT_POST_POLL_LIMIT_MS,
  publishAdPost,
} from "./meta-client";
import { adRequestId } from "./product-ad-parts";
import theme from "./product-theme.module.css";
import styles from "./product-workbench.module.css";
import { ProductDraftError } from "./products-client";

// The Instagram confirm, the only place the workbench asks before something
// becomes public: the picture(s), "@airi.chat__", "Public. Everyone can see
// it.", and the caption as it will post (Muse Spark's opening composed by
// code, prices drawn by code). A tap on the caption turns it into the one
// free-text field of the page, capped at Instagram's 2,200 characters.
// Enter doesn't post: the button must be pressed. A dialog on a wide
// screen, a bottom sheet on a phone (the app's dialog does both).
//
// And the post itself: POST …/publish answers at once with the post being
// processed; the workbench asks every 3 s (each ask advances it at
// Instagram) until it's live or failed, for up to 4 minutes, then says
// "Still processing at Instagram" with Check again.

const COPY = PRODUCTS_COPY.publish;
const BENCH = PRODUCTS_COPY.workbench;

/** Hashtags in a caption. */
export const hashtagCount = (caption: string) =>
  (caption.match(/(^|\s)#[^\s#]+/gu) ?? []).length;

/** Why a caption can't go to Instagram; null when it can. */
export function captionIssue(caption: string): string | null {
  if (Array.from(caption).length > PRODUCT_AD_CAPTION_MAX) return COPY.tooLong;
  if (hashtagCount(caption) > PRODUCT_AD_CAPTION_HASHTAGS_MAX)
    return COPY.tooManyHashtags(PRODUCT_AD_CAPTION_HASHTAGS_MAX);
  return null;
}

export function PublishSheet({
  open,
  onOpenChange,
  onReturnFocus,
  destination,
  account,
  pictures,
  caption: initialCaption,
  sending,
  problem,
  onPost,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReturnFocus?: () => void;
  destination: ProductAdPostDestination;
  /** The Instagram @name it posts as. */
  account: string;
  /** Thumbnails of what posts: the poster, or the picture(s). */
  pictures: readonly string[];
  /** The ad's post text; empty when it has none. */
  caption: string;
  sending: boolean;
  /** Why the last press was refused, in the owner's words; null otherwise. */
  problem: string | null;
  /** "Post": the caption as shown (edited or not). */
  onPost: (caption: string) => void;
}) {
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(initialCaption);
  // Each opening starts from the ad's own text.
  const [openedAs, setOpenedAs] = useState(open);
  if (open !== openedAs) {
    setOpenedAs(open);
    if (open) {
      setEditing(false);
      setCaption(initialCaption);
    }
  }
  const hasCaption = destination !== "story";
  const issue = hasCaption ? captionIssue(caption) : null;
  return (
    <Dialog open={open} onOpenChange={next => !sending && onOpenChange(next)}>
      <DialogContent
        onCloseAutoFocus={event => {
          if (onReturnFocus) {
            event.preventDefault();
            onReturnFocus();
          }
        }}
        showCloseButton={false}
        overlayClassName={theme.scrim}
        className={cn(theme.theme, styles.sheet)}
      >
        <DialogTitle className={cn(theme.displayM, styles.sheetTitle)}>
          <Instagram aria-hidden="true" />
          {COPY.title[destination]}
        </DialogTitle>
        <div className={styles.sheetBody}>
          <div className={styles.sheetThumbs} aria-hidden="true">
            {pictures.slice(0, 4).map((url, index) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={`${index}-${url}`} src={url} alt="" decoding="async" />
            ))}
          </div>
          <div className={styles.sheetText}>
            <p className={styles.sheetAccount}>
              <span className={styles.avatar} aria-hidden="true">
                {(account.replace(/^@/, "")[0] ?? "A").toUpperCase()}
              </span>
              {account}
            </p>
            <DialogDescription className={styles.sheetPublic}>
              <Globe aria-hidden="true" />
              {COPY.publicNote}
            </DialogDescription>
            {hasCaption &&
              (editing ? (
                <div className={styles.captionField}>
                  <label htmlFor={`${ids}-caption`} className="sr-only">
                    {COPY.caption}
                  </label>
                  <textarea
                    id={`${ids}-caption`}
                    className={styles.captionInput}
                    value={caption}
                    maxLength={PRODUCT_AD_CAPTION_MAX}
                    rows={5}
                    autoFocus
                    disabled={sending}
                    aria-describedby={`${ids}-count`}
                    onChange={event => setCaption(event.target.value)}
                  />
                  <span id={`${ids}-count`} className={styles.captionCount}>
                    {COPY.captionCount(
                      Array.from(caption).length,
                      PRODUCT_AD_CAPTION_MAX
                    )}
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.captionShown}
                  aria-label={`${COPY.editCaption}: ${caption}`}
                  disabled={sending}
                  onClick={() => setEditing(true)}
                >
                  {caption || COPY.caption}
                </button>
              ))}
            {issue ? (
              <p role="alert" className={styles.issue}>
                {issue}
              </p>
            ) : null}
            {problem ? (
              <p role="alert" className={styles.issue}>
                {problem}
              </p>
            ) : null}
          </div>
        </div>
        <div className={styles.sheetActions}>
          <Button
            type="button"
            variant="ghost"
            disabled={sending}
            onClick={() => onOpenChange(false)}
          >
            {COPY.notNow}
          </Button>
          <Button
            type="button"
            disabled={sending || issue !== null}
            onClick={() => onPost(hasCaption ? caption : "")}
          >
            <Instagram aria-hidden="true" />
            {sending ? COPY.posting : COPY.post}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A Meta refusal's words; the generic one for a code it has none for. */
export function metaRefusal(code: ProductsErrorCode | "failed"): string {
  const refusals: Record<string, string> = BENCH.refusals;
  return refusals[code] ?? BENCH.refusals.failed;
}

/** The newest post of the ad that went out from this tile; null when none. */
export function latestTilePost(
  ad: Pick<ProductAdRecord, "meta">,
  template: Pick<ProductTemplate, "id">,
  still?: ProductAdStillChoice | null
): ProductAdPostRecord | null {
  const posts = ad.meta?.posts ?? [];
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    const post = posts[index]!;
    if (
      productTemplateOfPost(post)?.id === template.id &&
      (still === undefined ||
        (post.still?.kind === still?.kind &&
          post.still?.productId === still?.productId &&
          (post.still?.colourway ?? null) === (still?.colourway ?? null)))
    )
      return post;
  }
  return null;
}

const inFlight = (post: ProductAdPostRecord | null) =>
  post?.state === "processing" || post?.state === "publishing";

/**
 * The tile's post: the newest one, kept current while Instagram makes it.
 * `publish` posts after the confirm; `onSettled` hears it go live or fail.
 */
export function useTilePost({
  workspaceId,
  ad,
  template,
  still,
  onSettled,
}: {
  workspaceId: string;
  ad: ProductAdRecord;
  template: Pick<ProductTemplate, "id">;
  still?: ProductAdStillChoice | null;
  onSettled: (post: ProductAdPostRecord) => void;
}) {
  const scope = JSON.stringify([
    workspaceId,
    ad.id,
    template.id,
    still?.kind ?? null,
    still?.productId ?? null,
    still?.colourway ?? null,
  ]);
  const stored = latestTilePost(ad, template, still);
  const [answer, setAnswer] = useState<{
    scope: string;
    post: ProductAdPostRecord;
  } | null>(null);
  const local = answer?.scope === scope ? answer.post : null;
  const post =
    local &&
    (!stored ||
      local.id === stored.id ||
      Date.parse(local.requestedAt) >= Date.parse(stored.requestedAt))
      ? local
      : stored;
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<ProductsErrorCode | "failed" | null>(
    null
  );
  const [pollFrom, setPollFrom] = useState<number | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const settled = useRef(onSettled);
  const pendingRequest = useRef<{ scope: string; id: string } | null>(null);
  const sendingNow = useRef(false);
  useEffect(() => {
    settled.current = onSettled;
  });

  const postId = post?.id ?? null;
  const flying = inFlight(post);
  useEffect(() => {
    if (!flying || !postId || gaveUp) return;
    const started = pollFrom ?? Date.now();
    if (pollFrom === null) setPollFrom(started);
    let stop = false;
    const timer = setInterval(() => {
      if (Date.now() - started > PRODUCT_POST_POLL_LIMIT_MS) {
        setGaveUp(true);
        return;
      }
      void loadAdPost(workspaceId, ad.id, postId)
        .then(next => {
          if (stop) return;
          setAnswer({ scope, post: next });
          if (!inFlight(next)) settled.current(next);
        })
        .catch(() => undefined);
    }, PRODUCT_META_POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [flying, postId, gaveUp, pollFrom, workspaceId, ad.id, scope]);

  const publish = useCallback(
    async (request: Omit<ProductAdPublishRequest, "requestId">) => {
      if (sendingNow.current) return false;
      sendingNow.current = true;
      setSending(true);
      setRefusal(null);
      // A lost HTTP answer is not proof that nothing was posted. Keep the
      // same intent until the server acknowledges it, including after the
      // owner closes and reopens the tile in this tab.
      const storageKey = `products:pending-post:${scope}`;
      let requestId =
        pendingRequest.current?.scope === scope
          ? pendingRequest.current.id
          : null;
      try {
        requestId ??= sessionStorage.getItem(storageKey);
      } catch {
        // Storage can be unavailable; the mounted workbench still retries safely.
      }
      requestId ??= adRequestId();
      pendingRequest.current = { scope, id: requestId };
      try {
        sessionStorage.setItem(storageKey, requestId);
      } catch {}
      try {
        const next = await publishAdPost(workspaceId, ad.id, {
          requestId,
          ...request,
        });
        pendingRequest.current = null;
        try {
          sessionStorage.removeItem(storageKey);
        } catch {}
        setAnswer({ scope, post: next });
        setGaveUp(false);
        setPollFrom(Date.now());
        if (!inFlight(next)) settled.current(next);
        return true;
      } catch (error) {
        setRefusal(error instanceof ProductDraftError ? error.code : "failed");
        return false;
      } finally {
        sendingNow.current = false;
        setSending(false);
      }
    },
    [workspaceId, ad.id, scope]
  );

  const checkAgain = useCallback(() => {
    setGaveUp(false);
    setPollFrom(Date.now());
  }, []);

  return {
    post,
    sending,
    refusal,
    clearRefusal: () => setRefusal(null),
    publish,
    stillProcessing: flying && gaveUp,
    checkAgain,
  };
}
