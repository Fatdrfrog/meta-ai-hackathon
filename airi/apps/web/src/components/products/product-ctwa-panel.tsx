"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  PRODUCT_AD_CTWA_MIN_DAILY_CENTS,
  PRODUCT_AD_CTWA_STEPS,
  type ProductAdCtwaAsset,
  type ProductAdCtwaRecord,
  type ProductAdCtwaRunRequest,
  type ProductAdRecord,
  type ProductsCtwaReadiness,
  type ProductsErrorCode,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import {
  Check,
  ExternalLink,
  FileText,
  Globe,
  Lock,
  MapPin,
  MessageCircle,
  Minus,
  Plus,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  createCtwaAd,
  loadCtwaAd,
  PRODUCT_META_POLL_MS,
  runCtwaAd,
} from "./meta-client";
import { adRequestId } from "./product-ad-parts";
import theme from "./product-theme.module.css";
import styles from "./product-workbench.module.css";
import { ProductDraftError } from "./products-client";

// The WhatsApp ad's side of the workbench (Click-to-WhatsApp, Marketing API,
// Facebook placements): what the chat opens with (Muse Spark's greeting and
// quick questions), where it's shown, and once "Create ad" ran, Meta's
// steps as they're made (Video ✓ Campaign ✓ Ad set ✓ Creative ✓ Ad ✓ ·
// Paused) with the Ads Manager link. Create ad needs no confirm: it makes
// everything PAUSED, which spends nothing until Run. Meta may review it
// while paused. Run is its
// own step after its confirm, capped on the server ($1 a day for at most
// 3 days unless the server says otherwise), shown only when the server has
// it on. A WhatsApp number not linked to the Page shows the fix.

const COPY = PRODUCTS_COPY.ctwa;
const BENCH = PRODUCTS_COPY.workbench;

/** Business Suite, where the owner links the WhatsApp number to the Page. */
export const BUSINESS_SUITE_URL =
  "https://business.facebook.com/latest/settings/";

/** A review that may take minutes to a day: asked again this often while it runs. */
export const CTWA_REVIEW_POLL_MS = 30_000;

const making = (ctwa: ProductAdCtwaRecord | null) =>
  ctwa !== null &&
  (PRODUCT_AD_CTWA_STEPS as readonly string[]).includes(ctwa.state);

/** Whether Meta still reviews it, runs it or refused it, from effective_status. */
export function ctwaRunState(
  ctwa: Pick<ProductAdCtwaRecord, "state" | "effectiveStatus">
): "in_review" | "running" | "disapproved" | "unknown" | null {
  if (ctwa.state !== "running") return null;
  if (ctwa.effectiveStatus === null) return "unknown";
  const status = ctwa.effectiveStatus ?? "";
  if (status === "DISAPPROVED" || status === "WITH_ISSUES")
    return "disapproved";
  if (status === "ACTIVE") return "running";
  return "in_review";
}

/**
 * The ad's Click-to-WhatsApp ad, kept current while Meta makes it (one
 * step per ask) and while it's reviewed; `create` is "Create ad", `run` is
 * the Run sheet's press.
 */
export function useCtwa({
  workspaceId,
  ad,
  onSettled,
}: {
  workspaceId: string;
  ad: ProductAdRecord;
  onSettled: (ctwa: ProductAdCtwaRecord) => void;
}) {
  const stored = ad.meta?.ctwa ?? null;
  const [local, setLocal] = useState<ProductAdCtwaRecord | null>(null);
  const ctwa =
    local && (!stored || local.attempt >= stored.attempt) ? local : stored;
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<ProductsErrorCode | "failed" | null>(
    null
  );
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });

  const inSteps = making(ctwa);
  const reviewing = ctwa
    ? ["in_review", "unknown"].includes(ctwaRunState(ctwa) ?? "")
    : false;
  useEffect(() => {
    if (!inSteps && !reviewing) return;
    let stop = false;
    const timer = setInterval(
      () => {
        void loadCtwaAd(workspaceId, ad.id)
          .then(next => {
            if (stop || !next) return;
            setLocal(next);
            if (!making(next)) settled.current(next);
          })
          .catch(() => undefined);
      },
      inSteps ? PRODUCT_META_POLL_MS : CTWA_REVIEW_POLL_MS
    );
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [inSteps, reviewing, workspaceId, ad.id]);

  /** "Create ad" (or its Try again): null once Meta took it, else why it was refused. */
  const create = useCallback(
    async (
      asset: ProductAdCtwaAsset
    ): Promise<ProductsErrorCode | "failed" | null> => {
      setSending(true);
      setRefusal(null);
      try {
        const next = await createCtwaAd(workspaceId, ad.id, {
          requestId: adRequestId(),
          asset,
        });
        setLocal(next);
        if (!making(next)) settled.current(next);
        return null;
      } catch (error) {
        const code = error instanceof ProductDraftError ? error.code : "failed";
        setRefusal(code);
        return code;
      } finally {
        setSending(false);
      }
    },
    [workspaceId, ad.id]
  );

  const run = useCallback(
    async (request: ProductAdCtwaRunRequest) => {
      setSending(true);
      setRefusal(null);
      try {
        const next = await runCtwaAd(workspaceId, ad.id, request);
        setLocal(next);
        settled.current(next);
        return true;
      } catch (error) {
        setRefusal(error instanceof ProductDraftError ? error.code : "failed");
        return false;
      } finally {
        setSending(false);
      }
    },
    [workspaceId, ad.id]
  );

  return { ctwa, sending, refusal, create, run, making: inSteps };
}

/**
 * Where Meta's steps stand: the index of the step being made (or the one a
 * failed attempt stopped at), the step count when all were made, and -1
 * when a failure doesn't say where it stopped.
 */
export function ctwaStepAt(
  ctwa: Pick<ProductAdCtwaRecord, "state" | "failedStep">
): number {
  const steps = PRODUCT_AD_CTWA_STEPS as readonly string[];
  if (ctwa.state === "failed") {
    // Null: it failed once everything was made (Meta didn't approve it).
    if (ctwa.failedStep === null) return steps.length;
    return ctwa.failedStep ? steps.indexOf(ctwa.failedStep) : -1;
  }
  const at = steps.indexOf(ctwa.state);
  return at === -1 ? steps.length : at;
}

/** Meta's steps as they're made: done, the one being made (or the one that failed), the ones to come. */
export function CtwaSteps({ ctwa }: { ctwa: ProductAdCtwaRecord }) {
  const at = ctwaStepAt(ctwa);
  const failed = ctwa.state === "failed";
  return (
    <ol className={styles.steps} aria-label={COPY.stepsLabel}>
      {PRODUCT_AD_CTWA_STEPS.map((step, index) => {
        const state =
          at === -1
            ? "next"
            : index < at
              ? "done"
              : index === at
                ? failed
                  ? "failed"
                  : "now"
                : "next";
        return (
          <li key={step} className={styles.stepItem} data-state={state}>
            <span className={styles.stepMark} aria-hidden="true">
              {state === "done" ? <Check /> : state === "failed" ? <X /> : null}
            </span>
            {COPY.steps[step]}
            <span className="sr-only">
              {state === "done"
                ? `, ${PRODUCTS_COPY.ad.stepStates.done}`
                : state === "now"
                  ? `, ${PRODUCTS_COPY.ad.stepStates.now}`
                  : state === "failed"
                    ? `, ${COPY.stoppedHere}`
                    : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The ad's state in a word, for the receipt and the tile's stamp. */
export function ctwaStatusWord(ctwa: ProductAdCtwaRecord): string | null {
  const run = ctwaRunState(ctwa);
  if (run === "unknown") return COPY.checkingMeta;
  if (run === "in_review") return COPY.inReview;
  if (run === "running") return COPY.running;
  if (run === "disapproved") return COPY.disapproved;
  if (ctwa.state === "paused") return COPY.paused;
  return null;
}

/** The workbench's side for a WhatsApp-ad tile. */
export function CtwaDetails({
  ad,
  ctwa,
  readiness,
  onCheckAgain,
  checking,
}: {
  ad: Pick<ProductAdRecord, "ctwa">;
  ctwa: ProductAdCtwaRecord | null;
  /** Null while it loads, or when it couldn't be read. */
  readiness: ProductsCtwaReadiness | null;
  onCheckAgain: () => void;
  checking: boolean;
}) {
  const greeting = ad.ctwa?.greeting ?? null;
  const questions = ad.ctwa?.questions ?? [];
  const missing = readiness?.connected && readiness.pageHasWhatsApp === false;
  const run = ctwa ? ctwaRunState(ctwa) : null;
  return (
    <div className={styles.ctwa}>
      {missing ? (
        <div className={styles.linkFix} role="status">
          <div className={styles.linkFixRow} aria-hidden="true">
            <span className={styles.linkEnd}>
              <FileText />
              {readiness?.pageName ?? COPY.page}
            </span>
            <span className={styles.linkBroken}>
              <X />
            </span>
            <span className={styles.linkEnd}>
              <MessageCircle />
              {COPY.whatsappNumber}
            </span>
          </div>
          <p className={styles.note}>{BENCH.states.pageWhatsAppMissing}</p>
          <div className={styles.linkFixActions}>
            <Button asChild variant="link" size="sm">
              <a
                href={BUSINESS_SUITE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {BENCH.states.linkInBusinessSuite}
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={checking}
              onClick={onCheckAgain}
            >
              {checking ? BENCH.states.checking : BENCH.states.checkAgain}
            </Button>
          </div>
        </div>
      ) : null}

      {greeting ? (
        <section className={styles.ctwaBlock} aria-label={COPY.chatOpensWith}>
          <h3 className={styles.railTitle}>
            <MessageCircle aria-hidden="true" />
            {COPY.chatOpensWith}
          </h3>
          <div className={styles.chat}>
            <p className={styles.bubble}>{greeting}</p>
            {questions.length > 0 ? (
              <ul className={styles.quickReplies}>
                {questions.map(question => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className={styles.ctwaBlock} aria-label={COPY.shown}>
        <h3 className={styles.railTitle}>
          <Globe aria-hidden="true" />
          {COPY.shown}
        </h3>
        <ul className={styles.shownChips}>
          <li>
            <FileText aria-hidden="true" />
            {COPY.placements}
          </li>
          <li>
            <MapPin aria-hidden="true" />
            {COPY.country}
          </li>
          <li>
            <Users aria-hidden="true" />
            {COPY.ages}
          </li>
          <li data-locked="">
            <Lock aria-hidden="true" />
            {COPY.instagramLocked}
          </li>
        </ul>
      </section>

      <section className={styles.ctwaBlock} aria-label={COPY.now}>
        <h3 className={styles.railTitle}>{COPY.now}</h3>
        <p className={styles.note}>
          {ctwa === null
            ? COPY.notMadeLine
            : run === "unknown"
              ? COPY.checkingMeta
              : run && ctwa.dailyBudgetCents !== null
                ? `${ctwaStatusWord(ctwa)} · ${COPY.runningLine(ctwa.dailyBudgetCents, ctwa.endsAt)}`
                : ctwa.state === "paused"
                  ? COPY.pausedLine
                  : ctwa.state === "failed"
                    ? ctwa.dailyBudgetCents === null
                      ? COPY.failedLine
                      : COPY.deliveryUnknown
                    : COPY.creating}
        </p>
        {ctwa ? <CtwaSteps ctwa={ctwa} /> : null}
      </section>
    </div>
  );
}

/**
 * Run's confirm: a $/day stepper (from the account's minimum to the
 * server's cap) and 1 or 3 days, "At most $3 · Meta reviews it before it
 * runs", Keep paused first. The server checks the caps again.
 */
export function RunSheet({
  open,
  onOpenChange,
  onReturnFocus,
  maxDailyCents,
  maxDays,
  sending,
  problem,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReturnFocus?: () => void;
  maxDailyCents: number;
  maxDays: number;
  sending: boolean;
  problem: string | null;
  onRun: (request: ProductAdCtwaRunRequest) => void;
}) {
  const ids = useId();
  const min = PRODUCT_AD_CTWA_MIN_DAILY_CENTS;
  const top = Math.max(min, maxDailyCents);
  const dayChoices = [1, 3].filter(days => days <= Math.max(1, maxDays));
  const [daily, setDaily] = useState(min);
  const [days, setDays] = useState(dayChoices[dayChoices.length - 1] ?? 1);
  // Each opening starts from the account's minimum, for the longest choice.
  const [openedAs, setOpenedAs] = useState(open);
  if (open !== openedAs) {
    setOpenedAs(open);
    if (open) {
      setDaily(min);
      setDays(dayChoices[dayChoices.length - 1] ?? 1);
    }
  }
  const total = daily * days;
  return (
    <Dialog open={open} onOpenChange={next => !sending && onOpenChange(next)}>
      <DialogContent
        onCloseAutoFocus={event => {
          if (onReturnFocus) {
            event.preventDefault();
            onReturnFocus();
          }
        }}
        showCloseButton={false}
        overlayClassName={theme.scrim}
        className={cn(theme.theme, styles.sheet)}
      >
        <DialogTitle className={cn(theme.displayM, styles.sheetTitle)}>
          {COPY.runTitle}
        </DialogTitle>
        <div className={styles.runBody}>
          <div className={styles.runRow}>
            <span id={`${ids}-daily`} className={styles.runLabel}>
              {COPY.perDayLabel}
            </span>
            <div
              className={styles.stepper}
              role="group"
              aria-labelledby={`${ids}-daily`}
            >
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={COPY.less}
                disabled={sending || daily <= min}
                onClick={() => setDaily(value => Math.max(min, value - 100))}
              >
                <Minus aria-hidden="true" />
              </Button>
              <output className={styles.stepperValue} aria-live="polite">
                {COPY.perDay(daily)}
              </output>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={COPY.more}
                disabled={sending || daily + 100 > top}
                onClick={() => setDaily(value => Math.min(top, value + 100))}
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className={styles.runRow}>
            <span id={`${ids}-days`} className={styles.runLabel}>
              {COPY.forLabel}
            </span>
            <div
              className={styles.dayChips}
              role="radiogroup"
              aria-labelledby={`${ids}-days`}
            >
              {dayChoices.map(choice => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={choice === days}
                  data-on={choice === days || undefined}
                  className={styles.dayChip}
                  disabled={sending}
                  onClick={() => setDays(choice)}
                >
                  {COPY.days(choice)}
                </button>
              ))}
            </div>
          </div>
          <DialogDescription className={styles.note}>
            {COPY.atMost(total)}
          </DialogDescription>
          {problem ? (
            <p role="alert" className={styles.issue}>
              {problem}
            </p>
          ) : null}
        </div>
        <div className={styles.sheetActions}>
          <Button
            type="button"
            variant="ghost"
            disabled={sending}
            onClick={() => onOpenChange(false)}
          >
            {COPY.keepPaused}
          </Button>
          <Button
            type="button"
            disabled={sending}
            onClick={() => onRun({ dailyBudgetCents: daily, days })}
          >
            {COPY.runFor(total)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
