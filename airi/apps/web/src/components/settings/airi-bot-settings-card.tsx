"use client";

import { FreePlanUpsell } from "@/components/limits/free-plan-upsell";
import { AiriManagerGuardCard } from "@/components/settings/airi-manager-guard-card";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import { type WorkspaceBotSettingsApiResponse } from "@/lib/airi/workspace-bot-contract";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Rollout = "bot" | "scenarios" | "coach";

// Rollout requests change only their own switch, so they cannot overwrite
// unsaved prompt or retrieval settings in the agent form.
const ROLLOUTS = {
  bot: {
    defaultKey: "defaultBotEnabled",
    countKey: "enabledConversations",
    enabledKey: "enabled",
    applyKey: "applyToExisting",
  },
  scenarios: {
    defaultKey: "defaultScenariosEnabled",
    countKey: "scenariosEnabledConversations",
    enabledKey: "scenariosEnabled",
    applyKey: "applyScenariosToExisting",
  },
  coach: {
    defaultKey: "defaultCoachEnabled",
    countKey: "coachEnabledConversations",
    enabledKey: "coachEnabled",
    applyKey: "applyCoachToExisting",
  },
} as const;

export function AiriBotSettingsCard({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("AiContextManager");
  const { data: limits } = useCompanyLimits(workspaceId);
  const [settings, setSettings] =
    useState<WorkspaceBotSettingsApiResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<Rollout | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    setSettings(null);
    setSaving(null);
    setIsLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/airi-bot`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          }
        );
        const data = await response.json();
        if (!response.ok || data.success !== true)
          throw new Error("load failed");
        if (requestGeneration === generation.current) setSettings(data);
      } catch {
        if (
          !controller.signal.aborted &&
          requestGeneration === generation.current
        )
          setLoadFailed(true);
      } finally {
        if (requestGeneration === generation.current) setIsLoading(false);
      }
    })();
    return () => {
      controller.abort();
      generation.current = requestGeneration + 1;
    };
  }, [workspaceId, loadAttempt]);

  const applyToAll = useCallback(
    async (rollout: Rollout, enabled: boolean) => {
      if (!settings || saving) return;
      const config = ROLLOUTS[rollout];
      const requestGeneration = generation.current;
      setSaving(rollout);
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/airi-bot`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              [config.enabledKey]: enabled,
              [config.applyKey]: true,
            }),
          }
        );
        const data = await response.json();
        if (!response.ok || data.success !== true)
          throw new Error(data.error || t("botSettings.saveControlsFailed"));
        if (requestGeneration !== generation.current) return;
        setSettings(current => (current ? { ...current, ...data } : current));
        toast.success(
          t(
            rollout === "bot"
              ? `botSettings.${enabled ? "enableSuccess" : "disableSuccess"}`
              : `botSettings.${rollout === "scenarios" ? "scenario" : "coach"}${enabled ? "EnableSuccess" : "DisableSuccess"}`
          )
        );
      } catch (error) {
        if (requestGeneration === generation.current)
          toast.error(
            error instanceof Error
              ? error.message
              : t("botSettings.saveControlsFailed")
          );
      } finally {
        if (requestGeneration === generation.current) setSaving(null);
      }
    },
    [settings, saving, workspaceId, t]
  );

  const allOn =
    settings?.defaultBotEnabled &&
    settings.enabledConversations === settings.totalConversations;
  const allOff =
    settings &&
    !settings.defaultBotEnabled &&
    settings.enabledConversations === 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("botSettings.title")}</CardTitle>
        <CardDescription>{t("botSettings.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {limits?.subscriptionType === "free" && (
          <FreePlanUpsell workspaceId={workspaceId} />
        )}
        {isLoading ? (
          <div
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("botSettings.loading")}
          </div>
        ) : loadFailed ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-3 text-sm"
          >
            <span>{t("botSettings.loadFailed")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLoadAttempt(value => value + 1)}
            >
              {t("retry")}
            </Button>
          </div>
        ) : settings ? (
          <div className="divide-y rounded-lg border">
            <div className="space-y-3 p-4">
              <div className="space-y-1">
                <h4 className="text-sm font-medium">
                  {t("botSettings.autoReplyTitle")}
                </h4>
                <p className="text-xs text-muted-foreground">
                  <span>
                    {t("botSettings.coverage", {
                      enabled: settings.enabledConversations,
                      total: settings.totalConversations,
                    })}
                  </span>{" "}
                  {t(
                    settings.defaultBotEnabled
                      ? "botSettings.enabledHint"
                      : "botSettings.disabledHint"
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => applyToAll("bot", true)}
                  disabled={saving !== null || Boolean(allOn)}
                >
                  {saving === "bot" && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t(
                    allOn
                      ? "botSettings.enabledButton"
                      : "botSettings.enableButton"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => applyToAll("bot", false)}
                  disabled={saving !== null || Boolean(allOff)}
                >
                  {t("botSettings.disableButton")}
                </Button>
              </div>
            </div>
            {(["scenarios", "coach"] as const).map(rollout => {
              const config = ROLLOUTS[rollout];
              const prefix = rollout === "scenarios" ? "scenario" : "coach";
              const enabled = settings[config.defaultKey];
              const count = settings[config.countKey];
              const mixed = enabled
                ? count !== settings.totalConversations
                : count !== 0;
              return (
                <div key={rollout} className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <h4 className="text-sm font-medium">
                        {t(`botSettings.${prefix}Title`)}
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        {t(`botSettings.${prefix}Coverage`, {
                          enabled: count,
                          total: settings.totalConversations,
                        })}{" "}
                        {t(
                          `botSettings.${prefix}${enabled ? "EnabledHint" : "DisabledHint"}`
                        )}
                      </p>
                    </div>
                    <Switch
                      aria-label={t(`botSettings.${prefix}Title`)}
                      checked={enabled}
                      disabled={saving !== null}
                      onCheckedChange={checked => applyToAll(rollout, checked)}
                    />
                  </div>
                  {mixed && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={saving !== null}
                      onClick={() => applyToAll(rollout, enabled)}
                    >
                      {t(
                        enabled
                          ? "botSettings.enableButton"
                          : "botSettings.disableButton"
                      )}
                    </Button>
                  )}
                  {saving === rollout && (
                    <p role="status" className="text-xs text-muted-foreground">
                      {t("botSettings.savingControls")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="border-t pt-4">
          <AiriManagerGuardCard workspaceId={workspaceId} embedded />
        </div>
      </CardContent>
    </Card>
  );
}
