import type { ProductKitPart, ProductKitStatus } from "./types-kit";

// What a kit's parts add up to, read the same way by the server (the kit's
// status) and the page (its chips and next steps).

/** What Meta decided about a carousel template, as the page says it. */
export type CarouselVerdict =
  | "waiting"
  | "approved"
  | "rejected"
  | "paused"
  | "disabled"
  | "limit";

/**
 * Meta's template status as a verdict: PENDING, IN_APPEAL or not read yet
 * are still waiting; LIMIT_EXCEEDED means the account has as many
 * templates as Meta allows.
 */
export function carouselVerdict(
  metaStatus: string | null | undefined
): CarouselVerdict {
  switch ((metaStatus ?? "").trim().toUpperCase()) {
    case "APPROVED":
    case "FLAGGED":
      return "approved";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "LIMIT_EXCEEDED":
      return "limit";
    case "DISABLED":
    case "DELETED":
    case "PENDING_DELETION":
    case "ARCHIVED":
      return "disabled";
    default:
      return "waiting";
  }
}

type OrderFormLike = { state: string };
type CarouselLike = { state: string; metaStatus?: string | null };
type PartsLike = {
  orderForm?: OrderFormLike | null;
  carousel?: CarouselLike | null;
};

/** Verdicts the owner can only answer by making the carousel again. */
const TURNED_DOWN: ReadonlySet<CarouselVerdict> = new Set([
  "rejected",
  "disabled",
  "limit",
]);

/**
 * Whether "Try again" (or "Make it again") makes this part again: a part
 * that wasn't made, or a carousel Meta turned down for good.
 */
export function kitPartCanRetry(
  part: ProductKitPart,
  value: OrderFormLike | CarouselLike | null | undefined
): boolean {
  if (!value) return false;
  if (value.state === "failed") return true;
  return (
    part === "carousel" &&
    value.state === "submitted" &&
    TURNED_DOWN.has(carouselVerdict((value as CarouselLike).metaStatus))
  );
}

/** States a part can be edited and sent again from, by part. */
const EDITABLE: Record<ProductKitPart, ReadonlySet<string>> = {
  // With Meta in any verdict (a new template goes), or not made.
  carousel: new Set(["submitted", "failed"]),
  // Published (a new version goes), kept as a draft, or not made.
  orderForm: new Set(["ready", "draft", "failed"]),
};

/**
 * Whether "Edit and send again", "Edit and try again", "Edit order form"
 * or "Edit and publish" can send this part with the owner's edits. A part
 * being made, or one airi is still looking for at Meta, can't (409
 * kit_part_busy); nor can a part that wasn't asked for or was skipped.
 */
export function kitPartCanEdit(
  part: ProductKitPart,
  value: OrderFormLike | CarouselLike | null | undefined
): boolean {
  return Boolean(value && EDITABLE[part].has(value.state));
}

/** Whether a part is still being made or looked for: an edit waits for it. */
export function kitPartBusy(
  value: OrderFormLike | CarouselLike | null | undefined
): boolean {
  return value?.state === "making" || value?.state === "checking";
}

/**
 * The kit as a whole: making while a part is (a carousel airi is still
 * looking for at Meta included); needing attention when a part wasn't made,
 * the form is only a draft or Meta turned the carousel down or paused it;
 * waiting while Meta checks the carousel; ready otherwise. A carousel
 * skipped for too few photos was never possible, so it doesn't count.
 */
export function productKitStatus(parts: PartsLike): ProductKitStatus {
  const { orderForm, carousel } = parts;
  if (
    orderForm?.state === "making" ||
    carousel?.state === "making" ||
    carousel?.state === "checking"
  )
    return "making";
  const verdict =
    carousel?.state === "submitted"
      ? carouselVerdict(carousel.metaStatus)
      : null;
  if (
    orderForm?.state === "failed" ||
    orderForm?.state === "draft" ||
    carousel?.state === "failed" ||
    (verdict !== null && verdict !== "waiting" && verdict !== "approved")
  )
    return "needs_attention";
  if (verdict === "waiting") return "waiting_for_meta";
  return "ready";
}
