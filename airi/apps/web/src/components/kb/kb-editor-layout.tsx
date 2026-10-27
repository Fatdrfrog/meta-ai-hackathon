"use client";

import { type ReactNode, memo } from "react";
import { KBEditorBaseStyles } from "./kb-editor-base-styles";

interface KBEditorLayoutProps {
  children: ReactNode;
  titleSlot: ReactNode;
  toolbarSlot?: ReactNode;
  dialogsSlot?: ReactNode;
  statusIndicatorSlot?: ReactNode;
}

export const KBEditorLayout = memo(function KBEditorLayout({
  children,
  titleSlot,
  toolbarSlot,
  dialogsSlot,
  statusIndicatorSlot,
}: KBEditorLayoutProps) {
  return (
    <div className="flex flex-col h-full overflow-hidden min-h-0">
      <KBEditorBaseStyles />

      <div
        className="flex-1 overflow-y-auto scrollbar-hide"
        style={{ scrollbarGutter: "stable" }}
      >
        <div className="px-6 py-8 max-w-4xl mx-auto w-full pb-8">
          {titleSlot}
          <div
            aria-hidden="true"
            className="mb-6 h-2 w-full rounded-full bg-muted/40"
          />

          <div className="space-y-4">
            <div className="rounded-lg border border-border/60 bg-background">
              {toolbarSlot}
              <div className="relative">{children}</div>
            </div>
            {statusIndicatorSlot}
          </div>
        </div>
      </div>
      {dialogsSlot}
    </div>
  );
});
