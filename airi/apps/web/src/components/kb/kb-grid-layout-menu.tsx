"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Editor } from "@tiptap/react";
import { LayoutGrid } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo } from "react";

const GRID_COLUMN_OPTIONS = [2, 3, 4] as const;

export const KBGridLayoutMenu = memo(function KBGridLayoutMenu({
  editor,
}: {
  editor: Editor;
}) {
  const t = useTranslations("EnhancedMarkdownEditor");

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          onMouseDown={event => event.preventDefault()}
          aria-label={t("gridLayout")}
        >
          <LayoutGrid className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44" portalled={false}>
        {GRID_COLUMN_OPTIONS.map(columns => (
          <DropdownMenuItem
            key={columns}
            onSelect={() =>
              editor.chain().focus().insertKBGrid({ columns }).run()
            }
          >
            {t("gridColumns", { columns })}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
