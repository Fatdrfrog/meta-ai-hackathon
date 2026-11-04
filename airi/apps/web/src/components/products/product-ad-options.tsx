"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductAdOption, ProductAdTextLimit } from "@/lib/products/types";
import { useId, type ReactNode } from "react";
import {
  AdRadioGroup,
  ChangedMark,
  WordField,
  wordsEdited,
} from "./product-ad-parts";
import styles from "./product-ad-studio.module.css";

// The ad's opening words and its ending: Muse Spark's three of each, by
// kind, each a paper sticker with an English gloss under it, or the owner's
// own words. Choosing one puts its text in the words on screen (`sticker` or
// `ending`): a free change for "Update the video". An ad written before the
// options has only its words, to keep or change.

const COPY = PRODUCTS_COPY.ad;

/** Which option is chosen: one of Muse Spark's by its place, or the owner's own words. */
export type AdOptionChoice = number | "own";

/** The option whose text the words are, else the owner's own. */
export function adOptionChoice(
  options: ReadonlyArray<{ text: string }>,
  text: string
): AdOptionChoice {
  const index = options.findIndex(option => !wordsEdited(option.text, text));
  return index >= 0 ? index : "own";
}

export function AdOptions<Kind extends string>({
  title,
  about,
  kindNames,
  ownLabel,
  options,
  saved,
  value,
  choice,
  onChoose,
  onWrite,
  limit,
  disabled = false,
  describedBy,
  children,
}: {
  title: string;
  about: string;
  kindNames: Record<Kind, string>;
  /** The own-words field's name, for screen readers ("Your own opening words"). */
  ownLabel: string;
  options: ReadonlyArray<ProductAdOption<Kind>>;
  /** The words in the video now. */
  saved: string;
  /** The words the owner chose or wrote, not in the video yet. */
  value: string;
  choice: AdOptionChoice;
  onChoose: (choice: AdOptionChoice) => void;
  onWrite: (text: string) => void;
  limit: ProductAdTextLimit;
  disabled?: boolean;
  /** Why the choices are disabled, when they are. */
  describedBy?: string;
  /** More under the choices, like the presenter's toggle under the ending. */
  children?: ReactNode;
}) {
  const ids = useId();
  const changed = wordsEdited(value, saved);
  const own = (
    <WordField
      id={`${ids}-own`}
      label={
        <>
          <span className="sr-only">{ownLabel}</span>
          <span aria-hidden="true">{COPY.ownWordsOption}</span>
        </>
      }
      value={value}
      saved={saved}
      limit={limit}
      onChange={onWrite}
      disabled={disabled}
      describedBy={describedBy}
    />
  );
  return (
    <section className={styles.toolSection} aria-labelledby={`${ids}-title`}>
      <div className={styles.field}>
        <h3 id={`${ids}-title`} className={styles.sectionTitle}>
          {title}
          {changed ? <ChangedMark /> : null}
        </h3>
        <p className={styles.note}>{about}</p>
      </div>
      {options.length === 0 ? (
        own
      ) : (
        <>
          <AdRadioGroup<AdOptionChoice>
            labelledBy={`${ids}-title`}
            describedBy={describedBy}
            value={choice}
            onChange={onChoose}
            disabled={disabled}
            className={styles.optionList}
            itemClassName={styles.option}
            options={[
              ...options.map((option, index) => ({
                value: index,
                content: (
                  <>
                    <span aria-hidden="true" className={styles.optionRadio} />
                    <span className={styles.optionBody}>
                      <span className={styles.optionKind}>
                        {kindNames[option.kind]}
                      </span>
                      <span className={styles.optionSticker}>
                        {option.text}
                      </span>
                      {option.gloss ? (
                        <span className={styles.optionGloss}>
                          {option.gloss}
                        </span>
                      ) : null}
                    </span>
                    {!wordsEdited(option.text, saved) ? (
                      <span className={styles.optionNow}>
                        {COPY.inVideoNow}
                      </span>
                    ) : null}
                  </>
                ),
              })),
              {
                value: "own" as const,
                content: (
                  <>
                    <span aria-hidden="true" className={styles.optionRadio} />
                    <span className={styles.optionBody}>
                      <span className={styles.optionOwn}>
                        {COPY.ownWordsOption}
                      </span>
                      <span className={styles.optionGloss}>
                        {COPY.lineRoom(limit.lines ?? 1, limit.chars)}
                      </span>
                    </span>
                    {!options.some(
                      option => !wordsEdited(option.text, saved)
                    ) ? (
                      <span className={styles.optionNow}>
                        {COPY.inVideoNow}
                      </span>
                    ) : null}
                  </>
                ),
              },
            ]}
          />
          {choice === "own" ? own : null}
        </>
      )}
      {children}
    </section>
  );
}
