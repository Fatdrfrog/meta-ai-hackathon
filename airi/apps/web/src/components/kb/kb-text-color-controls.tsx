"use client";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  getKBColorSwatches,
  readKBTextStyleColors,
  sanitizeKBColorValue,
  type KBColorKind,
} from "@/lib/kb/kb-text-colors";
import { cn } from "@/lib/utils";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Check, Highlighter, Palette, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useState } from "react";

const CONTROL_CONFIG = {
  text: {
    labelKey: "textColor",
    resetKey: "resetTextColor",
    fallbackColor: "#111827",
    Icon: Palette,
  },
  highlight: {
    labelKey: "highlightColor",
    resetKey: "resetHighlightColor",
    fallbackColor: "#fef3c7",
    Icon: Highlighter,
  },
} as const;

function applyKBColor(editor: Editor, kind: KBColorKind, value: string | null) {
  const color = sanitizeKBColorValue(value);
  const chain = editor.chain().focus();

  if (kind === "text") {
    return color ? chain.setColor(color).run() : chain.unsetColor().run();
  }

  return color
    ? chain.setBackgroundColor(color).run()
    : chain.unsetBackgroundColor().run();
}

function KBColorPickerButton({
  editor,
  kind,
  value,
}: {
  editor: Editor;
  kind: KBColorKind;
  value: string | null;
}) {
  const t = useTranslations("EnhancedMarkdownEditor");
  const [open, setOpen] = useState(false);
  const config = CONTROL_CONFIG[kind];
  const Icon = config.Icon;
  const swatches = getKBColorSwatches(kind);
  const previewColor = value ?? config.fallbackColor;

  const applyColor = (nextColor: string | null, close = true) => {
    applyKBColor(editor, kind, nextColor);
    if (close) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          onMouseDown={event => event.preventDefault()}
          aria-label={t(config.labelKey)}
        >
          <span className="relative flex h-4 w-4 items-center justify-center">
            <Icon className="h-4 w-4" />
            <span
              className={cn(
                "absolute -right-1 -bottom-1 h-2.5 w-2.5 rounded-full border border-background shadow-sm",
                kind === "highlight" ? "ring-1 ring-foreground/10" : null
              )}
              style={{ backgroundColor: previewColor }}
              aria-hidden="true"
            />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-2" portalled={false}>
        <div className="grid grid-cols-6 gap-1">
          {swatches.map(swatch => (
            <button
              key={swatch.value}
              type="button"
              className="relative h-7 w-7 rounded-md border border-border transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ backgroundColor: swatch.value }}
              onClick={() => applyColor(swatch.value)}
              aria-label={`${t(config.labelKey)} ${swatch.value}`}
              title={swatch.label}
            >
              {value === swatch.value ? (
                <Check className="absolute inset-0 m-auto h-3.5 w-3.5 text-white drop-shadow" />
              ) : null}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="color"
            value={previewColor}
            aria-label={`${t(config.labelKey)} ${t("customColor")}`}
            className="h-8 w-10 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
            onChange={event => applyColor(event.target.value, false)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 flex-1 justify-start gap-2 px-2"
            onClick={() => applyColor(null)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>{t(config.resetKey)}</span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const KBTextColorControls = memo(function KBTextColorControls({
  editor,
}: {
  editor: Editor;
}) {
  const { textColor, highlightColor } = useEditorState({
    editor,
    selector: ctx =>
      readKBTextStyleColors(ctx.editor.getAttributes("textStyle")),
  });

  return (
    <>
      <KBColorPickerButton editor={editor} kind="text" value={textColor} />
      <KBColorPickerButton
        editor={editor}
        kind="highlight"
        value={highlightColor}
      />
    </>
  );
});
