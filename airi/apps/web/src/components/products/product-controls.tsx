import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import styles from "./product-controls.module.css";

// Small controls the Products parts share: the check that marks a chosen
// product or a part to make, status chips, and a segmented toggle. They read
// the Paper tokens, so they belong inside the Products column.

/**
 * The 22px check: rose with a white tick when checked, never black. It only
 * shows the state: the button, checkbox or label around it carries it.
 */
export function ProductCheck({
  checked,
  disabled = false,
  className,
}: {
  checked: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-checked={checked || undefined}
      data-disabled={disabled || undefined}
      className={cn(styles.check, className)}
    >
      <svg viewBox="0 0 16 16">
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" pathLength={1} />
      </svg>
    </span>
  );
}

export type ProductChipTone = "neutral" | "accent" | "ok" | "danger";

/** A status or cost chip: "Order form ready", "Making · 0:38", "1 AI action". */
export function ProductChip({
  tone = "neutral",
  children,
  className,
}: {
  tone?: ProductChipTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span data-tone={tone} className={cn(styles.chip, className)}>
      {children}
    </span>
  );
}

/**
 * Two or three choices side by side, the chosen one raised: "Polished · As
 * filmed", "Carousel · Order form". A group of toggle buttons named `label`.
 */
export function ProductSegmented<Value extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: ReadonlyArray<{ value: Value; label: ReactNode }>;
  value: Value;
  onChange: (value: Value) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(styles.segmented, className)}
    >
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
