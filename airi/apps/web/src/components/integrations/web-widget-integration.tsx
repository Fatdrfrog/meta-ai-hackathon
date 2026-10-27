"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  createWebWidgetSource,
  regenerateWebWidgetKeys,
  updateWebWidgetSource,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Source, WebWidgetCredentials } from "@/types/supabase";
import {
  AlertCircle,
  Check,
  Code,
  Copy,
  Eye,
  ExternalLink,
  Loader2,
  RefreshCw,
  Settings,
  Shield,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CopyableInput } from "./copyable-input";
import { WebWidgetCommerceSettings } from "./web-widget-commerce-settings";
import { buildWebWidgetInstallSnippets } from "./web-widget-installation-snippets";

type WebWidgetIntegrationProps = {
  source?: Source;
  workspaceId: string;
  onSourceChanged?: () => Promise<unknown>;
  connectionActionsDisabled?: boolean;
};

export function WebWidgetIntegration(props: WebWidgetIntegrationProps) {
  const credentials = props.source?.credentials as
    | WebWidgetCredentials
    | undefined;
  const sourceKey = props.source
    ? [
        props.source.id,
        credentials?.client_key ?? "",
        credentials?.status ?? "",
        credentials?.allowed_domains?.join("|") ?? "",
      ].join(":")
    : "new";

  return <WebWidgetIntegrationContent key={sourceKey} {...props} />;
}

function WebWidgetIntegrationContent({
  source,
  workspaceId,
  onSourceChanged,
  connectionActionsDisabled = false,
}: WebWidgetIntegrationProps) {
  const t = useTranslations("WebWidgetIntegration");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isCreating, setIsCreating] = useState(false);
  const [allowedDomains, setAllowedDomains] = useState(() => {
    const creds = source?.credentials as WebWidgetCredentials;
    return creds?.allowed_domains?.join(", ") || "";
  });
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Create widget if doesn't exist
  const handleCreate = () => {
    setIsCreating(true);
    setError(null);

    startTransition(async () => {
      try {
        const result = await createWebWidgetSource(
          workspaceId,
          "Website Widget",
          []
        );
        if (result.error) {
          setError(result.error);
          toast.error(result.error);
        } else {
          toast.success(t("widgetCreated"));
          await onSourceChanged?.();
          router.refresh();
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : t("failedToCreateWidget");
        setError(errorMessage);
        toast.error(errorMessage);
      } finally {
        setIsCreating(false);
      }
    });
  };

  // Update allowed domains
  const handleSave = () => {
    if (!source) return;

    const domains = allowedDomains
      .split(",")
      .map((d: string) => d.trim())
      .filter(Boolean);

    setError(null);
    startTransition(async () => {
      try {
        const result = await updateWebWidgetSource(source.id, {
          allowedDomains: domains,
        });
        if (result.error) {
          setError(result.error);
          toast.error(result.error);
        } else {
          toast.success(t("settingsSaved"));
          await onSourceChanged?.();
          router.refresh();
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : t("failedToSaveSettings");
        setError(errorMessage);
        toast.error(errorMessage);
      }
    });
  };

  // Regenerate keys
  const handleRegenerate = () => {
    if (!source || !confirm(t("regenerateKeysConfirm"))) return;

    setError(null);
    startTransition(async () => {
      try {
        const result = await regenerateWebWidgetKeys(source.id);
        if (result.error) {
          setError(result.error);
          toast.error(result.error);
        } else {
          toast.success(t("keysRegenerated"));
          await onSourceChanged?.();
          router.refresh();
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : t("failedToRegenerateKeys");
        setError(errorMessage);
        toast.error(errorMessage);
      }
    });
  };

  // Copy to clipboard helper
  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      toast.success(t("copiedToClipboard"));
      setTimeout(() => {
        setCopiedKey(current => (current === key ? null : current));
      }, 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  if (!source) {
    if (isCreating) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("creatingWidget")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t("settingUpWidget")}</span>
            </div>
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="flex items-start gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium">{t("failedToCreateWidget")}</p>
                <p className="text-xs mt-1 opacity-90">{error}</p>
              </div>
            </div>
          )}
          <Button
            onClick={handleCreate}
            disabled={isPending || isCreating || connectionActionsDisabled}
          >
            {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("createWidget")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const credentials = source.credentials as WebWidgetCredentials;
  const clientKey = credentials?.client_key || "";
  const widgetUrl =
    process.env.NEXT_PUBLIC_WIDGET_CDN_URL || "https://widget.airi.chat";
  const {
    embedCode,
    nextJsSnippet,
    reactSpaSnippet,
    vueNuxtSnippet,
    angularSnippet,
    reactNativeWebViewSnippet,
    iosAndroidWebViewSnippet,
    flutterWebViewSnippet,
    mobileContextSnippet,
  } = buildWebWidgetInstallSnippets({ clientKey, widgetUrl });
  const isActive = credentials?.status === "active";

  const embedOptions = [
    {
      id: "html",
      title: "HTML / CMS / Static Sites",
      description: "WordPress, Webflow, Wix, Shopify, Tilda, plain HTML",
      snippet: embedCode,
      hint: "Paste before the closing </body> tag.",
    },
    {
      id: "nextjs",
      title: "Next.js",
      description: "App Router and Pages Router",
      snippet: nextJsSnippet,
      hint: "Use next/script with afterInteractive.",
    },
    {
      id: "react",
      title: "React SPA (Vite/CRA)",
      description: "Load script dynamically inside an app shell component",
      snippet: reactSpaSnippet,
    },
    {
      id: "vue",
      title: "Vue / Nuxt",
      description: "Head-level injection with useHead",
      snippet: vueNuxtSnippet,
    },
    {
      id: "angular",
      title: "Angular",
      description: "Renderer2-based script injection in component lifecycle",
      snippet: angularSnippet,
    },
    {
      id: "rn-webview",
      title: "React Native WebView",
      description: "Inject loader.js into a WebView screen",
      snippet: reactNativeWebViewSnippet,
      contextSnippet: mobileContextSnippet,
    },
    {
      id: "native-webview",
      title: "iOS / Android Native WebView",
      description: "Use an HTML shell and load the widget script there",
      snippet: iosAndroidWebViewSnippet,
      contextSnippet: mobileContextSnippet,
    },
    {
      id: "flutter-webview",
      title: "Flutter InAppWebView",
      description: "Inject loader script via UserScript at document end",
      snippet: flutterWebViewSnippet,
      contextSnippet: mobileContextSnippet,
    },
  ];

  return (
    <div className="space-y-4">
      {isActive && (
        <Card className="border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20">
          <CardContent className="pt-4 pb-4 space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
                {t("quickStart.title")}
              </p>
              <p className="text-xs text-emerald-800/90 dark:text-emerald-200">
                {t("quickStart.description")}
              </p>
            </div>
            <ol className="list-decimal list-inside space-y-1 text-xs text-emerald-900 dark:text-emerald-100">
              <li>{t("quickStart.step1")}</li>
              <li>{t("quickStart.step2")}</li>
              <li>{t("quickStart.step3")}</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 border-emerald-300 bg-white/80 dark:bg-transparent"
                onClick={() => copyToClipboard(embedCode, "quick-start")}
              >
                {copiedKey === "quick-start" ? (
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t("quickStart.copyScript")}
              </Button>
              <Button asChild variant="secondary" size="sm" className="h-8">
                <Link href={`/panel/w/${workspaceId}/widget-branding`}>
                  {t("quickStart.openBranding")}
                  <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
                </Link>
              </Button>
            </div>
            <p className="text-[11px] text-emerald-800/90 dark:text-emerald-300">
              {t("quickStart.noReembedNeeded")}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Status */}
      <div className="flex items-center gap-2">
        <Badge variant={isActive ? "default" : "secondary"}>
          {isActive ? t("active") : t("inactive")}
        </Badge>
        {isPending && (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("saving")}
          </span>
        )}
      </div>

      {/* Error Banner */}
      {error && (
        <div className="flex items-start gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-medium">{t("error")}</p>
            <p className="text-xs mt-1 opacity-90">{error}</p>
          </div>
        </div>
      )}

      <Tabs defaultValue="install" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="install" className="gap-2">
            <Code className="h-4 w-4" />
            {t("tabs.installation")}
          </TabsTrigger>
          <TabsTrigger value="config" className="gap-2">
            <Settings className="h-4 w-4" />
            {t("tabs.configuration")}
          </TabsTrigger>
        </TabsList>

        {/* Installation Tab */}
        <TabsContent value="install" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("installation.title")}
              </CardTitle>
              <CardDescription className="text-xs">
                {t("installation.description")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Accordion
                type="single"
                collapsible
                defaultValue="html"
                className="w-full rounded-md border px-3"
              >
                {embedOptions.map(option => (
                  <AccordionItem key={option.id} value={option.id}>
                    <AccordionTrigger className="hover:no-underline py-3">
                      <div className="text-left">
                        <p className="text-sm font-medium leading-none">
                          {option.title}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {option.description}
                        </p>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="space-y-3 pb-4">
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            copyToClipboard(option.snippet, option.id)
                          }
                        >
                          {copiedKey === option.id ? (
                            <Check className="h-3.5 w-3.5 mr-1.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 mr-1.5" />
                          )}
                          <span className="text-xs">
                            {t("installation.copy")}
                          </span>
                        </Button>
                      </div>
                      <pre className="bg-muted p-2.5 rounded text-[11px] overflow-x-auto border font-mono whitespace-pre-wrap">
                        <code>{option.snippet}</code>
                      </pre>
                      {option.hint && (
                        <p className="text-[11px] text-muted-foreground">
                          {option.hint}
                        </p>
                      )}
                      {option.contextSnippet && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] font-medium text-muted-foreground">
                              Mobile app context sync (optional)
                            </p>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                copyToClipboard(
                                  option.contextSnippet,
                                  `${option.id}-context`
                                )
                              }
                            >
                              {copiedKey === `${option.id}-context` ? (
                                <Check className="h-3.5 w-3.5 mr-1.5" />
                              ) : (
                                <Copy className="h-3.5 w-3.5 mr-1.5" />
                              )}
                              <span className="text-xs">
                                {t("installation.copy")}
                              </span>
                            </Button>
                          </div>
                          <pre className="bg-muted p-2.5 rounded text-[11px] overflow-x-auto border font-mono whitespace-pre-wrap">
                            <code>{option.contextSnippet}</code>
                          </pre>
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>

              <div className="rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-3">
                <p className="text-xs font-medium text-blue-900 dark:text-blue-100">
                  Mobile WebView note
                </p>
                <p className="text-[11px] text-blue-800 dark:text-blue-200 mt-1">
                  If the widget runs inside app WebViews, call{" "}
                  <code>window.airiSetContext(...)</code> when users switch
                  tabs/screens so conversations stay grouped correctly.
                </p>
                <p className="text-[11px] text-blue-800 dark:text-blue-200 mt-1">
                  Branding and content updates are loaded from server config, so
                  re-embedding is not required.
                </p>
              </div>

              {/* Features */}
              <div className="rounded-md bg-blue-50 dark:bg-blue-950/20 p-2.5 text-xs">
                <p className="font-medium text-blue-900 dark:text-blue-100 mb-1.5">
                  ✨ {t("installation.includesTitle")}
                </p>
                <ul className="text-blue-800 dark:text-blue-200 space-y-0.5 text-[11px]">
                  <li>• {t("installation.features.realtime")}</li>
                  <li>• {t("installation.features.autoReply")}</li>
                  <li>• {t("installation.features.responsive")}</li>
                  <li>• {t("installation.features.universal")}</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Configuration Tab */}
        <TabsContent value="config" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Widget Settings</CardTitle>
              <CardDescription className="text-xs">
                Manage security and authentication
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Client Key */}
              <CopyableInput
                label={t("clientKey")}
                value={clientKey}
                copySuccessMessage={t("copiedToClipboard")}
              />

              {/* Allowed Domains */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2 text-xs">
                  <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                  {t("allowedDomains")}
                </Label>
                <Input
                  placeholder={t("allowedDomainsPlaceholder")}
                  value={allowedDomains}
                  onChange={e => {
                    setAllowedDomains(e.target.value);
                    setError(null);
                  }}
                  disabled={isPending || connectionActionsDisabled}
                  className="text-sm"
                />
                <div className="space-y-1">
                  <p className="text-[11px] text-muted-foreground">
                    Comma-separated domains where widget can load:
                  </p>
                  <div className="text-[11px] text-muted-foreground space-y-0.5 ml-2">
                    <p>
                      •{" "}
                      <code className="bg-muted px-1 rounded text-[10px]">
                        example.com
                      </code>{" "}
                      - Exact domain
                    </p>
                    <p>
                      •{" "}
                      <code className="bg-muted px-1 rounded text-[10px]">
                        *.example.com
                      </code>{" "}
                      - All subdomains
                    </p>
                    <p>
                      •{" "}
                      <code className="bg-muted px-1 rounded text-[10px]">
                        localhost:*
                      </code>{" "}
                      - Local development
                    </p>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <Button
                  onClick={handleSave}
                  disabled={isPending || connectionActionsDisabled}
                  size="sm"
                >
                  {isPending && (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  )}
                  {t("saveChanges")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={isPending || connectionActionsDisabled}
                >
                  {isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-2" />
                  )}
                  {t("regenerateKeys")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <WebWidgetCommerceSettings
        workspaceId={workspaceId}
        sourceId={source.id}
        clientKey={clientKey}
        widgetUrl={widgetUrl}
        disabled={connectionActionsDisabled}
      />

      {/* Privacy Notice */}
      <Card className="border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20">
        <CardContent className="pt-3 pb-3">
          <div className="flex items-start gap-2">
            <Eye className="h-3.5 w-3.5 mt-0.5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
            <div className="text-xs text-blue-800 dark:text-blue-200 space-y-1">
              <p className="font-medium text-blue-900 dark:text-blue-100">
                {t("privacy.title")}
              </p>
              <p className="text-[11px]">{t("privacy.description")}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
