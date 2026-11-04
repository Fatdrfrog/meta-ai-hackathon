"use client";

import { Button } from "@/components/ui/button";
import { oneLine } from "@/lib/products/ad-request";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  productAdTextIssues,
  type ProductAdRecord,
  type ProductAdTextLimit,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { Check, CircleAlert, Copy, Download, Lock } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { downloadProductAdFile } from "./ads-client";
import styles from "./product-ad-studio.module.css";
import { ProductCheck } from "./product-controls";
import theme from "./product-theme.module.css";

// The pieces the studio's views share: the head, the product chips with
// their locked prices, the sketch of the first scene, the scene rows, and
// small controls (a check, a choice, a radio group, a field for words, a
// download, a copy button).

const COPY = PRODUCTS_COPY.ad;

/** An id for one press, so sending it twice does it once. */
export function adRequestId(): string {
  const api = typeof crypto === "undefined" ? undefined : crypto;
  if (typeof api?.randomUUID === "function") return api.randomUUID();
  return `ad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Whether a line was changed: the server keeps words as one line, so
 * spacing alone (the owner's, or a double space in Muse Spark's) isn't.
 */
export const wordsEdited = (draft: string, saved: string | undefined) =>
  oneLine(draft) !== oneLine(saved ?? "");

/**
 * Why the owner's words can't go on screen, in their terms, by the script's
 * own checks: empty, a number or a currency (Airi draws prices), letters
 * the fonts lack, or more than the line room. Null when they can.
 */
export function wordsIssue(
  text: string,
  limit: ProductAdTextLimit
): string | null {
  const [first] = productAdTextIssues("text", text, limit);
  if (!first) return null;
  if (first.includes("is empty")) return COPY.issues.empty;
  if (first.includes("digit")) return COPY.issues.digits;
  if (first.includes("currency")) return COPY.issues.currency;
  if (first.includes("fonts")) return COPY.issues.letters;
  return COPY.issues.room(limit.lines ?? 1, limit.chars);
}

/** A rose dot for a control whose change isn't in the video yet, said as "changed". */
export function ChangedMark() {
  return (
    <span className={styles.changedMark}>
      <span aria-hidden="true" className={styles.changedDot} />
      <span className="sr-only">{COPY.changed}</span>
    </span>
  );
}

/**
 * A line of the owner's words, with its room ("One line of up to 26
 * letters") and, once changed, the script's own checks.
 */
export function WordField({
  id,
  label,
  value,
  saved,
  limit,
  onChange,
  disabled = false,
  describedBy,
}: {
  id: string;
  label: ReactNode;
  value: string;
  saved: string;
  limit: ProductAdTextLimit;
  onChange: (value: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const lines = limit.lines ?? 1;
  const changed = wordsEdited(value, saved);
  // Only a changed line is checked: the saved words passed already.
  const issue = changed ? wordsIssue(value, limit) : null;
  const describedByIds = [
    `${id}-room`,
    issue ? `${id}-issue` : null,
    describedBy ?? null,
  ]
    .filter(Boolean)
    .join(" ");
  const shared = {
    id,
    value,
    className: styles.input,
    maxLength: limit.chars * lines + 20,
    spellCheck: true,
    disabled,
    "aria-invalid": issue ? true : undefined,
    "aria-describedby": describedByIds,
  } as const;
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <label htmlFor={id} className={styles.fieldLabel}>
          {label}
          {changed ? <ChangedMark /> : null}
        </label>
        <span id={`${id}-room`} className={styles.fieldRoom}>
          {COPY.lineRoom(lines, limit.chars)}
        </span>
      </div>
      {lines > 1 ? (
        <textarea
          {...shared}
          rows={2}
          onChange={event => onChange(event.target.value)}
        />
      ) : (
        <input
          {...shared}
          autoComplete="off"
          onChange={event => onChange(event.target.value)}
        />
      )}
      {issue ? (
        <p id={`${id}-issue`} className={styles.issue}>
          {issue}
        </p>
      ) : null}
    </div>
  );
}

/** One option of an AdRadioGroup. */
export type AdRadioOption<Value> = {
  value: Value;
  content: ReactNode;
  /** Its accessible name, when its content says more than the name should. */
  label?: string;
  disabled?: boolean;
  className?: string;
};

/**
 * One choice of a few, as buttons in a WAI-ARIA radio group: Tab reaches the
 * chosen one (or the first), the arrow keys, Home and End move the choice
 * and the focus, wrapping, over the options that aren't disabled.
 */
export function AdRadioGroup<Value extends string | number>({
  label,
  labelledBy,
  describedBy,
  value,
  options,
  onChange,
  disabled = false,
  className,
  itemClassName,
}: {
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  value: Value | null;
  options: ReadonlyArray<AdRadioOption<Value>>;
  onChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
  itemClassName?: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.flatMap((option, index) =>
    disabled || option.disabled ? [] : [index]
  );
  const checkedIndex = options.findIndex(option => option.value === value);
  const tabbable = enabled.includes(checkedIndex)
    ? checkedIndex
    : (enabled[0] ?? -1);

  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(from);
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = enabled[(at + 1) % enabled.length];
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    buttons.current[next]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      className={className}
    >
      {options.map((option, index) => {
        const checked = index === checkedIndex;
        return (
          <button
            key={String(option.value)}
            ref={element => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.label}
            tabIndex={index === tabbable ? 0 : -1}
            disabled={disabled || option.disabled}
            data-checked={checked || undefined}
            className={cn(itemClassName, option.className)}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
            onKeyDown={event => move(event, index)}
          >
            {option.content}
          </button>
        );
      })}
    </div>
  );
}

/** "0:38", "12:05": the making clock. */
export function clockTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "38 s", "1 min 4 s", "2 min": how long something took. */
export function tookTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

const MEGABYTE = 1024 * 1024;

/** "3.2 MB", "860 KB", in the units WhatsApp's 16 MB is counted in. */
export function fileSize(bytes: number): string {
  if (bytes >= MEGABYTE) return `${(bytes / MEGABYTE).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** What "Still your …" calls a product: its English name, else "product". */
export function productWord(product: { englishName: string | null }): string {
  const name = product.englishName?.trim();
  if (!name) return "product";
  // "Blue doll" reads as "blue doll" mid-sentence; a name with other
  // capitals ("LOL doll", "Web UMN mug") is a brand's and keeps them.
  return /^[A-Z][^A-Z]*$/.test(name)
    ? `${name[0]!.toLowerCase()}${name.slice(1)}`
    : name;
}

/** A name's first letter, for a product without a photo. */
const initialOf = (name: string) =>
  (Array.from(name.trim())[0] ?? "?").toUpperCase();

/** A file name for one of the ad's downloads: "video-ad-2026-11-02.mp4". */
export function adFileName(
  ad: Pick<ProductAdRecord, "readyAt" | "createdAt">,
  kind: "video" | "status" | "feed"
): string {
  const day = (ad.readyAt ?? ad.createdAt).slice(0, 10);
  return kind === "video"
    ? `video-ad-${day}.mp4`
    : kind === "status"
      ? `status-picture-${day}.jpg`
      : `ad-picture-4x5-${day}.jpg`;
}

/** The studio's head: "Video ad", what it shows, and its state. */
export function AdHead({
  titleId,
  meta,
  status,
}: {
  titleId: string;
  meta: ReactNode;
  status?: ReactNode;
}) {
  return (
    <header className={styles.head}>
      <div className={styles.headText}>
        <h2 id={titleId} className={cn(theme.displayL, styles.title)}>
          {COPY.title}
        </h2>
        {meta ? <p className={styles.meta}>{meta}</p> : null}
      </div>
      {status}
    </header>
  );
}

/** A dot that doesn't move, for "Making · 0:38". */
export function StatusDot() {
  return <span aria-hidden="true" className={styles.statusDot} />;
}

/** A product's cut-out in a small circle, or its initial. */
function ChipThumb({
  name,
  imageUrl,
}: {
  name: string;
  imageUrl: string | null;
}) {
  return (
    <span className={styles.chipThumb} aria-hidden="true">
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" loading="lazy" decoding="async" />
      ) : (
        initialOf(name)
      )}
    </span>
  );
}

/** A price drawn by code from the shelf, on a paper label with a lock. */
export function LockedPrice({ text }: { text: string }) {
  return (
    <span className={cn(theme.priceLabel, styles.lockedPrice)}>
      <Lock aria-hidden="true" />
      <span>
        <span className="sr-only">{COPY.priceLocked}: </span>
        {text}
      </span>
    </span>
  );
}

/** The ad's products as chips: cut-out, name, locked price, and what stops one. */
export function AdProductChips({
  products,
}: {
  products: ReadonlyArray<{
    productId: string;
    name: string;
    priceText: string | null;
    imageUrl: string | null;
    problem?: keyof typeof COPY.problems | null;
  }>;
}) {
  return (
    <ul className={styles.chips}>
      {products.map(product => (
        <li
          key={product.productId}
          className={styles.productChip}
          data-problem={product.problem ? "" : undefined}
        >
          <ChipThumb name={product.name} imageUrl={product.imageUrl} />
          <span className={styles.chipName} title={product.name}>
            {product.name}
          </span>
          {product.priceText ? <LockedPrice text={product.priceText} /> : null}
          {product.problem ? (
            <span className={styles.chipProblem}>
              {COPY.problems[product.problem]}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The brief an ad was made from, in one line under its products. */
export function AdBriefLine({ ad }: { ad: ProductAdRecord }) {
  const ending = ad.ending.phone ?? ad.ending.shopName;
  return (
    <dl className={styles.briefLine}>
      <div>
        <dt>{COPY.idea}</dt>
        <dd>
          {ad.idea.kind === "own" && ad.idea.text
            ? `«${ad.idea.text}»`
            : COPY.ideas[ad.idea.kind]}
        </dd>
      </div>
      <div>
        <dt>{COPY.voice}</dt>
        <dd>{PRODUCTS_COPY.adVoice.modes[ad.voice]}</dd>
      </div>
      {ending ? (
        <div>
          <dt>{COPY.ending}</dt>
          <dd>{ending}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The first scene sketched from the real cut-out, name and price, on the
 * sand the ad's pictures stand on: what the ad will roughly look like.
 */
export function AdSketch({
  product,
}: {
  product: { name: string; priceText: string | null; imageUrl: string | null };
}) {
  return (
    <div className={styles.sketch} aria-hidden="true">
      <div className={styles.sketchLabels}>
        <span className={styles.sketchName}>{product.name}</span>
        {product.priceText ? (
          <span className={theme.priceLabel}>{product.priceText}</span>
        ) : null}
      </div>
      {product.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.sketchProduct}
          src={product.imageUrl}
          alt=""
          decoding="async"
        />
      ) : (
        <span className={styles.sketchInitial}>{initialOf(product.name)}</span>
      )}
      <div className={styles.sketchPlank} />
    </div>
  );
}

/** A still the ad made, shown as it is. */
export function AdStill({ url, alt }: { url: string; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={styles.still} src={url} alt={alt} decoding="async" />;
}

/**
 * The ad's scenes, one row per product: its picture (the exact photo first,
 * then Muse Image's once checked), name and locked price, and where the
 * picture came from. `settled` says the pictures are done, so an exact photo
 * is the one the video uses. `body` adds a row's own content, like its
 * caption or the field to change it.
 */
export function AdSceneList({
  ad,
  settled,
  body,
}: {
  ad: ProductAdRecord;
  settled: boolean;
  body?: (productId: string) => ReactNode;
}) {
  return (
    <ul className={styles.scenes}>
      {ad.products.map(product => {
        const scene = ad.scenes.find(
          entry => entry.productId === product.productId
        );
        const picture = scene?.imageUrl ?? null;
        return (
          <li key={product.productId} className={styles.scene}>
            <span className={styles.sceneThumb}>
              {picture ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={picture} alt="" loading="lazy" decoding="async" />
              ) : product.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={product.imageUrl}
                  alt=""
                  data-cutout=""
                  loading="lazy"
                  decoding="async"
                />
              ) : null}
            </span>
            <div className={styles.sceneBody}>
              <span className={styles.sceneName}>
                {product.name}
                <LockedPrice text={product.priceText} />
              </span>
              {body?.(product.productId)}
              <SceneSource
                method={scene?.method ?? null}
                checked={scene?.checked ?? false}
                hasPicture={picture !== null}
                settled={settled}
                word={productWord(product)}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SceneSource({
  method,
  checked,
  hasPicture,
  settled,
  word,
}: {
  method: "muse" | "exact" | null;
  checked: boolean;
  hasPicture: boolean;
  settled: boolean;
  word: string;
}) {
  if (method === "muse")
    return (
      <span className={styles.source} data-tone={checked ? "ok" : undefined}>
        {checked ? <Check aria-hidden="true" /> : null}
        <span>
          {COPY.sceneMuse}
          {checked ? ` · ${COPY.sceneChecked(word)}` : ""}
        </span>
      </span>
    );
  return (
    <span className={styles.source}>
      {settled
        ? COPY.sceneExact
        : hasPicture
          ? COPY.sceneExactForNow
          : COPY.sceneWaiting}
    </span>
  );
}

/** A checkbox drawn as the shared rose check. */
export function AdToggle({
  checked,
  onChange,
  disabled = false,
  describedBy,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
  children: ReactNode;
}) {
  return (
    <label className={styles.toggle} data-disabled={disabled || undefined}>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={event => onChange(event.target.checked)}
      />
      <ProductCheck
        checked={checked}
        disabled={disabled}
        className={styles.toggleCheck}
      />
      <span>{children}</span>
    </label>
  );
}

/** One choice of a few, as pills that wrap: radio buttons named `name`. */
export function AdChoices<Value extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  describedBy,
}: {
  name: string;
  legend: string;
  options: ReadonlyArray<{ value: Value; label: string }>;
  value: Value;
  onChange: (value: Value) => void;
  describedBy?: string;
}) {
  return (
    <fieldset className={styles.fieldset} aria-describedby={describedBy}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.choices}>
        {options.map(option => (
          <label key={option.value} className={styles.choice}>
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span
              className={styles.choicePill}
              data-checked={option.value === value || undefined}
            >
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A download of one of the ad's files. It's a real link (to open in a new
 * tab, or for a page without scripts); a click saves the file under `fileName`.
 */
export function AdDownload({
  url,
  fileName,
  variant = "outline",
  children,
}: {
  url: string;
  fileName: string;
  variant?: "default" | "outline";
  children: ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Button asChild variant={variant} fullWidth>
      <a
        href={url}
        download={fileName}
        target="_blank"
        rel="noopener noreferrer"
        aria-busy={saving || undefined}
        onClick={event => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          void downloadProductAdFile(url, fileName).finally(() =>
            setSaving(false)
          );
        }}
      >
        <Download aria-hidden="true" />
        {children}
      </a>
    </Button>
  );
}

/** Copies `text`; says it did, or that it couldn't, for a moment. */
export function CopyButton({
  text,
  label = COPY.copy,
  ariaLabel,
  iconOnly = false,
}: {
  text: string;
  label?: string;
  ariaLabel?: string;
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  const Icon = state === "copied" ? Check : Copy;
  return (
    <span className={styles.copyWrap}>
      <Button
        variant={iconOnly ? "ghost" : "outline"}
        size={iconOnly ? "icon-sm" : "sm"}
        aria-label={ariaLabel ?? (iconOnly ? label : undefined)}
        onClick={() => void copy()}
      >
        <Icon aria-hidden="true" />
        {iconOnly ? null : state === "copied" ? COPY.copied : label}
      </Button>
      <span className="sr-only" aria-live="polite">
        {state === "copied"
          ? COPY.copied
          : state === "failed"
            ? COPY.copyFailed
            : ""}
      </span>
      {state === "failed" && !iconOnly ? (
        <span className={styles.issue}>{COPY.copyFailed}</span>
      ) : null}
    </span>
  );
}

/** The bar kept at the bottom of a narrow studio, with its one main action. */
export function AdBar({ children }: { children: ReactNode }) {
  return <div className={styles.bar}>{children}</div>;
}

/** A still, dim outline of the studio while the ad loads. */
export function AdSkeleton({ label }: { label: string }) {
  return (
    <div role="status" className={styles.skeleton}>
      <span className="sr-only">{label}</span>
      <div className={styles.columns} aria-hidden="true">
        <div className={styles.side}>
          <div className={cn(styles.picture, styles.skeletonPicture)} />
        </div>
        <div className={styles.main}>
          <div className={styles.skeletonLine} style={{ width: "40%" }} />
          <div className={styles.skeletonLine} style={{ width: "70%" }} />
          <div className={styles.skeletonLine} style={{ width: "55%" }} />
        </div>
      </div>
    </div>
  );
}

/** Why something didn't load, and a way to ask again or leave. */
export function AdProblem({
  message,
  action,
}: {
  message: string;
  action: ReactNode;
}) {
  return (
    <div className={cn(theme.sheet, styles.panel)}>
      <p role="alert" className={styles.alert}>
        <CircleAlertIcon />
        <span>{message}</span>
      </p>
      <div className={styles.actions}>{action}</div>
    </div>
  );
}

/** The alert rows' icon. */
export function CircleAlertIcon() {
  return <CircleAlert aria-hidden="true" />;
}
