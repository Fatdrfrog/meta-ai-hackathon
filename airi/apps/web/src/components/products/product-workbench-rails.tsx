"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  PRODUCT_AD_SETTINGS,
  PRODUCT_AD_STOCK_VOICES,
  productAdRecordingIsPaid,
  productAdSpeechCode,
  type ProductAdRecord,
  type ProductAdRecordStill,
  type ProductAdSetting,
  type ProductAdStudioColourway,
  type ProductAdUpdateRequest,
  type ProductAdVoiceMode,
  type ProductVoiceRecord,
  type ProductVoiceSamplesResponse,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import {
  Coins,
  Images,
  Lock,
  Mic,
  Palette,
  Sparkles,
  VolumeX,
  Wand2,
} from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import { currentPictureIndex } from "./product-ad-scene-tools";
import {
  ConsentDialog,
  newWordsCents,
  recordingCents,
} from "./product-ad-voice";
import styles from "./product-workbench.module.css";
import { ProductDraftError, productVoiceUrl } from "./products-client";
import {
  changeProductAdVoice,
  fetchProductVoice,
  fetchProductVoiceSamples,
  productVoiceSamplesUrl,
} from "./voices-client";
import { adRequestId } from "./product-ad-parts";

// The workbench's picture rails, with no text fields: Shots (the products in
// the ad, in ad order: which shot the Look edits, or which product a still
// shows), Look (Wall, the shot's kept Muse Image pictures and a two-tap "New
// place" for a video or In a room; the Studio still's colourways; In a room
// or Studio for the carousel) and Voice (faces: the owner's recording, their
// copied voice, Airi's voices, Off). Free picks queue a change the
// workbench sends by itself; a paid one (New place, a voice that costs)
// asks for a second tap, "Make · …", and never starts without it.

const COPY = PRODUCTS_COPY.workbench;

function Rail({
  title,
  icon,
  children,
  note,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  note?: ReactNode;
}) {
  const id = useId();
  return (
    <section className={styles.rail} aria-labelledby={id}>
      <h3 id={id} className={styles.railTitle}>
        <span aria-hidden="true">{icon}</span>
        {title}
      </h3>
      <div className={styles.railRow}>{children}</div>
      {note ? <div className={styles.railNote}>{note}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shots

export function ShotsRail({
  ad,
  selected,
  onSelect,
}: {
  ad: Pick<ProductAdRecord, "products" | "scenes">;
  selected: string;
  onSelect: (productId: string) => void;
}) {
  if (ad.products.length < 2) return null;
  return (
    <Rail title={COPY.rails.shots} icon={<Images />}>
      {ad.products.map((product, index) => {
        const scene = ad.scenes.find(
          entry => entry.productId === product.productId
        );
        const thumb = scene?.imageUrl ?? product.imageUrl;
        const on = product.productId === selected;
        return (
          <button
            key={product.productId}
            type="button"
            className={cn(styles.tile, styles.shotTile)}
            aria-pressed={on}
            aria-label={COPY.shots.shot(index, product.name)}
            data-on={on || undefined}
            onClick={() => onSelect(product.productId)}
          >
            {thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumb}
                alt=""
                loading="lazy"
                decoding="async"
                data-cutout={scene?.imageUrl ? undefined : ""}
              />
            ) : null}
            <span className={styles.tileNumber} aria-hidden="true">
              {index + 1}
            </span>
          </button>
        );
      })}
    </Rail>
  );
}

// ---------------------------------------------------------------------------
// Look

/** The next tested place after the one the scene has, for "New place". */
export function nextSetting(
  current: ProductAdSetting | null
): ProductAdSetting {
  const at = current ? PRODUCT_AD_SETTINGS.indexOf(current) : -1;
  return PRODUCT_AD_SETTINGS[(at + 1) % PRODUCT_AD_SETTINGS.length]!;
}

/** What a scene shows once the changes waiting are in: the exact photo, or a kept picture. */
export function sceneLook(
  ad: ProductAdRecord,
  productId: string,
  pending: ProductAdUpdateRequest | null
): { exact: boolean; pictureIndex: number | null } {
  const scene = ad.scenes.find(entry => entry.productId === productId);
  const change = pending?.scenes?.find(entry => entry.productId === productId);
  const exact =
    change?.useExact ??
    (scene ? scene.useExact || scene.method === "exact" : true);
  const pictureIndex =
    change?.pictureIndex ?? (scene ? currentPictureIndex(scene) : null);
  return { exact, pictureIndex: exact ? null : pictureIndex };
}

/** What the Look rail edits for a tile. */
export type WorkbenchLook =
  | { kind: "scene" }
  | { kind: "studio"; stills: ProductAdRecordStill[]; colourway: string | null }
  | {
      kind: "carousel";
      room: ProductAdRecordStill | null;
      studio: ProductAdRecordStill | null;
      chosen: "room" | "studio";
    }
  | { kind: "none" };

export function LookRail({
  ad,
  productId,
  look,
  pending,
  onQueue,
  onColourway,
  onCarouselLook,
  onNewPlace,
  newPlaceBlocked,
}: {
  ad: ProductAdRecord;
  productId: string;
  look: WorkbenchLook;
  pending: ProductAdUpdateRequest | null;
  onQueue: (change: ProductAdUpdateRequest) => void;
  onColourway: (colourway: ProductAdStudioColourway) => void;
  onCarouselLook: (look: "room" | "studio") => void;
  /** The second tap on New place. */
  onNewPlace: (productId: string, setting: ProductAdSetting) => void;
  /** Why New place can't start now ("AI is off for your company"); null when it can. */
  newPlaceBlocked: string | null;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  if (look.kind === "none") return null;
  const product = ad.products.find(entry => entry.productId === productId);
  if (!product) return null;

  if (look.kind === "studio") {
    if (look.stills.length === 0) return null;
    return (
      <Rail title={COPY.rails.look} icon={<Palette />}>
        {look.stills.map((still, index) => {
          const colourway = still.colourway ?? "white";
          const on =
            (look.colourway ?? look.stills[0]?.colourway) === colourway;
          return (
            <button
              key={`${colourway}-${index}`}
              type="button"
              className={cn(styles.tile, styles.lookTile)}
              aria-pressed={on}
              data-on={on || undefined}
              onClick={() => onColourway(colourway)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={still.url} alt="" loading="lazy" decoding="async" />
              <span className={styles.tileName}>
                {COPY.look.colourways[colourway]}
              </span>
            </button>
          );
        })}
      </Rail>
    );
  }

  if (look.kind === "carousel") {
    const options = (
      [
        ["room", look.room, PRODUCTS_COPY.gallery.tiles.post_room],
        ["studio", look.studio, PRODUCTS_COPY.gallery.tiles.post_studio],
      ] as const
    ).filter(([, still]) => still !== null);
    if (options.length < 2) return null;
    return (
      <Rail title={COPY.rails.look} icon={<Palette />}>
        {options.map(([value, still, name]) => {
          const on = look.chosen === value;
          return (
            <button
              key={value}
              type="button"
              className={cn(styles.tile, styles.lookTile)}
              aria-pressed={on}
              data-on={on || undefined}
              onClick={() => onCarouselLook(value)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={still!.url} alt="" loading="lazy" decoding="async" />
              <span className={styles.tileName}>{name}</span>
            </button>
          );
        })}
      </Rail>
    );
  }

  // A scene: Wall (the exact photo), the kept pictures, New place.
  const scene = ad.scenes.find(entry => entry.productId === productId);
  const shown = sceneLook(ad, productId, pending);
  const running =
    ad.status === "making" &&
    ad.runKind === "scene" &&
    scene?.redo?.outcome === null;
  const left = ad.picturesLeft;
  const busy = ad.status === "making";
  const blocked = newPlaceBlocked ?? (left === 0 ? COPY.look.noneLeft : null);
  const pictures = (scene?.pictures ?? []).filter(picture => picture.url);
  const outcome =
    ad.status === "ready" &&
    scene?.redo?.outcome &&
    scene.redo.outcome !== "new" &&
    scene.redo.renderNo === ad.renderNo
      ? scene.redo.outcome
      : null;
  const isArmed = armed === productId;
  const setting = nextSetting(scene?.place?.setting ?? null);

  return (
    <Rail
      title={COPY.rails.look}
      icon={<Palette />}
      note={
        outcome ? (
          <p role="status" className={styles.note}>
            {PRODUCTS_COPY.ad.outcomes[outcome](product.name)}
          </p>
        ) : blocked ? (
          <p className={styles.note}>{blocked}</p>
        ) : isArmed ? (
          <p className={styles.note}>{COPY.look.newPlaceNote(left)}</p>
        ) : null
      }
    >
      <button
        type="button"
        className={cn(styles.tile, styles.lookTile, styles.wallTile)}
        aria-pressed={shown.exact}
        aria-label={`${COPY.look.wall}. ${COPY.look.exactPhoto}`}
        data-on={shown.exact || undefined}
        onClick={() => {
          setArmed(null);
          onQueue({ scenes: [{ productId, useExact: true }] });
        }}
      >
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            data-cutout=""
          />
        ) : null}
        <span className={styles.tileName}>{COPY.look.wall}</span>
      </button>
      {pictures.length > 0
        ? pictures.map(picture => {
            const on = !shown.exact && shown.pictureIndex === picture.index;
            return (
              <button
                key={picture.index}
                type="button"
                className={cn(styles.tile, styles.lookTile)}
                aria-pressed={on}
                aria-label={`${COPY.look.picture(picture.index, picture.place)}. ${COPY.look.keptPicture}`}
                data-on={on || undefined}
                onClick={() => {
                  setArmed(null);
                  onQueue({
                    scenes: [
                      {
                        productId,
                        pictureIndex: picture.index,
                        useExact: false,
                      },
                    ],
                  });
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={picture.url!}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
                <span className={styles.tileName}>
                  {COPY.look.picture(picture.index, picture.place)}
                </span>
              </button>
            );
          })
        : scene?.method === "muse" && scene.imageUrl
          ? (() => {
              const on = !shown.exact;
              return (
                <button
                  type="button"
                  className={cn(styles.tile, styles.lookTile)}
                  aria-pressed={on}
                  data-on={on || undefined}
                  onClick={() => {
                    setArmed(null);
                    onQueue({ scenes: [{ productId, useExact: false }] });
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={scene.imageUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                  <span className={styles.tileName}>{COPY.look.making}</span>
                </button>
              );
            })()
          : null}
      <button
        type="button"
        className={cn(styles.tile, styles.lookTile, styles.newPlace)}
        data-armed={isArmed || undefined}
        data-running={running || undefined}
        disabled={blocked !== null || (busy && !running)}
        aria-busy={running || undefined}
        aria-label={
          running
            ? `${COPY.look.making}…`
            : isArmed
              ? `${COPY.look.makeOnePicture}: ${PRODUCTS_COPY.ad.settings[setting]}`
              : `${COPY.look.newPlace}. ${COPY.look.newPlaceNote(left)}`
        }
        onClick={() => {
          if (running) return;
          if (!isArmed) {
            setArmed(productId);
            return;
          }
          setArmed(null);
          onNewPlace(productId, setting);
        }}
      >
        {running ? (
          <span className={styles.newPlaceRunning}>
            <Sparkles aria-hidden="true" />
            {COPY.look.making}
          </span>
        ) : isArmed ? (
          <span className={styles.makeChip}>{COPY.look.makeOnePicture}</span>
        ) : (
          <>
            <Wand2 aria-hidden="true" className={styles.newPlaceIcon} />
            <span className={styles.coin} aria-hidden="true">
              {blocked && newPlaceBlocked ? <Lock /> : <Coins />}
            </span>
          </>
        )}
        <span className={styles.tileName}>{COPY.look.newPlace}</span>
      </button>
    </Rail>
  );
}

// ---------------------------------------------------------------------------
// Voice

type Face = {
  key: string;
  voice: ProductAdVoiceMode;
  stockVoiceId: string | null;
  label: string;
  mark: ReactNode;
};

const isLive = (voice: ProductVoiceRecord | null | undefined) =>
  voice?.state === "pending" || voice?.state === "ready";

/** What a voice costs the ad in cents: 0 when it's free. */
export function voiceCents(
  ad: ProductAdRecord,
  voice: ProductAdVoiceMode,
  copying: boolean
): number {
  if (voice === "clone" || voice === "stock")
    return newWordsCents(ad.products.length, copying);
  if (voice === "own" && productAdRecordingIsPaid(ad))
    return recordingCents(ad.products.length);
  return 0;
}

export function VoiceRail({
  workspaceId,
  ad,
  onAd,
  blocked,
}: {
  workspaceId: string;
  ad: ProductAdRecord;
  /** The voice run's answer: the ad, its voice run started. */
  onAd: (ad: ProductAdRecord) => void;
  /** Why a voice that costs can't start now; null when it can. */
  blocked: string | null;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  // Airi voices' samples, asked for the first time one is tapped; the
  // tapped one plays as soon as they're in.
  const audio = useRef<HTMLAudioElement>(null);
  const wantedSample = useRef<string | null>(null);
  const [samplesWanted, setSamplesWanted] = useState(false);
  const language = productAdSpeechCode(ad.language, null) ?? "en";
  const playSample = (
    data: ProductVoiceSamplesResponse | undefined,
    voiceId: string | null
  ) => {
    const url = data?.samples.find(sample => sample.voiceId === voiceId)?.url;
    const element = audio.current;
    if (!url || !element) return;
    element.src = url;
    try {
      const started = element.play();
      // jsdom and old browsers answer play() without a promise.
      if (started && typeof started.catch === "function")
        started.catch(() => undefined);
    } catch {
      // No sample to hear: the face still applies on its second tap.
    }
  };
  const samples = useSWR<ProductVoiceSamplesResponse, ProductDraftError>(
    samplesWanted ? productVoiceSamplesUrl(workspaceId, language) : null,
    fetchProductVoiceSamples,
    {
      revalidateOnFocus: false,
      onSuccess: data => playSample(data, wantedSample.current),
    }
  );
  const copied = useSWR<ProductVoiceRecord | null, ProductDraftError>(
    productVoiceUrl(workspaceId),
    fetchProductVoice,
    { revalidateOnFocus: false }
  );
  const hasRecording = ad.hasRecording !== false;
  const faces: Face[] = [
    ...(hasRecording
      ? [
          {
            key: "own",
            voice: "own" as const,
            stockVoiceId: null,
            label: COPY.voice.you,
            mark: <Mic />,
          },
        ]
      : []),
    {
      key: "clone",
      voice: "clone",
      stockVoiceId: null,
      label: COPY.voice.youNew,
      mark: <Sparkles />,
    },
    ...PRODUCT_AD_STOCK_VOICES.map(stock => ({
      key: `stock:${stock.id}`,
      voice: "stock" as const,
      stockVoiceId: stock.id,
      label: stock.name,
      mark: <span>{stock.name.slice(0, 1)}</span>,
    })),
    {
      key: "none",
      voice: "none",
      stockVoiceId: null,
      label: COPY.voice.off,
      mark: <VolumeX />,
    },
  ];
  const fellBack = ad.voiceResult?.fallback ? ad.voiceResult.used : null;
  const nowKey =
    ad.voice === "stock" ? `stock:${ad.stockVoiceId ?? ""}` : ad.voice;
  const running = ad.status === "making" && ad.runKind === "voice";
  const busy = ad.status !== "ready" || sending;
  const copying = copied.data?.state === "pending";

  const apply = async (face: Face) => {
    setSending(true);
    setProblem(null);
    try {
      onAd(
        await changeProductAdVoice(workspaceId, ad.id, {
          requestId: adRequestId(),
          voice: face.voice,
          ...(face.stockVoiceId ? { stockVoiceId: face.stockVoiceId } : {}),
        })
      );
    } catch (error) {
      const code = error instanceof ProductDraftError ? error.code : "failed";
      const refusals: Record<string, string> = PRODUCTS_COPY.adVoice.refusals;
      setProblem(refusals[code] ?? COPY.voiceFailed);
    } finally {
      setSending(false);
    }
  };

  const tap = (face: Face) => {
    setProblem(null);
    const same = face.key === nowKey && !fellBack;
    if (same || busy) return;
    if (
      face.voice === "clone" &&
      copied.data !== undefined &&
      !isLive(copied.data)
    ) {
      setConsentOpen(true);
      return;
    }
    if (face.voice === "stock") {
      wantedSample.current = face.stockVoiceId;
      if (samples.data) playSample(samples.data, face.stockVoiceId);
      else setSamplesWanted(true);
    }
    const cents = voiceCents(ad, face.voice, face.voice === "clone" && copying);
    if (cents > 0) {
      if (blocked) return;
      if (armed !== face.key) {
        setArmed(face.key);
        return;
      }
    }
    setArmed(null);
    void apply(face);
  };

  return (
    <Rail
      title={COPY.rails.voice}
      icon={<Mic />}
      note={
        problem ? (
          <p role="alert" className={styles.issue}>
            {problem}
          </p>
        ) : running ? (
          <p role="status" className={styles.note}>
            {COPY.voice.running}
          </p>
        ) : fellBack ? (
          <p className={styles.note}>{COPY.voice.fellBack}</p>
        ) : blocked ? (
          <p className={styles.note}>{blocked}</p>
        ) : null
      }
    >
      {faces.map(face => {
        const on = face.key === nowKey;
        const isArmed = armed === face.key;
        const cents = voiceCents(
          ad,
          face.voice,
          face.voice === "clone" && copying
        );
        const locked = cents > 0 && blocked !== null;
        return (
          <button
            key={face.key}
            type="button"
            className={styles.face}
            aria-pressed={on}
            data-on={on || undefined}
            data-armed={isArmed || undefined}
            disabled={busy || locked}
            aria-label={
              isArmed
                ? `${face.label}: ${COPY.voice.make(cents)}`
                : on
                  ? `${face.label}, ${COPY.voice.now}`
                  : face.label
            }
            onClick={() => tap(face)}
          >
            <span className={styles.faceDisc} aria-hidden="true">
              {face.mark}
              {locked ? (
                <span className={styles.faceLock}>
                  <Lock />
                </span>
              ) : null}
            </span>
            <span className={styles.faceName} aria-hidden="true">
              {isArmed ? COPY.voice.make(cents) : face.label}
            </span>
          </button>
        );
      })}
      <audio ref={audio} preload="none" className="sr-only" />
      <ConsentDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        workspaceId={workspaceId}
        productIds={ad.products.map(product => product.productId)}
        onAgreed={voice => {
          void copied.mutate(voice, { revalidate: false });
          setConsentOpen(false);
          // The copy is made; the voice run still waits for its own tap.
          if (isLive(voice)) setArmed("clone");
        }}
      />
    </Rail>
  );
}
