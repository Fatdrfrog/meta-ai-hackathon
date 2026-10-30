"use client";

import { Progress } from "@/components/ui/progress";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { formatProductPrice } from "@/lib/products/types";
import { cn } from "@/lib/utils";
import {
  AudioLines,
  CircleAlert,
  Film,
  ListChecks,
  ScanSearch,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useReducedMotion } from "./product-motion";
import { initialOf, NameInitial } from "./product-shelf";
import {
  auraColors,
  formatElapsed,
  latestMade,
  madeKeys,
  newestLanded,
  photoTrail,
  type ImportPhase,
  type StagePhoto,
} from "./product-stage-model";
import styles from "./product-stage.module.css";

const COPY = PRODUCTS_COPY.stage;

// How long each photo being made holds the front of the deck when several are.
const SPOTLIGHT_TURN_MS = 5000;
// How long one picture on the stage hands over to the next.
const CROSSFADE_MS = 400;
// The products that stand together once an import is ready.
const POSTER_MAX = 6;
// On a phone, the poster's host and the first few products.
const POSTER_MAX_SMALL = 3;
// As many photos fan out on the stage as the job makes at once.
const DECK_MAX = 4;

export type StagePhase = ImportPhase | "uploading";

const RUNNING: ReadonlySet<StagePhase> = new Set<StagePhase>([
  "uploading",
  "queued",
  "preparing",
  "resuming",
  "listening",
  "watching",
  "cutting",
]);

// An import's steps before it has any picture: the aurora carries the stage.
const UNLIT: ReadonlySet<StagePhase> = new Set<StagePhase>([
  "queued",
  "preparing",
  "listening",
  "watching",
]);

const GLYPHS: Record<StagePhase, LucideIcon> = {
  uploading: Film,
  queued: Film,
  preparing: Film,
  resuming: Film,
  listening: AudioLines,
  watching: ScanSearch,
  cutting: Sparkles,
  ready: ListChecks,
  nothing: Film,
  failed: CircleAlert,
};

const NO_PHOTOS: readonly StagePhoto[] = [];

/**
 * The newest photo made while the stage was on screen. Photos made before
 * it first saw the import's products never count, so a reload doesn't
 * replay them.
 */
function useLanded(photos: readonly StagePhoto[] | null): StagePhoto | null {
  const made = photos ? madeKeys(photos) : null;
  const [seen, setSeen] = useState<{
    made: string | null;
    landed: string | null;
  }>({ made, landed: null });
  if (photos && made !== null && made !== seen.made) {
    const landed =
      seen.made === null
        ? null
        : newestLanded(new Set(seen.made.split("\n")), photos);
    setSeen({ made, landed: landed?.key ?? seen.landed });
  }
  return (
    photos?.find(
      photo =>
        photo.key === seen.landed && photo.state === "made" && photo.imageUrl
    ) ?? null
  );
}

/** Counts up every few seconds while `count` things take turns. */
function useTurn(count: number, active: boolean): number {
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (!active || count < 2) return;
    const timer = setInterval(
      () => setTurn(value => value + 1),
      SPOTLIGHT_TURN_MS
    );
    return () => clearInterval(timer);
  }, [count, active]);
  return turn;
}

// A clock that ticks once a second while a stage shows how long it's taken.
const clock = {
  now: 0,
  timer: null as ReturnType<typeof setInterval> | null,
  listeners: new Set<() => void>(),
};
function subscribeClock(listener: () => void) {
  clock.listeners.add(listener);
  if (!clock.timer) {
    clock.now = Date.now();
    clock.timer = setInterval(() => {
      clock.now = Date.now();
      for (const notify of clock.listeners) notify();
    }, 1000);
  }
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0 && clock.timer) {
      clearInterval(clock.timer);
      clock.timer = null;
    }
  };
}
const NO_CLOCK = () => () => undefined;

/** The seconds since `from`, while `active`; null on the server. */
function useElapsed(from: string | null, active: boolean): number | null {
  const now = useSyncExternalStore(
    active && from ? subscribeClock : NO_CLOCK,
    () => clock.now,
    () => 0
  );
  const start = from ? Date.parse(from) : Number.NaN;
  if (!active || now === 0 || !Number.isFinite(start)) return null;
  return Math.max(0, (now - start) / 1000);
}

/** What stands on the stage: the phone it was filmed on, a scene, or the poster. */
type Subject =
  | { kind: "phone"; id: "phone" }
  | {
      kind: "poster";
      id: "poster";
      cast: readonly StagePhoto[];
      host: string | null;
    }
  | {
      kind: "scene";
      id: string;
      /** A made photo: the one that just landed, or the latest. */
      spot: StagePhoto | null;
      /** The photos being made, fanned out beside or instead of it. */
      deck: readonly StagePhoto[];
      turn: number;
      /** The spot landed just now, and lifts off its filmed crop. */
      landing: boolean;
    };

function pickSubject(
  list: readonly StagePhoto[],
  {
    phase,
    landed,
    presenter,
    turn,
  }: {
    phase: StagePhase;
    landed: StagePhoto | null;
    presenter: string | null;
    turn: number;
  }
): Subject {
  const running = RUNNING.has(phase);
  // Once ready, its products stand together, with whoever presented them.
  if (phase === "ready") {
    const cast = list
      .filter(
        photo =>
          photo.featured &&
          photo.state === "made" &&
          photo.imageUrl &&
          photo.method !== "none"
      )
      .slice(0, POSTER_MAX);
    if (cast.length >= 2 || (presenter !== null && cast.length > 0))
      return { kind: "poster", id: "poster", cast, host: presenter };
  }
  const deck = running
    ? list.filter(photo => photo.state === "making").slice(0, DECK_MAX)
    : [];
  // A photo made while the stage was on screen lifts off and stays until the
  // next; before one does, the photos being made fill the stage.
  const spot = landed ?? (deck.length > 0 ? null : latestMade(list));
  if (!spot && deck.length === 0) return { kind: "phone", id: "phone" };
  return {
    kind: "scene",
    id: spot ? `spot:${spot.key}` : "deck",
    spot,
    deck,
    turn,
    landing: spot !== null && spot.key === landed?.key && phase !== "failed",
  };
}

/**
 * What the stage showed before its subject changed, kept a moment so the
 * two cross-fade: it never shows an empty frame in between.
 */
function useOutgoing(subject: Subject, reduced: boolean): Subject | null {
  const [shown, setShown] = useState<{
    current: Subject;
    out: Subject | null;
  }>({ current: subject, out: null });
  if (shown.current !== subject)
    setShown({
      current: subject,
      out:
        shown.current.id !== subject.id && !reduced ? shown.current : shown.out,
    });
  useEffect(() => {
    if (!shown.out) return;
    const timer = setTimeout(
      () => setShown(state => ({ ...state, out: null })),
      CROSSFADE_MS
    );
    return () => clearTimeout(timer);
  }, [shown.out]);
  return shown.out?.id === subject.id ? null : shown.out;
}

const titleOf = (photo: StagePhoto) =>
  photo.price === null
    ? photo.name
    : COPY.withPrice(
        photo.name,
        formatProductPrice(photo.price, { from: photo.priceIsFrom })
      );

/**
 * A video's way to products, played on a dark stage: the owner's own video
 * while it uploads, the models' steps while the import reads it, then each
 * photo lifting off the frame it was filmed in. It only ever shows what's
 * real; until there is a picture, an aurora in airi's colours stands in.
 * Where it's wide enough, the words take the left column and what's being
 * made the right; on a phone they stack.
 */
export function CreationStage({
  mode,
  phase,
  label,
  labelId,
  helper = null,
  alert = false,
  percent,
  fill = null,
  preview,
  photos,
  presenter = null,
  startedAt = null,
  actions = null,
}: {
  mode: "upload" | "import";
  phase: StagePhase;
  label: string;
  labelId?: string;
  helper?: string | null;
  alert?: boolean;
  /** How far it has got, for the line along the bottom; null hides it. */
  percent: number | null;
  /** The share of the video sent, rising up the phone while it uploads. */
  fill?: number | null;
  /** The local video, when it was uploaded from this page. */
  preview: string | null;
  /** The import's photos, or null before its products load. */
  photos: readonly StagePhoto[] | null;
  /** The person who presented the products, cut out. */
  presenter?: string | null;
  /** When the import was created, for the time it has taken so far. */
  startedAt?: string | null;
  actions?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const still = phase === "failed";
  const running = RUNNING.has(phase);
  const list = photos ?? NO_PHOTOS;
  const landed = useLanded(photos);
  const makingCount = Math.min(
    DECK_MAX,
    list.filter(photo => photo.state === "making").length
  );
  const turn = useTurn(makingCount, running && !reduced);
  const subject = useMemo(
    () => pickSubject(list, { phase, landed, presenter, turn }),
    [list, phase, landed, presenter, turn]
  );
  const outgoing = useOutgoing(subject, reduced);
  const elapsed = useElapsed(
    startedAt,
    mode === "import" && running && phase !== "uploading"
  );
  const [brokenVideo, setBrokenVideo] = useState<string | null>(null);
  const video = preview && preview !== brokenVideo ? preview : null;

  const scene = subject.kind === "scene" ? subject : null;
  const poster = subject.kind === "poster";
  const split = !poster;
  const spot = scene?.spot ?? null;
  const front = scene?.deck.length
    ? scene.deck[scene.turn % scene.deck.length]!
    : null;
  // What the words beside it describe: the photo made, else the one in front.
  const featured = spot ?? front;
  const backdrop =
    landed?.originalUrl ?? latestMade(list, "originalUrl")?.originalUrl ?? null;
  const note = mode === "import" && running ? COPY.leave : null;

  const renderSubject = (shown: Subject) =>
    shown.kind === "poster" ? (
      <Poster photos={shown.cast} host={shown.host} />
    ) : shown.kind === "scene" ? (
      <Scene
        spot={shown.spot}
        deck={shown.deck}
        turn={shown.turn}
        landing={shown.landing}
      />
    ) : (
      <PhoneFrame
        phase={phase}
        video={video}
        play={running && !reduced}
        fill={fill}
        onVideoError={() => setBrokenVideo(preview)}
      />
    );

  return (
    <div
      data-canvas={mode}
      data-phase={phase}
      data-subject={subject.kind}
      data-still={still ? "" : undefined}
      data-unlit={UNLIT.has(phase) ? "" : undefined}
      className={cn(
        styles.canvas,
        // The dark class re-scopes airi's own colours: the stage is dark in
        // both themes, buttons and progress included.
        "@container dark relative isolate flex h-[min(64svh,29rem)] min-w-0 flex-col overflow-hidden rounded-[28px] bg-card text-card-foreground shadow-[0_24px_60px_-30px_rgba(0,0,0,0.45)] ring-1 ring-white/10 scheme-dark sm:h-[clamp(22rem,60svh,34rem)]"
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          styles.aurora,
          "pointer-events-none absolute -inset-1/4 -z-30"
        )}
      />
      {backdrop ? (
        // Signed storage URLs; next/image would need every bucket host configured.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={backdrop}
          src={backdrop}
          alt=""
          aria-hidden="true"
          decoding="async"
          className={cn(
            styles.backdrop,
            "pointer-events-none absolute inset-0 -z-20 size-full scale-125 object-cover"
          )}
        />
      ) : video ? (
        // A paused first frame: playing it here too would decode the file twice.
        <video
          src={`${video}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          className={cn(
            styles.backdrop,
            "pointer-events-none absolute inset-0 -z-20 size-full scale-125 object-cover"
          )}
        />
      ) : null}
      <div
        aria-hidden="true"
        className={cn(
          styles.vignette,
          "pointer-events-none absolute inset-0 -z-10"
        )}
      />
      <div
        aria-hidden="true"
        className={cn(
          styles.scrimTop,
          "pointer-events-none absolute inset-x-0 top-0 z-[1] h-40"
        )}
      />
      {split ? (
        <div
          aria-hidden="true"
          className={cn(
            styles.scrimSide,
            "pointer-events-none absolute inset-y-0 left-0 z-[1] hidden w-1/2 @min-[34rem]:block"
          )}
        />
      ) : null}
      <div
        aria-hidden="true"
        className={cn(
          styles.scrimBottom,
          "pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-1/2"
        )}
      />
      <div
        aria-hidden="true"
        className={cn(
          styles.grain,
          "pointer-events-none absolute inset-0 z-[5]"
        )}
      />
      {elapsed !== null ? (
        <span
          aria-hidden="true"
          className="absolute top-5 right-5 z-10 text-[13px] leading-snug text-white/55 tabular-nums sm:top-6 sm:right-6"
        >
          {formatElapsed(elapsed)}
        </span>
      ) : null}

      <div
        className={cn(
          "relative z-10 grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-5 sm:p-6",
          split &&
            "@min-[34rem]:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] @min-[34rem]:gap-x-6 @min-[34rem]:gap-y-4"
        )}
      >
        <div
          role={alert ? "alert" : undefined}
          aria-live={alert ? undefined : "polite"}
          className="col-start-1 row-start-1 min-w-0"
        >
          <p
            id={labelId}
            className={cn(
              "max-w-xl text-[19px] leading-snug font-semibold tracking-tight text-balance sm:text-xl",
              // Clear of the time in the corner, where they share the top.
              elapsed !== null && "pr-12 @min-[34rem]:pr-0"
            )}
          >
            {label}
          </p>
          {helper ? (
            <p className="mt-1 max-w-md text-[13px] leading-snug text-pretty text-white/75">
              {helper}
            </p>
          ) : null}
          {note ? (
            <p className="mt-0.5 hidden max-w-md text-[13px] leading-snug text-pretty text-white/70 @min-[34rem]:block">
              {note}
            </p>
          ) : null}
        </div>

        {split && featured?.priceQuote ? (
          // The owner's own words for what's on the stage, beside it.
          <div
            aria-hidden="true"
            className="col-start-1 row-start-2 hidden self-center @min-[34rem]:block"
          >
            <p className="line-clamp-3 text-lg leading-[1.35] text-balance text-white/85">
              {COPY.quote(featured.priceQuote)}
            </p>
          </div>
        ) : null}

        <div
          aria-hidden="true"
          className={cn(
            "relative isolate col-start-1 row-start-2 min-h-0",
            split &&
              "@min-[34rem]:col-start-2 @min-[34rem]:row-span-3 @min-[34rem]:row-start-1"
          )}
        >
          <div
            className={cn(
              styles.keylight,
              "pointer-events-none absolute -inset-[12%] -z-10"
            )}
          />
          <div className="grid h-full w-full grid-cols-1 grid-rows-1">
            {outgoing ? (
              <div
                key={outgoing.id}
                data-fade="out"
                className={cn(
                  styles.layer,
                  "pointer-events-none col-start-1 row-start-1 min-h-0"
                )}
              >
                {renderSubject(outgoing)}
              </div>
            ) : null}
            <div
              key={subject.id}
              data-fade={outgoing ? "in" : undefined}
              className={cn(styles.layer, "col-start-1 row-start-1 min-h-0")}
            >
              {renderSubject(subject)}
            </div>
          </div>
        </div>

        <div className="col-start-1 row-start-3 flex min-w-0 flex-col gap-3 self-end">
          {featured && !poster ? (
            <Caption
              title={titleOf(featured)}
              line={
                spot
                  ? photoTrail(spot)
                  : featured.priceQuote
                    ? COPY.quote(featured.priceQuote)
                    : null
              }
              // Beside the stage, the quote already stands on its own.
              quote={!spot}
            />
          ) : null}
          {list.length > 0 && !poster ? (
            <Filmstrip
              photos={list}
              current={featured?.key ?? null}
              focus={featured?.key ?? null}
            />
          ) : null}
          {actions ? (
            <div
              className={cn(
                "flex flex-wrap items-center justify-end gap-2",
                split && "@min-[34rem]:justify-start"
              )}
            >
              {actions}
            </div>
          ) : null}
        </div>
      </div>

      {percent !== null ? (
        <Progress
          value={percent}
          aria-label={label}
          className={cn(
            "absolute inset-x-0 bottom-0 z-[11] h-1 rounded-none bg-white/10",
            // On a phone the rail's segments under the stage say how far it
            // is; two bars that disagree would only confuse.
            mode === "import" && "max-lg:hidden"
          )}
        />
      ) : null}
    </div>
  );
}

// A voice's loudness along the strip: louder in the middle, uneven like speech.
const VOICE = Array.from({ length: 48 }, (_, index) => {
  const envelope = Math.sin((Math.PI * (index + 0.5)) / 48);
  const wobble = 0.5 + 0.5 * Math.abs(Math.sin(index * 2.3 + 0.4));
  return Math.round(Math.max(0.14, envelope * wobble) * 100) / 100;
});

/** The phone the video was filmed on: the video itself, or a lit pane. */
function PhoneFrame({
  phase,
  video,
  play,
  fill,
  onVideoError,
}: {
  phase: StagePhase;
  video: string | null;
  play: boolean;
  fill: number | null;
  onVideoError: () => void;
}) {
  const Glyph = GLYPHS[phase];
  const listening = phase === "listening";
  const scanning =
    phase === "queued" || phase === "preparing" || phase === "watching";
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div
        className={cn(
          styles.frame,
          "relative aspect-[9/16] h-full max-h-[28rem] max-w-full overflow-hidden rounded-[22px]"
        )}
      >
        {video ? (
          <video
            // Without playing, the first frame: some phones paint none otherwise.
            src={play ? video : `${video}#t=0.1`}
            muted
            loop
            playsInline
            autoPlay={play}
            preload="metadata"
            // A file the browser can't play, such as HEVC in Chrome on Windows.
            onError={onVideoError}
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <>
            <span className={cn(styles.viewfinder, "absolute inset-3")} />
            {listening ? null : (
              <Glyph
                className={cn(
                  styles.glyph,
                  "absolute inset-0 m-auto size-11 text-white/90"
                )}
                strokeWidth={1.4}
              />
            )}
          </>
        )}
        {scanning ? (
          <span
            data-pace={phase === "watching" ? undefined : "slow"}
            className={cn(styles.scan, "absolute inset-0")}
          />
        ) : null}
        {fill !== null ? (
          <span
            className={cn(
              styles.fill,
              "absolute inset-x-0 bottom-0 motion-safe:transition-[height] motion-safe:duration-300"
            )}
            style={{ height: `${Math.max(0, Math.min(100, fill))}%` }}
          />
        ) : null}
        {listening ? (
          // Centred; on a narrow phone the outer bars fall off the edges.
          <span className="absolute inset-x-3 top-1/2 flex h-[55%] -translate-y-1/2 items-center justify-center gap-[3px] overflow-hidden">
            {VOICE.map((height, index) => (
              <span
                key={index}
                className={cn(styles.bar, "h-full w-0.5 shrink-0 rounded-full")}
                style={{ "--i": index, "--h": height } as CSSProperties}
              />
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A made photo standing on the stage, with the photos still being made
 * fanned out beside it; or those alone, before any has landed.
 */
function Scene({
  spot,
  deck,
  turn,
  landing,
}: {
  spot: StagePhoto | null;
  deck: readonly StagePhoto[];
  turn: number;
  landing: boolean;
}) {
  const paired = spot !== null && deck.length > 0;
  return (
    <div
      data-landing={landing ? "" : undefined}
      className={cn(
        "relative flex h-full w-full items-end",
        paired ? "justify-start" : "justify-center"
      )}
    >
      <div
        className={cn(
          styles.floor,
          "pointer-events-none absolute inset-x-[6%] bottom-0 h-px"
        )}
      />
      {spot ? (
        <div
          data-paired={paired ? "" : undefined}
          className={cn(styles.spotBox, "relative z-[1] h-full min-w-0")}
        >
          <LiftOff photo={spot} play={landing} />
        </div>
      ) : null}
      {deck.length > 0 ? (
        <Deck photos={deck} turn={turn} paired={paired} />
      ) : null}
    </div>
  );
}

/**
 * The photos being made, fanned out like prints: the one in front, then the
 * others behind it. They take turns at the front while motion is allowed.
 */
function Deck({
  photos,
  turn,
  paired,
}: {
  photos: readonly StagePhoto[];
  turn: number;
  paired: boolean;
}) {
  const front = turn % photos.length;
  return (
    <div
      data-paired={paired ? "" : undefined}
      className={cn(
        styles.deck,
        "aspect-[3/4]",
        paired
          ? "absolute right-[2%] bottom-0 h-[56%]"
          : "relative h-full max-h-[28rem] max-w-full"
      )}
    >
      {photos.map((photo, index) => (
        <GeneratingTile
          key={photo.key}
          photo={photo}
          index={index}
          position={(index - front + photos.length) % photos.length}
        />
      ))}
    </div>
  );
}

/** A photo being made: a glow in its own colours, with the words it's made from. */
function GeneratingTile({
  photo,
  index,
  position,
}: {
  photo: StagePhoto;
  index: number;
  /** Its place in the deck: 0 in front. */
  position: number;
}) {
  const [first, second] = auraColors(photo.prompt);
  return (
    <div
      data-pos={position}
      className={cn(
        styles.card,
        styles.genTile,
        "absolute inset-0 overflow-hidden rounded-[22px]"
      )}
      style={
        { "--aura-1": first, "--aura-2": second, "--i": index } as CSSProperties
      }
    >
      <span className={cn(styles.genGlow, "absolute -inset-1/4")} />
      <span className={cn(styles.genPrint, "absolute inset-0")} />
      <span className={cn(styles.genScrim, "absolute inset-0")} />
      <Sparkles
        className={cn(styles.twinkle, "absolute top-3.5 left-3.5 size-[18px]")}
        strokeWidth={1.8}
      />
      {photo.prompt ? (
        <p
          className={cn(
            styles.genPrompt,
            "absolute inset-x-4 bottom-4 line-clamp-4 font-mono text-[13px] leading-snug"
          )}
        >
          {photo.prompt}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A made photo on the stage. When `play`, the filmed crop blurs in and the
 * cut-out rises out of it, once its image has decoded.
 */
function LiftOff({ photo, play }: { photo: StagePhoto; play: boolean }) {
  const url = photo.imageUrl;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url)
    return (
      <div className="grid h-full place-items-center">
        <NameInitial name={photo.name} />
      </div>
    );
  const ready = loaded === url;
  return (
    <div
      data-play={play && ready ? "" : undefined}
      // One cell, sized to the stage: the cut-out can't grow past it.
      className="grid h-full w-full grid-cols-1 grid-rows-1 items-end justify-items-center"
    >
      {photo.originalUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo.originalUrl}
          alt=""
          decoding="async"
          draggable={false}
          className={cn(
            styles.spotCrop,
            "col-start-1 row-start-1 max-h-[min(100%,28rem)] max-w-full rounded-[14px] object-contain"
          )}
        />
      ) : null}
      <div
        className={cn(
          styles.spotCut,
          "relative col-start-1 row-start-1 flex h-full min-h-0 w-full items-end justify-center"
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={url}
          src={url}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={event => {
            void Promise.resolve(event.currentTarget.decode?.())
              .catch(() => undefined)
              .finally(() => setLoaded(url));
          }}
          onError={() => setFailed(url)}
          className={cn(
            "max-h-[min(100%,28rem)] max-w-full object-contain select-none",
            !ready && "opacity-0"
          )}
        />
      </div>
    </div>
  );
}

/** The products an import made, standing together with their host. */
function Poster({
  photos,
  host,
}: {
  photos: readonly StagePhoto[];
  host: string | null;
}) {
  const count = photos.length + (host ? 1 : 0);
  // Nearer the middle stands in front.
  const depth = (index: number) =>
    count - Math.round(Math.abs(index - (count - 1) / 2) * 2);
  return (
    // The floor sits a little above the stage's foot, with the check below.
    <div className="h-full w-full pb-[6%]">
      <div className="relative flex h-full w-full items-end justify-center">
        <div
          className={cn(
            styles.floor,
            "pointer-events-none absolute inset-x-[4%] bottom-0 h-px"
          )}
        />
        {host ? (
          <PosterItem url={host} index={0} depth={depth(0)} kind="host" />
        ) : null}
        {photos.map((photo, index) => {
          const place = index + (host ? 1 : 0);
          return (
            <PosterItem
              key={photo.key}
              url={photo.imageUrl!}
              index={place}
              depth={depth(place)}
              kind={photos.length <= 3 ? "few" : "item"}
              extra={index >= POSTER_MAX_SMALL}
            />
          );
        })}
      </div>
    </div>
  );
}

function PosterItem({
  url,
  index,
  depth,
  kind,
  extra = false,
}: {
  url: string;
  index: number;
  depth: number;
  kind: "host" | "few" | "item";
  /** Left out on a phone. */
  extra?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      data-kind={kind}
      data-extra={extra ? "" : undefined}
      className={cn(styles.posterItem, "relative min-w-0 select-none")}
      style={{ "--i": index, zIndex: depth } as CSSProperties}
    />
  );
}

function Caption({
  title,
  line,
  quote,
}: {
  title: string;
  line: string | null;
  /** The line is the owner's quote, which the split stage shows apart. */
  quote: boolean;
}) {
  return (
    <div aria-hidden="true" className="flex min-w-0 flex-col gap-0.5">
      {/* Keyed by their words: a new photo dips them, never blanks them. */}
      <p
        key={title}
        className={cn(
          styles.dip,
          "truncate text-[15px] font-semibold @min-[34rem]:text-base"
        )}
      >
        {title}
      </p>
      {line ? (
        <p
          key={line}
          className={cn(
            styles.dip,
            "line-clamp-3 text-[12.5px] leading-snug text-muted-foreground",
            quote && "@min-[34rem]:hidden"
          )}
        >
          {line}
        </p>
      ) : null}
    </div>
  );
}

/** One frame per photo, in the order filmed. */
function Filmstrip({
  photos,
  current,
  focus,
}: {
  photos: readonly StagePhoto[];
  current: string | null;
  focus: string | null;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // Scrolls the strip itself: scrollIntoView would scroll the page too.
  useEffect(() => {
    const element = strip.current;
    if (!element || !focus) return;
    const frame = Array.from(element.children).find(
      child => child instanceof HTMLElement && child.dataset.key === focus
    );
    if (frame instanceof HTMLElement)
      element.scrollLeft =
        frame.offsetLeft - (element.clientWidth - frame.offsetWidth) / 2;
  }, [focus]);
  return (
    <div
      ref={strip}
      aria-hidden="true"
      // A scroller is a tab stop in some browsers; this one is decoration.
      tabIndex={-1}
      className={cn(
        styles.strip,
        "relative -mx-3 flex gap-1.5 overflow-x-auto px-3"
      )}
    >
      {photos.map(photo => (
        <StripFrame
          key={photo.key}
          photo={photo}
          current={photo.key === current}
        />
      ))}
    </div>
  );
}

function StripFrame({
  photo,
  current,
}: {
  photo: StagePhoto;
  current: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const url =
    photo.state === "made" && photo.imageUrl !== broken ? photo.imageUrl : null;
  return (
    <span
      data-key={photo.key}
      data-state={photo.state}
      data-current={current ? "" : undefined}
      className={cn(
        styles.thumb,
        "relative grid h-12 w-9 flex-none items-end justify-items-center overflow-hidden rounded-[7px]"
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(url)}
          className={
            photo.method === "none"
              ? "size-full object-cover"
              : "mb-[6%] max-h-[88%] max-w-[88%] object-contain"
          }
        />
      ) : photo.state === "made" || photo.state === "unmade" ? (
        <span
          className={cn(
            "self-center text-[15px] leading-none font-light",
            photo.state === "unmade" ? "text-white/25" : "text-white/45"
          )}
        >
          {initialOf(photo.name)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A small still of an import for its row: its latest photo, or the aurora.
 * Rows never move; only the stage does.
 */
export function MiniStage({
  imageUrl,
  alert = false,
}: {
  imageUrl: string | null;
  alert?: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const url = imageUrl && imageUrl !== broken ? imageUrl : null;
  const Glyph = alert ? CircleAlert : Film;
  return (
    <div
      aria-hidden="true"
      className="dark relative isolate h-16 w-12 shrink-0 overflow-hidden rounded-[10px] bg-card ring-1 ring-white/10"
    >
      <div className={cn(styles.miniAurora, "absolute -inset-1/4 -z-10")} />
      {url ? (
        <span className="absolute inset-1 flex items-end justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setBroken(url)}
            className="max-h-full max-w-full object-contain drop-shadow-[0_3px_4px_rgb(0_0_0/0.5)]"
          />
        </span>
      ) : (
        <Glyph
          className="absolute inset-0 m-auto size-4 text-white/75"
          strokeWidth={1.8}
        />
      )}
    </div>
  );
}
