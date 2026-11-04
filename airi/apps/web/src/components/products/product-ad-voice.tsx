"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { voiceVideoDay } from "@/lib/products/copy-voice";
import {
  PRODUCT_AD_STOCK_VOICES,
  productAdRecordingIsPaid,
  productAdSpeechCode,
  productAdStockVoice,
  type ProductAdBriefProduct,
  type ProductAdCreateRequest,
  type ProductAdRecord,
  type ProductAdVoiceMode,
  type ProductShopWordsCode,
  type ProductVoiceRecord,
  type ProductVoiceSample,
  type ProductVoiceSource,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { CircleAlert, Pause, Play } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { ProductCheck } from "./product-controls";
import styles from "./product-ad-voice.module.css";
import studio from "./product-ad-studio.module.css";
import theme from "./product-theme.module.css";
import { ProductDraftError, productVoiceUrl } from "./products-client";
import {
  changeProductAdVoice,
  createProductVoice,
  fetchProductVoice,
  fetchProductVoiceSamples,
  fetchProductVoiceSource,
  productVoiceSamplesUrl,
  productVoiceSourceUrl,
  removeProductVoice,
} from "./voices-client";

// The ad's voice (Part V): the choice in the brief and the voice panel in
// the finished ad. Four voices: "Your recording" (v1's polished clips),
// "Your voice, new words" (an ElevenLabs copy of the owner's voice, made
// only after the consent tick, with "Remove my voice"), "Airi voices"
// (airi's voices, each with a sample in the ad's language) and "No voice".
// The brief and the ready view mount these and keep nothing else about
// voices.

const COPY = PRODUCTS_COPY.ad;
const VOICE = PRODUCTS_COPY.adVoice;

/** A voice's name, as the picker lists it ("Your recording", "No voice"…). */
export function productAdVoiceLabel(mode: ProductAdVoiceMode): string {
  return VOICE.modes[mode];
}

/** The voice the owner picked. */
export type ProductAdVoiceValue = {
  voice: ProductAdVoiceMode;
  /** With "stock": the Airi voice; null otherwise. */
  stockVoiceId: string | null;
};

/** The brief's starting choice: the owner's own recording. */
export const PRODUCT_AD_VOICE_DEFAULT: ProductAdVoiceValue = {
  voice: "own",
  stockVoiceId: null,
};

/**
 * What the brief sends for the owner's choice: the recording needs the
 * video to have the owner saying a price, so without one the ad is silent;
 * an Airi voice needs one picked.
 */
export function productAdVoiceRequest(
  value: ProductAdVoiceValue,
  products: readonly ProductAdBriefProduct[]
): Pick<ProductAdCreateRequest, "voice" | "stockVoiceId"> {
  if (value.voice === "own")
    return {
      voice: products.some(product => product.hasVoice) ? "own" : "none",
    };
  if (value.voice === "stock")
    return value.stockVoiceId
      ? { voice: "stock", stockVoiceId: value.stockVoiceId }
      : { voice: "none" };
  return { voice: value.voice };
}

/** About what reading new words costs, in whole cents: ~70 characters a scene, plus copying a voice. */
export function newWordsCents(productCount: number, copying: boolean): number {
  const usd = productCount * 70 * 0.00008 + (copying ? 0.12 : 0);
  return Math.max(1, Math.ceil(usd * 100));
}

/**
 * About what cleaning up the owner's recording costs, in whole cents: about
 * 4 s of clip a product through ElevenLabs' Voice Isolator, $0.12 a minute.
 */
export function recordingCents(productCount: number): number {
  return Math.max(1, Math.ceil(productCount * 4 * (0.12 / 60) * 100));
}

const messageOf = (error: unknown) =>
  error instanceof ProductDraftError ? error.code : "failed";

// ---------------------------------------------------------------------------
// The workspace's copied voice.

function useWorkspaceVoice(workspaceId: string, load: boolean) {
  return useSWR<ProductVoiceRecord | null, ProductDraftError>(
    load ? productVoiceUrl(workspaceId) : null,
    fetchProductVoice,
    { revalidateOnFocus: false }
  );
}

const isLive = (voice: ProductVoiceRecord | null | undefined) =>
  voice?.state === "pending" || voice?.state === "ready";

/** The consent to copy the owner's voice, asked once per workspace. */
function ConsentDialog({
  open,
  onOpenChange,
  workspaceId,
  productIds,
  onAgreed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  productIds: readonly string[];
  /** The voice the consent made: pending, or failed with why. */
  onAgreed: (voice: ProductVoiceRecord) => void;
}) {
  const ids = useId();
  const [agreed, setAgreed] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The video the copy would be made from, named before the tick: the
  // consent is sent for that video, so the voice copied is the one shown.
  const source = useSWR<ProductVoiceSource | null, ProductDraftError>(
    open ? productVoiceSourceUrl(workspaceId, productIds) : null,
    fetchProductVoiceSource,
    { revalidateOnFocus: false }
  );
  const sourceReady = source.data !== undefined && source.data !== null;
  useEffect(() => {
    if (open) {
      setAgreed(false);
      setProblem(null);
    }
  }, [open]);
  const confirm = async () => {
    if (sending || !source.data) return;
    if (!agreed) {
      setProblem(VOICE.consentNeeded);
      return;
    }
    setSending(true);
    setProblem(null);
    try {
      const voice = await createProductVoice(workspaceId, {
        consent: true,
        importId: source.data.importId,
      });
      onAgreed(voice);
    } catch (error) {
      const code = messageOf(error);
      setProblem(
        code === "import_not_found"
          ? VOICE.noSource
          : code === "voice_unavailable"
            ? VOICE.unavailable
            : code === "ai_disabled"
              ? VOICE.consentAiDisabled
              : VOICE.copyFailed
      );
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={next => !sending && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={theme.scrim}
        className={cn(theme.theme, styles.dialog)}
      >
        <div className={styles.dialogBody}>
          <DialogTitle className={cn(theme.displayM, styles.dialogTitle)}>
            {VOICE.consentTitle}
          </DialogTitle>
          <DialogDescription className={studio.note}>
            {VOICE.consentAbout}
          </DialogDescription>
          {source.isLoading ? (
            <p role="status" className={studio.note}>
              {VOICE.sourceLoading}
            </p>
          ) : source.error ? (
            <div className={styles.row}>
              <p role="alert" className={studio.issue}>
                {VOICE.sourceFailed}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void source.mutate()}
              >
                {VOICE.tryAgain}
              </Button>
            </div>
          ) : source.data ? (
            <p className={styles.source}>
              {VOICE.sourceFrom(
                voiceVideoDay(source.data.sourceVideoAt),
                source.data.productNames
              )}
            </p>
          ) : source.data === null ? (
            <p role="alert" className={studio.issue}>
              {VOICE.noSource}
            </p>
          ) : null}
          <label className={studio.toggle}>
            <input
              type="checkbox"
              className="sr-only"
              checked={agreed}
              disabled={sending}
              aria-describedby={problem ? `${ids}-problem` : undefined}
              onChange={event => {
                setAgreed(event.target.checked);
                if (event.target.checked) setProblem(null);
              }}
            />
            <ProductCheck
              checked={agreed}
              disabled={sending}
              className={studio.toggleCheck}
            />
            <span>{VOICE.consent}</span>
          </label>
          {problem ? (
            <p id={`${ids}-problem`} role="alert" className={studio.issue}>
              {problem}
            </p>
          ) : null}
          <div className={styles.dialogActions}>
            <Button
              type="button"
              variant="outline"
              disabled={sending}
              onClick={() => onOpenChange(false)}
            >
              {VOICE.consentCancel}
            </Button>
            <Button
              type="button"
              disabled={sending || !sourceReady}
              aria-disabled={!agreed || undefined}
              onClick={confirm}
            >
              {sending ? VOICE.copying : VOICE.consentConfirm}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The copied voice: where it's from, why it couldn't be made, and "Remove my voice". */
function CopiedVoice({
  workspaceId,
  voice,
  disabled,
  onRemoved,
  onTryAgain,
}: {
  workspaceId: string;
  voice: ProductVoiceRecord;
  disabled: boolean;
  onRemoved: () => void;
  onTryAgain: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  const day = voiceVideoDay(voice.sourceVideoAt);
  const remove = async () => {
    setRemoving(true);
    setProblem(null);
    try {
      await removeProductVoice(workspaceId);
      setConfirming(false);
      onRemoved();
    } catch {
      setProblem(VOICE.removeFailed);
    } finally {
      setRemoving(false);
    }
  };
  if (voice.state === "failed")
    return (
      <div className={styles.copied}>
        <p role="status" className={styles.warn}>
          <CircleAlert aria-hidden="true" />
          <span>
            {voice.errorCode === "too_little_speech"
              ? VOICE.tooLittle(voice.speechSeconds)
              : VOICE.errors[voice.errorCode ?? "clone_failed"]}
          </span>
        </p>
        {voice.errorCode !== "too_little_speech" ? (
          <div className={styles.row}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={onTryAgain}
            >
              {VOICE.tryAgain}
            </Button>
          </div>
        ) : null}
      </div>
    );
  return (
    <div className={styles.copied}>
      <p className={studio.note}>
        {voice.state === "pending"
          ? VOICE.pending(day)
          : day
            ? VOICE.madeFrom(day)
            : VOICE.madeFromUnknown}
      </p>
      {confirming ? (
        <div className={styles.confirm} role="group" aria-label={VOICE.remove}>
          <p className={studio.note}>{VOICE.removeConfirm}</p>
          <div className={styles.row}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={removing}
              onClick={remove}
            >
              {removing ? VOICE.removing : VOICE.removeYes}
            </Button>
            <Button
              ref={keep}
              type="button"
              variant="ghost"
              size="sm"
              disabled={removing}
              onClick={() => setConfirming(false)}
            >
              {VOICE.removeNo}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            className={styles.link}
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            {VOICE.remove}
          </button>
        </div>
      )}
      {problem ? (
        <p role="alert" className={studio.issue}>
          {problem}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// airi's voices.

/** One Airi voice: a choice, and its sample. */
function StockVoice({
  name,
  sample,
  checked,
  disabled,
  playing,
  onPick,
  onPlay,
}: {
  name: string;
  sample: ProductVoiceSample;
  checked: boolean;
  disabled: boolean;
  playing: boolean;
  onPick: () => void;
  onPlay: (playing: boolean) => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    if (playing) {
      setState("loading");
      element.currentTime = 0;
      const started = element.play();
      // jsdom and old browsers answer play() without a promise.
      if (started && typeof started.catch === "function")
        started.catch(() => {
          setState("failed");
          onPlay(false);
        });
    } else element.pause();
    // onPlay is the list's own setter: it never changes what this does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  return (
    <li className={styles.stock} data-checked={checked || undefined}>
      <label className={styles.stockPick}>
        <input
          type="radio"
          className="sr-only"
          name={name}
          value={sample.voiceId}
          checked={checked}
          disabled={disabled}
          onChange={onPick}
        />
        <span className={styles.stockDot} aria-hidden="true" />
        <span className={styles.stockText}>
          <span className={styles.stockName}>{sample.name}</span>
          <span className={styles.stockAbout}>{sample.about}</span>
        </span>
      </label>
      <button
        type="button"
        className={styles.play}
        aria-pressed={playing}
        aria-label={`${playing ? VOICE.stopSample : VOICE.playSample}: ${sample.name}`}
        onClick={() => onPlay(!playing)}
      >
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        <span aria-hidden="true">
          {playing && state === "loading"
            ? VOICE.sampleLoading
            : playing
              ? VOICE.stopSample
              : VOICE.playSample}
        </span>
      </button>
      {state === "failed" ? (
        <p role="status" className={cn(studio.issue, styles.stockProblem)}>
          {VOICE.sampleFailed}
        </p>
      ) : null}
      <audio
        ref={audio}
        preload="none"
        src={sample.url}
        onPlaying={() => setState("idle")}
        onEnded={() => onPlay(false)}
        onError={() => {
          if (!playing) return;
          setState("failed");
          onPlay(false);
        }}
      />
    </li>
  );
}

/** airi's voices for the ad's language, as a radiogroup with samples. */
function StockVoices({
  workspaceId,
  idPrefix,
  language,
  value,
  onChange,
  disabled,
}: {
  workspaceId: string;
  idPrefix: string;
  language: ProductShopWordsCode;
  value: string | null;
  onChange: (voiceId: string) => void;
  disabled: boolean;
}) {
  const { data, error, isLoading, mutate } = useSWR(
    productVoiceSamplesUrl(workspaceId, language),
    fetchProductVoiceSamples,
    { revalidateOnFocus: false }
  );
  const [playing, setPlaying] = useState<string | null>(null);
  if (isLoading)
    return (
      <p className={studio.note} role="status">
        {VOICE.samplesLoading}
      </p>
    );
  if (error || !data)
    return (
      <div className={styles.row}>
        <p role="alert" className={studio.issue}>
          {VOICE.samplesFailed}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => mutate()}
        >
          {VOICE.tryAgain}
        </Button>
      </div>
    );
  return (
    <fieldset className={studio.fieldset}>
      <legend className={cn(studio.legend, styles.subLegend)}>
        {VOICE.stockLegend}
      </legend>
      <ul className={styles.stocks}>
        {data.samples.map(sample => (
          <StockVoice
            key={sample.voiceId}
            name={`${idPrefix}-stock`}
            sample={sample}
            checked={value === sample.voiceId}
            disabled={disabled}
            playing={playing === sample.voiceId}
            onPick={() => onChange(sample.voiceId)}
            onPlay={next =>
              setPlaying(current =>
                next
                  ? sample.voiceId
                  : current === sample.voiceId
                    ? null
                    : current
              )
            }
          />
        ))}
      </ul>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// The picker, in the brief and in the finished ad.

type PickerProps = {
  workspaceId: string;
  idPrefix: string;
  value: ProductAdVoiceValue;
  onChange: (value: ProductAdVoiceValue) => void;
  /** The ad's products, for the video the voice is copied from. */
  productIds: readonly string[];
  /** Whether "Your recording" is offered: the video has the owner saying a price. */
  hasRecording: boolean;
  /** v1's words under "Your recording" and "No voice". */
  ownNote: string;
  language: ProductShopWordsCode;
  disabled: boolean;
  /** Under a heading that already says "Voice": the legend is for screen readers only. */
  legendHidden?: boolean;
};

/** The four voices, and what the chosen one needs: the consent, the copied voice, an Airi voice. */
function VoicePicker({
  workspaceId,
  idPrefix,
  value,
  onChange,
  productIds,
  hasRecording,
  ownNote,
  language,
  disabled,
  legendHidden = false,
}: PickerProps) {
  const modes: ProductAdVoiceMode[] = hasRecording
    ? ["own", "clone", "stock", "none"]
    : ["clone", "stock", "none"];
  const shown: ProductAdVoiceMode =
    value.voice === "own" && !hasRecording ? "none" : value.voice;
  // "Your voice, new words" was pressed: it's chosen once the workspace has a voice.
  const [wantsClone, setWantsClone] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [removedNote, setRemovedNote] = useState(false);
  // The consent made a voice that couldn't be copied: why, under the choice.
  const [notCopied, setNotCopied] = useState<ProductVoiceRecord | null>(null);
  const cloneShown = shown === "clone" || wantsClone;
  const workspaceVoice = useWorkspaceVoice(workspaceId, cloneShown);
  const voice = workspaceVoice.data;

  useEffect(() => {
    if (!wantsClone || workspaceVoice.isLoading) return;
    if (workspaceVoice.error) {
      setWantsClone(false);
      return;
    }
    if (voice === undefined) return;
    setWantsClone(false);
    if (isLive(voice)) onChange({ voice: "clone", stockVoiceId: null });
    else setConsentOpen(true);
    // onChange is the parent's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsClone, voice, workspaceVoice.isLoading, workspaceVoice.error]);

  // The copied voice gone while it's chosen (removed, or it couldn't be
  // made): the recording, or no voice, instead.
  useEffect(() => {
    if (
      shown === "clone" &&
      !wantsClone &&
      !consentOpen &&
      voice !== undefined &&
      !isLive(voice)
    )
      onChange({ voice: hasRecording ? "own" : "none", stockVoiceId: null });
    // onChange is the parent's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, voice, consentOpen, wantsClone]);

  const pick = (mode: ProductAdVoiceMode) => {
    setRemovedNote(false);
    setNotCopied(null);
    if (mode === shown && !wantsClone) return;
    if (mode === "clone") {
      setWantsClone(true);
      return;
    }
    setWantsClone(false);
    if (mode === "stock")
      onChange({
        voice: "stock",
        stockVoiceId: value.stockVoiceId ?? STOCK_DEFAULT,
      });
    else onChange({ voice: mode, stockVoiceId: null });
  };

  // Radios named alike: arrow keys move the choice, as in any radiogroup.
  return (
    <div className={styles.picker}>
      <fieldset
        className={studio.fieldset}
        aria-describedby={`${idPrefix}-voice-about`}
      >
        <legend className={legendHidden ? "sr-only" : studio.legend}>
          {COPY.voice}
        </legend>
        <div className={studio.choices}>
          {modes.map(mode => (
            <label key={mode} className={studio.choice}>
              <input
                type="radio"
                className="sr-only"
                name={`${idPrefix}-voice`}
                value={mode}
                checked={mode === (wantsClone ? "clone" : shown)}
                disabled={disabled}
                onChange={() => pick(mode)}
              />
              <span
                className={studio.choicePill}
                data-checked={
                  mode === (wantsClone ? "clone" : shown) || undefined
                }
              >
                {productAdVoiceLabel(mode)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div id={`${idPrefix}-voice-about`} className={styles.about}>
        {cloneShown ? (
          <>
            <p className={studio.note}>{VOICE.modeAbout.clone}</p>
            {workspaceVoice.isLoading ? (
              <p className={studio.note} role="status">
                {VOICE.checking}
              </p>
            ) : workspaceVoice.error ? (
              <div className={styles.row}>
                <p role="alert" className={studio.issue}>
                  {VOICE.checkFailed}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void workspaceVoice.mutate();
                    setWantsClone(true);
                  }}
                >
                  {VOICE.tryAgain}
                </Button>
              </div>
            ) : voice ? (
              <CopiedVoice
                workspaceId={workspaceId}
                voice={voice}
                disabled={disabled}
                onRemoved={() => {
                  setRemovedNote(true);
                  void workspaceVoice.mutate(null, { revalidate: false });
                }}
                onTryAgain={() => setConsentOpen(true)}
              />
            ) : null}
            <p className={studio.note}>{VOICE.pricesByCode}</p>
          </>
        ) : shown === "stock" ? (
          <>
            <p className={studio.note}>{VOICE.modeAbout.stock}</p>
            <StockVoices
              workspaceId={workspaceId}
              idPrefix={idPrefix}
              language={language}
              value={value.stockVoiceId}
              onChange={voiceId =>
                onChange({ voice: "stock", stockVoiceId: voiceId })
              }
              disabled={disabled}
            />
            <p className={studio.note}>{VOICE.pricesByCode}</p>
          </>
        ) : (
          <p className={studio.note}>{ownNote}</p>
        )}
        {removedNote ? (
          <p role="status" className={studio.note}>
            {VOICE.removed}
          </p>
        ) : null}
        {notCopied && !cloneShown ? (
          <p role="status" className={styles.warn}>
            <CircleAlert aria-hidden="true" />
            <span>
              {notCopied.errorCode === "too_little_speech"
                ? VOICE.tooLittle(notCopied.speechSeconds)
                : VOICE.errors[notCopied.errorCode ?? "clone_failed"]}
            </span>
          </p>
        ) : null}
      </div>
      <ConsentDialog
        open={consentOpen}
        onOpenChange={open => {
          setConsentOpen(open);
          if (!open) setWantsClone(false);
        }}
        workspaceId={workspaceId}
        productIds={productIds}
        onAgreed={next => {
          void workspaceVoice.mutate(next, { revalidate: false });
          setConsentOpen(false);
          if (isLive(next)) onChange({ voice: "clone", stockVoiceId: null });
          else setNotCopied(next);
        }}
      />
    </div>
  );
}

/** The first Airi voice, picked when "Airi voices" is pressed. */
const STOCK_DEFAULT: string | null = PRODUCT_AD_STOCK_VOICES[0]?.id ?? null;

export type ProductAdVoiceChoiceProps = {
  workspaceId: string;
  /** A prefix for the choice's ids, unique on the page. */
  idPrefix: string;
  value: ProductAdVoiceValue;
  onChange: (value: ProductAdVoiceValue) => void;
  /** The picked products, as the brief shows them. */
  products: readonly ProductAdBriefProduct[];
  /** The language of the ad's fixed words, for the Airi voices' samples. */
  wordsCode: ProductShopWordsCode;
  disabled?: boolean;
};

/** The brief's voice choice, inside the brief's own panel. */
export function ProductAdVoiceChoice({
  workspaceId,
  idPrefix,
  value,
  onChange,
  products,
  wordsCode,
  disabled = false,
}: ProductAdVoiceChoiceProps) {
  const withVoice = products.filter(product => product.hasVoice).length;
  const shown = productAdVoiceRequest(value, products).voice;
  const ownNote =
    withVoice === 0
      ? COPY.noVoiceClips
      : shown === "own"
        ? `${COPY.voiceAbout.own}${withVoice < products.length ? ` ${COPY.voiceSilent}` : ""}`
        : COPY.voiceAbout.none;
  return (
    <VoicePicker
      workspaceId={workspaceId}
      idPrefix={idPrefix}
      value={value}
      onChange={onChange}
      productIds={products.map(product => product.productId)}
      hasRecording={withVoice > 0}
      ownNote={ownNote}
      language={wordsCode}
      disabled={disabled}
    />
  );
}

// ---------------------------------------------------------------------------
// The finished ad's voice.

export type ProductAdVoicePanelProps = {
  workspaceId: string;
  ad: ProductAdRecord;
  /** The ad as POST /products/ads/[adId]/voice answered it, with its voice run started. */
  onChanged: (ad: ProductAdRecord) => void;
  /** While another change is being saved or run. */
  disabled?: boolean;
  /**
   * The run this panel's "Make the video with this voice" started, as the
   * studio keeps it while that run draws the view again: the panel comes
   * back with the press the keyboard's focus was on gone, so its heading
   * takes the focus, unless the owner has moved on elsewhere.
   */
  startedRunNo?: number | null;
};

const requestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * The finished ad's voice: what the video has, why it fell back when it
 * did, and changing it ("the voice can be changed and the video re-made"),
 * with what that costs.
 */
export function ProductAdVoicePanel({
  workspaceId,
  ad,
  onChanged,
  disabled = false,
  startedRunNo = null,
}: ProductAdVoicePanelProps) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<ProductAdVoiceValue>({
    voice: ad.voice,
    stockVoiceId: ad.stockVoiceId,
  });
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The picker's own read of the copied voice (one request, by SWR's key):
  // a voice not copied yet is copied in this run, and costs with it.
  const cloneVoice = useWorkspaceVoice(
    workspaceId,
    open && value.voice === "clone"
  );
  const copying =
    value.voice === "clone" && cloneVoice.data?.state === "pending";
  const hasRecording = ad.hasRecording !== false;
  const language = productAdSpeechCode(ad.language, null) ?? "en";
  const running = ad.status === "making" && ad.runKind === "voice";
  const failed =
    ad.status === "ready" &&
    ad.lastRun?.kind === "voice" &&
    ad.lastRun.outcome === "failed";
  const stockName =
    ad.voice === "stock"
      ? (productAdStockVoice(ad.stockVoiceId)?.name ?? null)
      : null;
  const result = ad.voiceResult;
  // After a failed voice run the ad keeps the voice it asked for, but the
  // video doesn't have it: the same voice can be sent again.
  const same =
    value.voice === ad.voice &&
    (value.voice !== "stock" || value.stockVoiceId === ad.stockVoiceId) &&
    !result?.fallback &&
    !failed;
  const paid = value.voice === "clone" || value.voice === "stock";
  const recordingPaid = value.voice === "own" && productAdRecordingIsPaid(ad);
  const busy = disabled || sending || running || ad.status !== "ready";

  // Closed (applied or cancelled), the picker's controls go: the keyboard's
  // focus goes back to Change, or to the heading while a run keeps Change off.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const change = changeButton.current;
      (change && !change.disabled ? change : titleRef.current)?.focus({
        preventScroll: true,
      });
    }
    wasOpen.current = open;
  }, [open]);

  // Back after the run its own press started: the heading takes the focus
  // the press had, if nothing else holds it.
  useEffect(() => {
    if (startedRunNo === null || startedRunNo !== ad.renderNo) return;
    const active = document.activeElement;
    if (!active || active === document.body)
      titleRef.current?.focus({ preventScroll: true });
  }, [startedRunNo, ad.renderNo]);

  const apply = async () => {
    if (busy || same) return;
    if (value.voice === "stock" && !value.stockVoiceId) return;
    setSending(true);
    setProblem(null);
    try {
      const next = await changeProductAdVoice(workspaceId, ad.id, {
        requestId: requestId(),
        voice: value.voice,
        ...(value.voice === "stock" && value.stockVoiceId
          ? { stockVoiceId: value.stockVoiceId }
          : {}),
      });
      setOpen(false);
      onChanged(next);
    } catch (error) {
      const code = messageOf(error);
      setProblem(
        code in VOICE.refusals
          ? VOICE.refusals[code as keyof typeof VOICE.refusals]
          : VOICE.refusals.failed
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      className={cn(theme.sheet, studio.panel)}
      aria-labelledby={`${ids}-title`}
    >
      <div className={studio.panelHead}>
        <h3
          ref={titleRef}
          id={`${ids}-title`}
          tabIndex={-1}
          className={studio.sectionTitle}
        >
          {VOICE.title}
        </h3>
        {!open ? (
          <Button
            ref={changeButton}
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setValue({ voice: ad.voice, stockVoiceId: ad.stockVoiceId });
              setProblem(null);
              setOpen(true);
            }}
          >
            {VOICE.change}
          </Button>
        ) : null}
      </div>
      <p className={studio.note}>
        <span className={styles.nowLabel}>{VOICE.now}: </span>
        {productAdVoiceLabel(result?.fallback ? result.used : ad.voice)}
        {stockName && !result?.fallback ? ` · ${stockName}` : ""}
      </p>
      {result?.fallback ? (
        <p role="status" className={styles.warn}>
          <CircleAlert aria-hidden="true" />
          <span>
            {VOICE.fallbacks[result.fallback]}
            {VOICE.fellBackTo[result.used === "own" ? "own" : "none"]}
          </span>
        </p>
      ) : null}
      {running ? (
        <p role="status" aria-live="polite" className={studio.note}>
          {VOICE.running}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className={styles.warn}>
          <CircleAlert aria-hidden="true" />
          <span>
            {ad.lastRun?.errorCode === "ai_disabled"
              ? VOICE.refusals.ai_disabled
              : VOICE.lastRunFailed}
          </span>
        </p>
      ) : null}
      {open ? (
        <>
          <VoicePicker
            workspaceId={workspaceId}
            idPrefix={ids}
            value={value}
            onChange={setValue}
            productIds={ad.products.map(product => product.productId)}
            hasRecording={hasRecording}
            ownNote={
              value.voice === "none" || !hasRecording
                ? COPY.voiceAbout.none
                : COPY.voiceAbout.own
            }
            language={language}
            disabled={busy}
            legendHidden
          />
          <p className={studio.note}>
            {same
              ? VOICE.sameVoice
              : paid
                ? VOICE.costPaid(newWordsCents(ad.products.length, copying))
                : recordingPaid
                  ? VOICE.costRecording(recordingCents(ad.products.length))
                  : VOICE.costFree}
          </p>
          {problem ? (
            <p role="alert" className={studio.issue}>
              {problem}
            </p>
          ) : null}
          <div className={styles.row}>
            <Button
              type="button"
              disabled={
                busy || same || (value.voice === "stock" && !value.stockVoiceId)
              }
              onClick={apply}
            >
              {sending ? VOICE.applying : VOICE.apply}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={sending}
              onClick={() => {
                setOpen(false);
                setProblem(null);
              }}
            >
              {VOICE.cancel}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
