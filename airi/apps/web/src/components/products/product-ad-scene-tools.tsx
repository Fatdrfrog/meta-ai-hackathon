"use client";

import { Button } from "@/components/ui/button";
import {
  AD_DESCRIBE_PLACE,
  AD_EARLIER_PICTURES,
  AD_SCENE_TOOLS,
} from "@/lib/products/ad-features";
import { oneLine } from "@/lib/products/ad-request";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  PRODUCT_AD_PLACE_REFUSALS,
  PRODUCT_AD_PLACE_WORDS_MAX,
  PRODUCT_AD_SETTINGS,
  PRODUCT_AD_TEXT_ZONES,
  type ProductAdPlaceRefusal,
  type ProductAdRecord,
  type ProductAdRecordScene,
  type ProductAdSetting,
  type ProductAdTextZone,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { Check, Pencil, Sparkles } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import {
  AdRadioGroup,
  AdToggle,
  ChangedMark,
  LockedPrice,
  productWord,
} from "./product-ad-parts";
import styles from "./product-ad-studio.module.css";

// The ad's scenes, one at a time, picked from scene tabs: the scene's
// picture with where it came from and its locked price; a new picture in
// one of the 5 tested places or a place the owner describes (the one paid
// press, from the ad's own AI action); the earlier pictures to pick again
// for free; where the words sit, with SAM 3.1's hint when they cover the
// product; the caption; and the exact photo. While a New picture runs, the
// scene shows its honest, still steps; after it, how it went.

const COPY = PRODUCTS_COPY.ad;

/** One scene's free choices, as the studio holds them before "Update the video". */
export type AdSceneDraft = {
  textZone: ProductAdTextZone;
  useExact: boolean;
  /** A kept picture to use again; null keeps the one in the video. */
  pictureIndex: number | null;
};

/** A scene's choices as the video has them. */
export const savedSceneDraft = (scene: ProductAdRecordScene): AdSceneDraft => ({
  textZone: scene.textZone,
  useExact: scene.useExact,
  pictureIndex: null,
});

/** The kept picture in the video now; null when it's the exact photo or none. */
export const currentPictureIndex = (scene: ProductAdRecordScene) =>
  scene.pictures.find(picture => picture.current)?.index ?? null;

/** Where a New picture is asked for: a tested place, or the owner's own. */
export type AdNewPicturePlace =
  | { setting: ProductAdSetting }
  | { words: string };

type PlaceChoice = ProductAdSetting | "describe";

const isPlaceRefusal = (
  reason: string | null
): reason is ProductAdPlaceRefusal =>
  (PRODUCT_AD_PLACE_REFUSALS as readonly (string | null)[]).includes(reason);

/** The scene the studio opens on: the one a New picture is running or just ran for. */
function firstScene(ad: ProductAdRecord): number {
  const index = ad.products.findIndex(product => {
    const redo = ad.scenes.find(
      scene => scene.productId === product.productId
    )?.redo;
    return redo && (redo.outcome === null || redo.renderNo === ad.renderNo);
  });
  return Math.max(0, index);
}

export type AdSceneToolsProps = {
  ad: ProductAdRecord;
  drafts: Readonly<Record<string, AdSceneDraft>>;
  onDraft: (productId: string, next: AdSceneDraft) => void;
  /** The caption's field for a product. */
  caption: (productId: string) => ReactNode;
  /** Why every control waits ("One change at a time"); null when they don't. */
  busyReason: string | null;
  /** Why New picture waits besides that ("Fix the lines in red first"). */
  blockedReason: string | null;
  onNewPicture: (productId: string, place: AdNewPicturePlace) => void;
  /** Why the last New picture press was refused, for its scene. */
  pressProblem: { productId: string; message: string } | null;
  /**
   * The scene the owner picked, kept by the studio across its runs (each run
   * draws the view again); null opens on firstScene.
   */
  selectedId?: string | null;
  onSelect?: (productId: string) => void;
};

export function AdSceneTools({
  ad,
  drafts,
  onDraft,
  caption,
  busyReason,
  blockedReason,
  onNewPicture,
  pressProblem,
  selectedId = null,
  onSelect,
}: AdSceneToolsProps) {
  const ids = useId();
  const [opened] = useState(() => firstScene(ad));
  const kept = selectedId
    ? ad.products.findIndex(entry => entry.productId === selectedId)
    : -1;
  const [own, setOwn] = useState<number | null>(null);
  const selected = own ?? (kept >= 0 ? kept : opened);
  const setSelected = (index: number) => {
    setOwn(index);
    const id = ad.products[index]?.productId;
    if (id) onSelect?.(id);
  };
  const [places, setPlaces] = useState<Record<string, PlaceChoice | null>>({});
  const [words, setWords] = useState<Record<string, string>>({});
  const product = ad.products[selected] ?? ad.products[0];
  if (!product) return null;
  const scene = ad.scenes.find(entry => entry.productId === product.productId);
  const productId = product.productId;
  const draft: AdSceneDraft = drafts[productId] ?? {
    textZone: scene?.textZone ?? "auto",
    useExact: scene?.useExact ?? false,
    pictureIndex: null,
  };
  const word = productWord(product);
  const disabled = busyReason !== null;
  const busyId = `${ids}-busy`;

  const running =
    ad.status === "making" &&
    ad.runKind === "scene" &&
    scene?.redo?.outcome === null;
  const outcome =
    ad.status === "ready" &&
    scene?.redo?.outcome &&
    scene.redo.renderNo === ad.renderNo
      ? scene.redo
      : null;

  // What the scene shows: the exact photo, a kept picture picked again, or
  // the picture in the video.
  const savedIndex = scene ? currentPictureIndex(scene) : null;
  const picked =
    draft.pictureIndex !== null
      ? (scene?.pictures.find(entry => entry.index === draft.pictureIndex) ??
        null)
      : null;
  const showsExact = draft.useExact || (!picked && scene?.method !== "muse");
  const pictureUrl = draft.useExact
    ? null
    : (picked?.url ?? scene?.imageUrl ?? null);
  const checked = picked ? true : (scene?.checked ?? false);

  // The place now: the setting of the picture in the video, when the video
  // shows the latest Muse Image picture of this scene.
  const latest = scene?.pictures[scene.pictures.length - 1];
  const nowSetting =
    scene &&
    scene.method === "muse" &&
    !scene.useExact &&
    (!scene.redo || scene.redo.outcome === "new") &&
    (scene.pictures.length === 0 || latest?.current)
      ? (scene.place?.setting ?? null)
      : null;

  const place = places[productId] ?? null;
  const described = oneLine(words[productId] ?? "");
  const left = ad.picturesLeft;
  const why =
    busyReason ??
    (left === 0
      ? COPY.newPictureWhy.noneLeft
      : place === null
        ? COPY.newPictureWhy.noPlace
        : place === "describe" && !described
          ? COPY.newPictureWhy.noWords
          : blockedReason);
  const press = () => {
    if (why || place === null) return;
    onNewPicture(
      productId,
      place === "describe" ? { words: described } : { setting: place }
    );
  };

  const zoneChanged = scene ? draft.textZone !== scene.textZone : false;
  const exactChanged = scene ? draft.useExact !== scene.useExact : false;
  const pictureChanged =
    draft.pictureIndex !== null && draft.pictureIndex !== savedIndex;
  const overlap = scene?.textOverlap;
  const hint =
    overlap?.covers && !zoneChanged && !draft.useExact ? overlap : null;
  const hintZone =
    hint?.suggested && hint.suggested !== draft.textZone
      ? hint.suggested
      : null;

  return (
    <section className={styles.toolSection} aria-labelledby={`${ids}-title`}>
      <div className={styles.field}>
        <h3 id={`${ids}-title`} className={styles.sectionTitle}>
          {COPY.scenesTitle}
        </h3>
        <p className={styles.note}>{COPY.scenesAbout}</p>
      </div>
      {busyReason ? (
        <p id={busyId} className={styles.note}>
          {busyReason}
        </p>
      ) : null}

      {ad.products.length > 1 ? (
        <AdRadioGroup<number>
          label={COPY.scenesPick}
          value={selected}
          onChange={setSelected}
          className={styles.sceneTabs}
          itemClassName={styles.sceneTab}
          options={ad.products.map((entry, index) => {
            const tabScene = ad.scenes.find(
              item => item.productId === entry.productId
            );
            const thumb = tabScene?.imageUrl ?? entry.imageUrl;
            const changed =
              drafts[entry.productId] &&
              tabScene &&
              (drafts[entry.productId]!.textZone !== tabScene.textZone ||
                drafts[entry.productId]!.useExact !== tabScene.useExact ||
                (drafts[entry.productId]!.pictureIndex !== null &&
                  drafts[entry.productId]!.pictureIndex !==
                    currentPictureIndex(tabScene)));
            return {
              value: index,
              label: COPY.sceneTab(index, entry.name),
              content: (
                <>
                  <span className={styles.sceneTabThumb} aria-hidden="true">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumb}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        data-cutout={tabScene?.imageUrl ? undefined : ""}
                      />
                    ) : null}
                  </span>
                  <span className={styles.sceneTabName} aria-hidden="true">
                    {index + 1} · {entry.name}
                  </span>
                  {changed ? <ChangedMark /> : null}
                </>
              ),
            };
          })}
        />
      ) : null}

      <div className={styles.sceneTool}>
        <div className={styles.scenePicture}>
          <div className={styles.scenePictureFrame}>
            {pictureUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={pictureUrl}
                alt={COPY.pictureAlt(product.name)}
                decoding="async"
              />
            ) : product.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={product.imageUrl}
                alt={COPY.pictureAlt(product.name)}
                data-cutout=""
                decoding="async"
              />
            ) : null}
            <span className={styles.sceneBadge}>
              {showsExact ? null : <Check aria-hidden="true" />}
              {showsExact
                ? COPY.badgeExact
                : checked
                  ? COPY.badgeMuse
                  : COPY.badgeMuseUnchecked}
            </span>
          </div>
        </div>

        <div className={styles.sceneControls}>
          <div className={styles.sceneHead}>
            <span className={styles.sceneName}>
              {product.name}
              <LockedPrice text={product.priceText} />
            </span>
            <span className={styles.note}>
              {COPY.sceneOf(selected, ad.products.length)}
            </span>
          </div>

          {running && scene ? (
            <SceneSteps ad={ad} scene={scene} word={word} />
          ) : null}
          {outcome ? <SceneOutcome outcome={outcome} word={word} /> : null}

          {AD_SCENE_TOOLS ? (
            <div className={styles.field}>
              <span id={`${ids}-place`} className={styles.groupLabel}>
                {COPY.placeTitle}
              </span>
              <AdRadioGroup<PlaceChoice>
                labelledBy={`${ids}-place`}
                describedBy={busyReason ? busyId : undefined}
                value={place}
                onChange={next =>
                  setPlaces(current => ({ ...current, [productId]: next }))
                }
                disabled={disabled}
                className={styles.chips}
                itemClassName={styles.placeChip}
                options={[
                  ...PRODUCT_AD_SETTINGS.map(setting => ({
                    value: setting,
                    content: (
                      <>
                        {COPY.settings[setting]}
                        {setting === nowSetting ? (
                          <span className={styles.placeNow}>
                            {" · "}
                            {COPY.placeNow}
                          </span>
                        ) : null}
                      </>
                    ),
                  })),
                  ...(AD_DESCRIBE_PLACE
                    ? [
                        {
                          value: "describe" as const,
                          content: (
                            <>
                              <Pencil aria-hidden="true" />
                              {COPY.describePlace}
                            </>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
              {place === "describe" ? (
                <div className={styles.describe}>
                  <div className={styles.fieldHead}>
                    <label
                      htmlFor={`${ids}-describe`}
                      className={styles.fieldLabel}
                    >
                      {COPY.describeLabel}
                    </label>
                    <span className={styles.fieldRoom}>
                      {COPY.describeCount(
                        Array.from(words[productId] ?? "").length
                      )}
                    </span>
                  </div>
                  <input
                    id={`${ids}-describe`}
                    className={styles.input}
                    value={words[productId] ?? ""}
                    maxLength={PRODUCT_AD_PLACE_WORDS_MAX}
                    autoComplete="off"
                    spellCheck
                    disabled={disabled}
                    aria-describedby={`${ids}-describe-help`}
                    onChange={event =>
                      setWords(current => ({
                        ...current,
                        [productId]: event.target.value,
                      }))
                    }
                  />
                  <p id={`${ids}-describe-help`} className={styles.note}>
                    {COPY.describeHelp}
                  </p>
                </div>
              ) : null}
              <div className={styles.newPicture}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={why !== null}
                  aria-describedby={`${ids}-new-note`}
                  onClick={press}
                >
                  <Sparkles aria-hidden="true" />
                  {COPY.newPicture}
                </Button>
                <span id={`${ids}-new-note`} className={styles.note}>
                  {why && why !== busyReason ? why : COPY.newPictureNote(left)}
                </span>
              </div>
              {pressProblem?.productId === productId ? (
                <p role="alert" className={styles.issue}>
                  {pressProblem.message}
                </p>
              ) : null}
            </div>
          ) : null}

          {AD_EARLIER_PICTURES && scene && scene.pictures.length >= 2 ? (
            <div className={styles.field}>
              <span id={`${ids}-earlier`} className={styles.groupLabel}>
                {COPY.earlierTitle}
                {pictureChanged ? <ChangedMark /> : null}
              </span>
              <div className={styles.earlierRow}>
                <AdRadioGroup<number>
                  labelledBy={`${ids}-earlier`}
                  describedBy={`${ids}-earlier-about`}
                  value={
                    draft.useExact ? null : (draft.pictureIndex ?? savedIndex)
                  }
                  onChange={index =>
                    onDraft(productId, {
                      ...draft,
                      pictureIndex: index === savedIndex ? null : index,
                      useExact: false,
                    })
                  }
                  disabled={disabled}
                  className={styles.earlier}
                  itemClassName={styles.earlierThumb}
                  options={scene.pictures.map(picture => ({
                    value: picture.index,
                    label: COPY.earlierPicture(picture.index, picture.place),
                    content: picture.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={picture.url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    ) : null,
                  }))}
                />
                <span id={`${ids}-earlier-about`} className={styles.note}>
                  {COPY.earlierAbout}
                </span>
              </div>
            </div>
          ) : null}

          <div className={styles.field}>
            <span id={`${ids}-zone`} className={styles.groupLabel}>
              {COPY.zoneTitle}
              {zoneChanged ? <ChangedMark /> : null}
            </span>
            <AdRadioGroup<ProductAdTextZone>
              labelledBy={`${ids}-zone`}
              value={draft.textZone}
              onChange={textZone => onDraft(productId, { ...draft, textZone })}
              disabled={disabled}
              className={styles.segmented}
              itemClassName={styles.segment}
              options={PRODUCT_AD_TEXT_ZONES.map(zone => ({
                value: zone,
                content: COPY.zones[zone],
              }))}
            />
            {hint ? (
              <div className={styles.hint}>
                <p className={styles.hintText}>
                  {COPY.coverHint(word, hintZone)}
                </p>
                {hintZone ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      onDraft(productId, { ...draft, textZone: hintZone })
                    }
                  >
                    {COPY.moveWordsTo(hintZone)}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {caption(productId)}

          <AdToggle
            checked={draft.useExact}
            disabled={disabled}
            onChange={useExact =>
              onDraft(productId, {
                ...draft,
                useExact,
                // The exact photo shows instead of any picture picked again.
                pictureIndex: useExact ? null : draft.pictureIndex,
              })
            }
          >
            {COPY.exactToggle}
            {exactChanged ? <ChangedMark /> : null}
          </AdToggle>
        </div>
      </div>
    </section>
  );
}

/** A New picture's still steps, driven by the ad's step and the scene's place. */
function SceneSteps({
  ad,
  scene,
  word,
}: {
  ad: ProductAdRecord;
  scene: ProductAdRecordScene;
  word: string;
}) {
  const describing = Boolean(scene.place?.words);
  const read = scene.place?.englishPlace ?? null;
  const late = ad.step === "framing" || ad.step === "video";
  const steps: Array<{ text: string; state: "done" | "now" | "next" }> = [
    ...(describing
      ? [
          {
            text: read ? COPY.sceneSteps.read(read) : COPY.sceneSteps.reading,
            state: read || late ? ("done" as const) : ("now" as const),
          },
        ]
      : []),
    {
      text: COPY.sceneSteps.image(word),
      state: late ? "done" : !describing || read ? "now" : "next",
    },
    {
      text: COPY.sceneSteps.check(word),
      state: late ? "done" : "next",
    },
    { text: COPY.sceneSteps.frame, state: late ? "now" : "next" },
  ];
  return (
    <ol
      className={styles.steps}
      aria-label={COPY.sceneStepsLabel}
      aria-live="polite"
    >
      {steps.map(step => (
        <li key={step.text} className={styles.step} data-state={step.state}>
          <span className={styles.stepDot} aria-hidden="true">
            {step.state === "done" ? <Check /> : null}
          </span>
          <span className={styles.stepText}>
            <span className={styles.stepName}>{step.text}</span>
          </span>
          <span className="sr-only">{COPY.stepStates[step.state]}</span>
        </li>
      ))}
    </ol>
  );
}

/** How the latest New picture on the scene went. */
function SceneOutcome({
  outcome,
  word,
}: {
  outcome: NonNullable<ProductAdRecordScene["redo"]>;
  word: string;
}) {
  const kind = outcome.outcome;
  if (!kind) return null;
  const detail =
    kind === "kept_check"
      ? word
      : kind === "place_refused"
        ? isPlaceRefusal(outcome.reason)
          ? COPY.placeRefusals[outcome.reason]
          : COPY.placeRefusedOther
        : "";
  return (
    <p
      role="status"
      className={cn(styles.outcome)}
      data-tone={kind === "new" ? "ok" : "warn"}
    >
      {COPY.outcomes[kind](detail)}
    </p>
  );
}
