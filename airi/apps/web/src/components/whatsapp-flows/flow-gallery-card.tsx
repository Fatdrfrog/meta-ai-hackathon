"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  getWhatsAppFlowStatusVariant,
  type WhatsAppFlowSummary,
} from "@/lib/whatsapp/flows/client";
import { WHATSAPP_FLOW_CATEGORIES } from "@icecore/shared/types/whatsapp-flows";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { FlowGalleryPreview } from "./flow-gallery-preview";
import type { FlowGalleryPreviewState } from "./use-flow-gallery-previews";

type FlowGalleryCardProps = {
  flow: WhatsAppFlowSummary;
  preview: FlowGalleryPreviewState;
  loadPreview: (flow: WhatsAppFlowSummary) => void;
  retryPreview: (flow: WhatsAppFlowSummary) => void;
  children: ReactNode;
};

export function FlowGalleryCard({
  flow,
  preview,
  loadPreview,
  retryPreview,
  children,
}: FlowGalleryCardProps) {
  const t = useTranslations("WhatsAppFlows");
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const status = flow.status || "UNKNOWN";
  const unavailable = flow.providerUnavailable || status === "MISSING";
  const issues = flow.validation_errors?.length ?? 0;
  const updated = flow.updated_at || flow.updated_time || flow.created_at;
  const date = updated ? new Date(updated) : null;

  useEffect(() => {
    if (unavailable || !cardRef.current) return;
    if (typeof IntersectionObserver === "undefined") {
      loadPreview(flow);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          loadPreview(flow);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" }
    );
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [flow, loadPreview, unavailable]);

  return (
    <Card
      ref={cardRef}
      role="listitem"
      aria-labelledby={titleId}
      className="min-w-0 gap-0 border-0 bg-transparent py-0 shadow-none"
    >
      <CardHeader className="gap-2 px-1 pt-1 pb-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <h2
            id={titleId}
            className="min-w-0 flex-1 text-sm font-semibold [overflow-wrap:anywhere]"
          >
            {flow.name || flow.id}
          </h2>
          <Badge
            className="shrink-0 text-xs"
            variant={getWhatsAppFlowStatusVariant(status)}
          >
            {[
              "DRAFT",
              "PUBLISHED",
              "DEPRECATED",
              "BLOCKED",
              "THROTTLED",
              "MISSING",
              "UNKNOWN",
            ].includes(status)
              ? t(`statuses.${status.toLowerCase()}`)
              : status}
          </Badge>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {flow.categories
              ?.map(category =>
                WHATSAPP_FLOW_CATEGORIES.some(known => known === category)
                  ? t(`categories.${category}`)
                  : category
              )
              .join(" · ")}
          </p>
          <div className="flex shrink-0 items-center gap-2">{children}</div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 px-1 pb-0">
        <FlowGalleryPreview
          model={preview.status === "ready" ? preview.model : null}
          loading={
            !unavailable &&
            ["idle", "queued", "loading"].includes(preview.status)
          }
          error={
            unavailable
              ? t("gallery.providerUnavailable")
              : preview.status === "error"
                ? preview.error
                : null
          }
          onRetry={unavailable ? undefined : () => retryPreview(flow)}
        />
        {flow.managedArtifact ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t(
              flow.managedArtifact.cleanupEligibility === "STATUS_UNVERIFIED"
                ? "table.providerStatusUnverified"
                : "table.managedArtifact"
            )}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-2 px-1 pt-3 pb-4">
        <div className="min-w-0 text-xs text-muted-foreground">
          <p className={issues ? "text-destructive" : ""}>
            {issues
              ? t("table.validationIssues", { count: issues })
              : flow.json_version
                ? t("table.noIssues")
                : t("table.validationUnknown")}
          </p>
          {date && !Number.isNaN(date.getTime()) ? (
            <time className="mt-0.5 block" dateTime={date.toISOString()}>
              {date.toLocaleDateString()}
            </time>
          ) : null}
        </div>
      </CardFooter>
    </Card>
  );
}
