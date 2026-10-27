"use client";

import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Input } from "@/components/ui/input";
import { ScenarioIntegerInput } from "@/components/scenarios/nodes/integer-input";
import { cn } from "@/lib/utils";
import type { ServiceMessageFieldErrorMap } from "./service-message-field-errors";

export const ServiceMessageFieldErrorsContext =
  createContext<ServiceMessageFieldErrorMap>(new Map());

type AccessibilityProps = {
  "aria-invalid"?: ComponentProps<typeof Input>["aria-invalid"];
  "aria-describedby"?: string;
};

/**
 * An error that belongs to a group of inputs (a contact without a name,
 * coordinates out of range). The group renders it once with
 * `ServiceGroupError`; its inputs point at it through `inputProps`.
 */
export function useServiceGroupError(fieldKey: string): {
  id: string;
  message: string | undefined;
  inputProps: AccessibilityProps;
} {
  const id = useId() + "-group-error";
  const errors = useContext(ServiceMessageFieldErrorsContext);
  const message = errors.get(fieldKey)?.message;
  return {
    id,
    message,
    inputProps: message ? { "aria-invalid": true, "aria-describedby": id } : {},
  };
}

export function ServiceGroupError({
  fieldKey,
  id,
  asField = false,
  className,
}: {
  fieldKey: string;
  /** The id from `useServiceGroupError`, so inputs can describe themselves. */
  id?: string;
  /**
   * Marks the error itself as the field, for a group whose fix is elsewhere
   * (another control, removing items). "Show" then focuses the error text.
   */
  asField?: boolean;
  className?: string;
}) {
  const errors = useContext(ServiceMessageFieldErrorsContext);
  const message = errors.get(fieldKey)?.message;
  if (!message) return null;
  return (
    <p
      id={id}
      data-sm-field={asField ? fieldKey : undefined}
      className={cn("text-[11px] leading-snug text-destructive", className)}
    >
      {message}
    </p>
  );
}

function joinIds(...ids: Array<string | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined || undefined;
}

/** The existing inputs keep their behavior; labels and diagnostics share one owner. */
function ServiceField({
  label,
  fieldKey,
  className,
  children,
}: {
  /** Shown above the input only when passed; never taken from a placeholder. */
  label?: string;
  fieldKey?: string;
  className?: string;
  children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby"?: string;
  }) => ReactNode;
}) {
  const id = useId();
  const errors = useContext(ServiceMessageFieldErrorsContext);
  const error = fieldKey ? errors.get(fieldKey)?.message : undefined;
  return (
    <label
      htmlFor={id}
      data-sm-field={fieldKey}
      className={`grid min-w-0 flex-1 gap-1 text-xs ${className?.includes("col-span-2") ? "col-span-2" : ""}`}
    >
      {label ? (
        <span className="font-medium text-muted-foreground">{label}</span>
      ) : null}
      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": error ? `${id}-error` : undefined,
      })}
      {error ? (
        <span id={`${id}-error`} className="text-destructive">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function ServiceMessageInput({
  label,
  fieldKey,
  ...props
}: ComponentProps<typeof Input> & { label?: string; fieldKey?: string }) {
  return (
    <ServiceField label={label} fieldKey={fieldKey} className={props.className}>
      {accessibility => (
        <Input
          {...props}
          id={accessibility.id}
          aria-invalid={
            accessibility["aria-invalid"] || props["aria-invalid"] || undefined
          }
          aria-describedby={joinIds(
            accessibility["aria-describedby"],
            props["aria-describedby"]
          )}
          className={cn(props.className, "bg-background")}
          aria-label={label ?? props["aria-label"]}
        />
      )}
    </ServiceField>
  );
}

export function ServiceMessageIntegerInput({
  label,
  fieldKey,
  ...props
}: ComponentProps<typeof ScenarioIntegerInput> & {
  label?: string;
  fieldKey?: string;
}) {
  return (
    <ServiceField label={label} fieldKey={fieldKey} className={props.className}>
      {accessibility => (
        <ScenarioIntegerInput
          {...props}
          id={accessibility.id}
          aria-invalid={
            accessibility["aria-invalid"] || props["aria-invalid"] || undefined
          }
          aria-describedby={joinIds(
            accessibility["aria-describedby"],
            props["aria-describedby"]
          )}
          className={cn(props.className, "bg-background")}
          aria-label={label ?? props["aria-label"]}
        />
      )}
    </ServiceField>
  );
}
