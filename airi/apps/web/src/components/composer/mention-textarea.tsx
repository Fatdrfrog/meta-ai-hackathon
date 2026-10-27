"use client";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

export type MentionTextareaHandle = HTMLTextAreaElement;

export type MentionTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange" | "placeholder"
> & {
  value: string;
  onValueChange: (value: string, target: HTMLTextAreaElement) => void;
  renderValue: (value: string) => ReactNode;
  placeholder: string;
  minHeight: number;
  maxHeight: number;
  textareaClassName?: string;
  overlayClassName?: string;
  placeholderClassName?: string;
};

export const MentionTextarea = forwardRef<
  MentionTextareaHandle,
  MentionTextareaProps
>(function MentionTextarea(
  {
    value,
    onValueChange,
    renderValue,
    placeholder,
    minHeight,
    maxHeight,
    textareaClassName,
    overlayClassName,
    placeholderClassName,
    className,
    onScroll,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    ...textareaProps
  },
  forwardedRef
) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });

  useImperativeHandle(
    forwardedRef,
    () => localRef.current as MentionTextareaHandle
  );

  useLayoutEffect(() => {
    const textarea = localRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(
      minHeight,
      Math.min(textarea.scrollHeight, maxHeight)
    )}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    setScroll(current => {
      const next = {
        left: textarea.scrollLeft,
        top: textarea.scrollTop,
      };
      return current.left === next.left && current.top === next.top
        ? current
        : next;
    });
  }, [maxHeight, minHeight, value]);

  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden",
          overlayClassName
        )}
      >
        <div
          data-testid="mention-textarea-overlay"
          style={{
            transform: `translate(${-scroll.left}px, ${-scroll.top}px)`,
          }}
        >
          {value ? (
            renderValue(value)
          ) : (
            <span className={cn("text-muted-foreground", placeholderClassName)}>
              {placeholder}
            </span>
          )}
        </div>
      </div>
      <Textarea
        {...textareaProps}
        ref={localRef}
        value={value}
        placeholder=""
        aria-label={ariaLabel ?? (ariaLabelledBy ? undefined : placeholder)}
        aria-labelledby={ariaLabelledBy}
        className={cn(className, textareaClassName)}
        onChange={event =>
          onValueChange(event.currentTarget.value, event.currentTarget)
        }
        onScroll={event => {
          setScroll({
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          });
          onScroll?.(event);
        }}
      />
    </div>
  );
});
