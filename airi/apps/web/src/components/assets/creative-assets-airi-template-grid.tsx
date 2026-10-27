import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MarketingTemplate } from "@/lib/creative-assets/marketing-templates";
import { Film, ImageIcon, Mic2, Play, WandSparkles } from "lucide-react";
import { memo } from "react";

import type { MarketingTemplatesTranslationFn } from "./creative-assets-tiktok-inspiration";

function skillIcon(skill: MarketingTemplate["skill"]) {
  if (skill === "video") return Film;
  if (skill === "audio") return Mic2;
  if (skill === "avatar") return WandSparkles;
  return ImageIcon;
}

export const AiriTemplateGrid = memo(function AiriTemplateGrid({
  templates,
  t,
  onApply,
}: {
  templates: MarketingTemplate[];
  t: MarketingTemplatesTranslationFn;
  onApply: (template: MarketingTemplate) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {templates.map(template => {
        const Icon = skillIcon(template.skill);
        return (
          <article
            key={template.id}
            className="group flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40"
          >
            <button
              type="button"
              className="relative aspect-[9/14] w-full overflow-hidden bg-muted/40 text-left"
              onClick={() => onApply(template)}
              data-testid={`marketing-template-${template.id}`}
            >
              {template.previewVideoUrl ? (
                <>
                  {/* react-doctor-disable-next-line react-doctor/html-no-nested-interactive -- no-controls preview is aria-hidden and removed from tab order */}
                  <video
                    className="h-full w-full object-cover"
                    src={template.previewVideoUrl}
                    poster={template.posterUrl || undefined}
                    muted
                    playsInline
                    loop
                    preload="metadata"
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                </>
              ) : template.posterUrl ? (
                <>
                  {/* eslint-disable @next/next/no-img-element */}
                  {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- runtime-authored showcase URLs are not optimizer-host constrained */}
                  <img
                    src={template.posterUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                  {/* eslint-enable @next/next/no-img-element */}
                </>
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center">
                  <Icon className="size-7 text-muted-foreground" />
                  <span className="line-clamp-3 text-[11px] leading-snug text-muted-foreground">
                    {template.description}
                  </span>
                </div>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/95 via-background/70 to-transparent p-3 pt-10">
                <div className="flex items-center gap-1.5">
                  {template.badge ? (
                    <Badge className="rounded-md px-1.5 py-0 text-[10px]">
                      {template.badge}
                    </Badge>
                  ) : null}
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    @
                    {template.skill === "audio"
                      ? "Voice"
                      : template.skill === "image"
                        ? "Image"
                        : template.skill === "video"
                          ? "Video"
                          : "Avatar"}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-sm font-medium">
                  {template.title}
                </div>
              </div>
              <span
                className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              >
                <Play className="size-3.5" />
              </span>
            </button>
            <div className="flex items-center justify-between gap-2 border-t p-2">
              <p className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
                {template.description}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 rounded-md px-2 text-[11px]"
                onClick={() => onApply(template)}
              >
                {t("marketingTemplatesUse")}
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
});
