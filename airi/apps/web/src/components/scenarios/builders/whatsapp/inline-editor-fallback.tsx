"use client";

import {
  resolveScenarioTokenLabel,
  SCENARIO_VARIABLE_CHIP_CLASSNAME,
  SCENARIO_VARIABLE_TOKEN_REGEX,
} from "@/components/scenarios/view/scenario-template-utils";
import { cn } from "@/lib/utils";
import {
  parseWhatsAppTextFormatting,
  type WhatsAppTextFormatSegment,
} from "@/lib/whatsapp-format";
import { createElement, Fragment, type ReactNode } from "react";
import type { WhatsAppInlineEditorProps } from "./inline-editor";
import { WHATSAPP_INLINE_EDITOR_CONTENT_CLASS } from "./inline-editor-classes";

/** How the editor's base styles wrap text (TipTap's `.ProseMirror` rule). */
const EDITOR_TEXT_WRAP_CLASS = "whitespace-break-spaces break-words";

/** Text the editor would load as HTML (see textToEditorHtml). */
const EDITOR_HTML_PATTERN = /<[a-z][\s\S]*>/i;

const FORMAT_TAGS = {
  bold: "strong",
  italic: "em",
  strikethrough: "s",
} as const;

type ResolveLabel = (token: string) => string;

/** A variable chip as the editor draws it, without its remove button. */
function WhatsAppInlineEditorFallbackChip({ label }: { label: string }) {
  return (
    <span className="inline align-baseline">
      <span className={SCENARIO_VARIABLE_CHIP_CLASSNAME}>
        <span className="truncate">{label}</span>
        <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </span>
    </span>
  );
}

function renderTextWithVariables(
  text: string,
  resolveLabel: ResolveLabel
): ReactNode {
  // Splitting on the token pattern puts each token at an odd position.
  const parts = text.split(SCENARIO_VARIABLE_TOKEN_REGEX);
  if (parts.length === 1) return text;
  return createElement(
    Fragment,
    null,
    ...parts.map((part, position) =>
      position % 2 === 1
        ? createElement(WhatsAppInlineEditorFallbackChip, {
            label: resolveLabel(part),
          })
        : part
    )
  );
}

function renderSegments(
  segments: WhatsAppTextFormatSegment[],
  resolveLabel: ResolveLabel
): ReactNode[] {
  return segments.map(segment => {
    if (segment.type === "text") {
      return renderTextWithVariables(segment.text, resolveLabel);
    }
    if (segment.kind === "monospace") {
      return createElement(
        "code",
        null,
        renderTextWithVariables(segment.text, resolveLabel)
      );
    }
    return createElement(
      FORMAT_TAGS[segment.kind],
      null,
      ...renderSegments(segment.children, resolveLabel)
    );
  });
}

/** The paragraph the editor loads for `value`, with the same marks. */
function WhatsAppInlineEditorFallbackText({
  value,
  placeholder,
  resolveVariableLabel,
}: Pick<
  WhatsAppInlineEditorProps,
  "value" | "placeholder" | "resolveVariableLabel"
>) {
  const text = value.trim();
  if (!text) {
    // The editor's placeholder floats with no height over an empty line.
    return (
      <p>
        <span className="pointer-events-none float-left h-0 opacity-40">
          {placeholder}
        </span>
        <br />
      </p>
    );
  }
  if (EDITOR_HTML_PATTERN.test(text)) return <p>{text}</p>;
  const resolveLabel: ResolveLabel = token =>
    resolveVariableLabel?.(token) ?? resolveScenarioTokenLabel(token);
  return createElement(
    "p",
    null,
    ...renderSegments(parseWhatsAppTextFormatting(text), resolveLabel)
  );
}

/**
 * The message laid out as the editor lays it out (line breaks, formatting
 * and variable chips): shown while the editor downloads and until it has
 * created its editor, so the node keeps its size.
 */
export function WhatsAppInlineEditorFallback({
  value,
  placeholder,
  className,
  error,
  resolveVariableLabel,
}: Pick<
  WhatsAppInlineEditorProps,
  "value" | "placeholder" | "className" | "error" | "resolveVariableLabel"
>) {
  return (
    <div className="w-full" data-inline-editor-fallback="">
      <div
        className={cn(
          "whatsapp-inline-editor w-full min-h-[1.5em] overflow-visible",
          "bg-transparent outline-none text-wrap break-words",
          error && "text-destructive",
          className
        )}
      >
        <div
          className={cn(
            WHATSAPP_INLINE_EDITOR_CONTENT_CLASS,
            EDITOR_TEXT_WRAP_CLASS
          )}
        >
          <WhatsAppInlineEditorFallbackText
            value={value}
            placeholder={placeholder}
            resolveVariableLabel={resolveVariableLabel}
          />
        </div>
      </div>
      {error ? (
        <p className="mt-0.5 text-[10px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
