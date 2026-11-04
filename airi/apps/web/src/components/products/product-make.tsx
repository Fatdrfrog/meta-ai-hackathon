"use client";

// "Make something with them": what the owner makes from shelf products. For
// customers on WhatsApp, a carousel and an order form made by one press (the
// kit); for new customers, the way into a video ad; and "What buyers see",
// built from the real products. Shown under a finished review, and as the
// page's ?make view for products chosen on the shelf.

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  KIT_CAROUSEL_MAX_CARDS,
  KIT_CAROUSEL_MIN_CARDS,
  ORDER_FORM_MAX_PRODUCTS,
} from "@/lib/products/kit-text";
import { buyerPrice, SHOP_WORDS } from "@/lib/products/shop-words";
import {
  PRODUCT_AD_MAX_PRODUCTS,
  PRODUCT_SHOP_WORDS_CODES,
  type ProductKitEdits,
  type ProductKitPart,
  type ProductKitPlanProduct,
  type ProductKitPlanResponse,
  type ProductKitRecord,
  type ProductShopWordsCode,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { CircleAlert, Clapperboard, Pencil } from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useSWRConfig } from "swr";
import { connectWhatsAppHref } from "./kit-links";
import {
  createProductKit,
  newKitRequestId,
  ownerTimeZone,
  retryProductKitPart,
  sendProductKitFormTest,
} from "./kits-client";
import { BuyersPreview } from "./product-buyers-preview";
import {
  ProductCheck,
  ProductChip,
  ProductSegmented,
} from "./product-controls";
import {
  KitCarouselEditBeforeMake,
  KitOrderFormEditBeforeMake,
  KitPartEditAfterMake,
  type KitDraftsCache,
} from "./product-kit-editor-sheet";
import {
  KitStatus,
  kitPartsSaid,
  kitRequestErrorLine,
  kitTitle,
} from "./product-kit-status";
import styles from "./product-make.module.css";
import theme from "./product-theme.module.css";
import {
  ProductDraftError,
  productKitUrl,
  productsMadeUrl,
} from "./products-client";
import {
  formatElapsed,
  madeWhen,
  useNow,
  useProductKit,
  useProductKitPlan,
} from "./use-product-kits";

const COPY = PRODUCTS_COPY.make;
const KIT = PRODUCTS_COPY.kit;
const EDIT = PRODUCTS_COPY.kit.edit;
const AD = PRODUCTS_COPY.adCard;

/** The owner's edits before Make, for the products and language they were made for. */
type KitEditsState = { key: string; edits: ProductKitEdits };

const hasEdits = (edits: ProductKitEdits) =>
  Boolean(edits.carousel || edits.orderForm);

const NO_EDITS: ProductKitEdits = {};

/** What the page gives the make view. */
export type MakeOutputsProps = {
  workspaceId: string;
  /** The products to make from, in shelf order. */
  productIds: readonly string[];
  /** The import whose review led here; null for products chosen on the shelf. */
  importId: string | null;
  /** "Change": the shelf's Choose mode, with these products chosen. */
  onChangeProducts: (productIds: string[]) => void;
  /** The video ad card: the ad's brief with these products (?ad=new&products=…). */
  onMakeAd: (productIds: string[]) => void;
};

/** The make view: the two cards, and what buyers see beside them. */
export function MakeOutputs({
  workspaceId,
  productIds,
  importId,
  onChangeProducts,
  onMakeAd,
}: MakeOutputsProps) {
  const titleId = useId();
  const { plan, waitingForProducts } = useProductKitPlan(
    workspaceId,
    productIds,
    importId
  );
  const [chosen, setChosen] = useState<ProductShopWordsCode | null>(null);
  // A review's last decisions may still be saving: wait for its products.
  const data =
    plan.data?.products.length === 0 && waitingForProducts
      ? undefined
      : plan.data;
  const language = chosen ?? data?.language ?? "en";
  // Only a language the owner spoke is called "the language you spoke": one
  // who spoke Uzbek gets English, which they didn't speak.
  const spoken = data?.languageIsSpoken ? data.language : null;
  const change = () => onChangeProducts([...productIds]);

  // "Edit cards" and "Edit questions" before Make: kept for these products
  // in this language; changing either starts them again, once the owner agrees.
  const editsKey = `${language}:${productIds.join(",")}`;
  const [editsState, setEditsState] = useState<KitEditsState | null>(null);
  const edits = editsState?.key === editsKey ? editsState.edits : NO_EDITS;
  const setEdits = useCallback(
    (next: ProductKitEdits) => setEditsState({ key: editsKey, edits: next }),
    [editsKey]
  );
  const [confirm, setConfirm] = useState<
    | { kind: "language"; to: ProductShopWordsCode }
    | { kind: "products"; productIds: string[] }
    | null
  >(null);
  const chooseLanguage = (code: ProductShopWordsCode) => {
    if (code === language) return;
    if (hasEdits(edits)) setConfirm({ kind: "language", to: code });
    else setChosen(code);
  };
  const changeProducts = (ids: string[]) => {
    if (hasEdits(edits)) setConfirm({ kind: "products", productIds: ids });
    else onChangeProducts(ids);
  };
  // Once answered, the question's buttons go: the keyboard's focus goes back
  // to the language line's Change it was asked from, or the section title.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const languageChangeRef = useRef<HTMLButtonElement>(null);
  const asked = useRef(confirm);
  useEffect(() => {
    const was = asked.current;
    asked.current = confirm;
    if (!was || confirm) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (
      (was.kind === "language" ? languageChangeRef.current : null) ??
      headingRef.current
    )?.focus({ preventScroll: true });
  }, [confirm]);

  let body: ReactNode;
  if (productIds.length === 0 || data?.products.length === 0)
    body = (
      <p className={styles.notice}>
        {COPY.noneOnShelf}{" "}
        <button type="button" className={styles.link} onClick={change}>
          {COPY.changeProducts}
        </button>
      </p>
    );
  else if (!data && plan.error)
    body = (
      <div role="alert" className={styles.notice}>
        <CircleAlert aria-hidden="true" className={styles.noticeIcon} />
        <span>{COPY.loadError}</span>
        <Button size="sm" variant="outline" onClick={() => void plan.mutate()}>
          {COPY.retry}
        </Button>
      </div>
    );
  else if (!data)
    body = (
      <div role="status" className={styles.skeleton}>
        <span className="sr-only">{COPY.loading}</span>
        <span
          aria-hidden="true"
          className={cn(theme.sheet, styles.ghostCard)}
        />
        <span
          aria-hidden="true"
          className={cn(theme.sheet, styles.ghostCard)}
        />
      </div>
    );
  else
    body = (
      <div className={styles.grid}>
        <div className={styles.cards}>
          <KitCard
            workspaceId={workspaceId}
            plan={data}
            importId={importId}
            language={language}
            edits={edits}
            onEditsChange={setEdits}
            onChangeProducts={changeProducts}
            onPlanStale={() => void plan.mutate()}
          />
          <VideoAdCard
            products={data.products}
            language={data.language}
            onMakeAd={onMakeAd}
          />
        </div>
        <BuyersPreview
          products={data.products}
          language={language}
          spokenLanguage={spoken}
          carousel={edits.carousel}
          orderForm={edits.orderForm}
        />
      </div>
    );

  const names = COPY.languages;
  return (
    <section aria-labelledby={titleId} className={styles.make}>
      <header className={styles.head}>
        <h2
          ref={headingRef}
          id={titleId}
          tabIndex={-1}
          className={theme.displayL}
        >
          {COPY.title}
        </h2>
        {data && data.products.length > 0 ? (
          <LanguageLine
            changeRef={languageChangeRef}
            spoken={spoken}
            value={language}
            onChange={chooseLanguage}
          />
        ) : null}
        {confirm?.kind === "language" ? (
          <EditsConfirm
            body={COPY.confirmLanguage.body(names[language], names[confirm.to])}
            keepLabel={COPY.confirmLanguage.keep(names[language])}
            goLabel={COPY.confirmLanguage.switch(names[confirm.to])}
            onKeep={() => setConfirm(null)}
            onGo={() => {
              setEditsState(null);
              setChosen(confirm.to);
              setConfirm(null);
            }}
          />
        ) : confirm?.kind === "products" ? (
          <EditsConfirm
            body={COPY.confirmProducts.body}
            keepLabel={COPY.confirmProducts.keep}
            goLabel={COPY.confirmProducts.change}
            onKeep={() => setConfirm(null)}
            onGo={() => {
              setEditsState(null);
              setConfirm(null);
              onChangeProducts(confirm.productIds);
            }}
          />
        ) : null}
      </header>
      {body}
    </section>
  );
}

/**
 * Asks before a change that starts the edits again: what goes, and the two
 * ways on. It takes the keyboard's focus as it opens.
 */
function EditsConfirm({
  body,
  keepLabel,
  goLabel,
  onKeep,
  onGo,
}: {
  body: string;
  keepLabel: string;
  goLabel: string;
  onKeep: () => void;
  onGo: () => void;
}) {
  const bodyId = useId();
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keepRef.current?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-describedby={bodyId}
      aria-label={body}
      className={styles.confirm}
    >
      <p id={bodyId}>{body}</p>
      <div className={styles.confirmActions}>
        <Button ref={keepRef} size="sm" variant="outline" onClick={onKeep}>
          {keepLabel}
        </Button>
        <Button size="sm" variant="outline" onClick={onGo}>
          {goLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * "Buyers see it in Kazakh, the language you spoke. Change", or "Buyers see
 * it in English." for a language the owner didn't speak (`spoken` null).
 */
function LanguageLine({
  changeRef,
  spoken,
  value,
  onChange,
}: {
  /** Its Change button, which the language question gives the focus back to. */
  changeRef?: RefObject<HTMLButtonElement | null>;
  spoken: ProductShopWordsCode | null;
  value: ProductShopWordsCode;
  onChange: (code: ProductShopWordsCode) => void;
}) {
  const [open, setOpen] = useState(false);
  const names = COPY.languages;
  return (
    <div className={styles.language}>
      <p className={styles.lede}>
        {value === spoken
          ? COPY.language(names[value])
          : COPY.languageChosen(names[value])}{" "}
        <button
          ref={changeRef}
          type="button"
          className={styles.link}
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
        >
          {COPY.change}
        </button>
      </p>
      {open ? (
        <ProductSegmented
          label={COPY.languageLabel}
          value={value}
          onChange={code => {
            onChange(code);
            setOpen(false);
          }}
          options={PRODUCT_SHOP_WORDS_CODES.map(code => ({
            value: code,
            label: names[code],
          }))}
        />
      ) : null}
    </div>
  );
}

/**
 * One of the two parts to make, ticked by default. A ticked part's footer row
 * opens its editor (outside the label, so it never toggles the tick); once
 * edited it says so, with Reset.
 */
function PartToggle({
  checked,
  disabled = false,
  onChange,
  title,
  meta,
  note,
  edit,
  editButtonRef,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  meta: string;
  note: string | null;
  /** The edit button, which the sheet gives the focus back to. */
  editButtonRef?: RefObject<HTMLButtonElement | null>;
  edit?: {
    label: string;
    edited: boolean;
    resetQuestion: string;
    onEdit: () => void;
    onReset: () => void;
  };
}) {
  const [confirmReset, setConfirmReset] = useState(false);
  const resetRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    // The question takes the focus as it opens, and gives it back as it goes.
    if (confirmReset) keepRef.current?.focus();
    else if (wasConfirming.current)
      (resetRef.current ?? editButtonRef?.current)?.focus();
    wasConfirming.current = confirmReset;
  }, [confirmReset, editButtonRef]);
  return (
    <div className={styles.part} data-disabled={disabled || undefined}>
      <label className={styles.toggle} data-disabled={disabled || undefined}>
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          disabled={disabled}
          onChange={event => onChange(event.target.checked)}
        />
        <ProductCheck checked={checked} disabled={disabled} />
        <span className={styles.toggleText}>
          <span className={styles.toggleTitle}>{title}</span>
          <span className={styles.toggleMeta}>{meta}</span>
          {note ? <span className={styles.toggleNote}>{note}</span> : null}
        </span>
      </label>
      {checked && !disabled && edit ? (
        confirmReset ? (
          <div className={styles.editRow} role="group" aria-label={title}>
            <p className={styles.resetQuestion}>{edit.resetQuestion}</p>
            <div className={styles.editActions}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setConfirmReset(false);
                  edit.onReset();
                }}
              >
                {EDIT.resetYes}
              </Button>
              <Button
                ref={keepRef}
                size="sm"
                variant="ghost"
                onClick={() => setConfirmReset(false)}
              >
                {EDIT.resetKeep}
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.editRow}>
            <Button
              ref={editButtonRef}
              size="sm"
              variant="outline"
              onClick={edit.onEdit}
            >
              <Pencil aria-hidden="true" />
              {edit.label}
            </Button>
            {edit.edited ? (
              <>
                <ProductChip tone="accent">{EDIT.edited}</ProductChip>
                <button
                  ref={resetRef}
                  type="button"
                  className={styles.link}
                  onClick={() => setConfirmReset(true)}
                >
                  {EDIT.reset}
                </button>
              </>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

/** The kit POST's refusals, all checked before the kit is written. */
const KIT_REFUSALS_BEFORE_WRITING: ReadonlySet<string> = new Set([
  "invalid_request",
  "not_enough_products",
  "whatsapp_not_connected",
]);

type Press =
  | { phase: "choose" }
  | {
      phase: "making";
      startedAt: number;
      carousel: boolean;
      orderForm: boolean;
    }
  | { phase: "refused"; line: string };

/**
 * For customers on WhatsApp: the carousel and the order form, both ticked,
 * made by one press. While they're made the card is a checklist; then it
 * shows the kit's status, a row per part with its next step.
 */
function KitCard({
  workspaceId,
  plan,
  importId,
  language,
  edits,
  onEditsChange,
  onChangeProducts,
  onPlanStale,
}: {
  workspaceId: string;
  plan: ProductKitPlanResponse;
  importId: string | null;
  language: ProductShopWordsCode;
  /** The owner's edits so far, sent with Make. */
  edits: ProductKitEdits;
  onEditsChange: (edits: ProductKitEdits) => void;
  onChangeProducts: (productIds: string[]) => void;
  onPlanStale: () => void;
}) {
  const titleId = useId();
  const { mutate } = useSWRConfig();
  const products = plan.products;
  const photos = products.filter(product => product.hasPhoto).length;
  const carouselPossible = photos >= KIT_CAROUSEL_MIN_CARDS;
  const [wantCarousel, setWantCarousel] = useState(true);
  const [wantForm, setWantForm] = useState(true);
  const carousel = carouselPossible && wantCarousel;
  const [press, setPress] = useState<Press>({ phase: "choose" });
  const [kit, setKit] = useState<ProductKitRecord | null>(plan.latestKit);
  // One press, one id: sent again unchanged after a lost answer, it finds
  // the same kit; with other products, parts, language or edits since, it
  // is a new press, so the change isn't dropped.
  const lastPress = useRef<{ id: string; body: string } | null>(null);
  const cardCount = Math.min(photos, KIT_CAROUSEL_MAX_CARDS);
  // What a screen reader hears as the card changes under the press: what
  // is being made, then what each part is. Always in the page, so it's said.
  const [said, setSaid] = useState("");

  // The editors before Make: the open one, the shelf's cards fetched once,
  // and a draft space of the card's own for the template editor.
  const [editing, setEditing] = useState<ProductKitPart | null>(null);
  // A sheet is mounted once first opened, and stays for its closing.
  const [sheets, setSheets] = useState<readonly ProductKitPart[]>([]);
  const openEditor = (part: ProductKitPart) => {
    setEditing(part);
    setSheets(shown => (shown.includes(part) ? shown : [...shown, part]));
  };
  const [drafts, setDrafts] = useState<KitDraftsCache>(null);
  const [editSession] = useState(newKitRequestId);
  const carouselEditRef = useRef<HTMLButtonElement>(null);
  const formEditRef = useRef<HTMLButtonElement>(null);
  const saveEdit = (part: ProductKitPart, next: ProductKitEdits) => {
    onEditsChange(next);
    setSaid(EDIT.saved[part]);
  };
  const resetEdit = (part: ProductKitPart) => {
    const rest = { ...edits };
    delete rest[part];
    onEditsChange(rest);
    setSaid(EDIT.reverted[part]);
  };
  // Make sends the edits of the parts it makes.
  const editsToSend: ProductKitEdits = {
    ...(carousel && edits.carousel ? { carousel: edits.carousel } : {}),
    ...(wantForm && edits.orderForm ? { orderForm: edits.orderForm } : {}),
  };

  // The press, Make another or a part's own Try again goes when the card
  // changes: the card's title takes the keyboard's focus, unless the owner
  // has moved on elsewhere.
  const cardRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusTitleIfLost = useCallback(() => {
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      cardRef.current?.contains(active)
    )
      headingRef.current?.focus({ preventScroll: true });
  }, []);
  const shown = useRef({ phase: press.phase, kitId: kit?.id ?? null });
  useEffect(() => {
    const now = { phase: press.phase, kitId: kit?.id ?? null };
    if (shown.current.phase === now.phase && shown.current.kitId === now.kitId)
      return;
    shown.current = now;
    focusTitleIfLost();
  }, [press.phase, kit?.id, focusTitleIfLost]);

  const make = async () => {
    const request = {
      productIds: products.map(product => product.id),
      ...(importId ? { importId } : {}),
      make: { carousel, orderForm: wantForm },
      language,
      ...(hasEdits(editsToSend) ? { edits: editsToSend } : {}),
    };
    const body = JSON.stringify(request);
    const requestId =
      lastPress.current?.body === body
        ? lastPress.current.id
        : newKitRequestId();
    lastPress.current = { id: requestId, body };
    setPress({
      phase: "making",
      startedAt: Date.now(),
      carousel,
      orderForm: wantForm,
    });
    setSaid(
      [
        wantForm ? `${KIT.makingOrderForm}.` : "",
        carousel ? `${KIT.makingCarousel(cardCount)}.` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
    try {
      const made = await createProductKit(workspaceId, {
        requestId,
        ...request,
        timeZone: ownerTimeZone(),
      });
      await mutate(productKitUrl(workspaceId, made.id), made, {
        revalidate: false,
      });
      void mutate(productsMadeUrl(workspaceId));
      setKit(made);
      setPress({ phase: "choose" });
      setSaid(kitPartsSaid(workspaceId, made));
      // They went with the kit; its own rows edit it from now on.
      if (hasEdits(edits)) onEditsChange(NO_EDITS);
    } catch (error) {
      const code = error instanceof ProductDraftError ? error.code : "failed";
      // Only a refusal decided before anything was written makes the next
      // press a new one. A lost answer, or the server failing after the kit
      // was made (503 draft_failed), keeps the id: sent again, it finds that
      // kit rather than send Meta a second template and Flow.
      if (KIT_REFUSALS_BEFORE_WRITING.has(code)) lastPress.current = null;
      if (code === "whatsapp_not_connected") onPlanStale();
      // The refusal's alert says why: an edit's failed check by its words.
      const issue =
        code === "invalid_request" && error instanceof ProductDraftError
          ? error.issues[0]
          : undefined;
      setSaid("");
      setPress({
        phase: "refused",
        line: issue ? EDIT.notSent(issue) : kitRequestErrorLine(code),
      });
    }
  };

  const title = kit ? kitTitle(kit) : KIT.title;
  return (
    <article
      ref={cardRef}
      aria-labelledby={titleId}
      className={cn(theme.sheet, styles.card)}
    >
      <div className={styles.cardHead}>
        <div>
          <p className={styles.forWhom}>{KIT.forWhom}</p>
          <h3
            ref={headingRef}
            id={titleId}
            tabIndex={-1}
            className={cn(theme.displayM, styles.cardTitle)}
          >
            {title}
          </h3>
        </div>
        <ProductChip>{KIT.noAi}</ProductChip>
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      {kit ? (
        <KitMade
          workspaceId={workspaceId}
          kit={kit}
          onFocusLost={focusTitleIfLost}
          onMakeAnother={() => {
            lastPress.current = null;
            setSaid("");
            setKit(null);
          }}
        />
      ) : press.phase === "making" ? (
        <KitMaking
          startedAt={press.startedAt}
          carousel={press.carousel}
          orderForm={press.orderForm}
          cardCount={cardCount}
        />
      ) : (
        <>
          <p className={styles.about}>{KIT.about}</p>
          <div className={styles.toggles}>
            <PartToggle
              checked={carousel}
              disabled={!carouselPossible}
              onChange={setWantCarousel}
              title={KIT.carousel}
              meta={
                carouselPossible
                  ? KIT.carouselMeta(cardCount)
                  : KIT.carouselTooFew
              }
              note={
                photos > KIT_CAROUSEL_MAX_CARDS ? KIT.carouselFirstTen : null
              }
              editButtonRef={carouselEditRef}
              edit={{
                label: EDIT.editCards,
                edited: Boolean(edits.carousel),
                resetQuestion: EDIT.resetConfirm.carousel,
                onEdit: () => openEditor("carousel"),
                onReset: () => resetEdit("carousel"),
              }}
            />
            <PartToggle
              checked={wantForm}
              onChange={setWantForm}
              title={KIT.orderForm}
              meta={KIT.orderFormMeta(
                Math.min(products.length, ORDER_FORM_MAX_PRODUCTS)
              )}
              note={
                products.length > ORDER_FORM_MAX_PRODUCTS
                  ? KIT.orderFormFirstTwenty
                  : null
              }
              editButtonRef={formEditRef}
              edit={{
                label: EDIT.editQuestions,
                edited: Boolean(edits.orderForm),
                resetQuestion: EDIT.resetConfirm.orderForm,
                onEdit: () => openEditor("orderForm"),
                onReset: () => resetEdit("orderForm"),
              }}
            />
          </div>
          {carouselPossible && sheets.includes("carousel") ? (
            <KitCarouselEditBeforeMake
              open={editing === "carousel"}
              onOpenChange={open => setEditing(open ? "carousel" : null)}
              returnFocusRef={carouselEditRef}
              workspaceId={workspaceId}
              productIds={products.map(product => product.id)}
              language={language}
              // Unsaved cards are kept per language: switching starts again.
              draftScope={`products:${editSession}:${language}`}
              saved={edits.carousel ?? null}
              drafts={drafts}
              onDrafts={setDrafts}
              onSave={carouselEdit =>
                saveEdit("carousel", { ...edits, carousel: carouselEdit })
              }
            />
          ) : null}
          {sheets.includes("orderForm") ? (
            <KitOrderFormEditBeforeMake
              open={editing === "orderForm"}
              onOpenChange={open => setEditing(open ? "orderForm" : null)}
              returnFocusRef={formEditRef}
              products={products}
              language={language}
              saved={edits.orderForm ?? null}
              onSave={formEdit =>
                saveEdit("orderForm", { ...edits, orderForm: formEdit })
              }
            />
          ) : null}
          <p className={styles.productsLine}>
            <span>
              {importId
                ? COPY.productsFromVideo(products.length)
                : COPY.productsFromShelf(products.length)}
            </span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              className={styles.link}
              onClick={() =>
                onChangeProducts(products.map(product => product.id))
              }
            >
              {COPY.changeProducts}
            </button>
          </p>
          {plan.whatsapp.connected ? (
            <div className={styles.actions}>
              <Button
                disabled={!carousel && !wantForm}
                onClick={() => void make()}
              >
                {makeLabel(carousel, wantForm)}
              </Button>
            </div>
          ) : (
            <div className={styles.callout}>
              <p>{KIT.notConnected}</p>
              <Button asChild>
                <Link href={connectWhatsAppHref(workspaceId)}>
                  {KIT.connectWhatsApp}
                </Link>
              </Button>
            </div>
          )}
          {press.phase === "refused" ? (
            <p role="alert" className={styles.alert}>
              <CircleAlert aria-hidden="true" />
              {press.line}
            </p>
          ) : null}
          <p className={styles.footnote}>{KIT.footnote}</p>
        </>
      )}
    </article>
  );
}

/** The push button names what it will make. */
export function makeLabel(carousel: boolean, orderForm: boolean): string {
  if (carousel && orderForm) return KIT.makeBoth;
  if (carousel) return KIT.makeCarousel;
  if (orderForm) return KIT.makeOrderForm;
  return KIT.chooseWhat;
}

/** While the press is made: a static checklist and the seconds so far. */
function KitMaking({
  startedAt,
  carousel,
  orderForm,
  cardCount,
}: {
  startedAt: number;
  carousel: boolean;
  orderForm: boolean;
  cardCount: number;
}) {
  const now = useNow(true);
  // Said by the card's live line: a region inserted already holding its
  // words isn't reliably read out.
  return (
    <div className={styles.making}>
      <ol className={styles.checklist}>
        {orderForm ? (
          <li>
            <span aria-hidden="true" className={styles.mark} />
            {KIT.makingOrderForm}
          </li>
        ) : null}
        {carousel ? (
          <li>
            <span aria-hidden="true" className={styles.mark} />
            {KIT.makingCarousel(cardCount)}
          </li>
        ) : null}
      </ol>
      <p className={styles.makingTime}>
        <span aria-hidden="true" className={styles.elapsed}>
          {formatElapsed(now - startedAt)}
        </span>{" "}
        {KIT.makingTiming}
      </p>
      <p className={styles.footnote}>{KIT.makingLeave}</p>
    </div>
  );
}

/** The kit once made, kept current, with "Make another". */
function KitMade({
  workspaceId,
  kit: made,
  onMakeAnother,
  onFocusLost,
}: {
  workspaceId: string;
  kit: ProductKitRecord;
  onMakeAnother: () => void;
  /** A part made again took its Try again away: the card keeps the focus. */
  onFocusLost: () => void;
}) {
  const { data: kit = made, mutate } = useProductKit(workspaceId, made);
  const { mutate: mutateKey } = useSWRConfig();
  const [remaking, setRemaking] = useState<ProductKitPart | null>(null);
  const [refusal, setRefusal] = useState<{
    part: ProductKitPart;
    line: string;
  } | null>(null);
  // "Edit and send again" and the like: the part whose sheet is mounted
  // (it stays mounted while its send goes on), whether it shows, and the
  // button that opened it.
  const [editing, setEditingPart] = useState<ProductKitPart | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const editTrigger = useRef<HTMLElement | null>(null);
  const setEditing = (part: ProductKitPart) => {
    setEditingPart(part);
    setEditOpen(true);
  };
  const [saidAfterEdit, setSaidAfterEdit] = useState("");
  // "Send me the order form": its send, and what it said.
  const [formTestSending, setFormTestSending] = useState(false);
  const [formTestLine, setFormTestLine] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);
  const sendFormTest = async () => {
    setFormTestSending(true);
    setFormTestLine(null);
    try {
      await sendProductKitFormTest(workspaceId, kit.id);
      setFormTestLine({ text: EDIT.sentTest, ok: true });
    } catch (error) {
      const code = error instanceof ProductDraftError ? error.code : "failed";
      const errors: Record<string, string> = EDIT.testErrors;
      setFormTestLine({
        text: errors[code] ?? EDIT.testErrors.failed,
        ok: false,
      });
    } finally {
      setFormTestSending(false);
    }
  };
  // Once a part is made again, its Try again may have gone with the focus.
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current || remaking !== null) return;
    settled.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) onFocusLost();
  });

  const retry = async (part: ProductKitPart) => {
    setRemaking(part);
    setRefusal(null);
    try {
      const next = await retryProductKitPart(workspaceId, kit.id, part);
      await mutate(next, { revalidate: false });
      void mutateKey(productsMadeUrl(workspaceId));
    } catch (error) {
      setRefusal({
        part,
        line: kitRequestErrorLine(
          error instanceof ProductDraftError ? error.code : "failed"
        ),
      });
    } finally {
      settled.current = true;
      setRemaking(null);
    }
  };

  return (
    <>
      <p className={styles.madeAt}>
        {KIT.madeAt(
          madeWhen(kit.createdAt, new Date(), PRODUCTS_COPY.made),
          kit.productIds.length
        )}
      </p>
      <KitStatus
        workspaceId={workspaceId}
        kit={kit}
        remaking={remaking}
        refusal={refusal}
        onRetry={part => void retry(part)}
        onEdit={(part, trigger) => {
          editTrigger.current = trigger;
          setEditing(part);
        }}
        formTest={{
          sending: formTestSending,
          line: formTestLine,
          onSend: () => void sendFormTest(),
        }}
      />
      {editing ? (
        <KitPartEditAfterMake
          // A part's own sheet; another part's opens fresh.
          key={editing}
          open={editOpen}
          onOpenChange={open => {
            setEditOpen(open);
          }}
          returnFocusRef={editTrigger}
          workspaceId={workspaceId}
          kit={kit}
          part={editing}
          onKit={next => {
            void mutate(next, { revalidate: false });
            void mutateKey(productsMadeUrl(workspaceId));
          }}
          onSent={setSaidAfterEdit}
        />
      ) : null}
      <p className="sr-only" aria-live="polite">
        {saidAfterEdit}
      </p>
      {kit.pricesChanged ? (
        <p className={styles.notice}>{KIT.pricesChanged}</p>
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="ghost"
          disabled={remaking !== null}
          onClick={onMakeAnother}
        >
          {KIT.makeAnother}
        </Button>
      </div>
    </>
  );
}

/** Products a video ad can show: with a cut-out and a price. */
export function adEligible(
  products: readonly ProductKitPlanProduct[]
): ProductKitPlanProduct[] {
  return products.filter(
    product => product.hasCutout && product.price !== null
  );
}

/** For new customers: the way into a video ad of up to 3 of these products. */
function VideoAdCard({
  products,
  language,
  onMakeAd,
}: {
  products: readonly ProductKitPlanProduct[];
  /** The language the owner spoke: the ad's. */
  language: ProductShopWordsCode;
  onMakeAd: (productIds: string[]) => void;
}) {
  const titleId = useId();
  const eligible = adEligible(products);
  const first = eligible[0];
  const price = first ? buyerPrice(first, SHOP_WORDS[language]) : null;
  return (
    <article
      aria-labelledby={titleId}
      className={cn(theme.sheet, styles.card, styles.adCard)}
    >
      <span aria-hidden="true" className={styles.adPoster}>
        {first?.imageUrl ? (
          // Signed storage links; next/image would need every bucket host.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={first.imageUrl} alt="" draggable={false} />
        ) : (
          <Clapperboard />
        )}
        {price ? (
          <span className={cn(theme.priceLabel, styles.adPrice)}>{price}</span>
        ) : null}
      </span>
      <div className={styles.adBody}>
        <div>
          <p className={styles.forWhom}>{AD.forWhom}</p>
          <h3 id={titleId} className={cn(theme.displayM, styles.adTitle)}>
            {AD.title}
            <ProductChip tone="accent">{AD.new}</ProductChip>
          </h3>
        </div>
        <p className={styles.about}>{AD.about}</p>
        <div className={styles.actions}>
          <Button
            variant="outline"
            disabled={!first}
            onClick={() =>
              onMakeAd(
                eligible
                  .slice(0, PRODUCT_AD_MAX_PRODUCTS)
                  .map(product => product.id)
              )
            }
          >
            <Clapperboard aria-hidden="true" />
            {AD.make}
          </Button>
          <ProductChip>{AD.cost}</ProductChip>
        </div>
        {first ? null : <p className={styles.footnote}>{AD.noneEligible}</p>}
      </div>
    </article>
  );
}
