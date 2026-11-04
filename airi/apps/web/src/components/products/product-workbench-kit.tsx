"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  KIT_CAROUSEL_MAX_CARDS,
  KIT_CAROUSEL_MIN_CARDS,
  ORDER_FORM_MAX_PRODUCTS,
} from "@/lib/products/kit-text";
import type {
  ProductKitEdits,
  ProductKitPart,
  ProductKitRecord,
} from "@/lib/products/types";
import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type RefObject } from "react";
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
  KitCarouselEditBeforeMake,
  KitOrderFormEditBeforeMake,
  KitPartEditAfterMake,
  type KitDraftsCache,
} from "./product-kit-editor-sheet";
import {
  KitStatus,
  kitPartsSaid,
  kitRequestErrorLine,
} from "./product-kit-status";
import {
  MetaCredits,
  WorkbenchFooter,
  type MoreItem,
} from "./product-workbench-parts";
import styles from "./product-workbench.module.css";
import {
  ProductDraftError,
  productKitUrl,
  productsMadeUrl,
} from "./products-client";
import { useProductKit, useProductKitPlan } from "./use-product-kits";

// The WhatsApp chat tile's workbench: v2's kit (the carousel template and
// the order-form Flow, made by one press) built in place. Left, what buyers
// see in WhatsApp; right, what it makes, then each part's status at Meta;
// the footer's one action is "Create on WhatsApp", which submits the
// carousel for Meta's review and publishes the form. It spends nothing, so
// there is no confirm. Edit cards, Edit questions and Send me a test sit in ⋯.

const COPY = PRODUCTS_COPY.workbench;
const KIT = PRODUCTS_COPY.kit;
const EDIT = PRODUCTS_COPY.kit.edit;

/** The kit POST's refusals decided before anything was written: the next press is a new one. */
const REFUSED_BEFORE_WRITING: ReadonlySet<string> = new Set([
  "invalid_request",
  "not_enough_products",
  "whatsapp_not_connected",
]);

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export function KitWorkbench({
  workspaceId,
  productIds,
  importId,
  priceToCheck,
  onChanged,
  more,
}: {
  workspaceId: string;
  productIds: readonly string[];
  importId: string | null;
  priceToCheck: boolean;
  onChanged?: () => void;
  /** The page's own ⋯ entries ("Check one by one"). */
  more: readonly MoreItem[];
}) {
  const { plan } = useProductKitPlan(workspaceId, productIds, importId);
  const { mutate } = useSWRConfig();
  const [made, setMade] = useState<ProductKitRecord | null>(null);
  const latest =
    plan.data?.latestKit && sameIds(plan.data.latestKit.productIds, productIds)
      ? plan.data.latestKit
      : null;
  const kit = made ?? latest;
  const [making, setMaking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [edits, setEdits] = useState<ProductKitEdits>({});
  const [drafts, setDrafts] = useState<KitDraftsCache>(null);
  const [editing, setEditing] = useState<ProductKitPart | null>(null);
  const [editSession] = useState(newKitRequestId);
  const lastPress = useRef<{ id: string; body: string } | null>(null);
  const moreRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const data = plan.data;
  if (!data) {
    return (
      <div className={styles.body}>
        <div className={styles.previewCol} aria-hidden="true">
          <div className={styles.sketch} data-format="chat" />
        </div>
        <div className={styles.side}>
          {plan.error ? (
            <div className={styles.problem}>
              <p role="alert" className={styles.alert}>
                {COPY.loadFailed}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void plan.mutate()}
              >
                {COPY.retry}
              </Button>
            </div>
          ) : (
            <p role="status" className={styles.note}>
              {COPY.loading}
            </p>
          )}
          <WorkbenchFooter
            target={COPY.target.whatsapp}
            more={more}
            action={
              <Button type="button" disabled>
                {COPY.actions.create_on_whatsapp}
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const products = data.products;
  const photos = products.filter(product => product.hasPhoto).length;
  const carousel = photos >= KIT_CAROUSEL_MIN_CARDS;
  const cards = Math.min(photos, KIT_CAROUSEL_MAX_CARDS);
  const language = kit?.language ?? data.language;
  const spoken = data.languageIsSpoken ? data.language : null;

  const make = async () => {
    const request = {
      productIds: products.map(product => product.id),
      ...(importId ? { importId } : {}),
      make: { carousel, orderForm: true },
      language: data.language,
      ...(edits.carousel || edits.orderForm
        ? {
            edits: {
              ...(carousel && edits.carousel
                ? { carousel: edits.carousel }
                : {}),
              ...(edits.orderForm ? { orderForm: edits.orderForm } : {}),
            },
          }
        : {}),
    };
    const body = JSON.stringify(request);
    // One press, one id: sent again unchanged after a lost answer, it finds
    // the same kit rather than send Meta a second template and Flow.
    const requestId =
      lastPress.current?.body === body
        ? lastPress.current.id
        : newKitRequestId();
    lastPress.current = { id: requestId, body };
    setMaking(true);
    setRefusal(null);
    setSaid(COPY.kit.making);
    try {
      const next = await createProductKit(workspaceId, {
        requestId,
        ...request,
        timeZone: ownerTimeZone(),
      });
      await mutate(productKitUrl(workspaceId, next.id), next, {
        revalidate: false,
      });
      void mutate(productsMadeUrl(workspaceId));
      setMade(next);
      setEdits({});
      setSaid(kitPartsSaid(workspaceId, next));
      onChanged?.();
      bodyRef.current
        ?.closest<HTMLElement>("section[aria-labelledby]")
        ?.focus({ preventScroll: true });
    } catch (error) {
      const code = error instanceof ProductDraftError ? error.code : "failed";
      if (REFUSED_BEFORE_WRITING.has(code)) lastPress.current = null;
      if (code === "whatsapp_not_connected") void plan.mutate();
      const issue =
        code === "invalid_request" && error instanceof ProductDraftError
          ? error.issues[0]
          : undefined;
      setSaid("");
      setRefusal(issue ? EDIT.notSent(issue) : kitRequestErrorLine(code));
    } finally {
      setMaking(false);
    }
  };

  const items: MoreItem[] = [
    ...(carousel
      ? [
          {
            key: "cards",
            label: COPY.menu.editCards,
            onSelect: () => setEditing("carousel"),
          },
        ]
      : []),
    {
      key: "questions",
      label: COPY.menu.editQuestions,
      onSelect: () => setEditing("orderForm"),
    },
    ...more,
  ];

  const blocked = priceToCheck
    ? COPY.states.priceToCheck
    : products.length === 0
      ? PRODUCTS_COPY.make.noneOnShelf
      : null;
  const action = !data.whatsapp.connected ? (
    <Button asChild>
      <Link href={connectWhatsAppHref(workspaceId)}>
        <MessageCircle aria-hidden="true" />
        {COPY.states.connectWhatsApp}
      </Link>
    </Button>
  ) : kit ? null : (
    <Button
      type="button"
      disabled={making || blocked !== null}
      onClick={() => void make()}
    >
      <MessageCircle aria-hidden="true" />
      {making ? PRODUCTS_COPY.ad.starting : COPY.actions.create_on_whatsapp}
    </Button>
  );

  return (
    <div ref={bodyRef} className={styles.body}>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      <div className={styles.previewCol}>
        <BuyersPreview
          products={products}
          language={language}
          spokenLanguage={spoken}
          carousel={kit ? undefined : edits.carousel}
          orderForm={kit ? undefined : edits.orderForm}
        />
        <MetaCredits chat />
      </div>
      <div className={styles.side}>
        {kit ? (
          <KitMade
            workspaceId={workspaceId}
            kit={kit}
            onKit={next => {
              setMade(next);
              void mutate(productsMadeUrl(workspaceId));
              onChanged?.();
            }}
            editing={editing}
            onEditing={setEditing}
            returnFocusRef={moreRef}
          />
        ) : (
          <ul className={styles.kitParts}>
            <li>{carousel ? COPY.kit.carousel(cards) : COPY.kit.noCarousel}</li>
            <li>
              {COPY.kit.orderForm(
                Math.min(products.length, ORDER_FORM_MAX_PRODUCTS)
              )}
            </li>
            <li className={styles.note}>{COPY.kit.reviewNote}</li>
          </ul>
        )}
        {!kit && carousel && editing === "carousel" ? (
          <KitCarouselEditBeforeMake
            open
            onOpenChange={open => setEditing(open ? "carousel" : null)}
            workspaceId={workspaceId}
            productIds={products.map(product => product.id)}
            language={data.language}
            draftScope={`products:${editSession}:${data.language}`}
            saved={edits.carousel ?? null}
            drafts={drafts}
            onDrafts={setDrafts}
            onSave={carouselEdit => {
              setEdits(current => ({ ...current, carousel: carouselEdit }));
              setSaid(EDIT.saved.carousel);
            }}
          />
        ) : null}
        {!kit && editing === "orderForm" ? (
          <KitOrderFormEditBeforeMake
            open
            onOpenChange={open => setEditing(open ? "orderForm" : null)}
            products={products}
            language={data.language}
            saved={edits.orderForm ?? null}
            onSave={formEdit => {
              setEdits(current => ({ ...current, orderForm: formEdit }));
              setSaid(EDIT.saved.orderForm);
            }}
          />
        ) : null}
        <WorkbenchFooter
          target={data.whatsapp.displayPhone ?? COPY.target.whatsapp}
          more={items}
          action={action}
          note={!kit && blocked ? blocked : null}
          alert={refusal}
        />
      </div>
    </div>
  );
}

/** The kit once made, kept current: each part's status, its retry, its editor, a test. */
function KitMade({
  workspaceId,
  kit: made,
  onKit,
  editing,
  onEditing,
  returnFocusRef,
}: {
  workspaceId: string;
  kit: ProductKitRecord;
  onKit: (kit: ProductKitRecord) => void;
  editing: ProductKitPart | null;
  onEditing: (part: ProductKitPart | null) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { data: kit = made, mutate } = useProductKit(workspaceId, made);
  const [remaking, setRemaking] = useState<ProductKitPart | null>(null);
  const [refusal, setRefusal] = useState<{
    part: ProductKitPart;
    line: string;
  } | null>(null);
  const [testSending, setTestSending] = useState(false);
  const [testLine, setTestLine] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);
  const [saidAfterEdit, setSaidAfterEdit] = useState("");

  const retry = async (part: ProductKitPart) => {
    setRemaking(part);
    setRefusal(null);
    try {
      const next = await retryProductKitPart(workspaceId, kit.id, part);
      await mutate(next, { revalidate: false });
      onKit(next);
    } catch (error) {
      setRefusal({
        part,
        line: kitRequestErrorLine(
          error instanceof ProductDraftError ? error.code : "failed"
        ),
      });
    } finally {
      setRemaking(null);
    }
  };

  const sendTest = async () => {
    setTestSending(true);
    setTestLine(null);
    try {
      await sendProductKitFormTest(workspaceId, kit.id);
      setTestLine({ text: EDIT.sentTest, ok: true });
    } catch (error) {
      const code = error instanceof ProductDraftError ? error.code : "failed";
      const errors: Record<string, string> = EDIT.testErrors;
      setTestLine({ text: errors[code] ?? EDIT.testErrors.failed, ok: false });
    } finally {
      setTestSending(false);
    }
  };

  return (
    <div className={styles.kitMade}>
      <KitStatus
        workspaceId={workspaceId}
        kit={kit}
        remaking={remaking}
        refusal={refusal}
        onRetry={part => void retry(part)}
        onEdit={(part, trigger) => {
          returnFocusRef.current = trigger;
          onEditing(part);
        }}
        formTest={{
          sending: testSending,
          line: testLine,
          onSend: () => void sendTest(),
        }}
      />
      {editing ? (
        <KitPartEditAfterMake
          key={editing}
          open
          onOpenChange={open => {
            if (!open) onEditing(null);
          }}
          returnFocusRef={returnFocusRef}
          workspaceId={workspaceId}
          kit={kit}
          part={editing}
          onKit={next => {
            void mutate(next, { revalidate: false });
            onKit(next);
          }}
          onSent={setSaidAfterEdit}
        />
      ) : null}
      <p className="sr-only" aria-live="polite">
        {saidAfterEdit}
      </p>
      {kit.pricesChanged ? (
        <p className={styles.note}>{KIT.pricesChanged}</p>
      ) : null}
    </div>
  );
}
