"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductsMetaReadiness } from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { CircleAlert, Globe, MoreHorizontal } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import useSWR from "swr";
import {
  fetchMetaReadiness,
  productsMetaUrl,
  refreshMetaReadiness,
} from "./meta-client";
import theme from "./product-theme.module.css";
import styles from "./product-workbench.module.css";
import type { ProductDraftError } from "./products-client";

// What every workbench shares: the footer with who it goes out as, the ⋯
// menu and the one Meta action; the Meta credit chips under the preview;
// and what the workspace can do on Meta now (GET /products/meta).

const COPY = PRODUCTS_COPY.workbench;

/**
 * What the workspace can do on Meta now; one request for every workbench
 * (SWR's key). `checkAgain` reads it past the server's cache ("Check
 * again", and after Meta refused a press), into the same key; `checking`
 * is true while it does.
 */
export function useMetaReadiness(workspaceId: string) {
  const swr = useSWR<ProductsMetaReadiness, ProductDraftError>(
    productsMetaUrl(workspaceId),
    fetchMetaReadiness,
    { revalidateOnFocus: true, shouldRetryOnError: false }
  );
  const { mutate } = swr;
  const [checking, setChecking] = useState(false);
  const checkAgain = useCallback(async () => {
    setChecking(true);
    try {
      await mutate(refreshMetaReadiness(workspaceId), { revalidate: false });
    } catch {
      // Meta couldn't be read: what was known stays.
    } finally {
      setChecking(false);
    }
  }, [mutate, workspaceId]);
  return {
    data: swr.data,
    error: swr.error,
    checking: checking || swr.isValidating,
    checkAgain,
  };
}

/** The Meta models that made it, once per workbench. */
export function MetaCredits({ chat = false }: { chat?: boolean }) {
  return (
    <ul className={styles.credits} aria-label={COPY.creditsLabel}>
      {(chat ? COPY.creditsChat : COPY.credits).map(name => (
        <li key={name}>
          <span aria-hidden="true" className={styles.creditDot} />
          {name}
        </li>
      ))}
    </ul>
  );
}

/** One ⋯ menu entry. */
export type MoreItem = {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
};

/** The ⋯ menu: downloads, the editors, a test, Back to video N. Nothing copies text. */
export function MoreMenu({ items }: { items: readonly MoreItem[] }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={COPY.more}
          className={styles.more}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={cn(theme.theme, theme.popover, styles.menu)}
      >
        {items.map(item => (
          <DropdownMenuItem
            key={item.key}
            disabled={item.disabled}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The workbench's footer: who it goes out as, the ⋯ menu, and the one Meta
 * action (or its receipt). `note` says why the action waits, under it.
 */
export function WorkbenchFooter({
  target,
  more,
  action,
  note,
  alert,
}: {
  target: string | null;
  more: readonly MoreItem[];
  action: ReactNode;
  note?: ReactNode;
  /** A refusal or a failure, said as an alert. */
  alert?: ReactNode;
}) {
  return (
    <footer className={styles.footer}>
      {alert ? (
        <p role="alert" className={styles.footerAlert}>
          <CircleAlert aria-hidden="true" />
          <span>{alert}</span>
        </p>
      ) : null}
      <div className={styles.footerRow}>
        {target ? (
          <span className={styles.target}>
            <Globe aria-hidden="true" />
            {target}
          </span>
        ) : (
          <span />
        )}
        <div className={styles.footerActions}>
          <MoreMenu items={more} />
          {action}
        </div>
      </div>
      {note ? <p className={styles.footerNote}>{note}</p> : null}
    </footer>
  );
}
