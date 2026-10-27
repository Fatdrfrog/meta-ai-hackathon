"use client";

import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export const TEMPLATE_FORM_FIELD_ITEM_CLASS =
  "flex flex-col gap-1.5 space-y-0";

export const TEMPLATE_FORM_SELECT_TRIGGER_CLASS = "h-9 w-full min-w-0";

export const TEMPLATE_FORM_OPTIONAL_ACTION_CLASS =
  "h-7 shrink-0 px-2.5 text-xs font-medium";

export function TemplateFormSection({
  title,
  action,
  children,
  className,
}: {
  title: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-center gap-3">
        <h3 className="shrink-0 text-sm font-medium tracking-tight text-foreground">
          {title}
        </h3>
        <Separator className="min-w-8 flex-1" />
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
