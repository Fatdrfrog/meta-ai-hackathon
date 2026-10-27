"use client";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ensureKBGoogleFontsLoaded,
  getKBGoogleFontOptions,
  sanitizeKBGoogleFontFamily,
} from "@/lib/kb/kb-google-fonts";
import { cn } from "@/lib/utils";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Check, Type } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useMemo, useState } from "react";

export const KBFontFamilyPicker = memo(function KBFontFamilyPicker({
  editor,
}: {
  editor: Editor;
}) {
  const t = useTranslations("EnhancedMarkdownEditor");
  const [open, setOpen] = useState(false);
  const fontOptions = useMemo(() => getKBGoogleFontOptions(), []);
  const { fontFamily } = useEditorState({
    editor,
    selector: ctx => ({
      fontFamily: sanitizeKBGoogleFontFamily(
        ctx.editor.getAttributes("textStyle").fontFamily
      ),
    }),
  });

  const applyFontFamily = (family: string | null) => {
    if (family) {
      ensureKBGoogleFontsLoaded([family]);
      editor.chain().focus().setFontFamily(family).run();
    } else {
      editor.chain().focus().unsetFontFamily().run();
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 max-w-[10rem] gap-1.5 px-2"
          onMouseDown={event => event.preventDefault()}
          aria-label={t("fontFamily")}
        >
          <Type className="h-4 w-4 shrink-0" />
          <span className="truncate text-xs">
            {fontFamily || t("fontFamily")}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" portalled={false}>
        <Command>
          <CommandInput placeholder={t("searchFonts")} />
          <CommandList>
            <CommandEmpty>{t("noFontsFound")}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__default"
                onSelect={() => applyFontFamily(null)}
              >
                <Check
                  className={cn(
                    "h-4 w-4",
                    fontFamily ? "opacity-0" : "opacity-100"
                  )}
                />
                <span>{t("defaultFont")}</span>
              </CommandItem>
              {fontOptions.map(option => (
                <CommandItem
                  key={option.family}
                  value={option.family}
                  onSelect={() => applyFontFamily(option.family)}
                  className="items-start"
                >
                  <Check
                    className={cn(
                      "mt-0.5 h-4 w-4",
                      fontFamily === option.family ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {option.family}
                  </span>
                  <span className="text-muted-foreground ml-auto text-[0.68rem] capitalize">
                    {option.category}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
});
