"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import type { ComponentProps, ReactElement } from "react";

/** Shared dashed add control used by template + service-message button editors. */
export const WHATSAPP_DASHED_ADD_BUTTON_CLASSNAME =
  "nodrag h-8 w-full justify-center rounded-lg border border-dashed border-zinc-400/70 bg-white/80 text-[11px] font-medium text-zinc-700 hover:bg-white hover:text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:bg-zinc-900";

export function WhatsAppDashedAddButton({
  children,
  className,
  showPlus = true,
  ...props
}: ComponentProps<typeof Button> & { showPlus?: boolean }): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(WHATSAPP_DASHED_ADD_BUTTON_CLASSNAME, className)}
      onPointerDown={event => event.stopPropagation()}
      {...props}
    >
      {showPlus ? <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : null}
      {children}
    </Button>
  );
}
