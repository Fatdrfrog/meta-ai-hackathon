"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  PRODUCT_AD_IDEA_KINDS,
  PRODUCT_AD_IDEA_MAX_LENGTH,
  PRODUCT_AD_MAX_PRODUCTS,
  PRODUCT_AD_MIN_PRODUCTS,
  PRODUCT_AD_VOICES,
  productAdLettersSupported,
  productAdShopName,
  type ProductAdBrief,
  type ProductAdCreateRequest,
  type ProductAdIdeaKind,
  type ProductAdVoice,
} from "@/lib/products/types";
import { oneLine } from "@/lib/products/ad-request";
import { cn } from "@/lib/utils";
import { useEffect, useId, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  createProductAd,
  fetchProductAdBrief,
  productAdBriefUrl,
} from "./ads-client";
import {
  AdBar,
  AdChoices,
  AdHead,
  AdProblem,
  AdProductChips,
  AdSketch,
  AdSkeleton,
  AdToggle,
} from "./product-ad-parts";
import styles from "./product-ad-studio.module.css";
import theme from "./product-theme.module.css";
import {
  ProductDraftError,
  productAdUrl,
  productsMadeUrl,
} from "./products-client";
import { useNarrowStudio } from "./use-product-ad";

// The brief for a new ad: one screen with everything filled in, and nothing
// spent until "Make the ad". Prices are locked to the shelf; the owner picks
// the idea, the voice and whether the person from the video appears, which
// takes their word that the person agreed.

const COPY = PRODUCTS_COPY.ad;

const IDEA_OPTIONS = PRODUCT_AD_IDEA_KINDS.map(kind => ({
  value: kind,
  label: COPY.ideas[kind],
}));
const VOICE_OPTIONS = PRODUCT_AD_VOICES.map(voice => ({
  value: voice,
  label: COPY.voices[voice],
}));

/** An id for one press of "Make the ad", so sending it twice makes one ad. */
function newRequestId(): string {
  const api = typeof crypto === "undefined" ? undefined : crypto;
  if (typeof api?.randomUUID === "function") return api.randomUUID();
  return `ad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const length = (text: string) => Array.from(text).length;

/** The ad POST's refusals, all checked before the ad is written. */
const AD_REFUSALS_BEFORE_WRITING: ReadonlySet<string> = new Set([
  "invalid_request",
  "not_enough_products",
  "ad_letters_unsupported",
  "trial_ended",
  "spend_limit",
  "ai_actions_used",
]);

type CreateErrorCode = keyof typeof COPY.createErrors;
const createError = (code: string) =>
  COPY.createErrors[
    (code in COPY.createErrors ? code : "failed") as CreateErrorCode
  ];

export type AdBriefProps = {
  workspaceId: string;
  productIds: string[];
  onCreated: (adId: string) => void;
  onChangeProducts: (productIds: string[]) => void;
};

/** The brief: loads what it starts from, then the form. */
export function AdBrief({
  workspaceId,
  productIds,
  onCreated,
  onChangeProducts,
}: AdBriefProps) {
  const titleId = useId();
  // An address with no products, or more than an ad shows, has no brief.
  const fits =
    productIds.length >= PRODUCT_AD_MIN_PRODUCTS &&
    productIds.length <= PRODUCT_AD_MAX_PRODUCTS;
  const { data, error, mutate } = useSWR<ProductAdBrief, ProductDraftError>(
    fits ? productAdBriefUrl(workspaceId, productIds) : null,
    fetchProductAdBrief,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  if (!data)
    return (
      <section aria-labelledby={titleId} className={styles.studio}>
        <AdHead titleId={titleId} meta={null} />
        {!fits || error?.code === "invalid_request" ? (
          <AdProblem
            message={COPY.needsPhotoAndPrice}
            action={
              <Button
                variant="outline"
                onClick={() => onChangeProducts(productIds)}
              >
                {COPY.chooseProducts}
              </Button>
            }
          />
        ) : error ? (
          <AdProblem
            message={COPY.briefFailed}
            action={
              <Button variant="outline" onClick={() => void mutate()}>
                {COPY.retry}
              </Button>
            }
          />
        ) : (
          <AdSkeleton label={COPY.loadingBrief} />
        )}
      </section>
    );
  return (
    <BriefForm
      titleId={titleId}
      workspaceId={workspaceId}
      brief={data}
      onCreated={onCreated}
      onChangeProducts={() => onChangeProducts(productIds)}
    />
  );
}

function BriefForm({
  titleId,
  workspaceId,
  brief,
  onCreated,
  onChangeProducts,
}: {
  titleId: string;
  workspaceId: string;
  brief: ProductAdBrief;
  onCreated: (adId: string) => void;
  onChangeProducts: () => void;
}) {
  const narrow = useNarrowStudio();
  const ids = useId();
  const { mutate } = useSWRConfig();
  const [idea, setIdea] = useState<ProductAdIdeaKind>("new");
  const [ownWords, setOwnWords] = useState("");
  const [voiceChoice, setVoiceChoice] = useState<ProductAdVoice>("own");
  const [showPresenter, setShowPresenter] = useState(false);
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The press being made: its id, and the brief it sent.
  const press = useRef<{ id: string; brief: string } | null>(null);
  // The owner may leave while the ad starts ("you can leave this page"):
  // an ad that starts after the brief has gone doesn't pull them back.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  // Choosing "Your own words" goes straight to typing them.
  const ownField = useRef<HTMLInputElement>(null);
  const choseOwn = useRef(false);
  useEffect(() => {
    if (idea === "own" && choseOwn.current) ownField.current?.focus();
    choseOwn.current = false;
  }, [idea]);

  const { products } = brief;
  const withVoice = products.filter(product => product.hasVoice).length;
  // "Your voice" is the default when the video has the owner saying a price.
  const voice: ProductAdVoice = withVoice > 0 ? voiceChoice : "none";
  const ownText = oneLine(ownWords);
  const presenterShown = brief.presenter !== null && showPresenter;

  // Texts the ad would draw that its fonts can't; the server checks them too.
  // The shop's name isn't one: the ending leaves out a name it can't draw.
  const unsupported = [
    ...products.flatMap(product => [product.name, product.priceText ?? ""]),
    idea === "own" ? ownText : "",
  ].filter(text => text && !productAdLettersSupported(text));

  const hasProblem = products.some(product => product.problem !== null);
  const why =
    products.length === 0
      ? COPY.nothingToMake
      : hasProblem
        ? COPY.needsPhotoAndPrice
        : unsupported.length > 0
          ? COPY.letters
          : brief.blocked
            ? COPY.blocked(brief.blocked)
            : idea === "own" && !ownText
              ? COPY.ownWordsNeeded
              : presenterShown && !consent
                ? COPY.presenterConsentNeeded
                : null;

  const make = async () => {
    if (why || sending) return;
    setSending(true);
    setRefusal(null);
    const request: Omit<ProductAdCreateRequest, "requestId"> = {
      productIds: products.map(product => product.productId),
      idea: idea === "own" ? { kind: "own", text: ownText } : { kind: idea },
      voice,
      presenter: { use: presenterShown, consent: presenterShown && consent },
    };
    // A press is sent again only with the brief it first sent: under the
    // same id the server answers with the ad that brief saved, so a brief
    // changed since is a new press, made of the owner's latest choices.
    const sent = JSON.stringify(request);
    const id =
      press.current?.brief === sent ? press.current.id : newRequestId();
    press.current = { id, brief: sent };
    try {
      const ad = await createProductAd(workspaceId, {
        requestId: id,
        ...request,
      });
      // The ad opens with what the server said, without asking again, and
      // Made from your shelf lists it, wherever the owner is now.
      await mutate(productAdUrl(workspaceId, ad.id), ad, { revalidate: false });
      void mutate(productsMadeUrl(workspaceId));
      if (onScreen.current) onCreated(ad.id);
    } catch (error) {
      const code = error instanceof ProductDraftError ? error.code : "failed";
      // A refusal decided before the ad was written is an answer: the next
      // press is a new one. A request that may not have arrived, or one the
      // server failed after writing the ad (503 ad_unavailable: its run
      // didn't start), keeps its id while the brief stays as it was, so
      // sending it again makes at most one ad, and starts the one that
      // exists.
      if (AD_REFUSALS_BEFORE_WRITING.has(code)) press.current = null;
      setRefusal(createError(code));
      setSending(false);
    }
  };

  const noteId = `${ids}-make-note`;
  const makeBlock = (
    <div className={styles.downloads}>
      <Button
        fullWidth
        disabled={why !== null || sending}
        aria-describedby={noteId}
        onClick={() => void make()}
      >
        {sending ? COPY.starting : COPY.make}
      </Button>
      <p
        id={noteId}
        role={refusal ? "alert" : undefined}
        className={refusal || why ? styles.issue : styles.note}
      >
        {refusal ?? why ?? COPY.cost}
      </p>
      {refusal || why ? <p className={styles.note}>{COPY.cost}</p> : null}
    </div>
  );

  const first = products[0];
  return (
    <section aria-labelledby={titleId} className={styles.studio}>
      <AdHead
        titleId={titleId}
        meta={products.length ? COPY.briefLead(products.length) : null}
      />
      <div className={cn(styles.columns, styles.pictureFirst)}>
        <div className={styles.main}>
          <div className={cn(theme.sheet, styles.panel)}>
            <div className={styles.panelHead}>
              <h3 className={styles.sectionTitle}>{COPY.products}</h3>
              <Button
                variant="link"
                size="sm"
                aria-label={COPY.changeProductsLabel}
                onClick={onChangeProducts}
              >
                {COPY.changeProducts}
              </Button>
            </div>
            {products.length > 0 ? (
              <AdProductChips products={products} />
            ) : (
              <p className={styles.issue}>{COPY.nothingToMake}</p>
            )}
            <p className={styles.note}>{COPY.pricesFromShelf}</p>
            {brief.missing > 0 && products.length > 0 ? (
              <p className={styles.note}>{COPY.missing(brief.missing)}</p>
            ) : null}
            {hasProblem ? (
              <p className={styles.issue}>{COPY.needsPhotoAndPrice}</p>
            ) : null}
            {unsupported.map(text => (
              <p key={text} className={styles.issue}>
                {COPY.lettersIn(text)}
              </p>
            ))}
          </div>

          <div className={cn(theme.sheet, styles.panel)}>
            <AdChoices
              name={`${ids}-idea`}
              legend={COPY.idea}
              options={IDEA_OPTIONS}
              value={idea}
              onChange={next => {
                choseOwn.current = next === "own";
                setIdea(next);
              }}
              describedBy={`${ids}-idea-about`}
            />
            <p id={`${ids}-idea-about`} className={styles.note}>
              {COPY.ideaAbout[idea]}
            </p>
            {idea === "own" ? (
              <div className={styles.field}>
                <div className={styles.fieldHead}>
                  <label htmlFor={`${ids}-own`} className={styles.fieldLabel}>
                    {COPY.ownWords}
                  </label>
                  <span className={styles.fieldRoom} aria-hidden="true">
                    {COPY.ownWordsCount(length(ownWords))}
                  </span>
                </div>
                <input
                  ref={ownField}
                  id={`${ids}-own`}
                  className={styles.input}
                  value={ownWords}
                  maxLength={PRODUCT_AD_IDEA_MAX_LENGTH}
                  autoComplete="off"
                  onChange={event => setOwnWords(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          <div className={cn(theme.sheet, styles.panel)}>
            {withVoice > 0 ? (
              <>
                <AdChoices
                  name={`${ids}-voice`}
                  legend={COPY.voice}
                  options={VOICE_OPTIONS}
                  value={voice}
                  onChange={setVoiceChoice}
                  describedBy={`${ids}-voice-about`}
                />
                <p id={`${ids}-voice-about`} className={styles.note}>
                  {COPY.voiceAbout[voice]}
                  {voice === "own" && withVoice < products.length
                    ? ` ${COPY.voiceSilent}`
                    : ""}
                </p>
              </>
            ) : (
              <div className={styles.field}>
                <h3 className={styles.sectionTitle}>{COPY.voice}</h3>
                <p className={styles.note}>{COPY.noVoiceClips}</p>
              </div>
            )}
          </div>

          {brief.presenter ? (
            <div className={cn(theme.sheet, styles.panel)}>
              <div className={styles.presenter}>
                <span className={styles.presenterPhoto}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={brief.presenter.imageUrl} alt={COPY.presenter} />
                </span>
                <div className={styles.presenterBody}>
                  <h3 className={styles.sectionTitle}>{COPY.presenter}</h3>
                  <p className={styles.note}>{COPY.presenterCredit}</p>
                  <AdToggle
                    checked={showPresenter}
                    onChange={next => {
                      setShowPresenter(next);
                      if (!next) setConsent(false);
                    }}
                  >
                    {COPY.presenterShow}
                  </AdToggle>
                  {showPresenter ? (
                    <AdToggle checked={consent} onChange={setConsent}>
                      {COPY.presenterConsent}
                    </AdToggle>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <div className={cn(theme.sheet, styles.panel)}>
            <dl className={styles.rows}>
              <div className={styles.row}>
                <dt>{COPY.ending}</dt>
                <dd>
                  {brief.ending.phone
                    ? COPY.endingWithNumber(brief.ending.phone)
                    : COPY.endingWithShop(
                        productAdShopName(brief.ending.shopName)
                      )}
                  {brief.ending.phone ? null : (
                    <span className={cn(styles.note, "block")}>
                      {COPY.endingConnect}
                    </span>
                  )}
                </dd>
              </div>
              <div className={styles.row}>
                <dt>{COPY.language}</dt>
                <dd>
                  {brief.language
                    ? COPY.languageSpoken(brief.language)
                    : COPY.languageUnknown}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <aside className={styles.side}>
          {first ? (
            <div className={styles.picture}>
              <AdSketch product={first} />
              <p className={styles.pictureCaption}>{COPY.sketchCaption}</p>
            </div>
          ) : null}
          {narrow ? null : makeBlock}
        </aside>
      </div>
      {narrow ? <AdBar>{makeBlock}</AdBar> : null}
    </section>
  );
}
