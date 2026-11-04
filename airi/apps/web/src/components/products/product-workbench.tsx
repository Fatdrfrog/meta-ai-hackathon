"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { panelSettingsHref } from "@/features/panel/shared/routing/hrefs";
import { oneLine } from "@/lib/products/ad-request";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductTemplate } from "@/lib/products/templates";
import {
  PRODUCT_AD_PLACE_WORDS_MAX,
  PRODUCT_AD_SETTINGS,
  PRODUCT_AD_TEXT_LIMITS,
  productAdMotionOf,
  type ProductAdPublishRequest,
  type ProductAdRecord,
  type ProductAdRecordStill,
  type ProductAdSetting,
  type ProductAdStillFormat,
  type ProductAdStillKind,
  type ProductAdStudioColourway,
  type ProductsErrorCode,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { Check, ExternalLink, Instagram, Megaphone, X } from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  downloadProductAdFile,
  redoProductAdScene,
  retryProductAd,
} from "./ads-client";
import {
  makingProgress,
  makingSteps,
  WAITING_FOR_SLOT_MS,
} from "./product-ad-making";
import {
  adFileName,
  adRequestId,
  clockTime,
  wordsEdited,
  wordsIssue,
} from "./product-ad-parts";
import {
  CtwaDetails,
  ctwaStatusWord,
  RunSheet,
  useCtwa,
} from "./product-ctwa-panel";
import {
  metaRefusal,
  PublishSheet,
  useTilePost,
} from "./product-publish-sheet";
import theme from "./product-theme.module.css";
import { KitWorkbench } from "./product-workbench-kit";
import {
  MetaCredits,
  useMetaReadiness,
  WorkbenchFooter,
  type MoreItem,
} from "./product-workbench-parts";
import {
  WorkbenchPreview,
  type WorkbenchCycle,
  type WorkbenchPicture,
} from "./product-workbench-preview";
import {
  adVoiceKey,
  LookRail,
  MusicRail,
  nextSetting,
  ShotsRail,
  VoiceRail,
  type PlacePick,
  type VoicePick,
  type WorkbenchLook,
} from "./product-workbench-rails";
import styles from "./product-workbench.module.css";
import { ProductDraftError } from "./products-client";
import { changeProductAdVoice } from "./voices-client";
import {
  useAdAutoUpdate,
  useNow,
  useProductAd,
  useSharedAdAutoUpdate,
} from "./use-product-ad";

// The workbench (studio v3, stream U2): the result of a tile, built in place
// under the tile's group row with a notch pointing at the tile. The preview
// in its real frame, picture rails (Shots, Look, Voice), and one Meta action
// labelled by the tile. One is open at a time; Escape closes it and the page
// returns focus to the tile. Not product-stage.tsx, which is the import's
// stage.
//
// Picks (a look, Wall, an opening or ending, a voice) wait for the owner's
// one Update press: one run for all of them, a free render or, with a new
// voice, the voice run, whose price the button names; the earlier video keeps
// playing meanwhile. Opening another Reel tile makes its motion at once. New
// place needs its own second tap. Only Post asks first (it's public), and Run
// (it spends); Create ad makes everything paused, and Create on WhatsApp only
// submits for review.

const COPY = PRODUCTS_COPY.workbench;
const AD = PRODUCTS_COPY.ad;

/** What the tile made, or is making. */
export type ProductWorkbenchSubject =
  /**
   * The ad is being asked for: the make's POST /products/ads hasn't answered
   * yet, or it was refused (`error`: ai_disabled, not_enough_products,
   * spend_limit…). The page swaps it for "ad" once the POST answers.
   */
  | { kind: "ad-pending"; error: ProductsErrorCode | "failed" | null }
  /** Every Reel, Story, Post and WhatsApp-ad tile: the one ad these picks made or reused. */
  | { kind: "ad"; adId: string }
  /**
   * The WhatsApp chat tile: v2's kit, made by the workbench's own "Create on
   * WhatsApp" from these products (all picks, up to 10, in pick order).
   */
  | { kind: "kit"; productIds: string[]; importId: string | null };

/** What the page gives the workbench. */
export type ProductWorkbenchProps = {
  workspaceId: string;
  /** The tile it opened from: its frame, its rails and its one Meta action. */
  template: ProductTemplate;
  subject: ProductWorkbenchSubject;
  /** The picks the tile uses, in pick order, as the shelf lists them. */
  picks: readonly WorkspaceProductRecord[];
  /**
   * A pick has a price to check (its red tag): the Meta action is disabled
   * with "Tap the red tag first", and the tag on the shelf is the fix.
   */
  priceToCheck: boolean;
  /**
   * The DOM id of the tile it opened from: the workbench is labelled by it
   * (aria-labelledby), and the page returns focus to it on close.
   */
  tileId: string;
  /** Escape or Close: the page closes it and returns focus to the tile. */
  onClose: () => void;
  /** "Try again" on a refused make ("ad-pending" with an error): the page makes again. */
  onRetryMake?: () => void;
  onCheckPrice?: () => void;
  /**
   * The ⋯ menu's "Check one by one": the page's swipe review of that import
   * (?review=<import>). Absent when the picks came from no import.
   */
  onCheckOneByOne?: (importId: string) => void;
  /**
   * Something changed that the page shows elsewhere (a run finished, a post
   * or the WhatsApp ad went out, a kit was made): it refreshes its tiles'
   * art and stamps and "Out on Meta".
   */
  onChanged?: () => void;
};

/** Where Instagram and Meta Ads are connected: Settings › Integrations. */
export const integrationHref = (
  workspaceId: string,
  integration: "instagram" | "meta_ads"
) => `${panelSettingsHref(workspaceId)}?integration=${integration}`;

/** The workbench. */
export function ProductWorkbench({
  workspaceId,
  template,
  subject,
  picks,
  priceToCheck,
  tileId,
  onClose,
  onRetryMake,
  onCheckPrice,
  onCheckOneByOne,
  onChanged,
}: ProductWorkbenchProps) {
  const ref = useRef<HTMLElement>(null);
  // Focus moves into the workbench after a make, and it comes into view.
  useEffect(() => {
    const element = ref.current;
    element?.focus({ preventScroll: true });
    element?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    // A sheet or menu opened from here closes itself first.
    if (!ref.current?.contains(event.target as Node)) return;
    event.stopPropagation();
    onClose();
  };

  const importId = picks.find(pick => pick.importId)?.importId ?? null;
  const more: MoreItem[] =
    importId && onCheckOneByOne
      ? [
          {
            key: "review",
            label: COPY.menu.checkOneByOne,
            onSelect: () => onCheckOneByOne(importId),
          },
        ]
      : [];

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={tileId}
      data-template={template.id}
      className={styles.workbench}
      onKeyDown={onKeyDown}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={styles.close}
        aria-label={COPY.close}
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
      {subject.kind === "ad" ? (
        <AdWorkbench
          key={subject.adId}
          workspaceId={workspaceId}
          template={template}
          adId={subject.adId}
          priceToCheck={priceToCheck}
          onChanged={onChanged}
          more={more}
        />
      ) : subject.kind === "kit" ? (
        <KitWorkbench
          key={subject.productIds.join(",")}
          workspaceId={workspaceId}
          productIds={subject.productIds}
          importId={subject.importId}
          priceToCheck={priceToCheck}
          onChanged={onChanged}
          more={more}
        />
      ) : (
        <PendingWorkbench
          template={template}
          picks={picks}
          error={subject.error}
          onRetryMake={onRetryMake}
          onCheckPrice={onCheckPrice}
          more={more}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// While the make's POST is on its way, or after it was refused.

const createError = (code: ProductsErrorCode | "failed") => {
  const errors: Record<string, string> = AD.createErrors;
  return errors[code] ?? AD.createErrors.failed;
};

function PendingWorkbench({
  template,
  picks,
  error,
  onRetryMake,
  onCheckPrice,
  more,
}: {
  template: ProductTemplate;
  picks: readonly WorkspaceProductRecord[];
  error: ProductsErrorCode | "failed" | null;
  onRetryMake?: () => void;
  onCheckPrice?: () => void;
  more: readonly MoreItem[];
}) {
  const first = picks[0];
  return (
    <div className={styles.body}>
      <div className={styles.previewCol}>
        <div className={styles.sketch} data-format={template.format}>
          {first?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={first.imageUrl} alt="" decoding="async" data-cutout="" />
          ) : null}
        </div>
        <MetaCredits />
      </div>
      <div className={styles.side}>
        {error ? (
          <div className={styles.problem}>
            <p role="alert" className={styles.alert}>
              {error === "price_to_check"
                ? COPY.states.priceToCheck
                : error === "ai_disabled"
                  ? COPY.states.aiOff
                  : createError(error)}
            </p>
            {error === "price_to_check" && onCheckPrice ? (
              <Button type="button" onClick={onCheckPrice}>
                {PRODUCTS_COPY.page.checkPrice}
              </Button>
            ) : onRetryMake &&
              error !== "ai_disabled" &&
              error !== "price_to_check" ? (
              <Button type="button" onClick={onRetryMake}>
                {COPY.states.tryAgain}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className={styles.making} role="status">
            <p className={styles.makingHead}>{COPY.asking}</p>
            <ol className={styles.steps}>
              {(["script", "pictures", "framing", "video"] as const).map(
                (step, index) => (
                  <li
                    key={step}
                    className={styles.stepItem}
                    data-state={index === 0 ? "now" : "next"}
                  >
                    <span className={styles.stepMark} aria-hidden="true" />
                    <span className={styles.stepName}>
                      {step === "pictures"
                        ? AD.steps.pictures(0, Math.min(picks.length, 3))
                        : AD.steps[step]}
                    </span>
                    <span className={styles.stepModel}>
                      {AD.stepModels[step]}
                    </span>
                  </li>
                )
              )}
            </ol>
            <p className={styles.note}>{COPY.keepPicking}</p>
          </div>
        )}
        <WorkbenchFooter
          target={null}
          more={more}
          action={
            <Button type="button" disabled>
              {COPY.actions[template.action]}
            </Button>
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The ad: made, being made, or failed.

function AdWorkbench({
  workspaceId,
  template,
  adId,
  priceToCheck,
  onChanged,
  more,
}: {
  workspaceId: string;
  template: ProductTemplate;
  adId: string;
  priceToCheck: boolean;
  onChanged?: () => void;
  more: readonly MoreItem[];
}) {
  const { data: ad, error, mutate } = useProductAd(workspaceId, adId);
  const setAd = useCallback(
    (next: ProductAdRecord) => void mutate(next, { revalidate: false }),
    [mutate]
  );
  const refresh = useCallback(() => void mutate(), [mutate]);
  const auto = useSharedAdAutoUpdate({
    workspaceId,
    ad,
    onAd: setAd,
    onStale: refresh,
  });

  // Switching between Reel tiles queues the tile's motion as a pending pick
  // for the owner's one Update video press, without auto-regenerating.
  const want =
    template.renderer === "motion" ? (template.motion ?? null) : null;
  const motion = ad ? productAdMotionOf(ad.motion) : null;
  const hasVideo = Boolean(ad?.video);
  const { queue } = auto;
  useEffect(() => {
    if (!want || !hasVideo || motion === null) return;
    queue({ motion: want });
  }, [want, motion, hasVideo, queue]);

  // A run that ends changes the tiles' art and stamps on the page.
  const status = ad?.status;
  const was = useRef(status);
  useEffect(() => {
    if (was.current === "making" && status && status !== "making")
      onChanged?.();
    was.current = status;
  }, [status, onChanged]);

  if (!ad)
    return (
      <div className={styles.body}>
        <div className={styles.previewCol} aria-hidden="true">
          <div className={styles.sketch} data-format={template.format} />
        </div>
        <div className={styles.side}>
          <div className={styles.problem}>
            {error?.code === "ad_not_found" ? (
              <p role="alert" className={styles.alert}>
                {COPY.notFound}
              </p>
            ) : error ? (
              <>
                <p role="alert" className={styles.alert}>
                  {COPY.loadFailed}
                </p>
                <Button type="button" variant="outline" onClick={refresh}>
                  {COPY.retry}
                </Button>
              </>
            ) : (
              <p role="status" className={styles.note}>
                {COPY.loading}
              </p>
            )}
          </div>
          <WorkbenchFooter
            target={null}
            more={more}
            action={
              <Button type="button" disabled>
                {COPY.actions[template.action]}
              </Button>
            }
          />
        </div>
      </div>
    );

  if (!ad.video && ad.status === "making")
    return <AdMakingBench ad={ad} template={template} more={more} />;
  if (!ad.video && ad.status === "failed")
    return (
      <AdFailedBench
        workspaceId={workspaceId}
        ad={ad}
        template={template}
        onAd={setAd}
        more={more}
      />
    );
  return (
    <AdReadyBench
      workspaceId={workspaceId}
      template={template}
      ad={ad}
      auto={auto}
      setAd={setAd}
      refresh={refresh}
      priceToCheck={priceToCheck}
      onChanged={onChanged}
      more={more}
    />
  );
}

/** The first make: the honest steps, each with its Meta model and its seconds. */
function AdMakingBench({
  ad,
  template,
  more,
}: {
  ad: ProductAdRecord;
  template: ProductTemplate;
  more: readonly MoreItem[];
}) {
  const now = useNow(true);
  const elapsed = Math.max(0, now - Date.parse(ad.requestedAt));
  const waiting = ad.startedAt === null && elapsed > WAITING_FOR_SLOT_MS;
  const steps = makingSteps(ad, now);
  const progress = Math.round(makingProgress(ad) * 100);
  const picture =
    ad.stills.statusUrl ??
    ad.scenes.find(scene => scene.imageUrl)?.imageUrl ??
    null;
  const first = ad.products[0];
  return (
    <div className={styles.body}>
      <div className={styles.previewCol}>
        <div className={styles.sketch} data-format={template.format}>
          {picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={picture} alt="" decoding="async" />
          ) : first?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={first.imageUrl} alt="" decoding="async" data-cutout="" />
          ) : null}
        </div>
        <MetaCredits />
      </div>
      <div className={styles.side}>
        <div className={styles.making}>
          <p className={styles.makingHead}>{COPY.making(clockTime(elapsed))}</p>
          <div
            role="progressbar"
            aria-label={AD.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className={styles.progress}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
          <ol className={styles.steps}>
            {steps.map(row => (
              <li
                key={row.step}
                className={styles.stepItem}
                data-state={row.state}
              >
                <span className={styles.stepMark} aria-hidden="true">
                  {row.state === "done" ? <Check /> : null}
                </span>
                <span className={styles.stepName}>
                  {row.name}
                  <span className="sr-only">, {AD.stepStates[row.state]}</span>
                </span>
                <span className={styles.stepModel}>{row.model}</span>
                <span className={styles.stepTime}>
                  {row.seconds === null ? "" : AD.seconds(row.seconds)}
                </span>
              </li>
            ))}
          </ol>
          {waiting ? <p className={styles.note}>{AD.waitingForSlot}</p> : null}
          <p className={styles.note}>{COPY.keepPicking}</p>
        </div>
        <WorkbenchFooter
          target={null}
          more={more}
          action={
            <Button type="button" disabled>
              {COPY.actions[template.action]}
            </Button>
          }
          note={COPY.states.waitForVideo}
        />
      </div>
    </div>
  );
}

/** An ad that couldn't be made: why, and Try again (it resumes, reusing what was made). */
function AdFailedBench({
  workspaceId,
  ad,
  template,
  onAd,
  more,
}: {
  workspaceId: string;
  ad: ProductAdRecord;
  template: ProductTemplate;
  onAd: (ad: ProductAdRecord) => void;
  more: readonly MoreItem[];
}) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reason = AD.failReasons[ad.errorCode ?? "failed"];
  const retry = async () => {
    setSending(true);
    setProblem(null);
    try {
      onAd(await retryProductAd(workspaceId, ad.id));
    } catch (error) {
      const code = error instanceof ProductDraftError ? error.code : "failed";
      const errors: Record<string, string> = AD.retryErrors;
      setProblem(errors[code] ?? AD.retryErrors.failed);
    } finally {
      setSending(false);
    }
  };
  const first = ad.products[0];
  return (
    <div className={styles.body}>
      <div className={styles.previewCol}>
        <div className={styles.sketch} data-format={template.format}>
          {first?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={first.imageUrl} alt="" decoding="async" data-cutout="" />
          ) : null}
        </div>
      </div>
      <div className={styles.side}>
        <div className={styles.problem}>
          <p role="alert" className={styles.alert}>
            {COPY.makingFailed(reason)}
          </p>
          <p className={styles.note}>{AD.tryAgainNote}</p>
          {problem ? (
            <p role="alert" className={styles.issue}>
              {problem}
            </p>
          ) : null}
          {ad.errorCode === "ai_disabled" ? null : (
            <Button
              type="button"
              disabled={sending}
              onClick={() => void retry()}
            >
              {sending ? AD.starting : COPY.states.tryAgain}
            </Button>
          )}
        </div>
        <WorkbenchFooter
          target={null}
          more={more}
          action={
            <Button type="button" disabled>
              {COPY.actions[template.action]}
            </Button>
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The made ad: preview, rails, and the one Meta action.

/** The still of a kind for a product (null: of every product), in a format. */
export function adStill(
  ad: Pick<ProductAdRecord, "stills" | "products">,
  kind: ProductAdStillKind,
  format: ProductAdStillFormat,
  productId: string | null,
  colourway: ProductAdStudioColourway | null = null
): ProductAdRecordStill | null {
  const matches = (ad.stills.templates ?? []).filter(
    still =>
      still.kind === kind &&
      still.format === format &&
      (productId === null || still.productId === productId)
  );
  const found =
    (colourway && matches.find(still => still.colourway === colourway)) ??
    matches[0] ??
    null;
  if (found) return found;
  // v2's one In a room picture is of the first product.
  const first = ad.products[0]?.productId ?? null;
  if (
    kind === "room" &&
    format === "feed" &&
    ad.stills.feedUrl &&
    (productId === null || productId === first)
  )
    return {
      kind,
      format,
      productId: first,
      colourway: null,
      url: ad.stills.feedUrl,
    };
  return null;
}

/** What the Look rail edits for the tile. */
function lookOf(
  template: ProductTemplate,
  ad: ProductAdRecord,
  productId: string,
  colourway: ProductAdStudioColourway | null,
  carouselLook: "room" | "studio"
): WorkbenchLook {
  if (template.frame === "fb_ad") return { kind: "none" };
  if (template.renderer === "motion" || template.renderer === "video")
    return { kind: "scene" };
  if (
    template.renderer === "still" &&
    (template.stillKind === "room" || template.stillKind === "print")
  )
    return { kind: "scene" };
  if (template.renderer === "still" && template.stillKind === "studio")
    return {
      kind: "studio",
      stills: (ad.stills.templates ?? []).filter(
        still =>
          still.kind === "studio" &&
          still.format === "feed" &&
          still.productId === productId
      ),
      colourway,
    };
  if (template.renderer === "carousel") {
    const first = ad.products[0]?.productId ?? null;
    return {
      kind: "carousel",
      room: first ? adStill(ad, "room", "feed", first) : null,
      studio: first ? adStill(ad, "studio", "feed", first) : null,
      chosen: carouselLook,
    };
  }
  return { kind: "none" };
}

/** An opening or ending the preview cycles through Muse Spark's options and lets the owner edit. */
function cycleOf(
  options: ReadonlyArray<{ text: string }>,
  text: string | null,
  savedText: string | undefined,
  limit: { chars: number; lines?: number },
  inputLabel: string,
  onPick: (text: string) => void,
  disabled: boolean
): WorkbenchCycle | null {
  if (text === null) return null;
  const at = options.findIndex(option => !wordsEdited(option.text, text));
  const count = Math.max(1, options.length);
  const changed = wordsEdited(text, savedText);
  const issue = changed ? wordsIssue(text, limit) : null;
  const maxLength = limit.chars * (limit.lines ?? 1) + 20;
  return {
    text,
    index: Math.max(0, at),
    count: options.length > 1 ? count : 1,
    disabled,
    inputLabel,
    maxLength,
    issue,
    onChange: onPick,
    onNext: () => {
      const next = options[(at + 1) % options.length];
      if (next) onPick(next.text);
    },
  };
}

function AdReadyBench({
  workspaceId,
  template,
  ad,
  auto,
  setAd,
  refresh,
  priceToCheck,
  onChanged,
  more,
}: {
  workspaceId: string;
  template: ProductTemplate;
  ad: ProductAdRecord;
  auto: ReturnType<typeof useAdAutoUpdate>;
  setAd: (ad: ProductAdRecord) => void;
  refresh: () => void;
  priceToCheck: boolean;
  onChanged?: () => void;
  more: readonly MoreItem[];
}) {
  const ids = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnFocus = useCallback(() => {
    bodyRef.current
      ?.closest<HTMLElement>("section[aria-labelledby]")
      ?.focus({ preventScroll: true });
  }, []);
  const readiness = useMetaReadiness(workspaceId);
  const meta = readiness.data ?? null;
  const [shot, setShot] = useState<string | null>(null);
  const shotId =
    shot && ad.products.some(product => product.productId === shot)
      ? shot
      : (ad.products[0]?.productId ?? "");
  const [colourways, setColourways] = useState<
    Record<string, ProductAdStudioColourway>
  >({});
  const [carouselLook, setCarouselLook] = useState<"room" | "studio">("room");
  const [sheet, setSheet] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [describe, setDescribe] = useState(false);
  const [placePick, setPlacePick] = useState<PlacePick | null>(null);
  const [placeProblem, setPlaceProblem] = useState<string | null>(null);
  // A voice picked on the rail; it waits for Update with the other picks.
  const [voicePick, setVoicePick] = useState<VoicePick | null>(null);
  const [voiceSending, setVoiceSending] = useState(false);
  const [voiceProblem, setVoiceProblem] = useState<string | null>(null);

  const settle = useCallback(() => {
    refresh();
    onChanged?.();
  }, [refresh, onChanged]);
  const ctwa = useCtwa({ workspaceId, ad, onSettled: settle });
  const ctwaMatches = ctwa.ctwa?.asset === (template.ctwaAsset ?? "video");
  const shownCtwa = ctwaMatches ? ctwa.ctwa : null;

  // What blocks a paid run now (New place, a voice that costs).
  const stop = meta?.ai.blocked ?? null;
  const paidBlocked = stop
    ? stop === "ai_disabled"
      ? COPY.states.aiOff
      : AD.blocked(stop)
    : null;

  const running = ad.status === "making";
  const updating = running || auto.sending || voiceSending;
  // The picks waiting for Update: free changes, a new place, and a voice the video hasn't.
  const voiceChange =
    voicePick && (voicePick.key !== adVoiceKey(ad) || ad.voiceResult?.fallback)
      ? voicePick
      : null;
  const hasChanges =
    auto.pending !== null || voiceChange !== null || placePick !== null;
  // Why Post and Create wait: an update going, or picks not made yet.
  const updateWhy = updating
    ? COPY.states.waitForUpdate
    : hasChanges
      ? COPY.states.updateFirst
      : null;
  const colourway = colourways[shotId] ?? null;
  const look = lookOf(template, ad, shotId, colourway, carouselLook);

  // The pictures the tile shows, and what Post sends.
  const stillProduct = template.perProduct ? shotId : null;
  const pictures: WorkbenchPicture[] = [];
  let publish: Omit<ProductAdPublishRequest, "requestId" | "caption"> | null =
    null;
  if (template.renderer === "still" && template.stillKind) {
    const format = template.stillFormat ?? "feed";
    const still =
      adStill(
        ad,
        template.stillKind,
        format,
        template.ctwaAsset === "picture"
          ? (ad.products[0]?.productId ?? null)
          : stillProduct,
        template.stillKind === "studio" ? colourway : null
      ) ??
      (template.ctwaAsset === "picture"
        ? adStill(ad, "studio", "feed", ad.products[0]?.productId ?? null)
        : null);
    if (still) {
      pictures.push({ url: still.url, alt: template.label });
      if (template.destination)
        publish = {
          destination: template.destination,
          still: {
            kind: still.kind,
            productId: still.productId,
            ...(still.kind === "studio" ? { colourway: still.colourway } : {}),
          },
        };
    }
  } else if (template.renderer === "carousel") {
    const collection = adStill(ad, "collection", "feed", null);
    const slides = [
      ...(collection ? [collection] : []),
      ...ad.products.flatMap(product => {
        const still =
          carouselLook === "studio"
            ? adStill(ad, "studio", "feed", product.productId)
            : adStill(ad, "room", "feed", product.productId);
        return still ? [still] : [];
      }),
    ].slice(0, 4);
    for (const still of slides)
      pictures.push({ url: still.url, alt: template.label });
    if (slides.length >= 2)
      publish = {
        destination: "carousel",
        ...(carouselLook === "studio"
          ? {
              slides: slides.map(still => ({
                kind: still.kind,
                productId: still.productId,
                ...(still.kind === "studio"
                  ? { colourway: still.colourway }
                  : {}),
              })),
            }
          : {}),
      };
  } else if (ad.video && template.destination) {
    publish = { destination: template.destination };
  }
  const post = useTilePost({
    workspaceId,
    ad,
    template,
    still: template.perProduct ? (publish?.still ?? null) : undefined,
    onSettled: settle,
  });
  const posterOrPicture =
    pictures.map(picture => picture.url).length > 0
      ? pictures.map(picture => picture.url)
      : ad.video?.posterUrl
        ? [ad.video.posterUrl]
        : [];

  // The opening and ending, cycled or edited inline on the preview.
  const sticker = auto.pending?.sticker ?? ad.script?.sticker ?? null;
  const endingText = auto.pending?.ending ?? ad.script?.ending ?? null;
  const opening = cycleOf(
    ad.openings,
    sticker,
    ad.script?.sticker,
    PRODUCT_AD_TEXT_LIMITS.sticker,
    COPY.cycle.openingInput,
    text => auto.queue({ sticker: text }),
    false
  );
  const ending = cycleOf(
    ad.endings,
    endingText,
    ad.script?.ending,
    PRODUCT_AD_TEXT_LIMITS.ending,
    COPY.cycle.endingInput,
    text => auto.queue({ ending: text }),
    false
  );
  const wordsInvalid = Boolean(opening?.issue || ending?.issue);

  // Update: every pick in one run. A new place carries any voice and free
  // changes in its scene run; a new voice carries the free changes in its
  // voice run; otherwise they go as one free render.
  const update = async () => {
    if (wordsInvalid) return;
    if (placePick) {
      setVoiceSending(true);
      setPlaceProblem(null);
      setVoiceProblem(null);
      const changes = auto.take();
      try {
        setAd(
          await redoProductAdScene(workspaceId, ad.id, placePick.productId, {
            requestId: adRequestId(),
            ...placePick.place,
            ...(changes ? { changes } : {}),
            ...(voiceChange
              ? {
                  voice: voiceChange.voice,
                  ...(voiceChange.stockVoiceId
                    ? { stockVoiceId: voiceChange.stockVoiceId }
                    : {}),
                }
              : {}),
          })
        );
        setPlacePick(null);
        setVoicePick(null);
      } catch (error) {
        if (changes) auto.queue(changes);
        const code = error instanceof ProductDraftError ? error.code : "failed";
        const errors: Record<string, string> = AD.newPictureErrors;
        setPlaceProblem(errors[code] ?? COPY.newPlaceFailed);
      } finally {
        setVoiceSending(false);
      }
      return;
    }
    if (!voiceChange) {
      auto.send();
      return;
    }
    setVoiceSending(true);
    setVoiceProblem(null);
    const changes = auto.take();
    try {
      setAd(
        await changeProductAdVoice(workspaceId, ad.id, {
          requestId: adRequestId(),
          voice: voiceChange.voice,
          ...(voiceChange.stockVoiceId
            ? { stockVoiceId: voiceChange.stockVoiceId }
            : {}),
          ...(changes ? { changes } : {}),
        })
      );
      setVoicePick(null);
    } catch (error) {
      // The picks stay, to update again or discard.
      if (changes) auto.queue(changes);
      const code = error instanceof ProductDraftError ? error.code : "failed";
      const refusals: Record<string, string> = PRODUCTS_COPY.adVoice.refusals;
      setVoiceProblem(refusals[code] ?? COPY.voiceFailed);
    } finally {
      setVoiceSending(false);
    }
  };
  const discard = () => {
    auto.cancel();
    setPlacePick(null);
    setPlaceProblem(null);
    setVoicePick(null);
    setVoiceProblem(null);
  };
  const updateCents = voiceChange?.cents ?? 0;

  // ⋯
  const items: MoreItem[] = [
    ...(ad.video
      ? [
          {
            key: "video",
            label: COPY.menu.downloadVideo,
            onSelect: () =>
              void downloadProductAdFile(
                ad.video!.url,
                adFileName(ad, "video")
              ),
          },
        ]
      : []),
    ...(pictures[0]
      ? [
          {
            key: "picture",
            label: COPY.menu.downloadPicture,
            onSelect: () =>
              void downloadProductAdFile(
                pictures[0]!.url,
                `${template.id.replace(/_/g, "-")}-${ad.renderNo}.jpg`
              ),
          },
        ]
      : []),
    ...(look.kind === "scene" && !paidBlocked
      ? [
          {
            key: "describe",
            label: COPY.menu.describePlace,
            onSelect: () => setDescribe(true),
            disabled: running || ad.picturesLeft === 0,
          },
        ]
      : []),
    ...(hasChanges
      ? [
          {
            key: "back",
            label: COPY.menu.backToVideo(ad.video?.renderNo ?? ad.renderNo),
            onSelect: discard,
          },
        ]
      : []),
    ...more,
  ];

  // The one Meta action.
  let target: string | null = null;
  let action: ReactNode = null;
  let note: ReactNode = null;
  let alert: ReactNode = null;
  if (template.action === "create_ad") {
    const ads = meta?.ads ?? null;
    target = COPY.target.ads(ads?.adAccountName ?? null);
    const record = shownCtwa;
    const otherBusy =
      !ctwaMatches && (ctwa.making || ctwa.ctwa?.state === "running");
    const pageMissing = Boolean(
      ads?.connected && ads.pageHasWhatsApp === false
    );
    const assetMissing =
      template.ctwaAsset === "picture" ? pictures.length === 0 : !ad.video;
    if (otherBusy) {
      action = ctwa.ctwa?.adsManagerUrl ? (
        <Button asChild variant="outline">
          <a
            href={ctwa.ctwa.adsManagerUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {PRODUCTS_COPY.ctwa.adsManager}
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
      ) : null;
      note = ctwa.making
        ? COPY.states.otherAdMaking
        : COPY.states.otherAdRunning;
    } else if (record && ctwa.making) {
      action = (
        <span className={styles.statusChip} role="status">
          {PRODUCTS_COPY.ctwa.creating}
        </span>
      );
    } else if (
      record &&
      (record.state === "paused" || record.state === "running")
    ) {
      const word = ctwaStatusWord(record);
      action = (
        <>
          {word ? (
            <span className={styles.statusChip} data-tone={record.state}>
              {word}
            </span>
          ) : null}
          {record.adsManagerUrl ? (
            <Button asChild variant="outline">
              <a
                href={record.adsManagerUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {PRODUCTS_COPY.ctwa.adsManager}
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          ) : null}
          {record.state === "paused" && ads?.runEnabled ? (
            <Button type="button" onClick={() => setRunOpen(true)}>
              {PRODUCTS_COPY.ctwa.run}
            </Button>
          ) : null}
        </>
      );
      // A Run Meta refused leaves the ad paused, with Meta's reason.
      alert = record.errorMessage;
    } else if (ads && !ads.connected) {
      action = (
        <Button asChild>
          <Link href={integrationHref(workspaceId, "meta_ads")}>
            <Megaphone aria-hidden="true" />
            {COPY.states.connectMetaAds}
          </Link>
        </Button>
      );
    } else {
      const why = priceToCheck
        ? COPY.states.priceToCheck
        : pageMissing
          ? COPY.states.pageWhatsAppMissing
          : updateWhy
            ? updateWhy
            : assetMissing
              ? COPY.states.noPicture
              : null;
      const failed = record?.state === "failed" ? record : null;
      // After Meta refused the ad itself, the next press starts a new one;
      // after a step failed, it resumes from that step.
      const fresh =
        failed !== null &&
        (failed.failedStep === null ||
          failed.effectiveStatus === "DISAPPROVED");
      action = (
        <Button
          type="button"
          disabled={why !== null || ctwa.sending}
          onClick={() =>
            void ctwa.create(template.ctwaAsset ?? "video").then(refused => {
              if (refused === null) returnFocus();
              // What Meta answered may have changed what's ready.
              if (
                refused === "page_whatsapp_missing" ||
                refused === "ads_not_connected"
              )
                void readiness.checkAgain();
            })
          }
        >
          <Megaphone aria-hidden="true" />
          {ctwa.sending
            ? PRODUCTS_COPY.ctwa.creating
            : fresh
              ? PRODUCTS_COPY.ctwa.createAgain
              : failed
                ? COPY.states.tryAgain
                : COPY.actions.create_ad}
        </Button>
      );
      note = why;
      alert = ctwa.refusal
        ? metaRefusal(ctwa.refusal)
        : failed
          ? failed.errorMessage
            ? failed.dailyBudgetCents === null
              ? `${failed.errorMessage} ${COPY.states.nothingSpent}.`
              : failed.errorMessage
            : failed.dailyBudgetCents === null
              ? metaRefusal(failed.errorCode ?? "ctwa_failed")
              : PRODUCTS_COPY.ctwa.deliveryUnknown
          : null;
    }
  } else if (template.destination) {
    const instagram = meta?.instagram ?? null;
    target = COPY.target.instagram(instagram?.username ?? null);
    const current = post.post;
    const notConnected = Boolean(
      instagram && (!instagram.connected || !instagram.canPublish)
    );
    if (current?.state === "published") {
      action = current.permalink ? (
        <Button asChild variant="outline">
          <a href={current.permalink} target="_blank" rel="noopener noreferrer">
            {PRODUCTS_COPY.outOnMeta.viewPost}
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
      ) : null;
      note = PRODUCTS_COPY.outOnMeta.onInstagram(
        PRODUCTS_COPY.outOnMeta.clock(
          current.publishedAt ?? current.requestedAt
        )
      );
    } else if (
      current?.state === "processing" ||
      current?.state === "publishing"
    ) {
      action = (
        <span className={styles.statusChip} role="status">
          {current.state === "processing"
            ? PRODUCTS_COPY.publish.processing
            : PRODUCTS_COPY.publish.publishing}
        </span>
      );
      if (post.stillProcessing)
        note = (
          <>
            {COPY.states.stillProcessing}{" "}
            <button
              type="button"
              className={styles.linkButton}
              onClick={post.checkAgain}
            >
              {COPY.states.checkAgain}
            </button>
          </>
        );
    } else if (notConnected) {
      action = (
        <Button asChild>
          <Link href={integrationHref(workspaceId, "instagram")}>
            <Instagram aria-hidden="true" />
            {COPY.states.connectInstagram}
          </Link>
        </Button>
      );
    } else {
      const why = priceToCheck
        ? COPY.states.priceToCheck
        : instagram?.quotaLeft === 0
          ? COPY.states.instagramQuota
          : updateWhy
            ? updateWhy
            : !publish
              ? COPY.states.noPicture
              : null;
      const failed = current?.state === "failed";
      action = (
        <Button
          type="button"
          disabled={why !== null}
          onClick={() => {
            post.clearRefusal();
            setSheet(true);
          }}
        >
          <Instagram aria-hidden="true" />
          {failed ? COPY.states.tryAgain : COPY.actions[template.action]}
        </Button>
      );
      note = why;
      alert =
        failed && current
          ? current.errorMessage
            ? `${current.errorMessage} ${COPY.states.nothingPosted}.`
            : metaRefusal(current.errorCode ?? "post_failed")
          : null;
    }
  }

  const lastRun = ad.lastRun;
  const runFailed =
    ad.status === "ready" &&
    lastRun?.outcome === "failed" &&
    lastRun.renderNo === ad.renderNo
      ? AD.updateFailed(AD.failReasons[lastRun.errorCode ?? "failed"])
      : null;
  const account =
    template.frame === "fb_ad"
      ? (meta?.ads.pageName ?? COPY.target.ads(null))
      : COPY.target.instagram(meta?.instagram.username ?? null);

  return (
    <div ref={bodyRef} className={styles.body}>
      <p className="sr-only" aria-live="polite">
        {running ? AD.announceUpdating : AD.announce[ad.status]}
      </p>
      <div className={styles.previewCol}>
        <WorkbenchPreview
          template={template}
          ad={ad}
          pictures={pictures}
          account={account}
          caption={ad.post?.text ?? null}
          opening={
            template.format === "video" && template.frame !== "fb_ad"
              ? opening
              : null
          }
          ending={
            template.format === "video" && template.frame !== "fb_ad"
              ? ending
              : null
          }
        />
        <MetaCredits />
      </div>
      <div className={styles.side}>
        {template.frame === "fb_ad" ? (
          <CtwaDetails
            ad={ad}
            ctwa={shownCtwa}
            readiness={meta?.ads ?? null}
            checking={readiness.checking}
            onCheckAgain={() => void readiness.checkAgain()}
          />
        ) : (
          <>
            {template.perProduct || look.kind === "scene" ? (
              <ShotsRail ad={ad} selected={shotId} onSelect={setShot} />
            ) : null}
            <LookRail
              ad={ad}
              productId={shotId}
              look={look}
              pending={auto.pending}
              placePick={placePick}
              onClearPlacePick={() => {
                if (placePick?.productId === shotId) setPlacePick(null);
              }}
              onQueue={auto.queue}
              onColourway={next =>
                setColourways(current => ({ ...current, [shotId]: next }))
              }
              onCarouselLook={setCarouselLook}
              onOpenNewPlace={() => {
                setPlaceProblem(null);
                setDescribe(true);
              }}
              newPlaceBlocked={paidBlocked}
            />
            {placeProblem ? (
              <p role="alert" className={styles.issue}>
                {placeProblem}
              </p>
            ) : null}
            {template.format === "video" ? (
              <>
                <VoiceRail
                  workspaceId={workspaceId}
                  ad={ad}
                  pick={voiceChange}
                  onPick={next => {
                    setVoiceProblem(null);
                    setVoicePick(next);
                  }}
                  sending={voiceSending}
                  problem={voiceProblem}
                  blocked={paidBlocked}
                />
                <MusicRail
                  ad={ad}
                  pending={auto.pending}
                  onQueue={auto.queue}
                  disabled={updating}
                />
              </>
            ) : null}
          </>
        )}
        {updating ? (
          <div className={styles.updating} role="status">
            <span className={styles.updatingChip}>{COPY.updating}</span>
            <span className={styles.updatingBar} aria-hidden="true" />
            <span className={styles.note}>
              {voiceSending || (running && ad.runKind !== "render")
                ? COPY.updatingNotePaid
                : COPY.updatingNote}
            </span>
          </div>
        ) : hasChanges ? (
          <div className={styles.updateBar}>
            <p className={styles.note}>{COPY.update.waiting}</p>
            <div className={styles.updateActions}>
              <Button type="button" variant="outline" onClick={discard}>
                {COPY.update.discard}
              </Button>
              <Button
                type="button"
                disabled={
                  wordsInvalid ||
                  ((updateCents > 0 || placePick !== null) &&
                    paidBlocked !== null)
                }
                onClick={() => void update()}
              >
                {updateCents > 0
                  ? COPY.update.buttonCost(updateCents)
                  : COPY.update.button}
              </Button>
            </div>
          </div>
        ) : null}
        {auto.problem ? (
          <p role="alert" className={styles.issue}>
            {COPY.updateFailed}
          </p>
        ) : null}
        {runFailed ? <p className={styles.issue}>{runFailed}</p> : null}
        <WorkbenchFooter
          target={target}
          more={items}
          action={action}
          note={note}
          alert={alert}
        />
      </div>

      {template.destination && publish ? (
        <PublishSheet
          open={sheet}
          onOpenChange={setSheet}
          onReturnFocus={returnFocus}
          destination={template.destination}
          account={COPY.target.instagram(meta?.instagram.username ?? null)}
          pictures={posterOrPicture}
          caption={ad.post?.text ?? ""}
          sending={post.sending}
          problem={
            post.refusal === "failed"
              ? PRODUCTS_COPY.publish.unconfirmed
              : post.refusal
                ? metaRefusal(post.refusal)
                : null
          }
          onPost={caption => {
            const edited =
              template.destination !== "story" &&
              caption !== (ad.post?.text ?? "");
            void post
              .publish({ ...publish!, ...(edited ? { caption } : {}) })
              .then(sent => {
                if (sent) setSheet(false);
                else void readiness.checkAgain();
              });
          }}
        />
      ) : null}
      {template.action === "create_ad" && meta?.ads.runEnabled ? (
        <RunSheet
          open={runOpen}
          onOpenChange={setRunOpen}
          onReturnFocus={returnFocus}
          maxDailyCents={meta.ads.runMaxDailyCents}
          maxDays={meta.ads.runMaxDays}
          sending={ctwa.sending}
          problem={ctwa.refusal ? metaRefusal(ctwa.refusal) : null}
          onRun={request =>
            void ctwa.run(request).then(done => {
              if (done) setRunOpen(false);
            })
          }
        />
      ) : null}
      {look.kind === "scene" ? (
        <NewPlaceSheet
          key={`${shotId}-${describe ? "open" : "closed"}`}
          id={ids}
          open={describe}
          onOpenChange={setDescribe}
          nowSetting={
            ad.scenes.find(scene => scene.productId === shotId)?.place
              ?.setting ?? null
          }
          initialPlace={
            placePick?.productId === shotId ? placePick.place : null
          }
          picturesLeft={ad.picturesLeft}
          onChoose={place => {
            setPlaceProblem(null);
            setPlacePick({ productId: shotId, place });
            setDescribe(false);
          }}
          problem={placeProblem}
        />
      ) : null}
    </div>
  );
}

/**
 * The New place modal: 20 tested places to choose from, plus a custom input
 * to describe any place. Choosing one queues it for the next Update press.
 */
function NewPlaceSheet({
  id,
  open,
  onOpenChange,
  nowSetting,
  initialPlace,
  picturesLeft,
  onChoose,
  problem,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nowSetting: ProductAdSetting | null;
  initialPlace: { setting: ProductAdSetting } | { words: string } | null;
  picturesLeft: number | null;
  onChoose: (place: { setting: ProductAdSetting } | { words: string }) => void;
  problem: string | null;
}) {
  const [selected, setSelected] = useState<ProductAdSetting | null>(() =>
    initialPlace && "setting" in initialPlace
      ? initialPlace.setting
      : initialPlace && "words" in initialPlace
        ? null
        : nextSetting(nowSetting)
  );
  const [words, setWords] = useState(() =>
    initialPlace && "words" in initialPlace ? initialPlace.words : ""
  );
  const text = oneLine(words);
  const customActive = text.length > 0 && selected === null;
  const canChoose = customActive || selected !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={theme.scrim}
        className={cn(theme.theme, styles.sheet, styles.placesSheet)}
      >
        <DialogTitle className={cn(theme.displayM, styles.sheetTitle)}>
          {COPY.look.modalTitle}
        </DialogTitle>
        <DialogDescription className={styles.note}>
          {COPY.look.modalSubtitle(picturesLeft)}
        </DialogDescription>
        <div
          role="radiogroup"
          aria-label={COPY.look.placesLabel}
          className={styles.placesGrid}
        >
          {PRODUCT_AD_SETTINGS.map(setting => {
            const on = selected === setting && !customActive;
            return (
              <button
                key={setting}
                type="button"
                role="radio"
                aria-checked={on}
                data-on={on || undefined}
                className={styles.placeOption}
                onClick={() => {
                  setSelected(setting);
                  setWords("");
                }}
              >
                <span>{AD.settings[setting]}</span>
                {setting === nowSetting ? (
                  <span className={styles.placeNowChip}>{AD.placeNow}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className={styles.customPlace}>
          <div className={styles.customPlaceHead}>
            <label htmlFor={`${id}-place`} className={styles.fieldLabel}>
              {COPY.look.ownPlaceLabel}
            </label>
            <span className={styles.captionCount}>
              {AD.describeCount(Array.from(words).length)}
            </span>
          </div>
          <input
            id={`${id}-place`}
            className={styles.input}
            value={words}
            placeholder={COPY.look.ownPlacePlaceholder}
            maxLength={PRODUCT_AD_PLACE_WORDS_MAX}
            autoComplete="off"
            onChange={event => {
              const next = event.target.value;
              setWords(next);
              if (oneLine(next)) setSelected(null);
            }}
          />
          <p className={styles.note}>{AD.describeHelp}</p>
        </div>
        {problem ? (
          <p role="alert" className={styles.issue}>
            {problem}
          </p>
        ) : null}
        <div className={styles.sheetActions}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {COPY.look.describeCancel}
          </Button>
          <Button
            type="button"
            disabled={!canChoose}
            onClick={() => {
              if (customActive) onChoose({ words: text });
              else if (selected) onChoose({ setting: selected });
            }}
          >
            {COPY.look.choosePlace}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
