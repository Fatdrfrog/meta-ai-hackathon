"use client";

import { createTelegramSource, updateSource } from "@/app/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Source,
  type PublicTelegramCredentials,
  isTelegramSource,
} from "@/types/supabase";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Download,
  ExternalLink,
  FileUp,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { CopyableInput } from "./copyable-input";

type TelegramSubscribersSummary = {
  total: number;
  latestImport?: {
    status: "processing" | "completed" | "failed";
    fileName?: string | null;
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
    insertedRows: number;
    updatedRows: number;
    createdAt?: string | null;
    completedAt?: string | null;
    failedAt?: string | null;
    failureReason?: string | null;
  } | null;
};

type TelegramSubscriberImportResponse = {
  success?: boolean;
  error?: string;
  insertedRows?: number;
  updatedRows?: number;
  summary?: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
  };
  errors?: Array<{ rowNumber: number; reason: string; value?: string }>;
};

const WEBHOOK_RECHECK_DELAY_MS = 3000;

interface TelegramIntegrationProps {
  source?: Source;
  workspaceId?: string;
  onSuccess?: () => void;
  connectionActionsDisabled?: boolean;
}

export function TelegramIntegration({
  source,
  workspaceId: workspaceIdProp,
  onSuccess,
  connectionActionsDisabled = false,
}: TelegramIntegrationProps) {
  const params = useParams();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const workspaceId = workspaceIdProp || (params?.workspaceId as string);

  // DRY helper: show toast, close modal, revalidate data
  const handleSuccess = (message: string) => {
    toast.success(message);
    // Revalidate SWR cache for integrations
    mutate(`/api/workspaces/${workspaceId}/integrations`);
    router.refresh();
    onSuccess?.();
  };
  const t = useTranslations("TelegramIntegration");

  const [botToken, setBotToken] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [lastValidatedToken, setLastValidatedToken] = useState<string | null>(
    null
  );
  const [validatedBotInfo, setValidatedBotInfo] = useState<{
    username?: string;
    first_name: string;
    canReadAllGroupMessages?: boolean;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedTokenCount, setSavedTokenCount] = useState(0);
  const [webhookStatus, setWebhookStatus] = useState<{
    isConfigured: boolean;
    url?: string;
    pendingUpdates?: number;
    lastError?: string;
    isLoading: boolean;
  }>({ isConfigured: false, isLoading: false });
  const [subscribersSummary, setSubscribersSummary] =
    useState<TelegramSubscribersSummary | null>(null);
  const [isLoadingSubscribers, setIsLoadingSubscribers] = useState(false);
  const [subscriberImportFile, setSubscriberImportFile] = useState<File | null>(
    null
  );
  const [subscriberImportAttested, setSubscriberImportAttested] =
    useState(false);
  const [isImportingSubscribers, setIsImportingSubscribers] = useState(false);
  const [isExportingSubscribers, setIsExportingSubscribers] = useState(false);
  const [lastImportResult, setLastImportResult] =
    useState<TelegramSubscriberImportResponse | null>(null);
  const subscriberFileInputRef = useRef<HTMLInputElement | null>(null);

  const telegramSource = source && isTelegramSource(source) ? source : null;
  // The integrations API sends a public view: whether a token is saved, never the token.
  const currentCredentials =
    telegramSource?.credentials &&
    typeof telegramSource.credentials === "object"
      ? (telegramSource.credentials as Partial<PublicTelegramCredentials>)
      : null;
  const hasBotToken = currentCredentials?.has_bot_token === true;
  const currentBotUsername =
    currentCredentials?.bot_username || validatedBotInfo?.username;
  const sourceId = telegramSource?.id;
  const [aiReactionsEnabled, setAiReactionsEnabled] = useState(
    currentCredentials?.ai_reactions_enabled === true
  );
  const [isSavingAiReactions, setIsSavingAiReactions] = useState(false);
  const [aiReactionsError, setAiReactionsError] = useState<string | null>(null);

  useEffect(() => {
    setAiReactionsEnabled(currentCredentials?.ai_reactions_enabled === true);
    setAiReactionsError(null);
  }, [sourceId, currentCredentials?.ai_reactions_enabled]);

  const handleAiReactionsChange = async (enabled: boolean) => {
    if (
      !sourceId ||
      connectionActionsDisabled ||
      isSavingAiReactions ||
      isSaving
    ) {
      return;
    }
    const previousValue = aiReactionsEnabled;
    setAiReactionsEnabled(enabled);
    setIsSavingAiReactions(true);
    setAiReactionsError(null);
    try {
      const result = await updateSource(sourceId, {
        credentials: { ai_reactions_enabled: enabled },
      });
      if (result.error) throw new Error(result.error);
      handleSuccess(t("aiReactions.saved"));
    } catch {
      setAiReactionsEnabled(previousValue);
      setAiReactionsError(t("aiReactions.saveFailed"));
    } finally {
      setIsSavingAiReactions(false);
    }
  };

  const checkWebhookStatus = useCallback(async () => {
    if (!telegramSource?.id) return;

    setWebhookStatus(prev => ({ ...prev, isLoading: true }));

    try {
      const response = await fetch(
        `/api/sources/telegram/set-webhook?sourceId=${telegramSource.id}`
      );
      const data = await response.json();

      if (response.ok && data.success) {
        setWebhookStatus({
          isConfigured: data.isConfigured || false,
          url: data.webhookInfo?.url,
          pendingUpdates: data.webhookInfo?.pending_update_count,
          lastError: data.webhookInfo?.last_error_message,
          isLoading: false,
        });
      } else {
        setWebhookStatus({
          isConfigured: false,
          isLoading: false,
        });
      }
    } catch {
      setWebhookStatus({
        isConfigured: false,
        isLoading: false,
      });
    }
  }, [telegramSource?.id]);

  const loadSubscribersSummary = useCallback(async () => {
    if (!sourceId || !workspaceId) {
      setSubscribersSummary(null);
      return;
    }

    setIsLoadingSubscribers(true);
    try {
      const response = await fetch(
        `/api/sources/telegram/${sourceId}/subscribers?workspaceId=${encodeURIComponent(
          workspaceId
        )}&limit=10`
      );
      const data = (await response.json()) as TelegramSubscribersSummary & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error || "Failed to load Telegram subscribers");
      }
      setSubscribersSummary(data);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load Telegram subscribers"
      );
    } finally {
      setIsLoadingSubscribers(false);
    }
  }, [sourceId, workspaceId]);

  const handleSubscriberFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSubscriberImportFile(event.target.files?.[0] || null);
    setLastImportResult(null);
  };

  const handleImportSubscribers = async () => {
    if (!sourceId || !workspaceId || !subscriberImportFile) return;
    if (!subscriberImportAttested) {
      toast.error("Confirm same-bot prior contact first.");
      return;
    }

    setIsImportingSubscribers(true);
    setLastImportResult(null);
    try {
      const csv = await subscriberImportFile.text();
      const safeFileName = subscriberImportFile.name
        .replace(/[^\x20-\x7E]/g, "_")
        .slice(0, 200);
      const response = await fetch(
        `/api/sources/telegram/${sourceId}/subscribers/import?workspaceId=${encodeURIComponent(
          workspaceId
        )}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "x-telegram-subscriber-import-attestation": "accepted",
            "x-import-file-name": safeFileName,
          },
          body: csv,
        }
      );
      const data = (await response.json()) as TelegramSubscriberImportResponse;
      setLastImportResult(data);
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Telegram subscriber import failed");
      }

      toast.success(
        `Imported ${data.summary?.validRows || 0} Telegram subscriber rows.`
      );
      setSubscriberImportFile(null);
      setSubscriberImportAttested(false);
      if (subscriberFileInputRef.current) {
        subscriberFileInputRef.current.value = "";
      }
      await loadSubscribersSummary();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Telegram subscriber import failed"
      );
    } finally {
      setIsImportingSubscribers(false);
    }
  };

  const handleExportSubscribers = async () => {
    if (!sourceId || !workspaceId) return;

    setIsExportingSubscribers(true);
    try {
      const response = await fetch(
        `/api/sources/telegram/${sourceId}/subscribers/export?workspaceId=${encodeURIComponent(
          workspaceId
        )}`
      );
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Telegram subscriber export failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `telegram-subscribers-${sourceId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Telegram subscriber export failed"
      );
    } finally {
      setIsExportingSubscribers(false);
    }
  };

  useEffect(() => {
    if (telegramSource?.id && hasBotToken) {
      checkWebhookStatus();
    }
  }, [telegramSource?.id, hasBotToken, checkWebhookStatus]);

  // A replaced token keeps the source id, so check the new bot's webhook. The
  // server registers it after the save responds, so check once more later.
  useEffect(() => {
    if (!savedTokenCount || !telegramSource?.id) return;
    void checkWebhookStatus();
    const timer = window.setTimeout(
      () => void checkWebhookStatus(),
      WEBHOOK_RECHECK_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [savedTokenCount, telegramSource?.id, checkWebhookStatus]);

  useEffect(() => {
    if (telegramSource?.id && hasBotToken) {
      void loadSubscribersSummary();
    }
  }, [telegramSource?.id, hasBotToken, loadSubscribersSummary]);

  const validateToken = async (token: string) => {
    if (!token.trim()) {
      setValidationError(t("errors.tokenRequired"));
      setValidatedBotInfo(null);
      return;
    }

    setIsValidating(true);
    setValidationError(null);

    try {
      const response = await fetch("/api/telegram/validate-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_token: token }),
      });

      const data = await response.json();

      if (!response.ok || !data.valid) {
        setValidationError(data.error || t("errors.invalidToken"));
        setValidatedBotInfo(null);
        return;
      }

      setValidatedBotInfo({
        username: data.botInfo?.username,
        first_name:
          data.botInfo?.first_name || t("botConfiguration.defaultBotName"),
        canReadAllGroupMessages: data.botInfo?.can_read_all_group_messages,
      });
      setLastValidatedToken(token.trim());
      setValidationError(null);
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : t("errors.invalidToken")
      );
      setValidatedBotInfo(null);
    } finally {
      setIsValidating(false);
    }
  };

  const handleTokenChange = (value: string) => {
    setBotToken(value);
    setValidatedBotInfo(null);
    setValidationError(null);
  };

  const handleSaveToken = async () => {
    if (!botToken.trim()) {
      toast.error(t("toast.enterToken"));
      return;
    }

    if (!validatedBotInfo) {
      toast.error(t("toast.validateFirst"));
      return;
    }

    if (!telegramSource && !workspaceId) {
      toast.error(t("toast.sourceNotFound"));
      return;
    }

    setIsSaving(true);

    try {
      const credentials = {
        bot_token: botToken.trim(),
        bot_username: validatedBotInfo.username,
      };

      const result = telegramSource
        ? await updateSource(telegramSource.id, { credentials })
        : await createTelegramSource(workspaceId, credentials);

      if (result.error) {
        toast.error(result.error);
        return;
      }

      handleSuccess(t("toast.tokenSaved"));
      // The saved token is never sent back, so the field starts empty again.
      setBotToken("");
      setValidatedBotInfo(null);
      setLastValidatedToken(null);
      setSavedTokenCount(count => count + 1);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("toast.saveFailed")
      );
    } finally {
      setIsSaving(false);
    }
  };

  const trimmedToken = botToken.trim();
  const isTokenDirty = !!trimmedToken && trimmedToken !== lastValidatedToken;

  const registerWebhook = async () => {
    if (!telegramSource?.id) return;

    try {
      const response = await fetch("/api/sources/telegram/set-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: telegramSource.id }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        handleSuccess(t("toast.webhookRegistered"));
      } else {
        toast.error(data.error || t("toast.webhookRegisterFailed"));
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("toast.webhookRegisterFailed")
      );
    }
  };

  const deepLink = currentBotUsername
    ? `https://t.me/${currentBotUsername}?start=${sourceId}`
    : "";
  const knownSubscriberCount = subscribersSummary?.total ?? 0;
  const latestImport = subscribersSummary?.latestImport ?? null;
  const latestImportTimestamp =
    latestImport?.completedAt ||
    latestImport?.failedAt ||
    latestImport?.createdAt;
  const latestImportDate = latestImportTimestamp
    ? new Date(latestImportTimestamp).toLocaleString()
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4" />
            {t("botConfiguration.title")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("botConfiguration.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasBotToken && (
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">
                  {t("botConfiguration.createBot.title")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="space-y-2">
                  <p className="font-medium">
                    {t("botConfiguration.createBot.step1")}
                  </p>
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    {t("botConfiguration.createBot.openBotFather")}{" "}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div className="space-y-2">
                  <p className="font-medium">
                    {t("botConfiguration.createBot.step2")}
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="font-medium">
                    {t("botConfiguration.createBot.step3")}
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                    <li>{t("botConfiguration.createBot.step3Item1")}</li>
                    <li>{t("botConfiguration.createBot.step3Item2")}</li>
                    <li>{t("botConfiguration.createBot.step3Item3")}</li>
                  </ul>
                </div>
                <div className="space-y-2">
                  <p className="font-medium">
                    {t("botConfiguration.createBot.step4")}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="space-y-2">
            <Label htmlFor="bot_token">
              {t("botConfiguration.tokenLabel")}
            </Label>
            <div className="flex gap-2">
              <Input
                id="bot_token"
                type="password"
                value={botToken}
                onChange={e => handleTokenChange(e.target.value)}
                placeholder={t("botConfiguration.tokenPlaceholder")}
                className="font-mono text-sm"
                disabled={
                  isValidating ||
                  isSaving ||
                  isSavingAiReactions ||
                  connectionActionsDisabled
                }
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => validateToken(botToken)}
                disabled={
                  connectionActionsDisabled ||
                  !isTokenDirty ||
                  isValidating ||
                  isSaving ||
                  isSavingAiReactions
                }
              >
                {isValidating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t("botConfiguration.validateButton")
                )}
              </Button>
            </div>
            {hasBotToken && (
              <p className="text-xs text-muted-foreground">
                {t("botConfiguration.replaceTokenHint")}
              </p>
            )}
            {hasBotToken && !trimmedToken && !validationError && (
              <Alert className="mt-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <AlertTitle>
                  {t("botConfiguration.alreadyConnected.title")}
                </AlertTitle>
                <AlertDescription>
                  {t("botConfiguration.alreadyConnected.description", {
                    username:
                      currentBotUsername ||
                      t("botConfiguration.usernameNotFound"),
                  })}
                </AlertDescription>
              </Alert>
            )}
            {validationError && (
              <Alert variant="destructive" className="mt-2">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>
                  {t("botConfiguration.validationError.title")}
                </AlertTitle>
                <AlertDescription>{validationError}</AlertDescription>
              </Alert>
            )}
            {validatedBotInfo && !validationError && (
              <Alert className="mt-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <AlertTitle>
                  {t("botConfiguration.tokenValid.title")}
                </AlertTitle>
                <AlertDescription>
                  {t("botConfiguration.tokenValid.description", {
                    username:
                      validatedBotInfo.username ||
                      t("botConfiguration.usernameNotFound"),
                    firstName: validatedBotInfo.first_name,
                  })}
                </AlertDescription>
              </Alert>
            )}
            {validatedBotInfo?.canReadAllGroupMessages === false && (
              <Alert className="mt-2 border-amber-200 bg-amber-50 text-amber-900">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                <AlertTitle>Group visibility is limited</AlertTitle>
                <AlertDescription>
                  Privacy mode is still enabled for this bot, so Telegram will
                  not deliver all group messages. Disable privacy mode in
                  BotFather if you want full group message visibility in
                  `panel/requests`.
                </AlertDescription>
              </Alert>
            )}
          </div>

          {validatedBotInfo && trimmedToken && (
            <Button
              onClick={handleSaveToken}
              disabled={
                isSaving || isSavingAiReactions || connectionActionsDisabled
              }
              className="w-full"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {t("botConfiguration.saving")}
                </>
              ) : (
                t("botConfiguration.saveButton")
              )}
            </Button>
          )}

          {telegramSource && hasBotToken ? (
            <div
              className="space-y-3 border-t pt-4"
              aria-busy={isSavingAiReactions}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor={`telegram-ai-reactions-${sourceId}`}>
                    {t("aiReactions.title")}
                  </Label>
                  <p
                    id={`telegram-ai-reactions-description-${sourceId}`}
                    className="text-xs text-muted-foreground"
                  >
                    {t("aiReactions.description")}
                  </p>
                </div>
                <Switch
                  id={`telegram-ai-reactions-${sourceId}`}
                  aria-describedby={`telegram-ai-reactions-description-${sourceId}`}
                  checked={aiReactionsEnabled}
                  onCheckedChange={enabled =>
                    void handleAiReactionsChange(enabled)
                  }
                  disabled={
                    connectionActionsDisabled ||
                    isSavingAiReactions ||
                    isSaving ||
                    isValidating
                  }
                  className="shrink-0"
                />
              </div>
              {isSavingAiReactions ? (
                <p
                  role="status"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                  {t("aiReactions.saving")}
                </p>
              ) : null}
              {aiReactionsError ? (
                <Alert variant="destructive">
                  <AlertDescription>{aiReactionsError}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}

          {/* Webhook Status */}
          {hasBotToken && (
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <Label>{t("webhookStatus.label")}</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={checkWebhookStatus}
                  disabled={
                    webhookStatus.isLoading || connectionActionsDisabled
                  }
                >
                  {webhookStatus.isLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    t("webhookStatus.refresh")
                  )}
                </Button>
              </div>
              {webhookStatus.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("webhookStatus.checking")}
                </div>
              ) : webhookStatus.isConfigured ? (
                <Alert>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <AlertTitle>{t("webhookStatus.active.title")}</AlertTitle>
                  <AlertDescription>
                    {webhookStatus.url && (
                      <div className="mt-1">
                        <p className="text-xs font-mono break-all">
                          {webhookStatus.url}
                        </p>
                        {webhookStatus.pendingUpdates !== undefined &&
                          webhookStatus.pendingUpdates > 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                              {webhookStatus.pendingUpdates}{" "}
                              {webhookStatus.pendingUpdates === 1
                                ? t("webhookStatus.active.pendingUpdate")
                                : t("webhookStatus.active.pendingUpdates")}
                            </p>
                          )}
                      </div>
                    )}
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <XCircle className="h-4 w-4" />
                  <AlertTitle>
                    {t("webhookStatus.notConfigured.title")}
                  </AlertTitle>
                  <AlertDescription>
                    <p className="mb-2">
                      {t("webhookStatus.notConfigured.description")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={registerWebhook}
                      disabled={connectionActionsDisabled}
                    >
                      {t("webhookStatus.notConfigured.button")}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {telegramSource && hasBotToken ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileUp className="h-4 w-4" />
              Subscribers
            </CardTitle>
            <CardDescription className="text-[11px]">
              CSV in/out. Same bot only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md bg-muted/30 px-2.5 py-2">
                <div className="text-[11px] text-muted-foreground">Known</div>
                <div className="text-base font-semibold">
                  {isLoadingSubscribers ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    knownSubscriberCount.toLocaleString()
                  )}
                </div>
              </div>
              <div className="rounded-md bg-muted/30 px-2.5 py-2">
                <div className="text-[11px] text-muted-foreground">Last</div>
                <div className="text-xs font-medium">
                  {latestImport
                    ? `${latestImport.status} / ${latestImport.validRows.toLocaleString()} ok`
                    : "No imports yet"}
                </div>
                {latestImportDate ? (
                  <div className="text-[11px] text-muted-foreground">
                    {latestImportDate}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => subscriberFileInputRef.current?.click()}
                disabled={isImportingSubscribers || connectionActionsDisabled}
                size="sm"
              >
                <FileUp className="mr-2 h-4 w-4" />
                Pick CSV
              </Button>
              <Button
                type="button"
                onClick={handleImportSubscribers}
                disabled={
                  isImportingSubscribers ||
                  connectionActionsDisabled ||
                  !subscriberImportFile ||
                  !subscriberImportAttested
                }
                size="sm"
              >
                {isImportingSubscribers ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FileUp className="mr-2 h-4 w-4" />
                )}
                Import
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleExportSubscribers}
                disabled={
                  isExportingSubscribers ||
                  connectionActionsDisabled ||
                  knownSubscriberCount === 0
                }
                size="sm"
              >
                {isExportingSubscribers ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Export
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={loadSubscribersSummary}
                disabled={isLoadingSubscribers || connectionActionsDisabled}
                aria-label="Refresh Telegram subscribers"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <input
                ref={subscriberFileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={handleSubscriberFileChange}
              />
            </div>

            {subscriberImportFile ? (
              <div className="rounded-md border bg-muted/10 px-2.5 py-1.5 text-xs">
                {subscriberImportFile.name}
              </div>
            ) : null}

            <div className="flex items-start gap-2 rounded-md border bg-muted/10 p-2.5">
              <Checkbox
                id={`telegram-subscriber-import-attestation-${sourceId}`}
                checked={subscriberImportAttested}
                onCheckedChange={checked =>
                  setSubscriberImportAttested(checked === true)
                }
                disabled={connectionActionsDisabled || isImportingSubscribers}
                className="mt-0.5"
              />
              <Label
                htmlFor={`telegram-subscriber-import-attestation-${sourceId}`}
                className="text-[11px] leading-snug"
              >
                Same bot prior contact. Import sends nothing.
              </Label>
            </div>

            {lastImportResult?.summary ? (
              <Alert className="py-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <AlertTitle className="text-xs">Import</AlertTitle>
                <AlertDescription className="text-xs">
                  {lastImportResult.summary.validRows.toLocaleString()} valid,{" "}
                  {lastImportResult.summary.invalidRows.toLocaleString()}{" "}
                  invalid,{" "}
                  {lastImportResult.summary.duplicateRows.toLocaleString()}{" "}
                  duplicate.
                </AlertDescription>
              </Alert>
            ) : null}

            {latestImport?.failureReason ? (
              <Alert variant="destructive" className="py-2">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle className="text-xs">Import failed</AlertTitle>
                <AlertDescription className="text-xs">
                  {latestImport.failureReason}
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {telegramSource && hasBotToken && currentBotUsername && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("chatLinking.title")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("chatLinking.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t("chatLinking.privateChat.title")}
              </p>
              <CopyableInput
                value={deepLink}
                description={t("chatLinking.privateChat.description")}
                copySuccessMessage={t("chatLinking.privateChat.copySuccess")}
              />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t("chatLinking.groupChat.title")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("chatLinking.groupChat.autoDetect", {
                  username: currentBotUsername,
                })}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
