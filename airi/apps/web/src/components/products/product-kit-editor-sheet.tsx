"use client";

// The sheet "Edit cards" and "Edit questions" open in: airi's real template
// and Flow editors on Products paper. The editors' own markup is untouched;
// the sheet's .skin maps their colour and radius tokens to Paper's. It loads
// the editors only when opened, and fetches what they open with: before Make,
// the shelf's cards (or the owner's saved edits); after Make, what was sent.

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { carouselVerdict } from "@/lib/products/kit-status";
import { buildOrderFormFlowConfig } from "@/lib/products/order-form-config";
import type {
  ProductKitCarouselEdit,
  ProductKitDraftsResponse,
  ProductKitOrderFormEdit,
  ProductKitPart,
  ProductKitPlanProduct,
  ProductKitRecord,
  ProductShopWordsCode,
  ProductsErrorCode,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { CircleAlert, X } from "lucide-react";
import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  loadProductKitEditSource,
  newKitRequestId,
  prepareProductKitDrafts,
  sendProductKitPartEdit,
} from "./kits-client";
import type { ProductCarouselEditorPrefill } from "./product-carousel-editor";
import styles from "./product-kit-editor-sheet.module.css";
import { kitErrorLine, kitRequestErrorLine } from "./product-kit-status";
import theme from "./product-theme.module.css";
import { ProductDraftError } from "./products-client";
import { formatElapsed, useNow } from "./use-product-kits";

const EDIT = PRODUCTS_COPY.kit.edit;
const KIT = PRODUCTS_COPY.kit;

function EditorLoading({ line }: { line: string }) {
  return (
    <div role="status" className={styles.loadingBody}>
      <span className={styles.loading}>{line}</span>
      <span aria-hidden="true" className={styles.ghost} />
      <span aria-hidden="true" className={styles.ghost} />
    </div>
  );
}

const LazyCarouselEditor = dynamic(
  () =>
    import("./product-carousel-editor").then(
      module => module.ProductCarouselEditor
    ),
  { ssr: false, loading: () => <EditorLoading line={EDIT.loadingSent} /> }
);

const LazyOrderFormEditor = dynamic(
  () =>
    import("./product-order-form-editor").then(
      module => module.ProductOrderFormEditor
    ),
  { ssr: false, loading: () => <EditorLoading line={EDIT.loadingForm} /> }
);

/** The frame: Paper header, the editor below it, and focus back on close. */
export function ProductKitEditorSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  status,
  banner,
  returnFocusRef,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle: string;
  /** A live line under the subtitle: "Sending… 0:14". */
  status?: ReactNode;
  /** Why this goes to Meta as a new template. */
  banner?: string | null;
  /** The button that opened the sheet: it takes the focus back. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={theme.scrim}
        className={cn(
          theme.theme,
          styles.skin,
          "!h-[min(92vh,920px)] md:!w-[min(1180px,calc(100vw-2rem))] !max-w-none gap-0 overflow-hidden p-0"
        )}
        onCloseAutoFocus={event => {
          const trigger = returnFocusRef?.current;
          if (trigger?.isConnected) {
            event.preventDefault();
            trigger.focus();
          }
        }}
      >
        <div className={styles.frame}>
          <header className={styles.head}>
            <div className={styles.headText}>
              <DialogTitle className={cn(theme.displayM, styles.title)}>
                {title}
              </DialogTitle>
              <DialogDescription className={styles.subtitle}>
                {subtitle}
              </DialogDescription>
              {status ? (
                <p className={styles.status} aria-live="polite">
                  {status}
                </p>
              ) : null}
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className={styles.close}
                aria-label={EDIT.close}
              >
                <X aria-hidden="true" />
              </button>
            </DialogClose>
          </header>
          {banner ? <p className={styles.banner}>{banner}</p> : null}
          <div className={styles.body}>{children}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Why a load or a send was refused, in the owner's words. */
function refusalLine(error: unknown): string {
  if (!(error instanceof ProductDraftError)) return KIT.errors.failed;
  switch (error.code) {
    case "carousel_found":
      return EDIT.carouselFound;
    case "template_name_taken":
      return EDIT.nameTaken;
    case "kit_part_busy":
      return EDIT.busy;
    case "invalid_request":
      return error.issues[0]
        ? EDIT.notSent(error.issues[0])
        : KIT.errors.failed;
    case "meta_refused": {
      // Meta's own words come first in the issues.
      const words = error.issues[0] ?? null;
      return EDIT.metaRefused(words, aboutName(words));
    }
    default:
      return kitRequestErrorLine(error.code);
  }
}

/**
 * Answers that may have come after the part was sent (a lost answer, the
 * server failing): pressed again, the same id finds what was sent. Every
 * other answer was a decision, so the next press is a new one.
 */
const MAYBE_SENT: ReadonlySet<ProductsErrorCode | "failed"> = new Set([
  "failed",
  "draft_failed",
  "load_failed",
]);

/** Meta's words about a refusal mention the template's name. */
const aboutName = (message: string | null) => /\bname\b/i.test(message ?? "");

// ------------------------------------------------------------ before Make

/** The shelf's cards for these products, kept by the make card. */
export type KitDraftsCache = {
  key: string;
  carousel: ProductKitDraftsResponse["carousel"];
} | null;

export const kitDraftsKey = (
  productIds: readonly string[],
  language: ProductShopWordsCode
) => `${language}:${productIds.join(",")}`;

/**
 * "Edit cards" before Make: the shelf's cards (once per products and
 * language, then cached) or the saved edits, in the template editor. Saving
 * keeps them in the make card; nothing goes to Meta until Make.
 */
export function KitCarouselEditBeforeMake({
  open,
  onOpenChange,
  returnFocusRef,
  workspaceId,
  productIds,
  language,
  draftScope,
  saved,
  drafts,
  onDrafts,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  workspaceId: string;
  productIds: readonly string[];
  language: ProductShopWordsCode;
  draftScope: string;
  saved: ProductKitCarouselEdit | null;
  drafts: KitDraftsCache;
  onDrafts: (drafts: KitDraftsCache) => void;
  onSave: (edit: ProductKitCarouselEdit) => void;
}) {
  const key = kitDraftsKey(productIds, language);
  const cached = drafts?.key === key ? drafts.carousel : null;
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loading = open && !saved && !cached && failure === null;

  useEffect(() => {
    if (!open || saved || cached) return;
    let cancelled = false;
    setFailure(null);
    prepareProductKitDrafts(workspaceId, {
      productIds: [...productIds],
      language,
    }).then(
      response => {
        if (!cancelled) onDrafts({ key, carousel: response.carousel });
      },
      error => {
        if (cancelled) return;
        const code = error instanceof ProductDraftError ? error.code : null;
        setFailure(
          code === "not_enough_products"
            ? EDIT.notEnoughPhotos
            : code === "storage_full"
              ? KIT.errors.storage_full
              : EDIT.prepareFailed
        );
      }
    );
    return () => {
      cancelled = true;
    };
    // `productIds` is read through `key`; a new array of the same ids is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, saved, cached, key, workspaceId, attempt, onDrafts]);

  // One prefill per opening source, so the editor never starts over under the owner.
  const sourceName = saved?.name ?? cached?.name ?? null;
  const sourceLanguage = saved ? language : (cached?.language ?? null);
  const sourceComponents = saved?.components ?? cached?.components ?? null;
  const prefill = useMemo<ProductCarouselEditorPrefill | null>(
    () =>
      sourceName !== null && sourceLanguage && sourceComponents
        ? {
            name: sourceName,
            language: sourceLanguage,
            components: sourceComponents,
          }
        : null,
    [sourceName, sourceLanguage, sourceComponents]
  );
  // While open, the editor keeps what it opened with: saving changes the
  // source under it, and it must not start over before it closes.
  const [openedWith, setOpenedWith] =
    useState<ProductCarouselEditorPrefill | null>(null);
  if (open && !openedWith && prefill) setOpenedWith(prefill);
  if (!open && openedWith) setOpenedWith(null);
  const shown = open ? (openedWith ?? prefill) : null;
  const cardCount = cached?.productIds.length ?? productIds.length;

  return (
    <ProductKitEditorSheet
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title={EDIT.carouselTitle}
      subtitle={EDIT.carouselBefore(cardCount)}
    >
      {shown ? (
        <LazyCarouselEditor
          workspaceId={workspaceId}
          prefill={shown}
          draftScope={draftScope}
          submitLabel={EDIT.saveChanges}
          onCreate={async input => {
            onSave({ name: input.name, components: input.components });
            return { success: true, toast: null };
          }}
          onSaved={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      ) : failure ? (
        <div role="alert" className={styles.failure}>
          <CircleAlert aria-hidden="true" />
          <p>{failure}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFailure(null);
              setAttempt(value => value + 1);
            }}
          >
            {EDIT.tryAgain}
          </Button>
        </div>
      ) : loading ? (
        <EditorLoading line={EDIT.preparing(productIds.length)} />
      ) : null}
    </ProductKitEditorSheet>
  );
}

/**
 * "Edit questions" before Make: the shelf's questions (made in the page) or
 * the saved edits, in the Flow editor. Saving keeps them in the make card.
 */
export function KitOrderFormEditBeforeMake({
  open,
  onOpenChange,
  returnFocusRef,
  products,
  language,
  saved,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  products: readonly ProductKitPlanProduct[];
  language: ProductShopWordsCode;
  saved: ProductKitOrderFormEdit | null;
  onSave: (edit: ProductKitOrderFormEdit) => void;
}) {
  return (
    <ProductKitEditorSheet
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title={EDIT.formTitle}
      subtitle={EDIT.formBefore(Math.min(products.length, 20))}
    >
      {open ? (
        <LazyOrderFormEditor
          initialConfig={
            saved?.config ?? buildOrderFormFlowConfig(products, language)
          }
          language={language}
          productIds={products.map(product => product.id)}
          note={EDIT.formFooter}
          submitLabel={EDIT.saveChanges}
          onSave={config => {
            onSave({ config });
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      ) : null}
    </ProductKitEditorSheet>
  );
}

// ------------------------------------------------------------ after Make

type Source =
  | { status: "loading" }
  | { status: "failed"; line: string }
  | {
      status: "ready";
      carousel?: ProductCarouselEditorPrefill;
      orderForm?: { config: WhatsAppFlowConfig };
    };

/** Why the carousel goes to Meta as a new template, by what Meta did with the first. */
export function carouselEditBanner(kit: ProductKitRecord): string | null {
  const carousel = kit.parts.carousel;
  if (!carousel) return null;
  const name = carousel.templateName ?? KIT.carousel;
  if (carousel.state === "failed") return EDIT.banner.failed;
  if (carousel.state !== "submitted") return null;
  switch (carouselVerdict(carousel.metaStatus)) {
    case "approved":
      return EDIT.banner.approved(name);
    case "waiting":
      return EDIT.banner.pending(name);
    default:
      return EDIT.banner.turnedDown(name);
  }
}

/**
 * After Make: a made part opened with what was sent and sent again with the
 * owner's edits: the carousel to Meta as a new template, the order form
 * published (a new version when it was ready). The route works on if the
 * sheet is closed; `onKit` gets the kit as it then is.
 */
export function KitPartEditAfterMake({
  open,
  onOpenChange,
  returnFocusRef,
  workspaceId,
  kit,
  part,
  onKit,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  workspaceId: string;
  kit: ProductKitRecord;
  part: ProductKitPart;
  /** The kit as the edit left it (also on carousel_found). */
  onKit: (kit: ProductKitRecord) => void;
  /** Said once the part went: for the card's live line. */
  onSent: (line: string) => void;
}) {
  const [source, setSource] = useState<Source>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [sendingSince, setSendingSince] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Why the cards didn't go, said under Send to Meta for review: the
  // editor's toast would cover the button for seconds.
  const [carouselError, setCarouselError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One edit, one id: sent again unchanged after a lost answer, it finds the
  // same edit; changed since, it is a new press, so the change isn't dropped.
  const lastSend = useRef<{ id: string; body: string } | null>(null);
  const now = useNow(sendingSince !== null);
  const kitId = kit.id;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSource({ status: "loading" });
    setCarouselError(null);
    loadProductKitEditSource(workspaceId, kitId, part).then(
      response => {
        if (cancelled) return;
        // Opened afresh from what the kit now holds: a new press.
        lastSend.current = null;
        setSource({
          status: "ready",
          ...(response.carousel
            ? {
                carousel: {
                  name: response.carousel.name,
                  language: response.carousel.language,
                  components: response.carousel.components,
                },
              }
            : {}),
          ...(response.orderForm ? { orderForm: response.orderForm } : {}),
        });
      },
      error => {
        if (!cancelled)
          setSource({ status: "failed", line: refusalLine(error) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, kitId, part, attempt]);

  const send = useCallback(
    async (
      edit:
        | {
            part: "carousel";
            name: string;
            components: ProductKitCarouselEdit["components"];
          }
        | { part: "orderForm"; config: WhatsAppFlowConfig }
    ): Promise<string | null> => {
      const body = JSON.stringify(edit);
      const id =
        lastSend.current?.body === body
          ? lastSend.current.id
          : newKitRequestId();
      lastSend.current = { id, body };
      setSendingSince(Date.now());
      setNotice(null);
      try {
        const next = await sendProductKitPartEdit(workspaceId, kitId, {
          requestId: id,
          ...edit,
        });
        lastSend.current = null;
        onKit(next);
        const made = next.parts[edit.part];
        if (made?.state === "failed") {
          const error = made.error;
          return error?.code === "meta_refused"
            ? EDIT.metaRefused(error.message, aboutName(error.message))
            : kitErrorLine(error);
        }
        onSent(
          edit.part === "carousel"
            ? EDIT.sentCarousel
            : EDIT.publishedForm(next.parts.orderForm?.version ?? 1)
        );
        return null;
      } catch (error) {
        const code = error instanceof ProductDraftError ? error.code : "failed";
        if (!MAYBE_SENT.has(code)) lastSend.current = null;
        if (error instanceof ProductDraftError && error.kit) onKit(error.kit);
        if (code === "carousel_found") setNotice(EDIT.carouselFound);
        return refusalLine(error);
      } finally {
        setSendingSince(null);
      }
    },
    [kitId, onKit, onSent, workspaceId]
  );

  const sending = sendingSince !== null;
  const form = kit.parts.orderForm;
  const isCarousel = part === "carousel";
  const title = isCarousel ? EDIT.carouselTitle : EDIT.formTitle;
  const subtitle = isCarousel
    ? EDIT.carouselAfter
    : form?.state === "ready"
      ? EDIT.formAfterReady((form.version ?? 1) + 1)
      : EDIT.formAfterDraft;
  const status = sending ? (
    <>
      <span>{EDIT.sending(formatElapsed(now - (sendingSince ?? now)))}</span>{" "}
      <span>{EDIT.sendingNote}</span>
    </>
  ) : null;

  let body: ReactNode = null;
  if (!open) body = null;
  else if (source.status === "loading")
    body = (
      <EditorLoading line={isCarousel ? EDIT.loadingSent : EDIT.loadingForm} />
    );
  else if (source.status === "failed")
    body = (
      <div role="alert" className={styles.failure}>
        <CircleAlert aria-hidden="true" />
        <p>{source.line}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAttempt(value => value + 1)}
        >
          {EDIT.tryAgain}
        </Button>
      </div>
    );
  else if (isCarousel && source.carousel)
    body = (
      <>
        <LazyCarouselEditor
          workspaceId={workspaceId}
          prefill={source.carousel}
          draftScope={`products:kit:${kitId}:carousel`}
          submitLabel={EDIT.sendForReview}
          onCreate={async input => {
            setCarouselError(null);
            const refused = await send({
              part: "carousel",
              name: input.name,
              components: input.components,
            });
            if (refused === null) return { success: true, toast: null };
            setCarouselError(refused);
            // Said here in the sheet, not in a toast over the button.
            return { success: false, error: refused, toast: null };
          }}
          onSaved={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
        {/* A carousel Meta had after all is said once, by the banner. */}
        {carouselError && carouselError !== notice ? (
          <p role="alert" className={cn(styles.alert, styles.sendAlert)}>
            <CircleAlert aria-hidden="true" />
            <span>{carouselError}</span>
          </p>
        ) : null}
      </>
    );
  else if (!isCarousel && source.orderForm)
    body = (
      <LazyOrderFormEditor
        initialConfig={source.orderForm.config}
        language={kit.language}
        productIds={kit.productIds}
        note={EDIT.formFooterAfter}
        submitLabel={EDIT.publish}
        busy={sending}
        error={formError}
        onSave={config => {
          setFormError(null);
          void send({ part: "orderForm", config }).then(refused => {
            if (refused === null) onOpenChange(false);
            else setFormError(refused);
          });
        }}
        onCancel={() => onOpenChange(false)}
      />
    );

  return (
    <ProductKitEditorSheet
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title={title}
      subtitle={subtitle}
      status={status}
      banner={notice ?? (isCarousel ? carouselEditBanner(kit) : null)}
    >
      {body}
    </ProductKitEditorSheet>
  );
}
