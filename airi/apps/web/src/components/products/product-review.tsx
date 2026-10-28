"use client";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  formatProductPrice,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PRODUCT_PRICE,
  type DraftProductRecord,
  type ProductChanges,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  CircleAlert,
  Info,
  Play,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { NameInitial } from "./product-shelf";
import { WhatsAppDrafts } from "./product-whatsapp-drafts";
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
const FLY_MS = 280;

type Direction = "left" | "right";
type Flight = {
  key: string;
  product: DraftProductRecord;
  direction: Direction;
  fromX: number;
};

const directionOf = (to: ReviewMove["to"]): Direction =>
  to === "published" ? "right" : "left";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** A card dragged `x` px to the side, tilting as it goes. */
const dragTransform = (x: number) =>
  `translateX(${x}px) rotate(${Math.max(-18, Math.min(18, x * 0.08))}deg)`;

/** Off the side of the stack, as a card leaves or comes back. */
const awayTransform = (direction: Direction, width: number) =>
  `translateX(${direction === "right" ? "" : "-"}${Math.round(width * 1.4)}px) rotate(${direction === "right" ? 24 : -24}deg)`;

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
}: {
  workspaceId: string;
  importId: string;
  onClose: () => void;
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
  const root = useRef<HTMLDivElement>(null);

  // The review takes the keyboard's focus, so its keys work at once.
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  const decideTop = (to: ReviewMove["to"], fromX = 0) => {
    if (!top) return;
    setDragX(0);
    setReturning(null);
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
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable='true']"))
      return;
    const command = event.ctrlKey || event.metaKey;
    if (
      (event.key === "Backspace" && !command) ||
      (command && !event.shiftKey && event.key.toLowerCase() === "z")
    ) {
      event.preventDefault();
      undo();
      return;
    }
    if (command || event.altKey || event.shiftKey) return;
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
          <div className="absolute inset-0 animate-pulse rounded-[28px] bg-foreground/[0.06]" />
        </div>
      </div>
    );
  } else if (review.loadFailed) {
    content = (
      <div className="flex flex-col items-center gap-3 pt-16 text-center">
        <p role="alert" className="text-[15px] font-medium">
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
                  className="pointer-events-none absolute inset-0 transition-transform duration-150 ease-out"
                  style={{
                    transform: `translateY(${depth * 14}px) scale(${1 - depth * 0.05})`,
                    opacity: index === 0 ? 1 : 0.6,
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
            onDrag={setDragX}
            onSwipe={(direction, fromX) =>
              decideTop(direction === "right" ? "published" : "rejected", fromX)
            }
          >
            <ReviewCard
              product={top}
              soundOn={soundOn}
              dragX={dragX}
              onEdit={changes => review.edit(top.id, changes)}
            />
          </SwipeCard>
        </div>
        <div className="mt-7 flex items-center justify-center gap-6">
          <RoundButton
            label={COPY.skip}
            hint="←"
            onClick={() => decideTop("rejected")}
            className="size-16 text-destructive"
          >
            <X className="size-7" strokeWidth={2.5} aria-hidden="true" />
          </RoundButton>
          <RoundButton
            label={COPY.undo}
            hint="Backspace"
            onClick={undo}
            disabled={!lastMove}
            className="size-11 text-muted-foreground"
          >
            <Undo2 className="size-5" aria-hidden="true" />
          </RoundButton>
          <RoundButton
            label={COPY.add}
            hint="→"
            onClick={() => decideTop("published")}
            className="size-16 border-transparent bg-emerald-500 text-white shadow-emerald-500/30 hover:bg-emerald-500"
          >
            <Check className="size-7" strokeWidth={3} aria-hidden="true" />
          </RoundButton>
        </div>
        <p className="mt-5 hidden items-center justify-center gap-5 text-xs text-muted-foreground pointer-fine:flex">
          <span className="flex items-center gap-1.5">
            <Kbd>←</Kbd> {COPY.skip}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Backspace</Kbd> {COPY.undo}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>→</Kbd> {COPY.add}
          </span>
        </p>
      </>
    );
  }

  return (
    <div
      ref={root}
      tabIndex={-1}
      aria-labelledby="product-review-title"
      className="mx-auto flex w-full max-w-md flex-col outline-none"
    >
      <h2 id="product-review-title" className="sr-only">
        {COPY.title}
      </h2>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onClose}>
          <ArrowLeft aria-hidden="true" />
          {COPY.back}
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
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
          {queue.length > 0 ? (
            <Button variant="outline" size="sm" onClick={acceptAll}>
              <CheckCheck aria-hidden="true" />
              {COPY.acceptAll(queue.length)}
            </Button>
          ) : null}
        </div>
      </div>
      {products.length > 0 ? <ReviewProgress products={products} /> : null}
      <div className="relative mt-6">
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
        <p role="alert" className="mt-4 text-center text-sm text-destructive">
          {COPY.saveFailed}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

// Tall enough for a photo and the product's details, within a phone's screen.
const STACK = "relative h-[min(34rem,calc(100svh-17rem))] min-h-[26rem] w-full";

/** One mark per product, filled as each is added (green) or skipped. */
function ReviewProgress({ products }: { products: DraftProductRecord[] }) {
  return (
    <div aria-hidden="true" className="mt-3 flex gap-1">
      {products.map(product => (
        <span
          key={product.id}
          className={cn(
            "h-1 min-w-0 flex-1 rounded-full transition-colors duration-300",
            product.status === "published"
              ? "bg-emerald-500"
              : product.status === "rejected"
                ? "bg-foreground/35"
                : "bg-foreground/10"
          )}
        />
      ))}
    </div>
  );
}

function RoundButton({
  label,
  hint,
  onClick,
  disabled = false,
  className,
  children,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} (${hint})`}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid shrink-0 place-items-center rounded-full border border-foreground/10 bg-card shadow-lg shadow-black/[0.06] transition-transform outline-none hover:scale-105 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-95 disabled:pointer-events-none disabled:opacity-40",
        className
      )}
    >
      {children}
    </button>
  );
}

/**
 * The top card, which follows a drag and leaves once dragged far enough or
 * flicked; let go sooner, it settles back. A tap on its buttons stays a tap.
 */
function SwipeCard({
  returningFrom,
  onDrag,
  onSwipe,
  children,
}: {
  returningFrom: Direction | null;
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
      { duration: FLY_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
    );
    return () => animation?.cancel();
  }, [returningFrom]);

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
  onEdit,
}: {
  product: DraftProductRecord;
  still?: boolean;
  soundOn?: boolean;
  dragX?: number;
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

  return (
    <article
      aria-label={still ? undefined : product.name}
      className="flex size-full flex-col overflow-hidden rounded-[28px] border border-foreground/10 bg-card text-card-foreground shadow-[0_24px_60px_-30px_rgba(0,0,0,0.45)]"
    >
      <div className="relative min-h-0 flex-1 bg-linear-to-b from-foreground/[0.02] to-foreground/[0.08]">
        <CardPhoto
          key={shown ?? "none"}
          url={shown}
          original={showOriginal}
          name={product.name}
        />
        {edit && polished && original ? (
          <PhotoToggle view={view} onChange={setView} />
        ) : null}
        {!still && product.clipUrl ? (
          <VoiceClip url={product.clipUrl} soundOn={soundOn} />
        ) : null}
        {dragX !== 0 ? <Stamp dragX={dragX} /> : null}
      </div>
      <div className="flex max-h-[58%] shrink-0 flex-col overflow-y-auto px-5 pt-4 pb-5">
        <EditableName
          name={product.name}
          onSave={edit && (name => edit({ name }))}
        />
        <EditablePrice
          price={product.price}
          from={product.priceIsFrom}
          unsure={priceDoubts.length > 0 || product.price === null}
          onSave={edit && (price => edit({ price }))}
        />
        {product.doubts.length > 0 ? (
          <ul className="mt-1.5 flex flex-col gap-1">
            {[...priceDoubts, ...otherDoubts].map((doubt, index) => (
              <li
                key={index}
                className="flex gap-1.5 text-[13px] leading-snug text-destructive"
              >
                <CircleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                />
                {doubt.text}
              </li>
            ))}
          </ul>
        ) : null}
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
                className="flex gap-1.5 text-[13px] leading-snug text-muted-foreground"
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

/** The cut-out standing on the card's floor, or the photo as filmed. */
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
      // Signed storage URLs; next/image would need every bucket host configured.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className="absolute inset-0 size-full object-contain p-4 select-none"
      />
    );
  }
  return (
    <div className="absolute inset-0 flex items-end justify-center px-8 pt-12 pb-8">
      <div className="relative flex h-full max-w-full items-end justify-center">
        <span
          aria-hidden="true"
          className="absolute inset-x-[12%] bottom-0 h-4 translate-y-1/2 rounded-[50%] bg-black/25 blur-md dark:bg-black/70"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className="relative max-h-full max-w-full object-contain select-none"
        />
      </div>
    </div>
  );
}

function PhotoToggle({
  view,
  onChange,
}: {
  view: "polished" | "original";
  onChange: (view: "polished" | "original") => void;
}) {
  return (
    <div
      role="group"
      aria-label={COPY.photo}
      className="absolute top-3 right-3 flex rounded-full bg-background/85 p-0.5 text-xs font-medium shadow-sm backdrop-blur"
    >
      {(["polished", "original"] as const).map(value => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={cn(
            "rounded-full px-2.5 py-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            view === value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {COPY[value]}
        </button>
      ))}
    </div>
  );
}

// The clip's ring: r = 38 in an 80 × 80 box.
const RING = 2 * Math.PI * 38;

/**
 * The owner saying the price, as a round video in the corner of the card,
 * the way chat apps show video messages. It plays as the card comes up,
 * with sound when the owner has it on; a browser that wants a tap first
 * plays it silently, marked, until tapped.
 */
function VoiceClip({ url, soundOn }: { url: string; soundOn: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const ring = useRef<SVGCircleElement>(null);
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

  useEffect(() => {
    if (state !== "playing" && state !== "silent") return;
    let frame = 0;
    const tick = () => {
      const element = video.current;
      if (element && ring.current && element.duration > 0)
        ring.current.style.strokeDashoffset = String(
          RING * (1 - element.currentTime / element.duration)
        );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state]);

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
      className="absolute bottom-3 left-3 size-[76px] rounded-full bg-black shadow-lg ring-4 ring-card outline-none focus-visible:ring-ring/60"
    >
      <video
        ref={video}
        src={url}
        playsInline
        preload="auto"
        aria-hidden="true"
        onEnded={() => setState("ended")}
        className="size-full rounded-full object-cover"
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 80 80"
        className="absolute inset-0 size-full -rotate-90"
      >
        <circle
          cx="40"
          cy="40"
          r="38"
          fill="none"
          stroke="white"
          strokeOpacity="0.3"
          strokeWidth="3"
        />
        <circle
          ref={ring}
          cx="40"
          cy="40"
          r="38"
          fill="none"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={RING}
          strokeDashoffset={state === "ended" ? 0 : RING}
        />
      </svg>
      {state === "silent" ? (
        <span className="absolute right-0 bottom-0 grid size-6 place-items-center rounded-full bg-background text-foreground shadow">
          <VolumeX aria-hidden="true" className="size-3.5" />
        </span>
      ) : state === "idle" || state === "ended" ? (
        <span className="absolute inset-0 grid place-items-center rounded-full bg-black/30 text-white">
          <Play aria-hidden="true" className="size-6 fill-current" />
        </span>
      ) : null}
    </button>
  );
}

/** "Add" or "Skip", stamped on the card as it's dragged that way. */
function Stamp({ dragX }: { dragX: number }) {
  const add = dragX > 0;
  return (
    <span
      aria-hidden="true"
      style={{ opacity: Math.min(1, Math.abs(dragX) / FULL_DRAG_PX) }}
      className={cn(
        "absolute top-6 rounded-xl border-[3px] bg-card/70 px-3 py-0.5 text-2xl font-bold tracking-tight backdrop-blur-sm",
        add
          ? "left-5 -rotate-12 border-emerald-500 text-emerald-600"
          : "right-5 rotate-12 border-destructive text-destructive"
      )}
    >
      {add ? COPY.stampAdd : COPY.stampSkip}
    </span>
  );
}

/**
 * A field the owner fixes in place: Enter or leaving it saves, Escape
 * cancels. Saved or cancelled from the keyboard, the focus goes back to
 * what opened it.
 */
function InlineEdit({
  value,
  label,
  inputMode,
  maxLength,
  className,
  suffix = null,
  onDone,
}: {
  value: string;
  label: string;
  inputMode?: "numeric" | "text";
  maxLength?: number;
  className: string;
  suffix?: ReactNode;
  onDone: (value: string | null, fromKeyboard: boolean) => void;
}) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (save: boolean, fromKeyboard: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? text : null, fromKeyboard);
  };
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <input
        autoFocus
        aria-label={label}
        value={text}
        inputMode={inputMode}
        maxLength={maxLength}
        enterKeyHint="done"
        onFocus={event => event.currentTarget.select()}
        onChange={event => setText(event.target.value)}
        onBlur={() => finish(true, false)}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true, true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(false, true);
          }
        }}
        className={cn(
          "-mx-1.5 w-full min-w-0 rounded-md bg-foreground/[0.05] px-1.5 ring-2 ring-ring/40 outline-none",
          className
        )}
      />
      {suffix}
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

const NAME_CLASS = "text-[19px] leading-snug font-semibold";

function EditableName({
  name,
  onSave,
}: {
  name: string;
  onSave?: (name: string) => void;
}) {
  const field = useEditing();
  if (!onSave) return <p className={cn("line-clamp-2", NAME_CLASS)}>{name}</p>;
  if (field.editing) {
    return (
      <InlineEdit
        value={name}
        label={COPY.changeName}
        maxLength={MAX_PRODUCT_NAME_LENGTH}
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
        "-mx-1.5 self-start rounded-md px-1.5 text-left transition-colors outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50",
        NAME_CLASS
      )}
    >
      <span className="sr-only">{COPY.changeName}: </span>
      <span className="line-clamp-2 break-words">{name}</span>
    </button>
  );
}

const PRICE_CLASS =
  "text-[28px] leading-tight font-semibold tracking-tight tabular-nums";

/** A price as typed: spaces and separators are ignored; null when empty, undefined when it isn't one. */
function parsePrice(text: string): number | null | undefined {
  const digits = text.replace(/[\s.,'₸]/g, "");
  if (!digits) return null;
  if (!/^\d+$/.test(digits)) return undefined;
  const price = Number(digits);
  return price <= MAX_PRODUCT_PRICE ? price : undefined;
}

function EditablePrice({
  price,
  from,
  unsure,
  onSave,
}: {
  price: number | null;
  from: boolean;
  unsure: boolean;
  onSave?: (price: number | null) => void;
}) {
  const field = useEditing();
  const shown =
    price === null ? COPY.noPrice : formatProductPrice(price, { from });
  const tone = unsure ? "text-destructive" : undefined;
  if (!onSave) return <p className={cn(PRICE_CLASS, tone)}>{shown}</p>;
  if (field.editing) {
    return (
      <InlineEdit
        value={price === null ? "" : String(price)}
        label={COPY.priceInTenge}
        inputMode="numeric"
        className={PRICE_CLASS}
        suffix={<span className={PRICE_CLASS}>₸</span>}
        onDone={(value, fromKeyboard) => {
          field.close(fromKeyboard);
          if (value === null) return;
          const next = parsePrice(value);
          // Saved even when unchanged: setting the price confirms it.
          if (next !== undefined) onSave(next);
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
        "-mx-1.5 self-start rounded-md px-1.5 text-left transition-colors outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50",
        PRICE_CLASS,
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
      <p className="text-xs text-muted-foreground">{COPY.chooseShown}</p>
      <div className="mt-1.5 flex gap-2 overflow-x-auto p-0.5 pb-1">
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
              className={cn(
                "relative size-12 shrink-0 overflow-hidden rounded-lg bg-foreground/[0.05] transition outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                chosen
                  ? "ring-2 ring-foreground"
                  : "opacity-70 hover:opacity-100"
              )}
            >
              {option.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={option.imageUrl}
                  alt=""
                  draggable={false}
                  className="size-full object-contain p-1"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Once every product is checked: what went on the shelf, and what to make of it on WhatsApp. */
function ReviewDone({
  workspaceId,
  importId,
  products,
  canUndo,
  onUndo,
  onClose,
}: {
  workspaceId: string;
  importId: string;
  products: DraftProductRecord[];
  canUndo: boolean;
  onUndo: () => void;
  onClose: () => void;
}) {
  const added = products.filter(product => product.status === "published");
  const skipped = products.filter(
    product => product.status === "rejected"
  ).length;
  return (
    <div className="flex flex-col items-center pt-10 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 motion-safe:animate-in motion-safe:zoom-in-50">
        <Check aria-hidden="true" className="size-7" strokeWidth={3} />
      </span>
      <p role="status" className="mt-5 text-lg font-semibold text-balance">
        {products.length === 0 ? COPY.nothingLeft : COPY.done(added.length)}
      </p>
      {skipped > 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {COPY.skippedCount(skipped)}
        </p>
      ) : null}
      <div className="mt-8 flex gap-2">
        <Button onClick={onClose} autoFocus>
          {COPY.backToProducts}
        </Button>
        {canUndo ? (
          <Button variant="ghost" onClick={onUndo}>
            <Undo2 aria-hidden="true" />
            {COPY.undo}
          </Button>
        ) : null}
      </div>
      {added.length > 0 ? (
        <div className="mt-12 w-full">
          <WhatsAppDrafts
            workspaceId={workspaceId}
            importId={importId}
            added={added}
          />
        </div>
      ) : null}
    </div>
  );
}
