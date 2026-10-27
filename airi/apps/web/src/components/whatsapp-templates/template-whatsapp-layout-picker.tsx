"use client";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { WhatsAppMarketingLayout } from "./template-whatsapp-layout";

function StandardShapePreview() {
  return (
    <div
      aria-hidden="true"
      className="space-y-1 rounded-lg border bg-background/80 p-2"
    >
      <div className="h-3 rounded bg-muted" />
      <div className="h-8 rounded bg-muted/80" />
      <div className="h-2 w-2/3 rounded bg-muted/60" />
      <div className="flex gap-1 pt-0.5">
        <div className="h-4 flex-1 rounded-full border border-border bg-background" />
        <div className="h-4 flex-1 rounded-full border border-border bg-background" />
      </div>
    </div>
  );
}

function CarouselShapePreview() {
  return (
    <div
      aria-hidden="true"
      className="space-y-1 rounded-lg border bg-background/80 p-2"
    >
      <div className="h-6 rounded bg-muted/80" />
      <div className="flex gap-1">
        {["one", "two", "three"].map(key => (
          <div
            key={key}
            className="min-w-0 flex-1 overflow-hidden rounded border border-border bg-background"
          >
            <div className="h-6 bg-muted" />
            <div className="m-0.5 h-2 rounded bg-muted/50" />
            <div className="mx-0.5 mb-0.5 h-2 rounded-full border border-border" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LayoutChoiceCard({
  value,
  selected,
  title,
  description,
  includes,
  excludes,
  preview,
}: {
  value: WhatsAppMarketingLayout;
  selected: boolean;
  title: string;
  description: string;
  includes: string;
  excludes: string;
  preview: ReactNode;
}) {
  return (
    <label
      data-slot="whatsapp-layout-choice"
      data-layout={value}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex cursor-pointer flex-col gap-3 rounded-xl border p-3.5 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5 shadow-xs"
          : "border-border bg-background hover:bg-muted/40"
      )}
    >
      <div className="flex items-start gap-2.5">
        <RadioGroupItem
          value={value}
          aria-label={title}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium leading-none">{title}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      {preview}
      <ul className="space-y-1.5 text-[11px] leading-snug">
        <li className="flex gap-1.5 text-foreground">
          <Check className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{includes}</span>
        </li>
        <li className="flex gap-1.5 text-muted-foreground">
          <X className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{excludes}</span>
        </li>
      </ul>
    </label>
  );
}

export function TemplateWhatsAppLayoutPicker({
  value,
  disabled,
  showHiddenStandardNote,
  showHiddenCarouselNote,
  onChange,
}: {
  value: WhatsAppMarketingLayout;
  disabled?: boolean;
  showHiddenStandardNote?: boolean;
  showHiddenCarouselNote?: boolean;
  onChange: (layout: WhatsAppMarketingLayout) => void;
}) {
  const tTemplates = useTranslations("templates");

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {tTemplates("form.layoutHint")}
      </p>
      <RadioGroup
        value={value}
        disabled={disabled}
        aria-label={tTemplates("form.layout")}
        className="grid gap-3 sm:grid-cols-2"
        onValueChange={next => {
          if (next === "standard" || next === "carousel") {
            onChange(next);
          }
        }}
      >
        <LayoutChoiceCard
          value="standard"
          selected={value === "standard"}
          title={tTemplates("form.layoutStandard")}
          description={tTemplates("form.layoutStandardDescription")}
          includes={tTemplates("form.layoutStandardIncludes")}
          excludes={tTemplates("form.layoutStandardExcludes")}
          preview={<StandardShapePreview />}
        />
        <LayoutChoiceCard
          value="carousel"
          selected={value === "carousel"}
          title={tTemplates("form.layoutCarousel")}
          description={tTemplates("form.layoutCarouselDescription")}
          includes={tTemplates("form.layoutCarouselIncludes")}
          excludes={tTemplates("form.layoutCarouselExcludes")}
          preview={<CarouselShapePreview />}
        />
      </RadioGroup>
      {value === "carousel" && showHiddenStandardNote ? (
        <p className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {tTemplates("form.layoutHiddenStandard")}
        </p>
      ) : null}
      {value === "standard" && showHiddenCarouselNote ? (
        <p className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {tTemplates("form.layoutHiddenCarousel")}
        </p>
      ) : null}
    </div>
  );
}
