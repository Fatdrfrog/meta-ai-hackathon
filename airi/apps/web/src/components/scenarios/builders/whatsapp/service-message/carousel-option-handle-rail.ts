export type CarouselCardVisibility = "active" | "hiddenLeft" | "hiddenRight";

/**
 * A carousel card names itself with `data-carousel-card-id`, and each of its
 * routed buttons with `data-carousel-option-id` and `data-carousel-option-index`.
 */
const CAROUSEL_CARD_SELECTOR = "[data-carousel-card-id]";

export type CarouselOptionHandleLayout = {
  optionId: string;
  cardId: string;
  optionIndex: number;
  top: number;
  visibility: CarouselCardVisibility;
};

export type CarouselOptionHandleRailSnapshot = {
  /**
   * The cards whose buttons show route dots: every card fully in view, or
   * the most visible card when none fits whole. Empty before cards exist.
   */
  activeCardIds: readonly string[];
  options: CarouselOptionHandleLayout[];
};

export type CarouselRailCluster = {
  optionIndex: number;
  top: number;
  optionIds: string[];
};

export const EMPTY_CAROUSEL_OPTION_HANDLE_RAIL_SNAPSHOT: CarouselOptionHandleRailSnapshot =
  {
    activeCardIds: [],
    options: [],
  };

/** Scroll offsets can be fractional while widths and offsets are rounded. */
const CAROUSEL_CARD_IN_VIEW_TOLERANCE_PX = 2;

export function sameCarouselOptionHandleLayouts(
  current: readonly CarouselOptionHandleLayout[],
  next: readonly CarouselOptionHandleLayout[]
): boolean {
  if (current.length !== next.length) return false;
  return current.every((item, index) => {
    const other = next[index];
    return (
      other != null &&
      item.optionId === other.optionId &&
      item.cardId === other.cardId &&
      item.optionIndex === other.optionIndex &&
      item.top === other.top &&
      item.visibility === other.visibility
    );
  });
}

function sameCardIds(
  current: readonly string[],
  next: readonly string[]
): boolean {
  return (
    current.length === next.length &&
    current.every((cardId, index) => cardId === next[index])
  );
}

export function sameCarouselOptionHandleRailSnapshots(
  current: CarouselOptionHandleRailSnapshot,
  next: CarouselOptionHandleRailSnapshot
): boolean {
  return (
    sameCardIds(current.activeCardIds, next.activeCardIds) &&
    sameCarouselOptionHandleLayouts(current.options, next.options)
  );
}

function isHiddenCarouselCard(visibility: CarouselCardVisibility): boolean {
  switch (visibility) {
    case "active":
      return false;
    case "hiddenLeft":
    case "hiddenRight":
      return true;
    default: {
      const _exhaustive: never = visibility;
      return _exhaustive;
    }
  }
}

function classifyCardVisibility(
  card: HTMLElement,
  viewLeft: number,
  viewRight: number,
  activeCardIds: readonly string[]
): CarouselCardVisibility {
  const cardId = card.dataset.carouselCardId;
  if (cardId != null && activeCardIds.includes(cardId)) {
    return "active";
  }
  const mid = card.offsetLeft + card.offsetWidth / 2;
  const viewMid = (viewLeft + viewRight) / 2;
  return mid < viewMid ? "hiddenLeft" : "hiddenRight";
}

function isCarouselCardInView(
  card: HTMLElement,
  viewLeft: number,
  viewRight: number
): boolean {
  return (
    card.offsetWidth > 0 &&
    card.offsetLeft >= viewLeft - CAROUSEL_CARD_IN_VIEW_TOLERANCE_PX &&
    card.offsetLeft + card.offsetWidth <=
      viewRight + CAROUSEL_CARD_IN_VIEW_TOLERANCE_PX
  );
}

function readMostVisibleCarouselCardId(
  cards: readonly HTMLElement[],
  viewLeft: number,
  viewRight: number
): string | null {
  let mostVisibleCardId: string | null = null;
  let bestVisible = -1;
  for (const card of cards) {
    const visible =
      Math.min(card.offsetLeft + card.offsetWidth, viewRight) -
      Math.max(card.offsetLeft, viewLeft);
    if (visible > bestVisible) {
      bestVisible = visible;
      mostVisibleCardId = card.dataset.carouselCardId ?? null;
    }
  }
  return mostVisibleCardId ?? cards[0]?.dataset.carouselCardId ?? null;
}

/**
 * Two narrow cards can fit side by side, so a single "most visible" card
 * would leave the other without dots; at the scroll end that is always the
 * last card.
 */
function readActiveCarouselCardIds(
  cards: readonly HTMLElement[],
  viewLeft: number,
  viewRight: number
): string[] {
  const inView = cards.flatMap(card => {
    const cardId = card.dataset.carouselCardId;
    return cardId && isCarouselCardInView(card, viewLeft, viewRight)
      ? [cardId]
      : [];
  });
  if (inView.length > 0) return inView;
  const mostVisible = readMostVisibleCarouselCardId(cards, viewLeft, viewRight);
  return mostVisible == null ? [] : [mostVisible];
}

export function readCarouselOptionHandleRail(
  wrap: HTMLElement
): CarouselOptionHandleRailSnapshot {
  const viewport = wrap.querySelector(
    "[data-testid='carousel-cards-viewport']"
  );
  if (!(viewport instanceof HTMLElement)) {
    return EMPTY_CAROUSEL_OPTION_HANDLE_RAIL_SNAPSHOT;
  }
  const cards = [
    ...viewport.querySelectorAll<HTMLElement>(CAROUSEL_CARD_SELECTOR),
  ];
  const viewLeft = viewport.scrollLeft;
  const viewRight = viewLeft + Math.max(viewport.clientWidth, 1);
  const activeCardIds = readActiveCarouselCardIds(cards, viewLeft, viewRight);

  const wrapRect = wrap.getBoundingClientRect();
  // Screen rects include the canvas zoom, while the rail places dots in layout
  // pixels inside `wrap`; undo the zoom so a dot stays on its row at any zoom.
  // Node widths are whole pixels, so the width ratio is exact.
  const scale =
    wrap.offsetWidth > 0 && wrapRect.width > 0
      ? wrapRect.width / wrap.offsetWidth
      : 1;
  const options: CarouselOptionHandleLayout[] = [];
  for (const row of wrap.querySelectorAll<HTMLElement>(
    "[data-carousel-option-id]"
  )) {
    const optionId = row.dataset.carouselOptionId;
    if (!optionId) continue;
    const card = row.closest<HTMLElement>(CAROUSEL_CARD_SELECTOR);
    const cardId = card?.dataset.carouselCardId;
    if (!card || !cardId) continue;
    const parsedIndex = Number.parseInt(
      row.dataset.carouselOptionIndex ?? "",
      10
    );
    const rect = row.getBoundingClientRect();
    options.push({
      optionId,
      cardId,
      optionIndex: Number.isFinite(parsedIndex) ? parsedIndex : 0,
      top: (rect.top - wrapRect.top + rect.height / 2) / scale,
      visibility: classifyCardVisibility(
        card,
        viewLeft,
        viewRight,
        activeCardIds
      ),
    });
  }
  return { activeCardIds, options };
}

export function clusterHiddenConnectedHandles(
  layouts: readonly CarouselOptionHandleLayout[],
  connectedOptionIds: ReadonlySet<string>
): CarouselRailCluster[] {
  const hiddenByIndex = new Map<number, CarouselOptionHandleLayout[]>();
  for (const item of layouts) {
    if (
      !isHiddenCarouselCard(item.visibility) ||
      !connectedOptionIds.has(item.optionId)
    ) {
      continue;
    }
    const group = hiddenByIndex.get(item.optionIndex);
    if (group) {
      group.push(item);
      continue;
    }
    hiddenByIndex.set(item.optionIndex, [item]);
  }

  return [...hiddenByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([optionIndex, group]) => {
      group.sort(
        (a, b) => a.top - b.top || a.optionId.localeCompare(b.optionId)
      );
      return {
        optionIndex,
        top: group.reduce((sum, item) => sum + item.top, 0) / group.length,
        optionIds: group.map(item => item.optionId),
      };
    });
}
