"use client";

import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/message";
import { WandSparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { AiriCreateDialogStepProps } from "../use-scenario-generator-wizard";

type TemplatesStepWizardKey =
  | "templates"
  | "selectedTemplateId"
  | "selectedTemplate"
  | "isGeneratorBusy"
  | "isCreating"
  | "handleSelectTemplate"
  | "handleClearTemplate";

export function AiriCreateDialogTemplatesStep({
  wizard,
}: AiriCreateDialogStepProps<TemplatesStepWizardKey>) {
  const t = useTranslations("Scenarios.airiCreate");
  const {
    templates,
    selectedTemplateId,
    selectedTemplate,
    isGeneratorBusy,
    isCreating,
    handleSelectTemplate,
    handleClearTemplate,
  } = wizard;

  return (
    <>
      {templates.length > 0 ? (
        <Message from="assistant">
          <MessageAvatar name="AI" />
          <MessageContent className="w-full max-w-[96%]">
            <div className="space-y-2.5">
              <div>
                <div className="text-sm font-semibold">
                  {t("templates.title")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("templates.hint")}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {templates.map(template => {
                  const isSelected = selectedTemplateId === template.id;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      aria-label={t("templates.use", {
                        template: template.title,
                      })}
                      disabled={isGeneratorBusy || isCreating}
                      onClick={() => handleSelectTemplate(template)}
                      className={[
                        "inline-flex min-h-9 max-w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium ring-1 transition-colors",
                        isSelected
                          ? "bg-primary text-primary-foreground ring-primary"
                          : "bg-background text-foreground ring-border hover:bg-muted",
                        isGeneratorBusy || isCreating
                          ? "cursor-not-allowed opacity-55"
                          : "",
                      ].join(" ")}
                    >
                      <WandSparkles className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0">
                        <span className="block truncate">{template.title}</span>
                        <span
                          className={
                            isSelected
                              ? "block truncate text-primary-foreground/80"
                              : "block truncate text-muted-foreground"
                          }
                        >
                          {template.segmentLabel}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </MessageContent>
        </Message>
      ) : null}

      {selectedTemplate ? (
        <Message from="user">
          <MessageContent className="max-w-[88%]">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                {t("templates.use", { template: selectedTemplate.title })}
              </span>
              <button
                type="button"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-primary-foreground/75 hover:bg-primary-foreground/15 hover:text-primary-foreground"
                disabled={isGeneratorBusy || isCreating}
                onClick={handleClearTemplate}
                aria-label={t("templates.clear")}
                title={t("templates.clear")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </MessageContent>
        </Message>
      ) : null}
    </>
  );
}
