"use client";

import { cn } from "@/lib/utils";
import * as React from "react";

type Crumb = { label: string; href?: string };

export function PageHeader({
  title,
  description,
  primaryAction,
  secondaryAction,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: Crumb[];
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  className?: string;
}) {
  const hasActions = Boolean(primaryAction || secondaryAction);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className={cn(
          "flex min-w-0 flex-col gap-3",
          hasActions && "sm:flex-row sm:items-start sm:justify-between"
        )}
      >
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <p className="text-muted-foreground mt-1 text-sm text-pretty whitespace-pre-wrap sm:line-clamp-2">
              {description}
            </p>
          ) : null}
        </div>
        {hasActions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {secondaryAction}
            {primaryAction}
          </div>
        ) : null}
      </div>
    </div>
  );
}
