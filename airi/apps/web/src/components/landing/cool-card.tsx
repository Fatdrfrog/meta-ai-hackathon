"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function CoolCard({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-b from-card/95 via-card/90 to-card/75 py-0 shadow-[0_16px_36px_-30px_hsl(var(--foreground)/0.55)] transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_22px_45px_-28px_hsl(var(--primary)/0.5)]",
        className
      )}
      {...props}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-8 -top-px h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-20 h-40 w-40 rounded-full bg-primary/10 blur-3xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      />
      {children}
    </Card>
  );
}
