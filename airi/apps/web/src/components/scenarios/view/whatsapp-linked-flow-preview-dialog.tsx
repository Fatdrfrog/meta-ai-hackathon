"use client";

import type { WhatsAppFlowConfig } from "@/components/scenarios/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExternalLink, Info, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

type WhatsAppLinkedFlowPreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flowId?: string | null;
  flowName?: string | null;
  flowStatus?: string | null;
  flowAction?: "navigate" | "data_exchange";
  previewUrl?: string | null;
  flowConfig?: WhatsAppFlowConfig | null;
  loading?: boolean;
  error?: string | null;
};

export function WhatsAppLinkedFlowPreviewDialog({
  open,
  onOpenChange,
  flowId,
  flowName,
  flowStatus,
  flowAction,
  previewUrl = null,
  flowConfig,
  loading = false,
  error = null,
}: WhatsAppLinkedFlowPreviewDialogProps) {
  const t = useTranslations("Scenarios");
  const resolvedTitle =
    (flowName || "").trim() ||
    (flowId || "").trim() ||
    t("linkedFlowPreviewTitleFallback");
  const screens = flowConfig?.screens ?? [];
  const providerManaged = Boolean(
    !loading && !error && !flowConfig && previewUrl
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{resolvedTitle}</DialogTitle>
          <DialogDescription>
            {providerManaged
              ? t("flowProviderReferenceDescription")
              : t("linkedFlowPreviewDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {flowId ? (
              <span>
                {t("linkedFlowPreviewFlowId")}: {flowId}
              </span>
            ) : null}
            {flowStatus ? (
              <Badge variant="secondary">{flowStatus}</Badge>
            ) : null}
            {flowAction ? <Badge variant="outline">{flowAction}</Badge> : null}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("linkedFlowPreviewLoading")}
            </div>
          ) : null}

          {!loading && error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {providerManaged && previewUrl ? (
            <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Info
                  className="h-4 w-4 text-green-700 dark:text-green-300"
                  aria-hidden
                />
                {t("flowProviderReferenceTitle")}
              </div>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="mt-3 h-8 gap-1.5 text-xs"
              >
                <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  {t("flowProviderReferencePreview")}
                </a>
              </Button>
            </div>
          ) : null}

          {!loading && !error && flowConfig ? (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {t("linkedFlowPreviewButtonText")}:{" "}
                    {(flowConfig.ctaText || "").trim() || "Open"}
                  </span>
                  {flowConfig.bodyText ? (
                    <span>{t("linkedFlowPreviewBodyIncluded")}</span>
                  ) : null}
                  {flowConfig.headerText ? (
                    <span>{t("linkedFlowPreviewHeaderIncluded")}</span>
                  ) : null}
                  {flowConfig.footerText ? (
                    <span>{t("linkedFlowPreviewFooterIncluded")}</span>
                  ) : null}
                </div>
              </div>

              {screens.map(screen => (
                <div
                  key={screen.id}
                  className="rounded-lg border bg-background p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">
                        {screen.title}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("linkedFlowPreviewScreenId")}: {screen.id}
                      </div>
                    </div>
                    <Badge variant="outline">
                      {t("linkedFlowPreviewFieldCount", {
                        count: screen.fields.length,
                      })}
                    </Badge>
                  </div>

                  <div className="mt-3 space-y-2">
                    {screen.fields.map(field => (
                      <div
                        key={field.id}
                        className="rounded-md border bg-muted/10 px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-medium">
                            {(field.label || "").trim() || field.id}
                          </div>
                          <Badge variant="secondary">{field.fieldType}</Badge>
                          {field.required ? (
                            <Badge variant="outline">
                              {t("linkedFlowPreviewRequired")}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t("linkedFlowPreviewFieldId")}: {field.id}
                        </div>
                        {field.helperText ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {field.helperText}
                          </div>
                        ) : null}
                        {field.options && field.options.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {field.options.map(option => (
                              <span
                                key={option.id}
                                className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
                              >
                                {option.title}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
