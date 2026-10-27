"use client";

import { Badge } from "@/components/ui/badge";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/message";
import { Check, WandSparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  formatSourceMentionLabel,
  getSourceMentionRole,
  SourceMentionIcon,
} from "../shared";
import type { AiriCreateDialogStepProps } from "../use-scenario-generator-wizard";

type CampaignSetupStepWizardKey =
  | "generatorStatusLabel"
  | "connectedSourceMentionOptions"
  | "selectedSourceMentions"
  | "isGeneratorBusy"
  | "handleQuickSourceMention"
  | "higgsfieldUnavailableReason"
  | "scopedSourceOptions"
  | "sourceOptionsByType"
  | "sourceScopeByType"
  | "handleToggleSourceScope";

export function AiriCreateDialogCampaignSetupStep({
  wizard,
}: AiriCreateDialogStepProps<CampaignSetupStepWizardKey>) {
  const t = useTranslations("Scenarios.airiCreate");
  const {
    generatorStatusLabel,
    connectedSourceMentionOptions,
    selectedSourceMentions,
    isGeneratorBusy,
    handleQuickSourceMention,
    higgsfieldUnavailableReason,
    scopedSourceOptions,
    sourceOptionsByType,
    sourceScopeByType,
    handleToggleSourceScope,
  } = wizard;

  return (
    <>
      <Message from="assistant">
        <MessageAvatar name="AI" />
        <MessageContent className="w-full max-w-[96%]">
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">{t("setup.title")}</div>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline">{t("setup.triggerWorkflow")}</Badge>
                <Badge variant="secondary">{generatorStatusLabel}</Badge>
              </div>
            </div>

            <div className="space-y-2 rounded-lg bg-background/70 p-2">
              {connectedSourceMentionOptions.length > 0 ? (
                <div className="space-y-1">
                  <div className="px-1 text-[11px] font-medium uppercase text-muted-foreground">
                    {t("setup.sources")}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {connectedSourceMentionOptions.map(option => {
                      const selected = selectedSourceMentions.includes(
                        option.id
                      );
                      return (
                        <button
                          key={option.id}
                          type="button"
                          disabled={isGeneratorBusy}
                          aria-label={
                            selected
                              ? t("setup.sourceSelected", {
                                  source: option.label,
                                })
                              : t("setup.addSource", { source: option.label })
                          }
                          className={[
                            "inline-flex h-8 max-w-full items-center gap-1.5 rounded-md px-2 text-xs font-medium ring-1 transition-colors",
                            selected
                              ? "bg-primary text-primary-foreground ring-primary"
                              : "bg-background text-foreground ring-border hover:bg-muted",
                            isGeneratorBusy
                              ? "cursor-not-allowed opacity-50"
                              : "",
                          ].join(" ")}
                          onClick={() => handleQuickSourceMention(option)}
                        >
                          <SourceMentionIcon
                            option={option}
                            className="h-3.5 w-3.5 shrink-0"
                          />
                          <span>{option.label}</span>
                          <span
                            className={
                              selected
                                ? "text-primary-foreground/80"
                                : "text-muted-foreground"
                            }
                          >
                            {t(`sourceRole.${getSourceMentionRole(option.id)}`)}
                          </span>
                          {selected ? (
                            <Check className="h-3.5 w-3.5 shrink-0" />
                          ) : null}
                        </button>
                      );
                    })}
                    {higgsfieldUnavailableReason ? (
                      <button
                        type="button"
                        disabled
                        aria-label={t("setup.higgsfieldUnavailable", {
                          reason: higgsfieldUnavailableReason,
                        })}
                        className="inline-flex h-8 max-w-full cursor-not-allowed items-center gap-1.5 rounded-md bg-background px-2 text-xs font-medium text-muted-foreground opacity-60 ring-1 ring-border"
                      >
                        <WandSparkles className="h-3.5 w-3.5 shrink-0" />
                        <span>Higgsfield</span>
                        <span className="truncate">
                          {t("setup.unavailable")}
                        </span>
                      </button>
                    ) : null}
                  </div>
                  {higgsfieldUnavailableReason ? (
                    <div className="px-1 text-[11px] leading-snug text-muted-foreground">
                      {higgsfieldUnavailableReason}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {scopedSourceOptions.length > 0 ? (
                <div className="space-y-1">
                  <div className="px-1 text-[11px] font-medium uppercase text-muted-foreground">
                    {t("setup.sourceAccounts")}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {scopedSourceOptions.map(option => {
                      const channelOptions =
                        sourceOptionsByType.get(option.channel) || [];
                      const selectedIds =
                        sourceScopeByType[option.channel] ??
                        channelOptions.map(item => item.id);
                      const selected = selectedIds.includes(option.id);
                      const channelLabel = formatSourceMentionLabel(
                        option.channel
                      );
                      return (
                        <button
                          key={`${option.channel}-${option.id}`}
                          type="button"
                          disabled={
                            isGeneratorBusy || channelOptions.length <= 1
                          }
                          aria-label={
                            selected
                              ? t("setup.excludeAccount", {
                                  account: option.label,
                                  channel: channelLabel,
                                })
                              : t("setup.includeAccount", {
                                  account: option.label,
                                  channel: channelLabel,
                                })
                          }
                          className={[
                            "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 text-[11px] font-medium ring-1 transition-colors",
                            selected
                              ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-100 dark:ring-emerald-900/50"
                              : "bg-background text-muted-foreground ring-border hover:bg-muted",
                            isGeneratorBusy || channelOptions.length <= 1
                              ? "cursor-not-allowed opacity-60"
                              : "",
                          ].join(" ")}
                          onClick={() =>
                            handleToggleSourceScope(option.channel, option.id)
                          }
                        >
                          {selected ? (
                            <Check className="h-3 w-3 shrink-0" />
                          ) : null}
                          <span className="min-w-0 truncate">
                            {option.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </MessageContent>
      </Message>
    </>
  );
}
