"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { InstagramHumanAgentCapability } from "@/lib/instagram/human-agent";
import { cn } from "@/lib/utils";
import { buildWhatsAppTemplateSendComponentsFromTemplate } from "@/lib/whatsapp/templates/message-types";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import type { MobileWindowStatusResponse } from "@icecore/shared/types/mobile-api";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";
import { AlertCircle, Clock, Loader2, MessageSquare } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import useSWR from "swr";

const META_WA_TEMPLATES_URL =
  "https://business.facebook.com/wa/manage/message-templates/";
const DEFAULT_TEMPLATE_LANGUAGE = "en";

type ConversationTemplate = WhatsAppTemplate & {
  requiresVariables?: boolean;
  variables?: string[];
};

const EXPIRED_WINDOW_TONES = {
  blocked: {
    alert: "border-destructive bg-destructive/10",
    icon: "",
    title: "",
    description: "",
  },
  humanAgent: {
    alert:
      "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-800/60",
    icon: "text-emerald-700 dark:text-emerald-400",
    title: "text-emerald-900 dark:text-emerald-200",
    description: "text-emerald-800 dark:text-emerald-300",
  },
};

function ExpiredWindowAlert({
  title,
  tone,
  descriptionClassName,
  children,
}: {
  title: string;
  tone: keyof typeof EXPIRED_WINDOW_TONES;
  descriptionClassName?: string;
  children: ReactNode;
}) {
  const styles = EXPIRED_WINDOW_TONES[tone];
  return (
    <Alert className={cn("mx-3 my-1.5 w-auto py-1.5", styles.alert)}>
      <AlertCircle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", styles.icon)} />
      <AlertTitle
        className={cn("break-words text-xs font-medium", styles.title)}
      >
        {title}
      </AlertTitle>
      <AlertDescription
        className={cn(
          "overflow-wrap-anywhere mt-0.5 min-w-0 break-words text-xs",
          styles.description,
          descriptionClassName
        )}
      >
        {children}
      </AlertDescription>
    </Alert>
  );
}

function renderTemplatesLink(chunks: ReactNode) {
  return (
    <a
      href={META_WA_TEMPLATES_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline"
    >
      {chunks}
    </a>
  );
}

function formatHumanAgentExpiry(
  expiresAt: string | null | undefined,
  locale: string
): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function MetaWindowStatus({
  conversationId,
  windowInfo,
  channel,
  humanAgent,
  isLoading = false,
}: {
  conversationId: string;
  windowInfo: MobileWindowStatusResponse["windowInfo"];
  channel: "whatsapp" | "instagram";
  humanAgent?: InstagramHumanAgentCapability | null;
  isLoading?: boolean;
}) {
  const [isTemplateDialogOpen, setIsTemplateDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState(
    DEFAULT_TEMPLATE_LANGUAGE
  );
  const [templateVariableValues, setTemplateVariableValues] = useState<
    Record<string, string>
  >({});
  const [isSendingTemplate, setIsSendingTemplate] = useState(false);
  const [useManualInput, setUseManualInput] = useState(false);
  const t = useTranslations("ConversationDetailView");
  const locale = useLocale();

  const closeTemplateDialog = () => {
    setIsTemplateDialogOpen(false);
    setUseManualInput(false);
    setTemplateName("");
    setTemplateLanguage(DEFAULT_TEMPLATE_LANGUAGE);
    setTemplateVariableValues({});
  };

  const shouldLoadTemplates =
    channel === "whatsapp" && isTemplateDialogOpen && Boolean(conversationId);

  const { data: templatesData, isLoading: isLoadingTemplates } = useSWR<{
    templates?: ConversationTemplate[];
  }>(
    shouldLoadTemplates
      ? `/api/conversations/${conversationId}/templates`
      : null,
    (url: string) => fetch(url).then(r => r.json()),
    {
      revalidateOnFocus: false,
      onSuccess: data => {
        setUseManualInput(!(data?.templates && data.templates.length > 0));
      },
      onError: () => {
        setUseManualInput(true);
      },
    }
  );
  const templates: ConversationTemplate[] = templatesData?.templates ?? [];

  // Picking from the list fills the name and language, and a typed name
  // resolves the same way, so both paths send the same template.
  const normalizedTemplateName = templateName.trim().toLowerCase();
  const selectedTemplate = templates.find(
    tpl =>
      tpl.name.toLowerCase() === normalizedTemplateName &&
      tpl.language === templateLanguage
  );
  const selectedTemplateVariables = selectedTemplate?.variables || [];
  const missingTemplateVariables = selectedTemplateVariables.filter(
    variable => !templateVariableValues[variable]?.trim()
  );
  const isInstagramHumanAgentEnabled = Boolean(
    channel === "instagram" && humanAgent?.enabled
  );
  const isInstagramHumanAgentWindowExpired =
    channel === "instagram" &&
    humanAgent?.reason === "human_agent_window_expired";
  const humanAgentExpiresLabel = formatHumanAgentExpiry(
    humanAgent?.expiresAt,
    locale
  );

  const channelDisplayName = t(
    channel === "whatsapp" ? "channelWhatsapp" : "channelInstagram"
  );

  if (isLoading) {
    return <Skeleton className="h-12 mx-3 mb-1.5" />;
  }

  if (!windowInfo) return null;

  const { isWithinWindow, hoursRemaining } = windowInfo;

  if (isWithinWindow && hoursRemaining < 2 && hoursRemaining > 0) {
    const minutesRemaining = Math.round(hoursRemaining * 60);
    return (
      <Alert className="flex w-auto mx-3 mb-1.5 py-2 border-yellow-500 bg-yellow-50 dark:bg-yellow-950">
        <div className="flex items-start gap-2 w-full">
          <Clock className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-500 mt-0.5 shrink-0" />
          <AlertDescription className="text-xs text-yellow-800 dark:text-yellow-200 flex-1 min-w-0 col-start-auto">
            <strong>
              {t(
                channel === "whatsapp"
                  ? "windowExpiringMinutes"
                  : isInstagramHumanAgentEnabled
                    ? "instagramWindowExpiringMinutesHumanAgent"
                    : "instagramWindowExpiringMinutes",
                { minutes: minutesRemaining }
              )}
            </strong>
          </AlertDescription>
        </div>
      </Alert>
    );
  }

  if (isWithinWindow) return null;

  const expiredTitle = t("windowExpired", { channel: channelDisplayName });

  if (channel === "instagram") {
    if (isInstagramHumanAgentEnabled) {
      return (
        <ExpiredWindowAlert title={expiredTitle} tone="humanAgent">
          {t("instagramHumanAgentEnabledDescription")}
          {humanAgentExpiresLabel
            ? ` ${t("instagramHumanAgentAvailableUntil", {
                date: humanAgentExpiresLabel,
              })}`
            : null}
        </ExpiredWindowAlert>
      );
    }

    return (
      <ExpiredWindowAlert title={expiredTitle} tone="blocked">
        {t(
          isInstagramHumanAgentWindowExpired
            ? "instagramHumanAgentWindowExpiredDescription"
            : "instagramHumanAgentDisabledDescription"
        )}
      </ExpiredWindowAlert>
    );
  }

  const sendTemplate = async () => {
    const name = templateName.trim();
    if (!name) {
      toast.error(t("toastTemplateNameRequired"));
      return;
    }

    if (missingTemplateVariables.length > 0) {
      toast.error(
        `Fill all template parameters: ${missingTemplateVariables
          .map(variable => `{{${variable}}}`)
          .join(", ")}`
      );
      return;
    }

    setIsSendingTemplate(true);
    try {
      const builtComponents = selectedTemplate
        ? buildWhatsAppTemplateSendComponentsFromTemplate({
            templateComponents: selectedTemplate.components,
            values: templateVariableValues,
          }).components
        : undefined;
      const fallbackBodyComponents =
        selectedTemplateVariables.length > 0 &&
        (!builtComponents || builtComponents.length === 0)
          ? [
              {
                type: "body" as const,
                parameters: selectedTemplateVariables.map(variable => ({
                  type: "text" as const,
                  text: templateVariableValues[variable] || "",
                })),
              },
            ]
          : undefined;

      const res = await fetch(
        `/api/conversations/${conversationId}/send-template`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateName: name,
            languageCode: templateLanguage,
            components: builtComponents || fallbackBodyComponents,
          }),
        }
      );

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || t("toastTemplateSendFailed"));
      }

      toast.success(t("toastTemplateSentSuccess"));
      closeTemplateDialog();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("toastTemplateSendFailed");
      toast.error(message);
    } finally {
      setIsSendingTemplate(false);
    }
  };

  return (
    <>
      <ExpiredWindowAlert
        title={expiredTitle}
        tone="blocked"
        descriptionClassName="mt-1.5"
      >
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 w-fit h-7 text-xs self-start"
          onClick={() => setIsTemplateDialogOpen(true)}
        >
          <MessageSquare className="h-3 w-3 mr-1" />
          {t("sendTemplate")}
        </Button>
      </ExpiredWindowAlert>

      <Dialog
        open={isTemplateDialogOpen}
        onOpenChange={open => {
          if (open) {
            setIsTemplateDialogOpen(true);
          } else {
            closeTemplateDialog();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("sendTemplateDialogTitle", { channel: channelDisplayName })}
            </DialogTitle>
            <DialogDescription>
              {t("sendTemplateDialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {isLoadingTemplates ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  {t("loadingTemplates")}
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="templateName">
                  {templates.length > 0 && !useManualInput
                    ? t("selectTemplateLabel")
                    : t("templateNameLabel")}
                </Label>

                {templates.length > 0 && !useManualInput ? (
                  <>
                    <Select
                      value={
                        selectedTemplate
                          ? getWhatsAppTemplateOptionValue(selectedTemplate)
                          : ""
                      }
                      onValueChange={value => {
                        const selected = templates.find(
                          tpl => getWhatsAppTemplateOptionValue(tpl) === value
                        );
                        if (!selected) return;
                        setTemplateName(selected.name);
                        setTemplateLanguage(selected.language);
                        const nextValues: Record<string, string> = {};
                        (selected.variables || []).forEach(variable => {
                          nextValues[variable] =
                            templateVariableValues[variable] || "";
                        });
                        setTemplateVariableValues(nextValues);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t("chooseTemplatePlaceholder")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {templates.map(template => (
                          <SelectItem
                            key={`${template.name}-${template.language}`}
                            value={getWhatsAppTemplateOptionValue(template)}
                          >
                            <div className="flex flex-col items-start">
                              <span className="font-medium">
                                {template.name}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {t("templateListItemSubtitle", {
                                  language: template.language.toUpperCase(),
                                  category: template.category,
                                })}
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {templateName &&
                        t("selectedTemplateLanguageHint", {
                          language: templateLanguage.toUpperCase(),
                        })}
                    </p>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => setUseManualInput(true)}
                    >
                      {t("enterTemplateNameManually")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Input
                      id="templateName"
                      placeholder={t("templateNamePlaceholder")}
                      value={templateName}
                      onChange={e => setTemplateName(e.target.value)}
                    />

                    <div className="space-y-2">
                      <Label htmlFor="languageCode">
                        {t("languageCodeLabel")}
                      </Label>
                      <Select
                        value={templateLanguage}
                        onValueChange={setTemplateLanguage}
                      >
                        <SelectTrigger id="languageCode">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="en">
                            {t("templateLangOption_en")}
                          </SelectItem>
                          <SelectItem value="ru">
                            {t("templateLangOption_ru")}
                          </SelectItem>
                          <SelectItem value="kk">
                            {t("templateLangOption_kk")}
                          </SelectItem>
                          <SelectItem value="uz">
                            {t("templateLangOption_uz")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {t("languageCodeHint")}
                      </p>
                    </div>

                    {templates.length > 0 && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-xs"
                        onClick={() => setUseManualInput(false)}
                      >
                        {t("selectFromApprovedTemplates")}
                      </Button>
                    )}
                  </>
                )}

                {!useManualInput && selectedTemplateVariables.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/50 p-3 space-y-2">
                    <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                      {t("templateRequiresParameters")}
                    </p>
                    <div className="space-y-2">
                      {selectedTemplateVariables.map(variable => (
                        <div key={variable} className="space-y-1">
                          <Label htmlFor={`template-var-${variable}`}>
                            {`{{${variable}}}`}
                          </Label>
                          <Input
                            id={`template-var-${variable}`}
                            value={templateVariableValues[variable] || ""}
                            onChange={event =>
                              setTemplateVariableValues(prev => ({
                                ...prev,
                                [variable]: event.target.value,
                              }))
                            }
                            placeholder={t("templateVarValuePlaceholder", {
                              variable: `{{${variable}}}`,
                            })}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  {t.rich(
                    templates.length === 0
                      ? "templatesFooterNoTemplates"
                      : "templatesFooterWithCount",
                    { count: templates.length, link: renderTemplatesLink }
                  )}
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeTemplateDialog}
              disabled={isSendingTemplate}
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={() => void sendTemplate()}
              disabled={
                !templateName.trim() ||
                isSendingTemplate ||
                (!useManualInput && missingTemplateVariables.length > 0)
              }
            >
              {isSendingTemplate ? t("sendingTemplate") : t("sendTemplate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
