"use client";

import { Button } from "@/components/ui/button";
import { panelConnectWhatsAppOnboardingHref } from "@/features/panel/shared/routing/hrefs";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  DraftProductRecord,
  ProductsErrorCode,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import { Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  hasUnsavedNewTemplate,
  newTemplateHref,
  saveCarouselForTemplateEditor,
  whatsAppFlowsHref,
} from "./carousel-template-draft";
import {
  createProductOrderForm,
  prepareProductCarousel,
  ProductDraftError,
} from "./products-client";

const COPY = PRODUCTS_COPY.drafts;
const CAROUSEL_MIN = WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MIN;
const CAROUSEL_MAX = WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MAX;
// A WhatsApp Flow CheckboxGroup lists at most 20 items.
const ORDER_FORM_MAX = 20;

type DraftErrorCode = ProductsErrorCode | "failed";

const failureCode = (error: unknown): DraftErrorCode =>
  error instanceof ProductDraftError ? error.code : "failed";

function DraftFailure({
  workspaceId,
  code,
}: {
  workspaceId: string;
  code: DraftErrorCode;
}) {
  const known = code in COPY.errors;
  return (
    <p role="alert" className="mt-2 text-sm text-destructive">
      {known
        ? COPY.errors[code as keyof typeof COPY.errors]
        : COPY.errors.failed}
      {code === "whatsapp_not_connected" ? (
        <>
          {" "}
          <Link
            href={panelConnectWhatsAppOnboardingHref(workspaceId)}
            className="font-medium underline underline-offset-2"
          >
            {COPY.connectWhatsApp}
          </Link>
        </>
      ) : null}
    </p>
  );
}

/**
 * What the owner can make on WhatsApp from the products a review added: a
 * carousel template, which opens in airi's template editor, and an order
 * form, saved on Meta as a draft Flow. Both are written in the language the
 * owner spoke, for buyers, and the owner finishes them in airi.
 */
export function WhatsAppDrafts({
  workspaceId,
  importId,
  added,
}: {
  workspaceId: string;
  importId: string;
  /** The products the review added to the shelf, in the order filmed. */
  added: DraftProductRecord[];
}) {
  return (
    <div className="w-full text-left">
      <p className="text-[15px] font-medium">{COPY.lead}</p>
      <div className="mt-3 divide-y divide-foreground/10 border-y border-foreground/10">
        <CarouselDraft
          workspaceId={workspaceId}
          importId={importId}
          added={added}
        />
        <OrderFormDraft
          workspaceId={workspaceId}
          importId={importId}
          added={added}
        />
      </div>
    </div>
  );
}

function DraftRow({
  preview,
  title,
  about,
  children,
}: {
  preview: ReactNode;
  title: string;
  about: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-4 py-5">
      <div aria-hidden="true" className="shrink-0 pt-0.5">
        {preview}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">{title}</p>
        <p className="mt-0.5 text-sm text-pretty text-muted-foreground">
          {about}
        </p>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function CarouselDraft({
  workspaceId,
  importId,
  added,
}: {
  workspaceId: string;
  importId: string;
  added: DraftProductRecord[];
}) {
  const router = useRouter();
  const [state, setState] = useState<
    | { phase: "idle" | "confirm" | "making" | "opening" }
    | { phase: "failed"; code: DraftErrorCode }
  >({ phase: "idle" });
  const withPhotos = added.filter(product => product.imageUrl);

  const make = async () => {
    setState({ phase: "making" });
    try {
      const draft = await prepareProductCarousel(workspaceId, importId);
      saveCarouselForTemplateEditor(workspaceId, draft);
      setState({ phase: "opening" });
      router.push(newTemplateHref(workspaceId));
    } catch (error) {
      setState({ phase: "failed", code: failureCode(error) });
    }
  };

  let action: ReactNode;
  if (withPhotos.length < CAROUSEL_MIN) {
    action = (
      <p className="text-sm text-muted-foreground">{COPY.carouselTooFew}</p>
    );
  } else if (state.phase === "confirm") {
    // One unsaved new template is kept per workspace: say so before replacing it.
    action = (
      <div>
        <p className="text-sm">{COPY.replaceNewTemplate}</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void make()}>
            {COPY.replace}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setState({ phase: "idle" })}
          >
            {COPY.keep}
          </Button>
        </div>
      </div>
    );
  } else {
    const busy = state.phase === "making" || state.phase === "opening";
    action = (
      <>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (hasUnsavedNewTemplate(workspaceId))
              setState({ phase: "confirm" });
            else void make();
          }}
        >
          {state.phase === "making"
            ? COPY.makingCarousel
            : state.phase === "opening"
              ? COPY.openingTemplates
              : COPY.makeCarousel}
        </Button>
        {state.phase === "failed" ? (
          <DraftFailure workspaceId={workspaceId} code={state.code} />
        ) : null}
      </>
    );
  }

  return (
    <DraftRow
      preview={<CarouselPreview products={withPhotos} />}
      title={COPY.carousel}
      about={
        withPhotos.length > CAROUSEL_MAX
          ? `${COPY.carouselAbout} ${COPY.carouselFirstTen}`
          : COPY.carouselAbout
      }
    >
      {action}
    </DraftRow>
  );
}

function OrderFormDraft({
  workspaceId,
  importId,
  added,
}: {
  workspaceId: string;
  importId: string;
  added: DraftProductRecord[];
}) {
  const [state, setState] = useState<
    | { phase: "idle" | "saving" }
    | { phase: "saved"; name: string }
    | { phase: "failed"; code: DraftErrorCode }
  >({ phase: "idle" });

  const save = async () => {
    setState({ phase: "saving" });
    try {
      const { flow } = await createProductOrderForm(workspaceId, importId);
      setState({ phase: "saved", name: flow.name });
    } catch (error) {
      setState({ phase: "failed", code: failureCode(error) });
    }
  };

  return (
    <DraftRow
      preview={<OrderFormPreview />}
      title={COPY.orderForm}
      about={
        added.length > ORDER_FORM_MAX
          ? `${COPY.orderFormAbout} ${COPY.orderFormFirstTwenty}`
          : COPY.orderFormAbout
      }
    >
      {state.phase === "saved" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p role="status" className="flex items-center gap-1.5 text-sm">
            <Check
              aria-hidden="true"
              className="size-4 shrink-0 text-emerald-600"
            />
            {COPY.orderFormSaved(state.name)}
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href={whatsAppFlowsHref(workspaceId)}>{COPY.openFlows}</Link>
          </Button>
        </div>
      ) : (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={state.phase === "saving"}
            onClick={() => void save()}
          >
            {state.phase === "saving"
              ? COPY.makingOrderForm
              : COPY.makeOrderForm}
          </Button>
          {state.phase === "failed" ? (
            <DraftFailure workspaceId={workspaceId} code={state.code} />
          ) : null}
        </>
      )}
    </DraftRow>
  );
}

const PREVIEW_TILE =
  "size-12 overflow-hidden rounded-lg border border-foreground/10 bg-white shadow-sm";

/** A few of the products as carousel cards, the next ones peeking out. */
function CarouselPreview({ products }: { products: DraftProductRecord[] }) {
  return (
    <div className="relative h-12 w-[76px]">
      {products.slice(0, 3).map((product, index) => (
        <div
          key={product.id}
          className={cn(PREVIEW_TILE, "absolute top-0")}
          style={{ left: index * 14, zIndex: 3 - index }}
        >
          {/* Signed storage URLs; next/image would need every bucket host configured. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={product.imageUrl ?? undefined}
            alt=""
            draggable={false}
            className="size-full object-contain p-1"
          />
        </div>
      ))}
    </div>
  );
}

/** A form with items ticked, as buyers see it. */
function OrderFormPreview() {
  return (
    <div
      className={cn(
        PREVIEW_TILE,
        "flex w-[76px] flex-col justify-center gap-1.5 px-2.5"
      )}
    >
      {[true, false, true].map((ticked, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-2.5 shrink-0 rounded-[3px] border",
              ticked
                ? "border-emerald-500 bg-emerald-500"
                : "border-neutral-300"
            )}
          />
          <span className="h-1 flex-1 rounded-full bg-neutral-200" />
        </div>
      ))}
    </div>
  );
}
