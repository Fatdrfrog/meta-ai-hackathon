"use client";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  formatProductPrice,
  hasAtMostDecimals,
  MAX_PRODUCT_NAME_LENGTH,
  parseTypedPrice,
  productCurrency,
  productPriceDecimals,
  productPriceLength,
  type DraftProductRecord,
  type ProductChanges,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  CircleAlert,
  Eye,
  Info,
  Mic,
  Pause,
  Pencil,
  Play,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ProductSegmented } from "./product-controls";
import { MakeOutputs } from "./product-make";
import {
  animateOnSpring,
  EASE_OUT,
  prefersReducedMotion,
} from "./product-motion";
import styles from "./product-review.module.css";
import { NameInitial, PriceText } from "./product-shelf";
import theme from "./product-theme.module.css";
import { useProductReview, type ReviewMove } from "./use-product-review";

const COPY = PRODUCTS_COPY.review;

// A dragged card leaves once past this share of its width, or when flicked.
const SWIPE_SHARE = 0.3;
const FLICK_PX_PER_MS = 0.7;
const FLICK_MIN_PX = 64;
// Moving less than this is a tap on the card, not a drag.
const DRAG_START_PX = 8;
// How far a drag goes before its stamp shows fully and the next card is up.
const FULL_DRAG_PX = 110;
// A decided card leaves along its drag; the next one rises into place.
const FLY_MS = 220;
const RISE_MS = 200;
// The cards behind the top one: their edges show, 8px apart.
const BEHIND_STEP_PX = 8;
const BEHIND_SCALE_STEP = 0.04;

type Direction = "left" | "right";
type Flight = {
  key: string;
  product: DraftProductRecord;
  direction: Direction;
  fromX: number;
};

const directionOf = (to: ReviewMove["to"]): Direction =>
  to === "published" ? "right" : "left";

/** A card dragged `x` px to the side, tilting as it goes. */
const dragTransform = (x: number) =>
  `translateX(${x}px) rotate(${Math.max(-18, Math.min(18, x * 0.08))}deg)`;

/** Off the side of the stack, as a card leaves or comes back. */
const awayTransform = (direction: Direction, width: number) =>
  `translateX(${direction === "right" ? "" : "-"}${Math.round(width * 1.4)}px) rotate(${direction === "right" ? 24 : -24}deg)`;

/** Whether a key is typed into a field, which the review's keys leave be. */
function typedInField(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  return Boolean(
    target?.closest("input, textarea, select, [contenteditable='true']")
  );
}

/** Whether a key is the review's undo: Backspace, or Ctrl or ⌘ and Z. */
function isUndoKey(event: KeyboardEvent): boolean {
  const command = event.ctrlKey || event.metaKey;
  return (
    (event.key === "Backspace" && !command) ||
    (command && !event.shiftKey && event.key.toLowerCase() === "z")
  );
}

/**
 * Checking what a video found, one card per product, the way dating apps
 * do it: swipe right (or →) to add a product to the shelf, left (or ←) to
 * skip it, with undo, and "Accept all" for the rest. Each card plays the
 * owner saying the price, marks in red what Airi isn't sure of and why, and
 * lets the owner fix the name and price and choose the photo the shelf
 * shows.
 */
export function ProductReview({
  workspaceId,
  importId,
  onClose,
  onChangeProducts,
  onMakeAd,
}: {
  workspaceId: string;
  importId: string;
  onClose: () => void;
  /** "Change" in what to make: the shelf's Choose mode, with these chosen. */
  onChangeProducts: (productIds: string[]) => void;
  /** "Make a video ad": the ad's brief with these products. */
  onMakeAd: (productIds: string[]) => void;
}) {
  const review = useProductReview(workspaceId, importId);
  const { products, queue, lastMove } = review;
  const top = queue[0] ?? null;
  const [soundOn, setSoundOn] = useState(true);
  const [dragX, setDragX] = useState(0);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [returning, setReturning] = useState<{
    id: string;
    from: Direction;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Once a card was decided, the next one up rises into place.
  const [decided, setDecided] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // The review takes the keyboard's focus, so its keys work at once.
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  const decideTop = (to: ReviewMove["to"], fromX = 0) => {
    if (!top) return;
    setDragX(0);
    setReturning(null);
    setDecided(true);
    if (!prefersReducedMotion())
      setFlights(current => [
        ...current,
        {
          key: `${top.id}:${current.length}:${Date.now()}`,
          product: top,
          direction: directionOf(to),
          fromX,
        },
      ]);
    setAnnouncement(
      to === "published" ? COPY.added(top.name) : COPY.skipped(top.name)
    );
    review.decide([top.id], to);
  };

  const undo = () => {
    if (!lastMove) return;
    // A card brought back comes in from the side it left by.
    setReturning(
      lastMove.ids.length === 1
        ? { id: lastMove.ids[0]!, from: directionOf(lastMove.to) }
        : null
    );
    setAnnouncement(COPY.undone);
    review.undo();
  };

  const acceptAll = () => {
    setAnnouncement(COPY.allAdded(queue.length));
    review.decide(
      queue.map(product => product.id),
      "published"
    );
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || typedInField(event))
      return;
    if (isUndoKey(event)) {
      event.preventDefault();
      undo();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
      return;
    if (event.key === "ArrowRight" && top) {
      event.preventDefault();
      decideTop("published");
    } else if (event.key === "ArrowLeft" && top) {
      event.preventDefault();
      decideTop("rejected");
    } else if (event.key === "Escape") {
      onClose();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  let content: ReactNode;
  if (review.loading) {
    content = (
      <div role="status" aria-label={PRODUCTS_COPY.loading}>
        <div className={STACK}>
          {/* A still, blank card: nothing pulses while it loads. */}
          <div
            className={cn(
              theme.sheet,
              "absolute inset-0 flex flex-col overflow-hidden opacity-70"
            )}
          >
            <div className={styles.photo}>
              <span className={styles.board} />
            </div>
            <div className="h-32 shrink-0" />
          </div>
        </div>
      </div>
    );
  } else if (review.loadFailed) {
    content = (
      <div className="flex flex-col items-center gap-3 pt-16 text-center">
        <p role="alert" className="text-[15px] font-medium text-(--p-ink)">
          {COPY.loadFailed}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={review.reload}>
            {PRODUCTS_COPY.retry}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {COPY.backToProducts}
          </Button>
        </div>
      </div>
    );
  } else if (!top) {
    content = (
      <ReviewDone
        workspaceId={workspaceId}
        importId={importId}
        products={products}
        canUndo={lastMove !== null}
        onUndo={undo}
        onClose={onClose}
        onChangeProducts={onChangeProducts}
        onMakeAd={onMakeAd}
      />
    );
  } else {
    const behind = queue.slice(1, 3);
    content = (
      <>
        <div className={STACK}>
          {behind
            .map((product, index) => {
              // The card right behind rises as the top one is dragged away.
              const lift =
                index === 0 ? Math.min(1, Math.abs(dragX) / FULL_DRAG_PX) : 0;
              const depth = index + 1 - lift;
              return (
                <div
                  key={product.id}
                  aria-hidden="true"
                  className={cn(
                    styles.behind,
                    "pointer-events-none absolute inset-0"
                  )}
                  style={{
                    transform: `translateY(${depth * BEHIND_STEP_PX}px) scale(${1 - depth * BEHIND_SCALE_STEP})`,
                  }}
                >
                  <ReviewCard product={product} still />
                </div>
              );
            })
            .reverse()}
          <SwipeCard
            key={top.id}
            returningFrom={returning?.id === top.id ? returning.from : null}
            rise={decided && returning?.id !== top.id}
            onDrag={setDragX}
            onSwipe={(direction, fromX) =>
              decideTop(direction === "right" ? "published" : "rejected", fromX)
            }
          >
            <ReviewCard
              product={top}
              soundOn={soundOn}
              dragX={dragX}
              defaultCurrency={review.lastCurrency}
              onEdit={changes => review.edit(top.id, changes)}
            />
          </SwipeCard>
        </div>
        <DecisionBar
          canUndo={lastMove !== null}
          onSkip={() => decideTop("rejected")}
          onUndo={undo}
          onAdd={() => decideTop("published")}
        />
      </>
    );
  }

  // Cards are checked in a narrow column; what to make with them takes the
  // page's width.
  const done = !review.loading && !review.loadFailed && !top;
  const position = Math.min(
    products.length,
    products.length - queue.length + 1
  );
  return (
    <div
      ref={root}
      tabIndex={-1}
      aria-labelledby="product-review-title"
      className={cn(
        theme.enter,
        "mx-auto flex w-full flex-col outline-none",
        done ? "max-w-none" : "max-w-[520px]"
      )}
    >
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" className="-ml-2.5" onClick={onClose}>
          <ArrowLeft aria-hidden="true" />
          {COPY.back}
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          {done ? null : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={COPY.sound}
              aria-pressed={soundOn}
              title={COPY.sound}
              onClick={() => setSoundOn(on => !on)}
            >
              {soundOn ? (
                <Volume2 aria-hidden="true" />
              ) : (
                <VolumeX aria-hidden="true" />
              )}
            </Button>
          )}
          {queue.length > 0 ? (
            <Button variant="outline" size="sm" onClick={acceptAll}>
              <CheckCheck aria-hidden="true" />
              {COPY.acceptAll(queue.length)}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-[18px] flex items-baseline justify-between gap-3">
        <h2 id="product-review-title" className={theme.displayM}>
          {COPY.title}
        </h2>
        {top ? (
          <span className="text-xs leading-4 text-(--p-ink-2) tabular-nums">
            {COPY.position(position, products.length)}
          </span>
        ) : null}
      </div>
      {products.length > 0 ? (
        <ReviewProgress products={products} current={top?.id ?? null} />
      ) : null}
      <div className={cn("relative", done ? "mt-8" : "mt-[22px]")}>
        {content}
        {/* Over whatever shows, so the last card still flies off. */}
        <div
          className={cn(STACK, "pointer-events-none absolute inset-x-0 top-0")}
        >
          {flights.map(flight => (
            <FlyingCard
              key={flight.key}
              flight={flight}
              onDone={() =>
                setFlights(current =>
                  current.filter(entry => entry.key !== flight.key)
                )
              }
            />
          ))}
        </div>
      </div>
      {review.failed ? (
        <p
          role="alert"
          className="mt-4 text-center text-sm text-(--p-danger-ink)"
        >
          {COPY.saveFailed}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

// Tall enough for a photo and the product's details (548px), within a
// phone's screen with the title, progress and buttons around it.
const STACK =
  "relative h-[min(34.25rem,calc(100svh-20rem))] min-h-[26rem] w-full";

/**
 * One segment per product: green once added, ink once skipped, rose for the
 * one being checked.
 */
function ReviewProgress({
  products,
  current,
}: {
  products: DraftProductRecord[];
  current: string | null;
}) {
  return (
    <div aria-hidden="true" className={styles.segments}>
      {products.map(product => (
        <span
          key={product.id}
          data-state={
            product.status === "published"
              ? "added"
              : product.status === "rejected"
                ? "skipped"
                : product.id === current
                  ? "now"
                  : undefined
          }
        />
      ))}
    </div>
  );
}

/** A key's hint inside a button, for a keyboard and a fine pointer only. */
function KeyHint({ children }: { children: ReactNode }) {
  return <Kbd className="ml-1 hidden pointer-fine:inline-flex">{children}</Kbd>;
}

/**
 * Skip (←), Undo and Add to shelf (→): labelled 48px buttons, 52px and
 * sharing the width on a phone. Adding is the view's one filled action.
 */
function DecisionBar({
  canUndo,
  onSkip,
  onUndo,
  onAdd,
}: {
  canUndo: boolean;
  onSkip: () => void;
  onUndo: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="mt-[30px] flex items-center justify-center gap-3 max-sm:mt-[26px] max-sm:gap-2.5">
      <Button
        variant="outline"
        title={`${COPY.skip} (←)`}
        className="h-12 px-5 text-[15px] [--p-button-radius:12px] max-sm:h-[52px] max-sm:flex-1"
        onClick={onSkip}
      >
        <X
          aria-hidden="true"
          strokeWidth={2.25}
          className="text-(--p-danger-ink)"
        />
        {COPY.skip}
        <KeyHint>
          <ArrowLeft aria-hidden="true" />
        </KeyHint>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={COPY.undo}
        title={`${COPY.undo} (Backspace)`}
        disabled={!canUndo}
        className="size-12 [--p-button-radius:12px] max-sm:size-[52px]"
        onClick={onUndo}
      >
        <Undo2 aria-hidden="true" />
      </Button>
      <Button
        variant="secondary"
        title={`${COPY.add} (→)`}
        className={cn(
          theme.ok,
          "h-12 px-5 text-[15px] max-sm:h-[52px] max-sm:flex-1"
        )}
        onClick={onAdd}
      >
        <Check aria-hidden="true" strokeWidth={2.5} />
        {COPY.add}
        <KeyHint>
          <ArrowRight aria-hidden="true" />
        </KeyHint>
      </Button>
    </div>
  );
}

/**
 * The top card, which follows a drag and leaves once dragged far enough or
 * flicked; let go sooner, it settles back. A tap on its buttons stays a tap.
 */
function SwipeCard({
  returningFrom,
  rise,
  onDrag,
  onSwipe,
  children,
}: {
  returningFrom: Direction | null;
  /** Up from behind the one just decided: it rises from the deck on the spring. */
  rise: boolean;
  onDrag: (x: number) => void;
  onSwipe: (direction: Direction, fromX: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    at: number;
    dragging: boolean;
  } | null>(null);
  // The click a drag ends with isn't a tap on what it started on.
  const swallowClick = useRef(false);
  const [x, setX] = useState(0);
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!returningFrom || !element || prefersReducedMotion()) return;
    const animation = element.animate?.(
      [
        {
          transform: awayTransform(returningFrom, element.offsetWidth),
          opacity: 0,
        },
        { transform: "none", opacity: 1 },
      ],
      { duration: FLY_MS, easing: EASE_OUT }
    );
    return () => animation?.cancel();
  }, [returningFrom]);

  // Rising from the deck: from where the card behind stood, once, as it
  // comes up.
  const [risesNow] = useState(rise);
  useEffect(() => {
    const element = ref.current;
    if (!risesNow || !element || prefersReducedMotion()) return;
    const animation = animateOnSpring(
      element,
      [
        {
          transform: `translateY(${BEHIND_STEP_PX}px) scale(${1 - BEHIND_SCALE_STEP})`,
          transformOrigin: "50% 100%",
        },
        { transform: "none", transformOrigin: "50% 100%" },
      ],
      RISE_MS
    );
    return () => animation?.cancel();
  }, [risesNow]);

  const follow = (next: number) => {
    setX(next);
    onDrag(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    swallowClick.current = false;
    if (event.button !== 0 || gesture.current) return;
    if (
      event.target instanceof Element &&
      event.target.closest("input, textarea")
    )
      return;
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: event.timeStamp,
      dragging: false,
    };
    setSettling(false);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const dx = event.clientX - current.x;
    if (!current.dragging) {
      if (Math.abs(dx) < DRAG_START_PX) return;
      // Mostly up or down: the page is being scrolled, not the card swiped.
      if (Math.abs(event.clientY - current.y) > Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      current.dragging = true;
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // A pointer already gone can't be captured; the drag goes on without.
      }
    }
    follow(dx);
  };

  const finish = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled: boolean
  ) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    gesture.current = null;
    if (!current.dragging) return;
    swallowClick.current = true;
    const dx = cancelled ? x : event.clientX - current.x;
    const speed = Math.abs(dx) / Math.max(1, event.timeStamp - current.at);
    const width = ref.current?.offsetWidth || 320;
    if (
      !cancelled &&
      (Math.abs(dx) > width * SWIPE_SHARE ||
        (speed > FLICK_PX_PER_MS && Math.abs(dx) > FLICK_MIN_PX))
    ) {
      onSwipe(dx > 0 ? "right" : "left", dx);
      return;
    }
    setSettling(true);
    follow(0);
  };

  return (
    <div
      ref={ref}
      className={cn(
        "absolute inset-0 cursor-grab touch-pan-y select-none active:cursor-grabbing",
        settling && "transition-transform duration-200 ease-out"
      )}
      style={x ? { transform: dragTransform(x) } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={event => finish(event, false)}
      onPointerCancel={event => finish(event, true)}
      onClickCapture={event => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.stopPropagation();
        event.preventDefault();
      }}
      onTransitionEnd={() => setSettling(false)}
    >
      {children}
    </div>
  );
}

/** A decided card on its way off the stack, from where the drag let it go. */
function FlyingCard({
  flight,
  onDone,
}: {
  flight: Flight;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const finished = useEffectEvent(onDone);
  useEffect(() => {
    const element = ref.current;
    const animation = element?.animate?.(
      [
        { transform: dragTransform(flight.fromX), opacity: 1 },
        {
          transform: awayTransform(flight.direction, element.offsetWidth),
          opacity: 0,
        },
      ],
      { duration: FLY_MS, easing: "ease-in", fill: "forwards" }
    );
    if (!animation) {
      finished();
      return;
    }
    animation.onfinish = () => finished();
    return () => animation.cancel();
  }, [flight]);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ transform: dragTransform(flight.fromX) }}
    >
      <ReviewCard product={flight.product} still />
    </div>
  );
}

/**
 * One product as the owner checks it. `still` draws it without its clip
 * or anything to press: the cards behind the top one, and one flying off.
 */
function ReviewCard({
  product,
  still = false,
  soundOn = false,
  dragX = 0,
  defaultCurrency = null,
  onEdit,
}: {
  product: DraftProductRecord;
  still?: boolean;
  soundOn?: boolean;
  dragX?: number;
  /** The currency a price without one is typed in at first. */
  defaultCurrency?: string | null;
  onEdit?: (changes: ProductChanges) => void;
}) {
  const [view, setView] = useState<"polished" | "original">("polished");
  const option = product.options[product.featuredOption] ?? null;
  const polished = option?.photoUrl ?? option?.imageUrl ?? product.imageUrl;
  const original = option?.originalUrl ?? null;
  const showOriginal = view === "original" ? Boolean(original) : !polished;
  const shown = showOriginal ? original : polished;
  const priceDoubts = product.doubts.filter(doubt => doubt.about === "price");
  const otherDoubts = product.doubts.filter(doubt => doubt.about !== "price");
  const edit = still ? undefined : onEdit;
  // The price's editor, which the doubt's own button opens too.
  const priceField = useEditing();

  return (
    <article
      aria-label={still ? undefined : product.name}
      className={cn(
        theme.sheet,
        "flex size-full flex-col overflow-hidden text-(--p-ink)"
      )}
    >
      <div className={styles.photo}>
        <CardPhoto
          key={shown ?? "none"}
          url={shown}
          original={showOriginal}
          name={product.name}
        />
        <span aria-hidden="true" className={styles.board} />
        {edit && polished && original ? (
          <ProductSegmented
            label={COPY.photo}
            className={styles.toggle}
            options={[
              { value: "polished", label: COPY.polished },
              { value: "original", label: COPY.original },
            ]}
            value={view}
            onChange={setView}
          />
        ) : null}
        {!still && product.clipUrl ? (
          <VoiceClip url={product.clipUrl} soundOn={soundOn} />
        ) : null}
        {dragX !== 0 ? <Stamp dragX={dragX} /> : null}
      </div>
      <div className="flex max-h-[58%] shrink-0 flex-col overflow-y-auto px-[22px] pt-[18px] pb-[22px] max-sm:px-[18px] max-sm:pt-4 max-sm:pb-[18px]">
        <EditableName
          name={product.name}
          onSave={edit && (name => edit({ name }))}
        />
        <EditablePrice
          field={priceField}
          price={product.price}
          currency={product.currency}
          defaultCurrency={defaultCurrency}
          from={product.priceIsFrom}
          unsure={priceDoubts.length > 0 || product.price === null}
          onSave={edit}
        />
        {product.doubts.length > 0 ? (
          <div role="note" className={styles.doubt}>
            <CircleAlert aria-hidden="true" strokeWidth={2} />
            <ul className="flex min-w-0 flex-col gap-1">
              {[...priceDoubts, ...otherDoubts].map((doubt, index) => (
                <li key={index} className="text-pretty">
                  {doubt.text}
                </li>
              ))}
            </ul>
            {edit && priceDoubts.length > 0 && !priceField.editing ? (
              <Button
                variant="outline"
                size="sm"
                className="col-start-2 mt-1.5 justify-self-start"
                onClick={priceField.open}
              >
                {COPY.changePrice}
              </Button>
            ) : null}
          </div>
        ) : null}
        <YouSaid
          quote={product.priceQuote}
          shown={product.priceSource === "on_screen"}
          seconds={option?.videoMomentSeconds ?? null}
        />
        {edit && product.options.length > 1 ? (
          <OptionPicker
            product={product}
            onPick={featuredOption => edit({ featuredOption })}
          />
        ) : null}
        {option && option.notes.length > 0 ? (
          <ul className="mt-2.5 flex flex-col gap-1">
            {option.notes.map((note, index) => (
              <li
                key={index}
                className="flex gap-1.5 text-[13px] leading-[18px] text-(--p-ink-2)"
              >
                <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {note}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

/** A moment in the video, as "0:33". */
const formatMoment = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * The owner's words the price came from, and when: "You said «кукла бес
 * мың» at 0:33". One line that wraps as text, never a row of columns.
 */
function YouSaid({
  quote,
  shown,
  seconds,
}: {
  quote: string | null;
  /** Read from text on screen, not said aloud. */
  shown: boolean;
  seconds: number | null;
}) {
  if (!quote) return null;
  return (
    <p className="mt-2 text-[13px] leading-[18px] text-pretty text-(--p-ink-2)">
      {shown ? (
        <Eye
          aria-hidden="true"
          strokeWidth={1.75}
          className="mr-1.5 inline-block size-3.5 align-[-2px]"
        />
      ) : (
        <Mic
          aria-hidden="true"
          strokeWidth={1.75}
          className="mr-1.5 inline-block size-3.5 align-[-2px]"
        />
      )}
      {shown ? COPY.shownInVideo : COPY.youSaid}{" "}
      <span className="text-(--p-ink)">
        «<bdi>{quote}</bdi>»
      </span>
      {seconds !== null ? ` ${COPY.at(formatMoment(seconds))}` : null}
    </p>
  );
}

/** The cut-out standing on the card's board, or the photo as filmed. */
function CardPhoto({
  url,
  original,
  name,
}: {
  url: string | null;
  original: boolean;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div className="absolute inset-0 flex items-end justify-center pb-8">
        <NameInitial name={name} />
      </div>
    );
  }
  if (original) {
    return (
      <div className={styles.filmed}>
        {/* Signed storage URLs; next/image would need every bucket host configured. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      </div>
    );
  }
  return (
    <div className={styles.stand}>
      <div className={styles.product}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  );
}

/**
 * The owner saying the price, as a round video in the corner of the card,
 * the way chat apps show video messages, ringed in paper. It plays as the
 * card comes up, with sound when the owner has it on; a browser that wants
 * a tap first plays it silently, marked, until tapped.
 */
function VoiceClip({ url, soundOn }: { url: string; soundOn: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"idle" | "playing" | "silent" | "ended">(
    "idle"
  );

  const play = (withSound: boolean) => {
    const element = video.current;
    if (!element) return;
    element.muted = !withSound;
    element.currentTime = 0;
    Promise.resolve()
      .then(() => element.play())
      .then(
        () => setState(element.muted ? "silent" : "playing"),
        () => {
          if (withSound) play(false);
          else setState("idle");
        }
      );
  };

  const start = useEffectEvent((withSound: boolean) => play(withSound));
  useEffect(() => {
    start(soundOn);
  }, [url, soundOn]);

  return (
    <button
      type="button"
      aria-label={state === "playing" ? COPY.pause : COPY.hear}
      title={COPY.hear}
      onClick={() => {
        if (state === "playing") {
          video.current?.pause();
          setState("idle");
        } else {
          // A tap allows sound in every browser.
          play(true);
        }
      }}
      className={styles.clip}
    >
      <video
        ref={video}
        src={url}
        playsInline
        preload="auto"
        aria-hidden="true"
        onEnded={() => setState("ended")}
      />
      <span aria-hidden="true" className={styles.clipBadge}>
        {state === "playing" ? (
          <Pause className="fill-current" />
        ) : state === "silent" ? (
          <VolumeX />
        ) : (
          <Play className="translate-x-px fill-current" />
        )}
      </span>
    </button>
  );
}

/** "Add" or "Skip", stamped on the card as it's dragged that way. */
function Stamp({ dragX }: { dragX: number }) {
  const add = dragX > 0;
  return (
    <span
      aria-hidden="true"
      data-to={add ? "add" : "skip"}
      style={{ opacity: Math.min(1, Math.abs(dragX) / FULL_DRAG_PX) }}
      className={styles.stamp}
    >
      {add ? COPY.stampAdd : COPY.stampSkip}
    </span>
  );
}

/** What's wrong with an edit, and which of the editor's fields to fix. */
type EditProblem = { message: string; field: "value" | "unit" };

// The field with the focus has a stronger ring; one at fault rings in red,
// as the design system's inputs do.
const FIELD_CLASS =
  "min-w-0 rounded-md bg-(--p-sunk) px-1.5 ring-2 ring-ring/40 transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/70 aria-invalid:ring-destructive";

/** Whether a keyboard is still composing what was typed, as an IME does. */
const composing = (event: ChangeEvent<HTMLInputElement>) =>
  (event.nativeEvent as InputEvent).isComposing === true;

/** Selects all of a field's text, so that typing replaces it. */
const selectAll = (field: HTMLInputElement) =>
  field.setSelectionRange(0, field.value.length);

/**
 * Selects a field's text whenever it takes the focus. Safari, and so every
 * iPhone browser, then drops that selection as the click or tap that focused
 * the field ends: the default of its mouseup puts the caret where the field
 * was pressed. So that one mouseup's default is prevented.
 */
function useSelectOnFocus() {
  const focusingPress = useRef(false);
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLInputElement>) => {
      focusingPress.current = document.activeElement !== event.currentTarget;
    },
    onFocus: (event: ReactFocusEvent<HTMLInputElement>) =>
      selectAll(event.currentTarget),
    onMouseUp: (event: ReactMouseEvent<HTMLInputElement>) => {
      if (focusingPress.current) event.preventDefault();
      focusingPress.current = false;
    },
  };
}

/**
 * A field the owner fixes in place: Enter or leaving it saves, Escape
 * cancels. Saved or cancelled from the keyboard, the focus goes back to
 * what opened it. A `unit`, such as a price's currency code, is a second,
 * short field after it; moving between the two keeps them open, and a
 * letter typed into a full unit starts it anew. An edit `check` refuses
 * isn't saved: Enter or leaving says why and stays open, with the field to
 * fix marked, until it's fixed or Escape drops it. Enter also puts the
 * focus on that field; leaving lets the focus go where it went, and the
 * keys pressed there still mind the open edit: Escape drops it rather than
 * closing the review, and the review's undo waits until it's done.
 */
function InlineEdit({
  value,
  label,
  inputMode,
  maxLength,
  dir,
  className,
  unit,
  check,
  onDone,
}: {
  value: string;
  /** The field's name, or one that follows what's typed in the unit. */
  label: string | ((unit: string) => string);
  inputMode?: "numeric" | "decimal" | "text";
  maxLength?: number;
  /** "auto" for words, which then read in their own direction. */
  dir?: "auto";
  className: string;
  unit?: { value: string; label: string; maxLength: number };
  check?: (value: string, unit: string) => EditProblem | null;
  onDone: (value: string | null, fromKeyboard: boolean, unit: string) => void;
}) {
  const [text, setText] = useState(value);
  const [unitText, setUnitText] = useState(unit?.value ?? "");
  const [problem, setProblem] = useState<EditProblem | null>(null);
  const valueField = useRef<HTMLInputElement>(null);
  const unitField = useRef<HTMLInputElement>(null);
  const selectValue = useSelectOnFocus();
  const selectUnit = useSelectOnFocus();
  const problemId = useId();
  const done = useRef(false);
  const finish = (save: boolean, fromKeyboard: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? text : null, fromKeyboard, unitText);
  };
  // A key pressed outside any field, before the review's own keys hear it.
  const onPageKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || typedInField(event))
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false, false);
    } else if (isUndoKey(event)) {
      event.preventDefault();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onPageKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // An Enter that picks an IME candidate is still typing.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const found = check?.(text, unitText) ?? null;
      if (!found) {
        finish(true, true);
        return;
      }
      setProblem(found);
      // The field to fix takes the focus, and on a phone its own keyboard.
      (found.field === "unit" ? unitField : valueField).current?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false, true);
    }
  };
  // The field at fault says so, and points at why.
  const fault = (field: EditProblem["field"]) =>
    problem?.field === field
      ? { "aria-invalid": true, "aria-describedby": problemId }
      : {};
  return (
    <span
      className="flex min-w-0 flex-col gap-1"
      onBlur={event => {
        // Moving between the editor's own fields keeps it open.
        if (event.currentTarget.contains(event.relatedTarget)) return;
        const found = check?.(text, unitText) ?? null;
        if (!found) {
          finish(true, false);
          return;
        }
        // Not dropped without a word: it says why, as Enter does, and the
        // focus stays where the owner put it.
        setProblem(found);
      }}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <input
          ref={valueField}
          autoFocus
          aria-label={typeof label === "function" ? label(unitText) : label}
          value={text}
          inputMode={inputMode}
          maxLength={maxLength}
          dir={dir}
          enterKeyHint="done"
          {...fault("value")}
          {...selectValue}
          onChange={event => {
            setText(event.target.value);
            if (problem?.field === "value") setProblem(null);
          }}
          onKeyDown={onKeyDown}
          className={cn(
            FIELD_CLASS,
            "w-full",
            unit ? "-ml-1.5" : "-mx-1.5",
            className
          )}
        />
        {unit ? (
          <input
            ref={unitField}
            aria-label={unit.label}
            value={unitText}
            maxLength={unit.maxLength}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="done"
            {...fault("unit")}
            {...selectUnit}
            onBeforeInput={event => {
              // A full code takes no more letters, so one typed with a
              // caret in it, as a second tap leaves, starts it anew.
              const field = event.currentTarget;
              if (
                !event.data ||
                field.value.length < unit.maxLength ||
                field.selectionStart !== field.selectionEnd
              )
                return;
              event.preventDefault();
              setUnitText(event.data.toUpperCase().slice(0, unit.maxLength));
              if (problem?.field === "unit") setProblem(null);
            }}
            onChange={event => {
              const typed = event.target.value;
              // In capitals as typed; a letter still being composed is left
              // as it is, or some phone keyboards type it twice.
              setUnitText(composing(event) ? typed : typed.toUpperCase());
              if (problem?.field === "unit") setProblem(null);
            }}
            onCompositionEnd={event =>
              setUnitText(event.currentTarget.value.toUpperCase())
            }
            onKeyDown={onKeyDown}
            // Wide enough for the widest codes, such as MWK, in the price's
            // own type.
            className={cn(FIELD_CLASS, "w-[4.75ch] flex-none", className)}
          />
        ) : null}
      </span>
      {problem ? (
        <span
          id={problemId}
          role="alert"
          className="text-[13px] leading-snug text-(--p-danger-ink)"
        >
          {problem.message}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A field fixed in place: whether it's open, and whether its opener takes
 * the focus back when it comes back, as it does once the keyboard closed
 * the field.
 */
function useEditing() {
  const [editing, setEditing] = useState(false);
  const [refocus, setRefocus] = useState(false);
  return {
    editing,
    refocus,
    open: () => {
      setRefocus(false);
      setEditing(true);
    },
    close: (fromKeyboard: boolean) => {
      setRefocus(fromKeyboard);
      setEditing(false);
    },
  };
}

// Geologica, the review's name size.
const NAME_CLASS =
  "font-(family-name:--p-font-display) text-[24px] leading-[30px] font-semibold tracking-[-0.012em]";
// A text button's quiet hover, and airi's focus ring.
const TEXT_BUTTON =
  "rounded-md text-left transition-colors outline-none hover:bg-(--p-sunk) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid";

function EditableName({
  name,
  onSave,
}: {
  name: string;
  onSave?: (name: string) => void;
}) {
  const field = useEditing();
  // Names read in their own direction, a name written right to left too.
  if (!onSave)
    return (
      <p dir="auto" className={cn("line-clamp-2", NAME_CLASS)}>
        {name}
      </p>
    );
  if (field.editing) {
    return (
      <InlineEdit
        value={name}
        label={COPY.changeName}
        maxLength={MAX_PRODUCT_NAME_LENGTH}
        dir="auto"
        className={NAME_CLASS}
        onDone={(value, fromKeyboard) => {
          field.close(fromKeyboard);
          const next = value?.trim();
          if (next && next !== name) onSave(next);
        }}
      />
    );
  }
  return (
    <button
      autoFocus={field.refocus}
      type="button"
      title={COPY.changeName}
      onClick={field.open}
      className={cn(
        "-mx-1.5 flex max-w-full items-center gap-2 self-start px-1.5",
        TEXT_BUTTON,
        NAME_CLASS
      )}
    >
      <span className="sr-only">{COPY.changeName}: </span>
      <span dir="auto" className="line-clamp-2 min-w-0 break-words">
        {name}
      </span>
      {/* A pencil hint: the name is the owner's to change. */}
      <Pencil
        aria-hidden="true"
        strokeWidth={1.75}
        className="size-[15px] shrink-0 text-(--p-ink-3)"
      />
    </button>
  );
}

// Geologica, tabular, drawn by code from the shelf's numbers.
const PRICE_CLASS =
  "font-(family-name:--p-font-display) font-semibold tracking-[-0.02em] tabular-nums";
// 44px (32 on a phone); a long price a step smaller, so it fits the card.
const PRICE_SIZE = {
  short: "text-[32px] leading-[38px] sm:text-[44px] sm:leading-[48px]",
  long: "text-[26px] leading-[32px] sm:text-[32px] sm:leading-[38px]",
  longest: "text-[22px] leading-[28px] sm:text-[26px] sm:leading-[32px]",
} as const;

// Priced in thousandths, the most decimals any currency has: an amount it
// reads but the chosen currency doesn't has more decimals than that one.
const MOST_DECIMALS_CURRENCY = "KWD";

/**
 * Whether a typed amount is a number, in the chosen currency or not: read
 * in the one with the most decimals, with any more decimals cut off, so
 * "4.9999" reads as 4.999. Only digits after a decimal point used once are
 * cut: "1.234.5678" is no number. Money signs go before NFKC, as they do
 * when the price is read.
 */
function isTypedNumber(text: string): boolean {
  const typed = text
    .replace(/[\p{Sc}円元圓]/gu, "")
    .normalize("NFKC")
    .trim();
  const decimal = /^(.*)([.,٫])(\p{Nd}+)$/u.exec(typed);
  let cut = typed;
  if (decimal && !decimal[1]!.includes(decimal[2]!)) {
    const most = productPriceDecimals(MOST_DECIMALS_CURRENCY);
    cut = decimal[1]! + decimal[2]! + [...decimal[3]!].slice(0, most).join("");
  }
  return parseTypedPrice(cut, MOST_DECIMALS_CURRENCY) !== "invalid";
}

/** A code field's text as the 3-letter code it looks like ("RUR"), or null. */
function threeLetters(unit: string): string | null {
  const letters = unit.normalize("NFKC").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(letters) ? letters : null;
}

/**
 * The price the owner set with its currency's code, or what's wrong with
 * it, said the way that currency writes prices. An empty amount takes the
 * price away; any other needs a known code. `stored` is the price that an
 * amount still as the editor opened stands for: it's only checked against
 * the code, never read again, as "1.255" KWD read in USD would be 1255.
 */
function typedPrice(
  text: string,
  unit: string,
  stored?: number | null
): { changes: ProductChanges } | { problem: EditProblem } {
  const currency = productCurrency(unit);
  const price = stored !== undefined ? stored : parseTypedPrice(text, currency);
  if (price === null) return { changes: { price: null } };
  const isNumber = price !== "invalid" || isTypedNumber(text);
  const decimals = productPriceDecimals(currency);
  if (!isNumber)
    return {
      problem: { message: COPY.priceInvalid(decimals), field: "value" },
    };
  if (!currency) {
    const letters = threeLetters(unit);
    return {
      problem: {
        message: letters ? COPY.currencyUnknown(letters) : COPY.currencyInvalid,
        field: "unit",
      },
    };
  }
  if (price === "invalid" || !hasAtMostDecimals(price, decimals))
    return {
      problem: {
        message: COPY.tooManyDecimals(currency, decimals),
        field: "value",
      },
    };
  return { changes: { price, currency } };
}

function EditablePrice({
  field,
  price,
  currency,
  defaultCurrency,
  from,
  unsure,
  onSave,
}: {
  /** Whether its editor is open: the card's, as the doubt's button opens it too. */
  field: ReturnType<typeof useEditing>;
  price: number | null;
  currency: string | null;
  /** The currency a price without one is typed in at first. */
  defaultCurrency: string | null;
  from: boolean;
  unsure: boolean;
  onSave?: (changes: ProductChanges) => void;
}) {
  const code = productCurrency(currency);
  const size =
    PRICE_SIZE[
      productPriceLength(
        price === null
          ? COPY.noPrice
          : formatProductPrice(price, { from, currency })
      )
    ];
  const shown =
    price === null ? (
      COPY.noPrice
    ) : (
      <PriceText price={price} currency={currency} from={from} />
    );
  const tone = unsure ? "text-(--p-danger-ink)" : undefined;
  if (!onSave)
    return <p className={cn("mt-0.5", PRICE_CLASS, size, tone)}>{shown}</p>;
  if (field.editing) {
    // The amount as the editor opens. Left as it is, it stands for the
    // stored price, whatever code is typed beside it.
    const prefill = price === null ? "" : String(price);
    const changesFrom = (text: string, unit: string) =>
      typedPrice(text, unit, text === prefill ? price : undefined);
    return (
      <InlineEdit
        value={prefill}
        label={unit => COPY.priceIn(productCurrency(unit))}
        inputMode="decimal"
        className={cn(PRICE_CLASS, PRICE_SIZE.short)}
        unit={{
          value: code ?? productCurrency(defaultCurrency) ?? "",
          label: COPY.currencyCode,
          maxLength: 3,
        }}
        check={(text, unit) => {
          const typed = changesFrom(text, unit);
          return "problem" in typed ? typed.problem : null;
        }}
        onDone={(text, fromKeyboard, unit) => {
          field.close(fromKeyboard);
          if (text === null) return;
          const typed = changesFrom(text, unit);
          // Saved even when unchanged: setting the price confirms it.
          if ("changes" in typed) onSave(typed.changes);
        }}
      />
    );
  }
  return (
    <button
      autoFocus={field.refocus}
      type="button"
      title={COPY.changePrice}
      onClick={field.open}
      className={cn(
        "-mx-1.5 mt-0.5 max-w-full self-start px-1.5",
        TEXT_BUTTON,
        PRICE_CLASS,
        size,
        tone
      )}
    >
      <span className="sr-only">{COPY.changePrice}: </span>
      {shown}
    </button>
  );
}

/** The product's options, to choose the one the shelf shows. */
function OptionPicker({
  product,
  onPick,
}: {
  product: DraftProductRecord;
  onPick: (index: number) => void;
}) {
  return (
    <div className="mt-3">
      <p className="text-xs leading-4 text-(--p-ink-2)">{COPY.chooseShown}</p>
      <div className="mt-1.5 flex gap-2 overflow-x-auto p-1">
        {product.options.map((option, index) => {
          const chosen = index === product.featuredOption;
          return (
            <button
              key={index}
              type="button"
              aria-pressed={chosen}
              aria-label={COPY.showOption(option.description)}
              title={option.description}
              onClick={() => {
                if (!chosen) onPick(index);
              }}
              // The chosen one in a pencil line, never black.
              className={styles.option}
            >
              {option.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={option.imageUrl} alt="" draggable={false} />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Once every product is checked: a strip saying what went on the shelf, then
 * what to make with it (the carousel and order form, or a video ad).
 */
function ReviewDone({
  workspaceId,
  importId,
  products,
  canUndo,
  onUndo,
  onClose,
  onChangeProducts,
  onMakeAd,
}: {
  workspaceId: string;
  importId: string;
  products: DraftProductRecord[];
  canUndo: boolean;
  onUndo: () => void;
  onClose: () => void;
  onChangeProducts: (productIds: string[]) => void;
  onMakeAd: (productIds: string[]) => void;
}) {
  const added = products.filter(product => product.status === "published");
  const skipped = products.filter(
    product => product.status === "rejected"
  ).length;
  return (
    <div className="flex flex-col gap-10">
      <div
        className={cn(
          theme.tile,
          "flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 py-3.5"
        )}
      >
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-(--p-ok) text-white"
        >
          <Check className="size-[17px]" strokeWidth={3} />
        </span>
        <p
          role="status"
          className="min-w-0 flex-1 text-[15px] leading-[22px] text-pretty"
        >
          <b className="font-semibold">
            {products.length === 0 ? COPY.nothingLeft : COPY.done(added.length)}
          </b>
          {skipped > 0 ? (
            <>
              {" "}
              <span className="text-(--p-ink-2)">
                {COPY.skippedCount(skipped)}
              </span>
            </>
          ) : null}
        </p>
        <div className="flex gap-1.5 max-sm:grid max-sm:w-full max-sm:grid-cols-[1fr_auto]">
          <Button variant="outline" onClick={onClose} autoFocus>
            {COPY.backToProducts}
          </Button>
          {canUndo ? (
            <Button variant="ghost" onClick={onUndo}>
              <Undo2 aria-hidden="true" />
              {COPY.undo}
            </Button>
          ) : null}
        </div>
      </div>
      {added.length > 0 ? (
        <MakeOutputs
          workspaceId={workspaceId}
          importId={importId}
          productIds={added.map(product => product.id)}
          onChangeProducts={onChangeProducts}
          onMakeAd={onMakeAd}
        />
      ) : null}
    </div>
  );
}
