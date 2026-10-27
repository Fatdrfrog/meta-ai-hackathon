"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type ManagerGuardSettings = {
  enabled: boolean;
  skipIfManagerRecentlyReplied: boolean;
  skipIfTaggedManagerMessage: boolean;
  managerRecentReplyWindowSeconds: number;
  managerUserLinks: unknown[];
};

type GuardResponse = {
  success: boolean;
  settings: ManagerGuardSettings;
  error?: string;
};

const DEFAULT_SETTINGS: ManagerGuardSettings = {
  enabled: true,
  skipIfManagerRecentlyReplied: true,
  skipIfTaggedManagerMessage: true,
  managerRecentReplyWindowSeconds: 300,
  managerUserLinks: [],
};

export function AiriManagerGuardCard({
  workspaceId,
  embedded = false,
}: {
  workspaceId: string;
  embedded?: boolean;
}) {
  const t = useTranslations("ManagerGuard");
  const [settings, setSettings] =
    useState<ManagerGuardSettings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] =
    useState<ManagerGuardSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [windowInput, setWindowInput] = useState("300");
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const saveRequestRef = useRef(0);

  const loadSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(false);
      setSavedSettings(null);
      const response = await fetch(
        `/api/workspaces/${workspaceId}/airi-manager-guard`,
        {
          method: "GET",
          cache: "no-store",
        }
      );

      const data = (await response
        .json()
        .catch(() => ({}))) as Partial<GuardResponse> & {
        error?: string;
      };

      if (!response.ok || !data.settings || data.success !== true) {
        throw new Error(data?.error || t("loadFailed"));
      }

      const nextSettings = data.settings;
      setSettings(nextSettings);
      setWindowInput(String(nextSettings.managerRecentReplyWindowSeconds));
      setSavedSettings(nextSettings);
      setSaveStatus("idle");
    } catch (error) {
      setLoadError(true);
      const message = error instanceof Error ? error.message : t("loadFailed");
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (isLoading || !savedSettings) return;

    const hasChanges =
      settings.enabled !== savedSettings.enabled ||
      settings.skipIfManagerRecentlyReplied !==
        savedSettings.skipIfManagerRecentlyReplied ||
      settings.skipIfTaggedManagerMessage !==
        savedSettings.skipIfTaggedManagerMessage ||
      settings.managerRecentReplyWindowSeconds !==
        savedSettings.managerRecentReplyWindowSeconds;

    if (!hasChanges) return;

    const timeout = window.setTimeout(() => {
      const requestId = ++saveRequestRef.current;

      void (async () => {
        try {
          setSaveStatus("saving");
          const response = await fetch(
            `/api/workspaces/${workspaceId}/airi-manager-guard`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(settings),
            }
          );

          const data = (await response
            .json()
            .catch(() => ({}))) as Partial<GuardResponse> & {
            error?: string;
          };

          if (!response.ok || !data.settings || data.success !== true) {
            throw new Error(data?.error || t("saveFailed"));
          }

          if (requestId !== saveRequestRef.current) return;

          const nextSettings = data.settings || settings;
          setSettings(nextSettings);
          setSavedSettings(nextSettings);
          setSaveStatus("saved");
        } catch (error) {
          if (requestId !== saveRequestRef.current) return;

          const message =
            error instanceof Error ? error.message : t("saveFailed");
          setSaveStatus("error");
          toast.error(message);
        }
      })();
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [settings, savedSettings, isLoading, workspaceId, t]);

  const sectionHeader = (
    <div className="flex items-start gap-3">
      <div className="space-y-1">
        <CardTitle className="text-sm">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </div>
    </div>
  );

  const sectionContent = (
    <>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      ) : loadError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 text-sm"
        >
          <span>{t("loadFailed")}</span>
          <Button size="sm" variant="outline" onClick={loadSettings}>
            {t("retry")}
          </Button>
        </div>
      ) : (
        <fieldset disabled={saveStatus === "saving"} className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label
                htmlFor="manager-guard-enabled"
                className="text-sm font-medium"
              >
                {t("enableLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("enableHint")}</p>
            </div>
            <Switch
              id="manager-guard-enabled"
              checked={settings.enabled}
              onCheckedChange={checked =>
                setSettings(prev => ({ ...prev, enabled: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label
                htmlFor="manager-guard-recent"
                className="text-sm font-medium"
              >
                {t("skipRecentLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("skipRecentHint")}
              </p>
            </div>
            <Switch
              id="manager-guard-recent"
              checked={settings.skipIfManagerRecentlyReplied}
              disabled={!settings.enabled}
              onCheckedChange={checked =>
                setSettings(prev => ({
                  ...prev,
                  skipIfManagerRecentlyReplied: checked,
                }))
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label
                htmlFor="manager-guard-tagged"
                className="text-sm font-medium"
              >
                {t("skipTaggedLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("skipTaggedHint")}
              </p>
            </div>
            <Switch
              id="manager-guard-tagged"
              checked={settings.skipIfTaggedManagerMessage}
              disabled={!settings.enabled}
              onCheckedChange={checked =>
                setSettings(prev => ({
                  ...prev,
                  skipIfTaggedManagerMessage: checked,
                }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="manager-window">{t("windowLabel")}</Label>
            <Input
              id="manager-window"
              type="number"
              min={30}
              max={86_400}
              value={windowInput}
              disabled={
                !settings.enabled || !settings.skipIfManagerRecentlyReplied
              }
              onChange={event => setWindowInput(event.target.value)}
              onBlur={() => {
                const parsed = Number.parseInt(windowInput, 10);
                const nextValue = Number.isFinite(parsed)
                  ? Math.max(30, Math.min(86_400, parsed))
                  : settings.managerRecentReplyWindowSeconds;
                setWindowInput(String(nextValue));
                setSettings(prev => ({
                  ...prev,
                  managerRecentReplyWindowSeconds: nextValue,
                }));
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {saveStatus === "saving"
              ? t("savingStatus")
              : saveStatus === "saved"
                ? t("savedStatus")
                : saveStatus === "error"
                  ? t("saveFailed")
                  : t("autoSaveHint")}
          </p>
        </fieldset>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="space-y-3">
        {sectionHeader}
        {sectionContent}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>{sectionHeader}</CardHeader>
      <CardContent className="space-y-6">{sectionContent}</CardContent>
    </Card>
  );
}
