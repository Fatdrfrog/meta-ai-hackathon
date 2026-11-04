"use client";

import { Button } from "@/components/ui/button";
import { oneLine } from "@/lib/products/ad-request";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  PRODUCT_AD_STEPS,
  PRODUCT_AD_TEXT_LIMITS,
  type ProductAdRecord,
  type ProductAdSceneChange,
  type ProductAdUpdateRequest,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, ExternalLink, Info } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import {
  redoProductAdScene,
  retryProductAd,
  updateProductAd,
} from "./ads-client";
import {
  AdOptions,
  adOptionChoice,
  type AdOptionChoice,
} from "./product-ad-options";
import {
  AdBar,
  AdBriefLine,
  AdDownload,
  AdHead,
  AdProductChips,
  CopyButton,
  StatusDot,
  WordField,
  adFileName,
  adRequestId,
  fileSize,
  productWord,
  tookTime,
  wordsEdited,
  wordsIssue,
} from "./product-ad-parts";
import { AdPlayer } from "./product-ad-player";
import {
  AdSceneTools,
  currentPictureIndex,
  savedSceneDraft,
  type AdNewPicturePlace,
  type AdSceneDraft,
} from "./product-ad-scene-tools";
import styles from "./product-ad-studio.module.css";
import {
  AdUpdateBarAction,
  AdUpdateCard,
  type AdRunning,
} from "./product-ad-update-bar";
import { ProductAdVoicePanel } from "./product-ad-voice";
import { ProductChip } from "./product-controls";
import theme from "./product-theme.module.css";
import { ProductDraftError } from "./products-client";
import { useNarrowStudio } from "./use-product-ad";

// The finished ad, and the studio's tools on it: the opening words and the
// ending (Muse Spark's three of each, or the owner's own), the scenes one at
// a time (place, New picture, earlier pictures, where the words sit, the
// caption, the exact photo), the price card's title, then the post text, the
// Click-to-WhatsApp copy, what Airi checked and how the ad was made. Every
// free change waits in the update card for one "Update the video", a run
// with no AI. While a run goes the view stays, with the earlier video
// playing; an edit run that fails says why here and keeps that video.

const COPY = PRODUCTS_COPY.ad;

const ADS_MANAGER_URL = "https://adsmanager.facebook.com/";

/** The words on screen, by field; captions by product. */
type Words = {
  sticker: string;
  captions: Record<string, string>;
  priceCardTitle: string;
  ending: string;
};

const wordsOf = (script: ProductAdRecord["script"]): Words => ({
  sticker: script?.sticker ?? "",
  captions: Object.fromEntries(
    (script?.captions ?? []).map(entry => [entry.productId, entry.caption])
  ),
  priceCardTitle: script?.priceCardTitle ?? "",
  ending: script?.ending ?? "",
});

const scenesOf = (ad: ProductAdRecord): Record<string, AdSceneDraft> =>
  Object.fromEntries(
    ad.scenes.map(scene => [scene.productId, savedSceneDraft(scene)])
  );

/** What the owner changed in the words, as the PATCH sends it; null when nothing. */
export function wordChanges(
  saved: ProductAdRecord["script"],
  draft: Words
): ProductAdUpdateRequest | null {
  const before = wordsOf(saved);
  const changes: ProductAdUpdateRequest = {};
  if (wordsEdited(draft.sticker, before.sticker))
    changes.sticker = oneLine(draft.sticker);
  const captions = Object.entries(draft.captions)
    .filter(([productId, caption]) =>
      wordsEdited(caption, before.captions[productId])
    )
    .map(([productId, caption]) => ({ productId, caption: oneLine(caption) }));
  if (captions.length > 0) changes.captions = captions;
  if (wordsEdited(draft.priceCardTitle, before.priceCardTitle))
    changes.priceCardTitle = oneLine(draft.priceCardTitle);
  if (wordsEdited(draft.ending, before.ending))
    changes.ending = oneLine(draft.ending);
  return Object.keys(changes).length > 0 ? changes : null;
}

/** What the owner changed in the scenes, as the PATCH sends it. */
export function sceneChanges(
  ad: ProductAdRecord,
  drafts: Readonly<Record<string, AdSceneDraft>>
): ProductAdSceneChange[] {
  return ad.scenes.flatMap(scene => {
    const draft = drafts[scene.productId];
    if (!draft) return [];
    const change: ProductAdSceneChange = { productId: scene.productId };
    if (draft.textZone !== scene.textZone) change.textZone = draft.textZone;
    if (draft.useExact !== scene.useExact) change.useExact = draft.useExact;
    if (
      draft.pictureIndex !== null &&
      draft.pictureIndex !== currentPictureIndex(scene)
    )
      change.pictureIndex = draft.pictureIndex;
    return Object.keys(change).length > 1 ? [change] : [];
  });
}

/** "$0.05"; "under $0.01" for less. */
const dollars = (usd: number) =>
  usd <= 0 ? "$0" : usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`;

/** An error code's words from one of the copy's maps, else its "failed". */
function errorWords(
  map: Readonly<Record<string, string>> & { failed: string },
  error: unknown
): string {
  const code = error instanceof ProductDraftError ? error.code : "failed";
  return Object.prototype.hasOwnProperty.call(map, code)
    ? (map[code] ?? map.failed)
    : map.failed;
}

/** The Click-to-WhatsApp copy as one text, for Copy all. */
function ctwaText(ctwa: NonNullable<ProductAdRecord["ctwa"]>): string {
  return [
    `${COPY.ctwaHeadline}: ${ctwa.headline}`,
    `${COPY.ctwaPrimaryText}: ${ctwa.primaryText}`,
    `${COPY.ctwaGreeting}: ${ctwa.greeting}`,
    `${COPY.ctwaQuestions}:`,
    ...ctwa.questions.map(question => `- ${question}`),
  ].join("\n");
}

/** A closed row that opens to its content: the post, the ad copy, the checks, the credits. */
function AdRow({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className={cn(theme.sheet, styles.rowPanel, styles.credits)}>
      <summary>
        <ChevronRight aria-hidden="true" />
        <span className={styles.rowTitle}>{title}</span>
        {summary ? <span className={styles.rowSummary}>{summary}</span> : null}
      </summary>
      <div className={styles.rowBody}>{children}</div>
    </details>
  );
}

export function AdReady({
  workspaceId,
  ad,
  onChanged,
  onChangeProducts,
  sceneId = null,
  onSceneId,
  voiceRunNo = null,
  onVoiceChanged,
}: {
  workspaceId: string;
  ad: ProductAdRecord;
  onChanged: (ad: ProductAdRecord) => void;
  /** The shelf's Choose mode with these products chosen, for a new ad. */
  onChangeProducts: (productIds: string[]) => void;
  /** The scene the owner picked, kept while the view is drawn again for each run. */
  sceneId?: string | null;
  onSceneId?: (productId: string) => void;
  /** The run the voice panel's own press started, kept the same way. */
  voiceRunNo?: number | null;
  /** The voice panel's answer; `onChanged` when not given. */
  onVoiceChanged?: (ad: ProductAdRecord) => void;
}) {
  const titleId = useId();
  const ids = useId();
  const narrow = useNarrowStudio();
  const saved = wordsOf(ad.script);
  const [draft, setDraft] = useState<Words>(saved);
  const [opening, setOpening] = useState<AdOptionChoice>(() =>
    adOptionChoice(ad.openings, saved.sticker)
  );
  const [ending, setEnding] = useState<AdOptionChoice>(() =>
    adOptionChoice(ad.endings, saved.ending)
  );
  const [scenes, setScenes] = useState(() => scenesOf(ad));
  // A run's end can change a scene's saved choices (a New picture turns the
  // exact photo off), so the scenes are taken again as the status changes.
  // Every control is off while a run goes, so no choice of the owner's is lost.
  const [scenesFor, setScenesFor] = useState(ad.status);
  if (scenesFor !== ad.status) {
    setScenesFor(ad.status);
    setScenes(scenesOf(ad));
  }
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryProblem, setRetryProblem] = useState<string | null>(null);
  const [pressProblem, setPressProblem] = useState<{
    productId: string;
    message: string;
  } | null>(null);

  // The run going on: the earlier video stays, and every control waits.
  const running: AdRunning | null =
    ad.status === "making" ? { kind: ad.runKind, since: ad.requestedAt } : null;
  const busy = running !== null || saving;
  const busyReason = running
    ? running.kind === "render" || running.kind === "voice"
      ? COPY.waitForUpdate
      : COPY.oneAtATime
    : saving
      ? COPY.oneAtATime
      : null;

  const limits = PRODUCT_AD_TEXT_LIMITS;
  const words = wordChanges(ad.script, draft);
  const sceneEdits = sceneChanges(ad, scenes);
  const changes: ProductAdUpdateRequest | null =
    words || sceneEdits.length > 0
      ? {
          ...(words ?? {}),
          ...(sceneEdits.length ? { scenes: sceneEdits } : {}),
        }
      : null;
  const issues = [
    wordsEdited(draft.sticker, saved.sticker) &&
      wordsIssue(draft.sticker, limits.sticker),
    ...Object.entries(draft.captions).map(
      ([productId, caption]) =>
        wordsEdited(caption, saved.captions[productId]) &&
        wordsIssue(caption, limits.caption)
    ),
    wordsEdited(draft.priceCardTitle, saved.priceCardTitle) &&
      wordsIssue(draft.priceCardTitle, limits.priceCardTitle),
    wordsEdited(draft.ending, saved.ending) &&
      wordsIssue(draft.ending, limits.ending),
  ].filter(Boolean);
  const nameOf = (productId: string) =>
    ad.products.find(product => product.productId === productId)?.name ?? "";
  const pending = [
    ...(words?.sticker !== undefined
      ? [COPY.changes.opening(words.sticker)]
      : []),
    ...(words?.captions ?? []).map(entry =>
      COPY.changes.caption(nameOf(entry.productId))
    ),
    ...sceneEdits.flatMap(change => [
      ...(change.pictureIndex !== undefined
        ? [COPY.changes.picture(nameOf(change.productId))]
        : []),
      ...(change.textZone !== undefined
        ? [COPY.changes.zone(nameOf(change.productId), change.textZone)]
        : []),
      ...(change.useExact !== undefined
        ? [COPY.changes.exact(nameOf(change.productId), change.useExact)]
        : []),
    ]),
    ...(words?.priceCardTitle !== undefined
      ? [COPY.changes.priceCardTitle(words.priceCardTitle)]
      : []),
    ...(words?.ending !== undefined ? [COPY.changes.ending(words.ending)] : []),
  ];
  const canUpdate = changes !== null && issues.length === 0 && !busy;

  const undoAll = () => {
    setDraft(saved);
    setOpening(adOptionChoice(ad.openings, saved.sticker));
    setEnding(adOptionChoice(ad.endings, saved.ending));
    setScenes(scenesOf(ad));
    setProblem(null);
  };

  const update = async () => {
    if (!changes || !canUpdate) return;
    setSaving(true);
    setProblem(null);
    try {
      onChanged(await updateProductAd(workspaceId, ad.id, changes));
    } catch (error) {
      setProblem(errorWords(COPY.updateErrors, error));
    } finally {
      // The answer's new run remounts the view; one that started nothing doesn't.
      setSaving(false);
    }
  };

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryProblem(null);
    try {
      onChanged(await retryProductAd(workspaceId, ad.id));
    } catch (error) {
      setRetryProblem(errorWords(COPY.retryErrors, error));
    } finally {
      setRetrying(false);
    }
  };

  const newPicture = async (productId: string, place: AdNewPicturePlace) => {
    if (busy) return;
    setSaving(true);
    setPressProblem(null);
    try {
      onChanged(
        await redoProductAdScene(workspaceId, ad.id, productId, {
          requestId: adRequestId(),
          ...place,
          // The free changes waiting go in with the new picture.
          ...(changes && issues.length === 0 ? { changes } : {}),
        })
      );
    } catch (error) {
      setPressProblem({
        productId,
        message: errorWords(COPY.newPictureErrors, error),
      });
    } finally {
      setSaving(false);
    }
  };

  const lastRun = ad.lastRun;
  const failed =
    ad.status === "ready" &&
    lastRun?.outcome === "failed" &&
    lastRun.renderNo === ad.renderNo
      ? {
          reason: COPY.failReasons[lastRun.errorCode ?? "failed"],
          canRetry: lastRun.kind === "render" || lastRun.kind === "scene",
        }
      : null;

  const video = ad.video;
  const size = video ? fileSize(video.bytes) : null;
  const anyMuse = ad.scenes.some(scene => scene.method === "muse");
  const aiPictures = ad.scenes.reduce(
    (count, scene) =>
      count + Math.max(scene.pictures.length, scene.method === "muse" ? 1 : 0),
    0
  );
  const madeIn =
    ad.readyAt && !running
      ? tookTime(Date.parse(ad.readyAt) - Date.parse(ad.requestedAt))
      : null;
  // How long each step took, for the credits: "words 7 s · pictures 21 s".
  const took = PRODUCT_AD_STEPS.flatMap(step => {
    const timing = ad.timings[step];
    if (!timing?.finishedAt) return [];
    const ms = Date.parse(timing.finishedAt) - Date.parse(timing.startedAt);
    return Number.isFinite(ms)
      ? [`${COPY.credits.stepNames[step]} ${tookTime(ms)}`]
      : [];
  });
  // One credit per scene whose picture a New picture made.
  const newPictureCredits = ad.scenes.flatMap(scene => {
    if (scene.redo?.outcome !== "new" || !scene.place) return [];
    const product = ad.products.find(
      entry => entry.productId === scene.productId
    );
    if (scene.place.words)
      return [
        COPY.credits.newPicturePlace(
          scene.place.englishPlace ?? scene.place.words
        ),
      ];
    return scene.place.setting && product
      ? [
          COPY.credits.newPictureSetting(
            productWord(product),
            scene.place.setting
          ),
        ]
      : [];
  });

  const dirty = changes !== null;
  // One main action at a time: the update while changes wait, else the video.
  const downloadVideo = (variant: "default" | "outline") =>
    video && size ? (
      <AdDownload
        url={video.url}
        fileName={adFileName(ad, "video")}
        variant={variant}
      >
        {COPY.download(size)}
      </AdDownload>
    ) : null;

  const captionField = (productId: string) =>
    productId in draft.captions ? (
      <WordField
        id={`${ids}-caption-${productId}`}
        label={COPY.caption(nameOf(productId))}
        value={draft.captions[productId] ?? ""}
        saved={saved.captions[productId] ?? ""}
        limit={limits.caption}
        disabled={busy}
        onChange={caption =>
          setDraft(current => ({
            ...current,
            captions: { ...current.captions, [productId]: caption },
          }))
        }
      />
    ) : null;

  const updateProps = {
    pending,
    canUpdate,
    onUpdate: () => void update(),
    onUndoAll: undoAll,
    saving,
    problem,
    running,
    failed,
    onRetry: () => void retry(),
    retrying,
    retryProblem,
  };

  return (
    <section aria-labelledby={titleId} className={styles.studio}>
      <AdHead
        titleId={titleId}
        meta={COPY.summary(
          ad.products.map(product => product.name),
          video?.seconds ?? null,
          ad.language
        )}
        status={
          running ? (
            <ProductChip tone="accent">
              <StatusDot />
              {COPY.updatingChip}
            </ProductChip>
          ) : (
            <ProductChip tone="ok">
              <Check aria-hidden="true" />
              {madeIn ? `${COPY.ready} · ${COPY.madeIn(madeIn)}` : COPY.ready}
            </ProductChip>
          )
        }
      />
      <div className={styles.columns}>
        <aside className={styles.side}>
          <div className={styles.picture}>
            <AdPlayer
              video={video}
              tag={
                video
                  ? COPY.videoTag(video.renderNo ?? ad.renderNo, video.seconds)
                  : null
              }
            />
          </div>
          <AdUpdateCard {...updateProps} showAction={!narrow} />
          <div className={styles.downloads}>
            {narrow
              ? dirty
                ? downloadVideo("outline")
                : null
              : downloadVideo(dirty ? "outline" : "default")}
            <div className={styles.downloadPair}>
              {ad.stills.statusUrl ? (
                <AdDownload
                  url={ad.stills.statusUrl}
                  fileName={adFileName(ad, "status")}
                >
                  {COPY.statusPicture}
                </AdDownload>
              ) : null}
              {ad.stills.feedUrl ? (
                <AdDownload
                  url={ad.stills.feedUrl}
                  fileName={adFileName(ad, "feed")}
                >
                  {COPY.adPicture}
                </AdDownload>
              ) : null}
            </div>
          </div>
          <div className={cn(theme.sheet, styles.aiBox)}>
            <h3 className={styles.sectionTitle}>{COPY.aiTitle}</h3>
            <ul className={styles.checks}>
              <li>
                <Check aria-hidden="true" />
                {COPY.aiWords(ad.openings.length > 0 || ad.endings.length > 0)}
              </li>
              <li>
                <Check aria-hidden="true" />
                {COPY.aiPictures(aiPictures)}
              </li>
              <li>
                <Check aria-hidden="true" />
                {COPY.aiFraming}
              </li>
            </ul>
            {ad.picturesLeft !== null ? (
              <p className={styles.note}>
                {COPY.aiPicturesLeft(ad.picturesLeft)}
              </p>
            ) : null}
          </div>
        </aside>

        <div className={styles.main}>
          <div className={cn(theme.sheet, styles.panel)}>
            <AdProductChips products={ad.products} />
            <AdBriefLine ad={ad} />
            {ad.pricesChanged ? (
              <div className={styles.downloads}>
                <p className={styles.issue}>{COPY.pricesChanged}</p>
                <div className={styles.actions}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onChangeProducts(
                        ad.products.map(product => product.productId)
                      )
                    }
                  >
                    {COPY.chooseAgain}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {/* The voice stream's panel (Part V). */}
          <ProductAdVoicePanel
            workspaceId={workspaceId}
            ad={ad}
            onChanged={onVoiceChanged ?? onChanged}
            startedRunNo={voiceRunNo}
            disabled={busy}
          />

          {ad.script ? (
            <>
              <div className={cn(theme.sheet, styles.panel)}>
                <AdOptions
                  title={COPY.openingTitle}
                  about={
                    ad.openings.length > 0
                      ? COPY.openingAbout
                      : COPY.openingAboutV1
                  }
                  kindNames={COPY.openingKinds}
                  ownLabel={COPY.ownOpeningLabel}
                  options={ad.openings}
                  saved={saved.sticker}
                  value={draft.sticker}
                  choice={opening}
                  onChoose={choice => {
                    setOpening(choice);
                    const option =
                      choice === "own" ? null : ad.openings[choice];
                    if (option)
                      setDraft(current => ({
                        ...current,
                        sticker: option.text,
                      }));
                  }}
                  onWrite={sticker =>
                    setDraft(current => ({ ...current, sticker }))
                  }
                  limit={limits.sticker}
                  disabled={busy}
                />
              </div>

              <div className={cn(theme.sheet, styles.panel)}>
                <AdSceneTools
                  ad={ad}
                  drafts={scenes}
                  onDraft={(productId, next) =>
                    setScenes(current => ({ ...current, [productId]: next }))
                  }
                  caption={captionField}
                  busyReason={busyReason}
                  blockedReason={
                    issues.length > 0 ? COPY.newPictureWhy.fixLines : null
                  }
                  onNewPicture={(productId, place) =>
                    void newPicture(productId, place)
                  }
                  pressProblem={pressProblem}
                  selectedId={sceneId}
                  onSelect={onSceneId}
                />
                <WordField
                  id={`${ids}-price-card`}
                  label={COPY.priceCardTitle}
                  value={draft.priceCardTitle}
                  saved={saved.priceCardTitle}
                  limit={limits.priceCardTitle}
                  disabled={busy}
                  onChange={priceCardTitle =>
                    setDraft(current => ({ ...current, priceCardTitle }))
                  }
                />
              </div>

              <div className={cn(theme.sheet, styles.panel)}>
                <AdOptions
                  title={COPY.endingTitle}
                  about={COPY.endingAbout}
                  kindNames={COPY.endingKinds}
                  ownLabel={COPY.ownEndingLabel}
                  options={ad.endings}
                  saved={saved.ending}
                  value={draft.ending}
                  choice={ending}
                  onChoose={choice => {
                    setEnding(choice);
                    const option = choice === "own" ? null : ad.endings[choice];
                    if (option)
                      setDraft(current => ({
                        ...current,
                        ending: option.text,
                      }));
                  }}
                  onWrite={text =>
                    setDraft(current => ({ ...current, ending: text }))
                  }
                  limit={limits.ending}
                  disabled={busy}
                />
              </div>
            </>
          ) : null}

          {ad.post ? (
            <AdRow title={COPY.postTitle} summary={COPY.postAbout}>
              <div className={styles.panelHead}>
                <p className={styles.note}>{COPY.postAbout}</p>
                <CopyButton text={ad.post.text} />
              </div>
              <p className={styles.postText}>{ad.post.text}</p>
            </AdRow>
          ) : null}

          {ad.ctwa ? (
            <AdRow title={COPY.ctwaTitle}>
              <div className={styles.panelHead}>
                <p className={styles.note}>{COPY.ctwaAbout}</p>
                <CopyButton text={ctwaText(ad.ctwa)} label={COPY.copyAll} />
              </div>
              <dl className={styles.rows}>
                {(
                  [
                    [COPY.ctwaHeadline, ad.ctwa.headline],
                    [COPY.ctwaPrimaryText, ad.ctwa.primaryText],
                    [COPY.ctwaGreeting, ad.ctwa.greeting],
                  ] as const
                ).map(([label, text]) => (
                  <div key={label} className={styles.row}>
                    <dt>{label}</dt>
                    <dd>{text}</dd>
                    <CopyButton
                      text={text}
                      iconOnly
                      ariaLabel={COPY.copyField(label)}
                    />
                  </div>
                ))}
                <div className={styles.row}>
                  <dt>{COPY.ctwaQuestions}</dt>
                  <dd>
                    <ul className={styles.questions}>
                      {ad.ctwa.questions.map(question => (
                        <li key={question}>{question}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              </dl>
              <div className={styles.actions}>
                <Button asChild variant="link" size="sm">
                  <a
                    href={ADS_MANAGER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {COPY.openAdsManager}
                    <ExternalLink aria-hidden="true" />
                  </a>
                </Button>
              </div>
            </AdRow>
          ) : null}

          <AdRow title={COPY.checksTitle}>
            <ul className={styles.checks}>
              <li>
                <Check aria-hidden="true" />
                {COPY.checks.prices}
              </li>
              <li>
                <Check aria-hidden="true" />
                {COPY.checks.pictures}
              </li>
              <li>
                <Check aria-hidden="true" />
                {COPY.checks.safe}
              </li>
              {size ? (
                <li>
                  <Check aria-hidden="true" />
                  {COPY.checks.size(size)}
                </li>
              ) : null}
              {anyMuse ? (
                <li data-tone="info">
                  <Info aria-hidden="true" />
                  {COPY.checks.aiLabel}
                </li>
              ) : null}
            </ul>
          </AdRow>

          <AdRow title={COPY.creditsTitle}>
            <ul className={styles.creditList}>
              <li>{COPY.credits.words}</li>
              <li>
                {anyMuse ? COPY.credits.pictures : COPY.credits.exactPictures}
              </li>
              {newPictureCredits.map(line => (
                <li key={line}>{line}</li>
              ))}
              <li>{COPY.credits.framing}</li>
              <li>
                {ad.voice === "own"
                  ? COPY.credits.voiceOwn
                  : ad.voice === "none"
                    ? COPY.credits.voiceNone
                    : `${COPY.voice}: ${PRODUCTS_COPY.adVoice.modes[ad.voice]}`}
              </li>
              {ad.presenter ? <li>{COPY.credits.presenter}</li> : null}
              <li>{COPY.credits.video}</li>
              <li>{COPY.credits.prices}</li>
              {took.length > 0 ? <li>{COPY.credits.took(took)}</li> : null}
              <li>{COPY.credits.cost(dollars(ad.costUsd))}</li>
            </ul>
          </AdRow>
        </div>
      </div>
      {narrow && (dirty || running || video) ? (
        <AdBar>
          {dirty || running ? (
            <AdUpdateBarAction {...updateProps} />
          ) : (
            downloadVideo("default")
          )}
        </AdBar>
      ) : null}
    </section>
  );
}
