"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MessageCircle, Plug, Settings } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export type SourceRequiredStateProps = {
  title: ReactNode;
  description: ReactNode;
  primaryHref?: string;
  primaryLabel?: ReactNode;
  secondaryHref?: string;
  secondaryLabel?: ReactNode;
  className?: string;
  icon?: "sources" | "whatsapp";
};

export function SourceRequiredState({
  title,
  description,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
  className,
  icon = "sources",
}: SourceRequiredStateProps) {
  const Icon = icon === "whatsapp" ? MessageCircle : Plug;
  const hasPrimaryAction = Boolean(primaryHref && primaryLabel);
  const hasSecondaryAction = Boolean(secondaryHref && secondaryLabel);

  return (
    <div
      className={cn(
        "flex min-h-[280px] flex-col items-center justify-center rounded-xl border bg-muted/20 px-6 py-10 text-center",
        className
      )}
    >
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-background ring-1 ring-border">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="flex max-w-xl flex-col gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {hasPrimaryAction || hasSecondaryAction ? (
        <div className="mt-5 flex w-full max-w-md flex-col gap-2 sm:flex-row sm:justify-center">
          {hasPrimaryAction ? (
            <Button
              asChild
              className="min-w-0 max-w-full [&_.btn-push-front]:min-w-0 [&_.btn-push-front]:whitespace-normal"
            >
              <Link href={primaryHref!} className="text-center">
                <Icon data-icon="inline-start" />
                {primaryLabel}
              </Link>
            </Button>
          ) : null}
          {hasSecondaryAction ? (
            <Button
              asChild
              variant="outline"
              className="min-w-0 max-w-full [&_.btn-push-front]:min-w-0 [&_.btn-push-front]:whitespace-normal"
            >
              <Link href={secondaryHref!} className="text-center">
                <Settings data-icon="inline-start" />
                {secondaryLabel}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
