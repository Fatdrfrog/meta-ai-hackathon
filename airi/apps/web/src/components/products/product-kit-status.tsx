"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { carouselVerdict, kitPartCanEdit } from "@/lib/products/kit-status";
import type {
  ProductKitPart,
  ProductKitPartError,
  ProductKitRecord,
  ProductsErrorCode,
} from "@/lib/products/types";
import {
  ClipboardList,
  GalleryHorizontalEnd,
  Pencil,
  RotateCcw,
  Send,
} from "lucide-react";
import Link from "next/link";
import type { ProductChipTone } from "./product-controls";
import { ProductChip } from "./product-controls";
import { assetsHref, templateHref, whatsAppFlowsHref } from "./kit-links";
import styles from "./product-make.module.css";
import { clockTime } from "./use-product-kits";

// A kit's status, one row per part, each with its own next step: what the
// make view shows once the press is made, and what the made list sums up.

const COPY = PRODUCTS_COPY.kit;
const LIST = PRODUCTS_COPY.made.chips;

export type KitAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "retry"; label: string; part: ProductKitPart };

type Chip = { label: string; tone: ProductChipTone };

/** One part as the page shows it. */
export type KitPartView = {
  part: ProductKitPart;
  name: string;
  /** Its chip in the make view, and in the made list (which names the part). */
  chip: Chip;
  listChip: Chip;
  line: string;
  actions: KitAction[];
  /** Made, and still good for buyers. */
  holds: boolean;
  /**
   * The make view's way to send it again with edits ("Edit and send again"),
   * and what that does; the made list doesn't offer it.
   */
  edit?: { label: string; note: string | null } | null;
  /** The order form's version once an edit published a new one (2 and up). */
  version?: number | null;
};

const EDIT = PRODUCTS_COPY.kit.edit;

/** "Carousel + order form", or the one part a kit has. */
export function kitTitle(kit: ProductKitRecord): string {
  if (kit.parts.carousel && kit.parts.orderForm) return COPY.title;
  return kit.parts.carousel ? COPY.carousel : COPY.orderForm;
}

/** Why a part wasn't made, in the owner's words. */
export function kitErrorLine(error: ProductKitPartError | null): string {
  switch (error?.code) {
    case "whatsapp_not_connected":
    case "not_enough_products":
    case "storage_full":
    case "timed_out":
      return COPY.errors[error.code];
    case "meta_refused":
      return COPY.errors.meta_refused(error.message);
    case "template_limit":
      return COPY.carouselLimit;
    default:
      return COPY.errors.failed;
  }
}

/** Why a request about a kit was refused, in the owner's words. */
export function kitRequestErrorLine(
  code: ProductsErrorCode | "failed"
): string {
  switch (code) {
    case "whatsapp_not_connected":
    case "not_enough_products":
    case "storage_full":
      return COPY.errors[code];
    default:
      return COPY.errors.failed;
  }
}

const retry = (part: ProductKitPart, label: string): KitAction => ({
  kind: "retry",
  label,
  part,
});

/** How a part being made looks: its chips and what it says. */
function makingLook(
  part: ProductKitPart,
  kit: ProductKitRecord
): Pick<KitPartView, "chip" | "listChip" | "line"> {
  return part === "orderForm"
    ? {
        chip: { label: COPY.chips.making, tone: "neutral" },
        listChip: { label: LIST.orderFormMaking, tone: "neutral" },
        line: COPY.orderFormMaking,
      }
    : {
        chip: { label: COPY.chips.making, tone: "neutral" },
        listChip: { label: LIST.carouselMaking, tone: "neutral" },
        line: COPY.carouselMaking(kit.parts.carousel?.cardCount ?? 0),
      };
}

function orderFormView(
  workspaceId: string,
  kit: ProductKitRecord
): KitPartView | null {
  const form = kit.parts.orderForm;
  if (!form) return null;
  const base = { part: "orderForm" as const, name: COPY.orderForm };
  const flows: KitAction = {
    kind: "link",
    label: COPY.openFlows,
    href: whatsAppFlowsHref(workspaceId),
  };
  if (form.state === "making")
    return {
      ...base,
      ...makingLook("orderForm", kit),
      actions: [],
      holds: false,
    };
  const version = (form.version ?? 1) > 1 ? form.version : null;
  if (form.state === "ready")
    return {
      ...base,
      chip: { label: COPY.chips.ready, tone: "ok" },
      listChip: { label: LIST.orderFormReady, tone: "ok" },
      line: COPY.orderFormReady(
        form.flowName ?? COPY.orderForm,
        form.productCount
      ),
      actions: [flows],
      holds: true,
      // A new version: forms already sent keep opening this one.
      edit: { label: EDIT.editOrderForm, note: null },
      version,
    };
  if (form.state === "draft")
    return {
      ...base,
      chip: { label: COPY.chips.draft, tone: "accent" },
      listChip: { label: LIST.orderFormDraft, tone: "accent" },
      line: COPY.orderFormDraft,
      actions: [flows],
      holds: false,
      edit: { label: EDIT.editAndPublish, note: null },
      version,
    };
  return {
    ...base,
    chip: { label: COPY.chips.notMade, tone: "danger" },
    listChip: { label: LIST.orderFormNotMade, tone: "danger" },
    line: kitErrorLine(form.error),
    actions: [retry("orderForm", COPY.tryAgain)],
    holds: false,
    edit:
      form.state === "failed"
        ? { label: EDIT.editAndPublish, note: null }
        : null,
    version,
  };
}

function carouselView(
  workspaceId: string,
  kit: ProductKitRecord
): KitPartView | null {
  const carousel = kit.parts.carousel;
  if (!carousel) return null;
  const base = { part: "carousel" as const, name: COPY.carousel };
  const templates = (label: string): KitAction => ({
    kind: "link",
    label,
    href: templateHref(workspaceId, carousel.templateName),
  });
  if (carousel.state === "making")
    return {
      ...base,
      ...makingLook("carousel", kit),
      actions: [],
      holds: false,
    };
  // Meta's answer was lost: no Try again while Airi looks for it there,
  // so nothing is sent twice.
  if (carousel.state === "checking")
    return {
      ...base,
      chip: { label: COPY.chips.checking, tone: "neutral" },
      listChip: { label: LIST.carouselChecking, tone: "neutral" },
      line: COPY.carouselChecking,
      actions: [],
      holds: false,
    };
  if (carousel.state === "skipped")
    return {
      ...base,
      chip: { label: COPY.chips.skipped, tone: "neutral" },
      listChip: { label: LIST.carouselNotMade, tone: "neutral" },
      line: COPY.carouselSkipped,
      actions: [],
      holds: false,
    };
  if (carousel.state === "failed") {
    // Where the owner frees what stopped it: storage in Assets, templates in Templates.
    const free: KitAction[] =
      carousel.error?.code === "storage_full"
        ? [
            {
              kind: "link",
              label: COPY.openAssets,
              href: assetsHref(workspaceId),
            },
          ]
        : carousel.error?.code === "template_limit"
          ? [
              {
                kind: "link",
                label: COPY.openTemplates,
                href: templateHref(workspaceId, null),
              },
            ]
          : [];
    return {
      ...base,
      chip: { label: COPY.chips.notMade, tone: "danger" },
      listChip: { label: LIST.carouselNotMade, tone: "danger" },
      line: kitErrorLine(carousel.error),
      actions: [retry("carousel", COPY.tryAgain), ...free],
      holds: false,
      edit: { label: EDIT.editAndTryAgain, note: null },
    };
  }
  switch (carouselVerdict(carousel.metaStatus)) {
    case "approved":
      return {
        ...base,
        chip: { label: COPY.chips.approved, tone: "ok" },
        listChip: { label: LIST.carouselApproved, tone: "ok" },
        line: carousel.approvedAt
          ? COPY.carouselApproved(clockTime(carousel.approvedAt))
          : COPY.carouselApprovedNoTime,
        actions: [templates(COPY.openTemplates)],
        holds: true,
      };
    case "rejected":
      return {
        ...base,
        chip: { label: COPY.chips.notApproved, tone: "danger" },
        listChip: { label: LIST.carouselNotApproved, tone: "danger" },
        line: COPY.carouselRejected(carousel.metaReason),
        actions: [
          templates(COPY.editInTemplates),
          retry("carousel", COPY.makeAgain),
        ],
        holds: false,
      };
    case "paused":
      return {
        ...base,
        chip: { label: COPY.chips.paused, tone: "neutral" },
        listChip: { label: LIST.carouselPaused, tone: "neutral" },
        line: COPY.carouselPaused,
        actions: [templates(COPY.openTemplates)],
        holds: false,
      };
    case "disabled":
      return {
        ...base,
        chip: { label: COPY.chips.turnedOff, tone: "danger" },
        listChip: { label: LIST.carouselTurnedOff, tone: "danger" },
        line: COPY.carouselDisabled,
        actions: [
          templates(COPY.editInTemplates),
          retry("carousel", COPY.makeAgain),
        ],
        holds: false,
      };
    case "limit":
      return {
        ...base,
        chip: { label: COPY.chips.limit, tone: "danger" },
        listChip: { label: LIST.carouselLimit, tone: "danger" },
        line: COPY.carouselLimit,
        actions: [
          templates(COPY.openTemplates),
          retry("carousel", COPY.makeAgain),
        ],
        holds: false,
      };
    default:
      return {
        ...base,
        chip: { label: COPY.chips.withMeta, tone: "accent" },
        listChip: { label: LIST.carouselWithMeta, tone: "accent" },
        line: COPY.carouselPending,
        actions: [templates(COPY.openTemplates)],
        holds: true,
      };
  }
}

/**
 * The kit's parts as the page shows them. `remaking` shows as being made,
 * but keeps its buttons: its Try again stays where the keyboard's focus is,
 * unpressable until the part is made.
 */
export function kitPartViews(
  workspaceId: string,
  kit: ProductKitRecord,
  remaking: ProductKitPart | null = null
): KitPartView[] {
  return [
    orderFormView(workspaceId, kit),
    withCarouselEdit(kit, carouselView(workspaceId, kit)),
  ]
    .filter((view): view is KitPartView => view !== null)
    .map(view =>
      view.part === remaking
        ? { ...view, ...makingLook(view.part, kit), holds: false, edit: null }
        : // Only what the edit route takes is offered.
          kitPartCanEdit(view.part, kit.parts[view.part])
          ? view
          : { ...view, edit: null }
    );
}

/**
 * "Edit and send again" on a carousel with Meta, whatever Meta decided: it
 * always goes as a new template, and the note says what becomes of this one.
 */
function withCarouselEdit(
  kit: ProductKitRecord,
  view: KitPartView | null
): KitPartView | null {
  const carousel = kit.parts.carousel;
  if (!view || carousel?.state !== "submitted") return view;
  const verdict = carouselVerdict(carousel.metaStatus);
  return {
    ...view,
    edit: {
      label: EDIT.editAndSendAgain,
      note:
        verdict === "waiting"
          ? EDIT.notes.pending
          : verdict === "approved"
            ? EDIT.notes.approved
            : verdict === "paused"
              ? EDIT.notes.paused
              : EDIT.notes.turnedDown,
    },
  };
}

/** What each part is now, said once for a screen reader: "Order form: Ready." */
export function kitPartsSaid(
  workspaceId: string,
  kit: ProductKitRecord
): string {
  return kitPartViews(workspaceId, kit)
    .map(view => `${view.name}: ${view.chip.label}.`)
    .join(" ");
}

/**
 * A retry button's state while a part is made again: unpressable, but still
 * focusable (aria-disabled), so the keyboard's focus isn't dropped.
 */
export const retryBusy = (busy: boolean) =>
  busy
    ? {
        "aria-disabled": true as const,
        className: "aria-disabled:opacity-50 aria-disabled:cursor-default",
      }
    : {};

/** What still works when one part wasn't made: "The order form stays ready." */
export function keptLine(views: KitPartView[]): string | null {
  if (views.length < 2) return null;
  const failing = views.filter(view =>
    view.actions.some(action => action.kind === "retry")
  );
  const holding = views.find(view => view.holds);
  if (failing.length !== 1 || !holding) return null;
  return holding.part === "orderForm" ? COPY.keptOrderForm : COPY.keptCarousel;
}

/**
 * The kit's status in the make view: a row per part with its chip, what it
 * means, and its next step. A part being made again shows as making.
 */
export function KitStatus({
  workspaceId,
  kit,
  remaking,
  refusal,
  onRetry,
  onEdit,
  formTest,
}: {
  workspaceId: string;
  kit: ProductKitRecord;
  /** The part being made again, if one is. */
  remaking: ProductKitPart | null;
  /** Why making a part again was refused. */
  refusal: { part: ProductKitPart; line: string } | null;
  onRetry: (part: ProductKitPart) => void;
  /** "Edit and send again" and the like; without it, the rows offer none. */
  onEdit?: (part: ProductKitPart, trigger: HTMLElement) => void;
  /** "Send me the order form" on a published form, and what the last send said. */
  formTest?: {
    sending: boolean;
    line: { text: string; ok: boolean } | null;
    onSend: () => void;
  } | null;
}) {
  const views = kitPartViews(workspaceId, kit, remaking);
  const kept = keptLine(views);
  return (
    <div className={styles.status}>
      <ul className={styles.statusRows} aria-live="polite">
        {views.map(view => (
          <li key={view.part} className={styles.statusRow}>
            <span className={styles.partIcon} aria-hidden="true">
              {view.part === "orderForm" ? (
                <ClipboardList />
              ) : (
                <GalleryHorizontalEnd />
              )}
            </span>
            <div className={styles.partBody}>
              <p className={styles.partHead}>
                <span className={styles.partName}>{view.name}</span>
                <ProductChip tone={view.chip.tone}>
                  {view.chip.label}
                </ProductChip>
                {view.version ? (
                  <ProductChip>{EDIT.version(view.version)}</ProductChip>
                ) : null}
              </p>
              <p className={styles.partLine}>{view.line}</p>
              {view.version ? (
                <p className={styles.partNote}>
                  {EDIT.versionNote(view.version)}
                </p>
              ) : null}
              {onEdit && view.edit?.note ? (
                <p className={styles.partNote}>{view.edit.note}</p>
              ) : null}
              {view.actions.length > 0 || (onEdit && view.edit) ? (
                <div className={styles.partActions}>
                  {onEdit && view.edit ? (
                    <Button
                      size="sm"
                      variant="outline"
                      {...retryBusy(remaking !== null)}
                      onClick={event => {
                        if (remaking === null)
                          onEdit(view.part, event.currentTarget);
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      {view.edit.label}
                    </Button>
                  ) : null}
                  {formTest &&
                  view.part === "orderForm" &&
                  kit.parts.orderForm?.state === "ready" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      {...retryBusy(formTest.sending)}
                      onClick={() => {
                        if (!formTest.sending) formTest.onSend();
                      }}
                    >
                      <Send aria-hidden="true" />
                      {formTest.sending ? EDIT.sendingTest : EDIT.sendTest}
                    </Button>
                  ) : null}
                  {view.actions.map(action =>
                    action.kind === "link" ? (
                      <Button
                        key={action.label}
                        asChild
                        size="sm"
                        variant="outline"
                      >
                        <Link href={action.href}>{action.label}</Link>
                      </Button>
                    ) : (
                      <Button
                        key={action.label}
                        size="sm"
                        variant="outline"
                        {...retryBusy(remaking !== null)}
                        onClick={() => {
                          if (remaking === null) onRetry(action.part);
                        }}
                      >
                        <RotateCcw aria-hidden="true" />
                        {action.label}
                      </Button>
                    )
                  )}
                </div>
              ) : null}
              {refusal?.part === view.part ? (
                <p role="alert" className={styles.partAlert}>
                  {refusal.line}
                </p>
              ) : null}
              {view.part === "orderForm" && formTest?.line ? (
                <p
                  role={formTest.line.ok ? "status" : "alert"}
                  className={
                    formTest.line.ok ? styles.partNote : styles.partAlert
                  }
                >
                  {formTest.line.text}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {kept ? <p className={styles.kept}>{kept}</p> : null}
    </div>
  );
}
