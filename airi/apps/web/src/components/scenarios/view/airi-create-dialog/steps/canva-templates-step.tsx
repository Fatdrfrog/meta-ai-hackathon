"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/message";
import { Check, ImageIcon, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import type { AiriCreateDialogStepProps } from "../use-scenario-generator-wizard";

type CanvaTemplatesStepWizardKey =
  | "generatorStatus"
  | "readyBlueprint"
  | "selectedCanvaTemplates"
  | "canvaTemplateResult"
  | "handleToggleCanvaTemplate";

export function AiriCreateDialogCanvaTemplatesStep({
  wizard,
}: AiriCreateDialogStepProps<CanvaTemplatesStepWizardKey>) {
  const t = useTranslations("Scenarios.airiCreate");
  const {
    generatorStatus,
    readyBlueprint,
    selectedCanvaTemplates,
    canvaTemplateResult,
    handleToggleCanvaTemplate,
  } = wizard;

  return (
    <>
      {(generatorStatus === "template_selection" ||
        generatorStatus === "fetching_templates" ||
        generatorStatus === "creating") &&
      readyBlueprint ? (
        <Message from="assistant">
          <MessageAvatar name="AI" />
          <MessageContent className="w-full max-w-[96%]">
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">
                    {t("canva.title")}
                  </div>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {t("canva.hint")}
                  </p>
                </div>
                <Badge variant="secondary">
                  {t("canva.selected", {
                    count: selectedCanvaTemplates.length,
                  })}
                </Badge>
              </div>

              {canvaTemplateResult?.status === "connection_needed" ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 p-3 text-sm">
                  <div>
                    <div className="font-medium">{t("canva.connectTitle")}</div>
                    <div className="text-xs text-muted-foreground">
                      {t("canva.connectHint")}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (canvaTemplateResult.connectUrl) {
                        window.location.href = canvaTemplateResult.connectUrl;
                      }
                    }}
                  >
                    {t("canva.connectTitle")}
                  </Button>
                </div>
              ) : null}

              {canvaTemplateResult?.status === "reconnect_required" ? (
                <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  {t("canva.reconnect")}
                </div>
              ) : null}

              {canvaTemplateResult?.status === "error" ? (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {canvaTemplateResult.error || t("canva.fetchFailed")}
                </div>
              ) : null}

              {generatorStatus === "fetching_templates" &&
              !canvaTemplateResult ? (
                <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("canva.fetching")}
                </div>
              ) : null}

              {canvaTemplateResult?.status === "ok" &&
              canvaTemplateResult.items.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  {t("canva.empty")}
                </div>
              ) : null}

              {canvaTemplateResult?.items.length ? (
                <div className="grid auto-rows-[190px] grid-cols-2 gap-2 md:grid-cols-3">
                  {canvaTemplateResult.items.map((template, index) => {
                    const selected = selectedCanvaTemplates.some(
                      item => item.id === template.id
                    );
                    return (
                      <button
                        key={`${template.id}-${index}`}
                        type="button"
                        className={`group relative flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-background text-left transition-colors ${
                          selected
                            ? "border-primary ring-2 ring-primary/30"
                            : "border-border hover:border-primary/50"
                        }`}
                        onClick={() => handleToggleCanvaTemplate(template)}
                      >
                        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-muted/40">
                          {template.thumbnailUrl ? (
                            <Image
                              src={template.thumbnailUrl}
                              alt=""
                              fill
                              sizes="(min-width: 768px) 33vw, 50vw"
                              className="object-contain"
                              unoptimized
                            />
                          ) : (
                            <ImageIcon className="h-7 w-7 text-muted-foreground" />
                          )}
                        </div>
                        <div className="shrink-0 border-t bg-background p-2">
                          <div className="line-clamp-2 text-xs font-medium">
                            {template.title}
                          </div>
                        </div>
                        {selected ? (
                          <div className="absolute right-2 top-2 rounded-full bg-primary p-1 text-primary-foreground">
                            <Check className="h-3.5 w-3.5" />
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </MessageContent>
        </Message>
      ) : null}
    </>
  );
}
