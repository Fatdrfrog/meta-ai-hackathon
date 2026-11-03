"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  PRODUCT_AD_STEPS,
  PRODUCT_AD_TEXT_LIMITS,
  productAdTextIssues,
  type ProductAdRecord,
  type ProductAdTextLimit,
  type ProductAdUpdateRequest,
} from "@/lib/products/types";
import { oneLine } from "@/lib/products/ad-request";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, ExternalLink, Info } from "lucide-react";
import { useId, useState } from "react";
import { updateProductAd } from "./ads-client";
import {
  AdBar,
  AdBriefLine,
  AdDownload,
  AdHead,
  AdProductChips,
  AdSceneList,
  CopyButton,
  adFileName,
  fileSize,
  tookTime,
} from "./product-ad-parts";
import { AdPlayer } from "./product-ad-player";
import styles from "./product-ad-studio.module.css";
import { ProductChip } from "./product-controls";
import theme from "./product-theme.module.css";
import { ProductDraftError } from "./products-client";
import { useNarrowStudio } from "./use-product-ad";

// The finished ad: the 9:16 player and its downloads, the words on screen
// (names and prices locked; the rest the owner may change, which makes the
// video again with no AI action), the post text and the Click-to-WhatsApp
// copy to paste, what Airi checked, and how the ad was made.

const COPY = PRODUCTS_COPY.ad;

const ADS_MANAGER_URL = "https://adsmanager.facebook.com/";

/**
 * Why the owner's words can't go on screen, in their terms, by the script's
 * own checks: empty, a number or a currency (Airi draws prices), letters
 * the fonts lack, or more than the line room. Null when they can.
 */
export function wordsIssue(
  text: string,
  limit: ProductAdTextLimit
): string | null {
  const [first] = productAdTextIssues("text", text, limit);
  if (!first) return null;
  if (first.includes("is empty")) return COPY.issues.empty;
  if (first.includes("digit")) return COPY.issues.digits;
  if (first.includes("currency")) return COPY.issues.currency;
  if (first.includes("fonts")) return COPY.issues.letters;
  return COPY.issues.room(limit.lines ?? 1, limit.chars);
}

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

/**
 * Whether a line was changed: the server keeps words as one line, so
 * spacing alone (the owner's, or a double space in Muse Spark's) isn't.
 */
const edited = (draft: string, saved: string | undefined) =>
  oneLine(draft) !== oneLine(saved ?? "");

/** What the owner changed, as the PATCH sends it; null when nothing. */
export function wordChanges(
  saved: ProductAdRecord["script"],
  draft: Words
): ProductAdUpdateRequest | null {
  const before = wordsOf(saved);
  const changes: ProductAdUpdateRequest = {};
  if (edited(draft.sticker, before.sticker))
    changes.sticker = oneLine(draft.sticker);
  const captions = Object.entries(draft.captions)
    .filter(([productId, caption]) =>
      edited(caption, before.captions[productId])
    )
    .map(([productId, caption]) => ({ productId, caption: oneLine(caption) }));
  if (captions.length > 0) changes.captions = captions;
  if (edited(draft.priceCardTitle, before.priceCardTitle))
    changes.priceCardTitle = oneLine(draft.priceCardTitle);
  if (edited(draft.ending, before.ending))
    changes.ending = oneLine(draft.ending);
  return Object.keys(changes).length > 0 ? changes : null;
}

/** "$0.05"; "under $0.01" for less. */
const dollars = (usd: number) =>
  usd <= 0 ? "$0" : usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`;

type SaveErrorCode = keyof typeof COPY.saveErrors;
const saveError = (code: string) =>
  COPY.saveErrors[(code in COPY.saveErrors ? code : "failed") as SaveErrorCode];

function WordField({
  id,
  label,
  value,
  saved,
  limit,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  saved: string;
  limit: ProductAdTextLimit;
  onChange: (value: string) => void;
}) {
  const lines = limit.lines ?? 1;
  // Only a changed line is checked: the saved words passed already.
  const issue = edited(value, saved) ? wordsIssue(value, limit) : null;
  const describedBy = issue ? `${id}-room ${id}-issue` : `${id}-room`;
  const shared = {
    id,
    value,
    className: styles.input,
    maxLength: limit.chars * lines + 20,
    spellCheck: true,
    "aria-invalid": issue ? true : undefined,
    "aria-describedby": describedBy,
  } as const;
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <label htmlFor={id} className={styles.fieldLabel}>
          {label}
        </label>
        <span id={`${id}-room`} className={styles.fieldRoom}>
          {COPY.lineRoom(lines, limit.chars)}
        </span>
      </div>
      {lines > 1 ? (
        <textarea
          {...shared}
          rows={2}
          onChange={event => onChange(event.target.value)}
        />
      ) : (
        <input
          {...shared}
          autoComplete="off"
          onChange={event => onChange(event.target.value)}
        />
      )}
      {issue ? (
        <p id={`${id}-issue`} className={styles.issue}>
          {issue}
        </p>
      ) : null}
    </div>
  );
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

export function AdReady({
  workspaceId,
  ad,
  onChanged,
  onChangeProducts,
}: {
  workspaceId: string;
  ad: ProductAdRecord;
  onChanged: (ad: ProductAdRecord) => void;
  /** The shelf's Choose mode with these products chosen, for a new ad. */
  onChangeProducts: (productIds: string[]) => void;
}) {
  const titleId = useId();
  const ids = useId();
  const narrow = useNarrowStudio();
  const [draft, setDraft] = useState<Words>(() => wordsOf(ad.script));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const saved = wordsOf(ad.script);
  const changes = wordChanges(ad.script, draft);
  const limits = PRODUCT_AD_TEXT_LIMITS;
  const changedIssues = [
    edited(draft.sticker, saved.sticker) &&
      wordsIssue(draft.sticker, limits.sticker),
    ...Object.entries(draft.captions).map(
      ([productId, caption]) =>
        edited(caption, saved.captions[productId]) &&
        wordsIssue(caption, limits.caption)
    ),
    edited(draft.priceCardTitle, saved.priceCardTitle) &&
      wordsIssue(draft.priceCardTitle, limits.priceCardTitle),
    edited(draft.ending, saved.ending) &&
      wordsIssue(draft.ending, limits.ending),
  ].filter(Boolean);
  const dirty = changes !== null;
  const canSave = dirty && changedIssues.length === 0 && !saving;

  const save = async () => {
    if (!changes || !canSave) return;
    setSaving(true);
    setProblem(null);
    try {
      onChanged(await updateProductAd(workspaceId, ad.id, changes));
    } catch (error) {
      setProblem(
        saveError(error instanceof ProductDraftError ? error.code : "failed")
      );
    } finally {
      setSaving(false);
    }
  };

  const video = ad.video;
  const size = video ? fileSize(video.bytes) : null;
  const anyMuse = ad.scenes.some(scene => scene.method === "muse");
  const madeIn = ad.readyAt
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

  // One main action at a time: download the video, or save the changes.
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
  const saveButton = (
    <Button fullWidth disabled={!canSave} onClick={() => void save()}>
      {saving ? COPY.saving : COPY.save}
    </Button>
  );

  const field = (
    key: string,
    label: string,
    value: string,
    savedValue: string,
    limit: ProductAdTextLimit,
    set: (value: string) => void
  ) => (
    <WordField
      id={`${ids}-${key}`}
      label={label}
      value={value}
      saved={savedValue}
      limit={limit}
      onChange={set}
    />
  );

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
          <ProductChip tone="ok">
            <Check aria-hidden="true" />
            {madeIn ? `${COPY.ready} · ${COPY.madeIn(madeIn)}` : COPY.ready}
          </ProductChip>
        }
      />
      <div className={styles.columns}>
        <aside className={styles.side}>
          <div className={styles.picture}>
            <AdPlayer video={video} />
          </div>
          <div className={styles.downloads}>
            {narrow
              ? dirty
                ? downloadVideo("outline")
                : null
              : downloadVideo(dirty ? "outline" : "default")}
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

          {ad.script ? (
            <div className={cn(theme.sheet, styles.panel)}>
              <div className={styles.field}>
                <h3 className={styles.sectionTitle}>{COPY.wordsTitle}</h3>
                <p className={styles.note}>{COPY.wordsAbout}</p>
              </div>
              {field(
                "sticker",
                COPY.sticker,
                draft.sticker,
                saved.sticker,
                limits.sticker,
                sticker => setDraft(current => ({ ...current, sticker }))
              )}
              <AdSceneList
                ad={ad}
                settled
                body={productId =>
                  productId in draft.captions
                    ? field(
                        `caption-${productId}`,
                        COPY.caption(
                          ad.products.find(
                            product => product.productId === productId
                          )?.name ?? ""
                        ),
                        draft.captions[productId] ?? "",
                        saved.captions[productId] ?? "",
                        limits.caption,
                        caption =>
                          setDraft(current => ({
                            ...current,
                            captions: {
                              ...current.captions,
                              [productId]: caption,
                            },
                          }))
                      )
                    : null
                }
              />
              {field(
                "price-card",
                COPY.priceCardTitle,
                draft.priceCardTitle,
                saved.priceCardTitle,
                limits.priceCardTitle,
                priceCardTitle =>
                  setDraft(current => ({ ...current, priceCardTitle }))
              )}
              {field(
                "ending",
                COPY.endingLine,
                draft.ending,
                saved.ending,
                limits.ending,
                ending => setDraft(current => ({ ...current, ending }))
              )}
              {dirty ? (
                <div className={styles.downloads}>
                  {narrow ? null : saveButton}
                  <div className={styles.actions}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onClick={() => {
                        setDraft(wordsOf(ad.script));
                        setProblem(null);
                      }}
                    >
                      {COPY.undoEdits}
                    </Button>
                    <span className={styles.note}>{COPY.saveNote}</span>
                  </div>
                  {problem ? (
                    <p role="alert" className={styles.issue}>
                      {problem}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {ad.post ? (
            <div className={cn(theme.sheet, styles.panel)}>
              <div className={styles.panelHead}>
                <h3 className={styles.sectionTitle}>{COPY.postTitle}</h3>
                <CopyButton text={ad.post.text} />
              </div>
              <p className={styles.note}>{COPY.postAbout}</p>
              <p className={styles.postText}>{ad.post.text}</p>
            </div>
          ) : null}

          {ad.ctwa ? (
            <div className={cn(theme.sheet, styles.panel)}>
              <div className={styles.panelHead}>
                <h3 className={styles.sectionTitle}>{COPY.ctwaTitle}</h3>
                <CopyButton text={ctwaText(ad.ctwa)} label={COPY.copyAll} />
              </div>
              <p className={styles.note}>{COPY.ctwaAbout}</p>
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
            </div>
          ) : null}

          <div className={cn(theme.sheet, styles.panel)}>
            <h3 className={styles.sectionTitle}>{COPY.checksTitle}</h3>
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
          </div>

          <div className={cn(theme.sheet, styles.panel)}>
            <details className={styles.credits}>
              <summary>
                <ChevronRight aria-hidden="true" />
                {COPY.creditsTitle}
              </summary>
              <ul className={styles.creditList}>
                <li>{COPY.credits.words}</li>
                <li>
                  {anyMuse ? COPY.credits.pictures : COPY.credits.exactPictures}
                </li>
                <li>{COPY.credits.framing}</li>
                <li>
                  {ad.voice === "own"
                    ? COPY.credits.voiceOwn
                    : COPY.credits.voiceNone}
                </li>
                {ad.presenter ? <li>{COPY.credits.presenter}</li> : null}
                <li>{COPY.credits.video}</li>
                <li>{COPY.credits.prices}</li>
                {took.length > 0 ? <li>{COPY.credits.took(took)}</li> : null}
                <li>{COPY.credits.cost(dollars(ad.costUsd))}</li>
              </ul>
            </details>
          </div>
        </div>
      </div>
      {narrow && (dirty || video) ? (
        <AdBar>{dirty ? saveButton : downloadVideo("default")}</AdBar>
      ) : null}
    </section>
  );
}
