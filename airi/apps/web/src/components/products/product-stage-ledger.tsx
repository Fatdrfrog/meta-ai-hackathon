"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { cn } from "@/lib/utils";
import { spokenPriceSpan } from "@icecore/temporal";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  ImageOff,
  ScanText,
  Scissors,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";
import {
  formatElapsed,
  type LedgerPhoto,
  type LedgerRow,
} from "./product-stage-model";
import styles from "./product-stage.module.css";

const COPY = PRODUCTS_COPY.stage.ledger;

// Rows shown before "Show all": a phone's column takes fewer than a wide one.
// The stylesheet hides the rest by the ledger's own width.
const NARROW_ROWS = 4;
const WIDE_ROWS = 8;

const PHOTO_ICONS: Record<LedgerPhoto, LucideIcon> = {
  made: Check,
  making: Scissors,
  waiting: Clock,
  unmade: ImageOff,
  noView: ImageOff,
};

/**
 * "What you said": each product the import found, as the owner said it.
 * When in the video, their own words, the name and price the models made of
 * them, and where its photo is. It's the models' real output, row by row: it
 * fills in as Muse Spark lists the products and as each photo lands.
 */
export function StageLedger({ rows }: { rows: readonly LedgerRow[] }) {
  const headingId = useId();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  // Whether rows are left out on a phone only, or at every width.
  const more =
    rows.length > WIDE_ROWS
      ? "all"
      : rows.length > NARROW_ROWS
        ? "narrow"
        : null;
  return (
    <section aria-labelledby={headingId} className={styles.ledger}>
      <div className={styles.ledgerHead}>
        <h3 id={headingId} className={styles.ledgerTitle}>
          {COPY.title}
        </h3>
        <p className={styles.ledgerCredit}>{COPY.credit}</p>
      </div>
      <ol
        id={listId}
        data-expanded={expanded ? "" : undefined}
        className={styles.ledgerRows}
      >
        {rows.map(row => (
          <LedgerItem key={row.key} row={row} />
        ))}
      </ol>
      {more ? (
        <Button
          variant="ghost"
          size="sm"
          data-more={more}
          aria-expanded={expanded}
          aria-controls={listId}
          className={styles.ledgerMore}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? COPY.showFewer : COPY.showAll(rows.length)}
          {expanded ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
        </Button>
      ) : null}
    </section>
  );
}

// The quote's marks, as the copy writes them around the owner's words.
const [QUOTE_OPEN, QUOTE_CLOSE] = COPY.quote("\n").split("\n");

/**
 * The owner's words in «», their price set apart (Paper: the price words at
 * 500 in ink), as the shared reading finds it: «мына кружка **бес жүз
 * теңге**». The product's own name stays out of it. Words with no price
 * said read plain.
 */
function QuoteWords({ quote, name }: { quote: string; name: string }) {
  const span = spokenPriceSpan(quote, name);
  if (!span) return <>{COPY.quote(quote)}</>;
  return (
    <>
      {QUOTE_OPEN}
      {quote.slice(0, span.start)}
      <span className={styles.ledgerSaidPrice}>
        {quote.slice(span.start, span.end)}
      </span>
      {quote.slice(span.end)}
      {QUOTE_CLOSE}
    </>
  );
}

function LedgerItem({ row }: { row: LedgerRow }) {
  const Icon = PHOTO_ICONS[row.photo];
  return (
    <li data-product={row.key} className={styles.ledgerRow}>
      <span className={styles.ledgerTime}>
        {row.moment === null ? null : formatElapsed(row.moment)}
      </span>
      <span
        dir="auto"
        title={
          row.quote
            ? `${row.onScreen ? `${COPY.onScreen} ` : ""}${COPY.quote(row.quote)}`
            : undefined
        }
        className={styles.ledgerQuote}
      >
        {row.quote ? (
          <>
            {/* Read on screen, not heard: marked, never passed off as said. */}
            {row.onScreen ? (
              <>
                <ScanText aria-hidden="true" className={styles.onScreen} />
                <span className="sr-only">{COPY.onScreen} </span>
              </>
            ) : null}
            <QuoteWords quote={row.quote} name={row.name} />
          </>
        ) : null}
      </span>
      <span dir="auto" title={row.name} className={styles.ledgerName}>
        {row.name}
      </span>
      <span
        data-doubt={row.priceDoubt ? "" : undefined}
        data-none={row.price === null ? "" : undefined}
        className={styles.ledgerPrice}
      >
        {row.price ?? COPY.noPrice}
        {row.priceDoubt ? (
          <span className="sr-only"> {PRODUCTS_COPY.stage.checkPrice}</span>
        ) : null}
      </span>
      {/* Keyed by where the photo is: a photo landing fades its line in. */}
      <span
        key={row.photo}
        data-photo={row.photo}
        className={cn(styles.ledgerPhoto, styles.arrive)}
      >
        <Icon aria-hidden="true" strokeWidth={2} />
        {COPY.photo[row.photo]}
      </span>
    </li>
  );
}
