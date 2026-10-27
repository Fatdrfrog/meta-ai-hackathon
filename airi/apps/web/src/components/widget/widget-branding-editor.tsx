"use client";

import {
  translateWidgetQuickReplies,
  updateWebWidgetBranding,
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
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { Source, WebWidgetCredentials } from "@/types/supabase";
import {
  MAX_WIDGET_QUICK_REPLIES,
  MAX_WIDGET_QUICK_REPLY_LENGTH,
  DEFAULT_WIDGET_LANGUAGE_CODE,
  isLegacyDefaultWidgetQuickReplies,
  normalizeWidgetLanguageCode,
  normalizeWidgetQuickReply,
  normalizeWidgetQuickReplies,
  normalizeWidgetQuickRepliesTranslations,
} from "@icecore/shared/lib/widget-localization";
import type {
  WidgetLanguageCode,
  WidgetQuickRepliesTranslations,
} from "@icecore/shared/types/widget-config";
import { SUPPORTED_WIDGET_LANGUAGE_CODES } from "@icecore/shared/types/widget-config";
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Palette,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { KeyboardEvent, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

type BubbleMode = "icon" | "text" | "svg";
type LogoMode = "default" | "text" | "svg";
type HomeVariant = "intercom" | "simple";
type QuickReplyItem = {
  id: string;
  value: string;
};
type LocalizedQuickReplyItems = Partial<
  Record<WidgetLanguageCode, QuickReplyItem[]>
>;
const EMPTY_QUICK_REPLIES: string[] = [];
const WIDGET_LANGUAGE_LABELS: Record<WidgetLanguageCode, string> = {
  en: "English",
  ru: "Russian",
  kz: "Kazakh",
  uz: "Uzbek",
};

const hasQuickReplyValue = (value: string, sourceReplies: string[]) => {
  const key = normalizeWidgetQuickReply(value).toLowerCase();
  return sourceReplies.some(
    reply => normalizeWidgetQuickReply(reply).toLowerCase() === key
  );
};

const isLegacyDefaultQuickReplies = (value: unknown) => {
  return isLegacyDefaultWidgetQuickReplies(value);
};

const resolveQuickReplies = (value: unknown, fallbackReplies: string[]) => {
  if (!Array.isArray(value) || isLegacyDefaultQuickReplies(value)) {
    return normalizeWidgetQuickReplies(fallbackReplies);
  }

  const parsed = normalizeWidgetQuickReplies(
    value.filter((item): item is string => typeof item === "string")
  );

  return parsed;
};

const createQuickReplyItem = (value: string): QuickReplyItem => ({
  id:
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `qr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
  value,
});

const createQuickReplyItems = (values: string[]): QuickReplyItem[] =>
  values.map(value => createQuickReplyItem(value));

const createQuickReplyItemsByLocale = (
  values: WidgetQuickRepliesTranslations
): LocalizedQuickReplyItems => {
  const itemsByLocale: LocalizedQuickReplyItems = {};

  for (const locale of SUPPORTED_WIDGET_LANGUAGE_CODES) {
    const localizedValues = values[locale];
    if (localizedValues?.length) {
      itemsByLocale[locale] = createQuickReplyItems(localizedValues);
    }
  }

  return itemsByLocale;
};

const toNormalizedQuickRepliesByLocale = (
  itemsByLocale: LocalizedQuickReplyItems
): WidgetQuickRepliesTranslations => {
  const normalizedByLocale: WidgetQuickRepliesTranslations = {};

  for (const locale of SUPPORTED_WIDGET_LANGUAGE_CODES) {
    const values = normalizeWidgetQuickReplies(
      (itemsByLocale[locale] || []).map(item => item.value)
    );
    if (values.length > 0) {
      normalizedByLocale[locale] = values;
    }
  }

  return normalizedByLocale;
};

const resolveLocalizedQuickReplies = (
  credentials: WebWidgetCredentials,
  fallbackReplies: string[]
) => {
  const defaultLocale =
    normalizeWidgetLanguageCode(
      credentials.content?.quick_replies_default_locale
    ) || DEFAULT_WIDGET_LANGUAGE_CODE;
  const localizedQuickReplies = normalizeWidgetQuickRepliesTranslations(
    credentials.content?.quick_replies_i18n
  );
  const defaultQuickReplies = localizedQuickReplies[defaultLocale]?.length
    ? localizedQuickReplies[defaultLocale]
    : resolveQuickReplies(credentials.content?.quick_replies, fallbackReplies);

  const nextLocalizedQuickReplies: WidgetQuickRepliesTranslations = {
    ...localizedQuickReplies,
  };

  if (defaultQuickReplies.length > 0) {
    nextLocalizedQuickReplies[defaultLocale] = defaultQuickReplies;
  }

  return {
    defaultLocale,
    localizedQuickReplies: nextLocalizedQuickReplies,
  };
};

type ColorFieldProps = {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
};

function ColorField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: ColorFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={value}
          onChange={e => onChange(e.target.value)}
          className="h-9 w-12 rounded border bg-background p-1"
        />
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}

type WidgetBrandingEditorProps = {
  source: Source;
  recommendedQuickReplies?: string[];
};

export function WidgetBrandingEditor({
  source,
  recommendedQuickReplies = EMPTY_QUICK_REPLIES,
}: WidgetBrandingEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const credentials = source.credentials as WebWidgetCredentials;
  const normalizedRecommendedQuickReplies = useMemo(
    () => normalizeWidgetQuickReplies(recommendedQuickReplies),
    [recommendedQuickReplies]
  );

  const initialValues = useMemo(() => {
    const initialLocalizedQuickReplies = resolveLocalizedQuickReplies(
      credentials,
      normalizedRecommendedQuickReplies
    );

    return {
      primaryColor: credentials.theme?.primary_color || "#0B6BCB",
      bubbleColor:
        credentials.theme?.bubble_color ||
        credentials.theme?.primary_color ||
        "#0B6BCB",
      headerBgColor: credentials.theme?.header_bg_color || "#FFFFFF",
      headerTextColor: credentials.theme?.header_text_color || "#111827",
      welcomeMessage:
        credentials.settings?.welcome_message ||
        "Hello! How can we help you today?",
      botName: credentials.content?.bot_name || "Airi",
      headerTitle: credentials.content?.header_title || "Chat with us",
      heroTitle: credentials.content?.hero_title || "Hi, I'm Airi!",
      ctaPrimaryText:
        credentials.content?.cta_primary_text || "Send us a message",
      ctaSecondaryText:
        credentials.content?.cta_secondary_text ||
        "We typically reply in a few minutes",
      quickReplyDefaultLocale: initialLocalizedQuickReplies.defaultLocale,
      localizedQuickReplies: initialLocalizedQuickReplies.localizedQuickReplies,
      bubbleMode: (credentials.branding?.bubble_mode || "icon") as BubbleMode,
      bubbleText: credentials.branding?.bubble_text || "",
      bubbleSvgUrl: credentials.branding?.bubble_svg_url || "",
      logoMode: (credentials.branding?.logo_mode || "default") as LogoMode,
      logoText: credentials.branding?.logo_text || "",
      logoSvgUrl: credentials.branding?.logo_svg_url || "",
      homeVariant: (credentials.layout?.home_variant ||
        "intercom") as HomeVariant,
      showHelpTab: credentials.layout?.show_help_tab ?? true,
      showNewsTab: credentials.layout?.show_news_tab ?? true,
    };
  }, [credentials, normalizedRecommendedQuickReplies]);

  const [primaryColor, setPrimaryColor] = useState(initialValues.primaryColor);
  const [bubbleColor, setBubbleColor] = useState(initialValues.bubbleColor);
  const [headerBgColor, setHeaderBgColor] = useState(
    initialValues.headerBgColor
  );
  const [headerTextColor, setHeaderTextColor] = useState(
    initialValues.headerTextColor
  );
  const [welcomeMessage, setWelcomeMessage] = useState(
    initialValues.welcomeMessage
  );
  const [botName, setBotName] = useState(initialValues.botName);
  const [headerTitle, setHeaderTitle] = useState(initialValues.headerTitle);
  const [heroTitle, setHeroTitle] = useState(initialValues.heroTitle);
  const [ctaPrimaryText, setCtaPrimaryText] = useState(
    initialValues.ctaPrimaryText
  );
  const [ctaSecondaryText, setCtaSecondaryText] = useState(
    initialValues.ctaSecondaryText
  );
  const [quickReplyDefaultLocale, setQuickReplyDefaultLocale] =
    useState<WidgetLanguageCode>(initialValues.quickReplyDefaultLocale);
  const [activeQuickReplyLocale, setActiveQuickReplyLocale] =
    useState<WidgetLanguageCode>(initialValues.quickReplyDefaultLocale);
  const [localizedQuickReplies, setLocalizedQuickReplies] =
    useState<LocalizedQuickReplyItems>(() =>
      createQuickReplyItemsByLocale(initialValues.localizedQuickReplies)
    );
  const [quickReplyDrafts, setQuickReplyDrafts] = useState<
    Record<WidgetLanguageCode, string>
  >(() => ({
    en: "",
    ru: "",
    kz: "",
    uz: "",
  }));
  const [dirtyQuickReplyLocales, setDirtyQuickReplyLocales] = useState<
    WidgetLanguageCode[]
  >([]);
  const [isQuickReplyTranslationPending, startQuickReplyTranslation] =
    useTransition();
  const [bubbleMode, setBubbleMode] = useState<BubbleMode>(
    initialValues.bubbleMode
  );
  const [bubbleText, setBubbleText] = useState(initialValues.bubbleText);
  const [bubbleSvgUrl, setBubbleSvgUrl] = useState(initialValues.bubbleSvgUrl);
  const [logoMode, setLogoMode] = useState<LogoMode>(initialValues.logoMode);
  const [logoText, setLogoText] = useState(initialValues.logoText);
  const [logoSvgUrl, setLogoSvgUrl] = useState(initialValues.logoSvgUrl);
  const [homeVariant, setHomeVariant] = useState<HomeVariant>(
    initialValues.homeVariant
  );
  const [showHelpTab, setShowHelpTab] = useState(initialValues.showHelpTab);
  const [showNewsTab, setShowNewsTab] = useState(initialValues.showNewsTab);
  const quickReplyValuesByLocale = useMemo(
    () => toNormalizedQuickRepliesByLocale(localizedQuickReplies),
    [localizedQuickReplies]
  );
  const activeQuickReplyItems =
    localizedQuickReplies[activeQuickReplyLocale] || [];
  const activeQuickReplyValues =
    quickReplyValuesByLocale[activeQuickReplyLocale] || [];
  const defaultQuickReplyValues =
    quickReplyValuesByLocale[quickReplyDefaultLocale] || [];

  const markQuickReplyLocaleDirty = (locale: WidgetLanguageCode) => {
    setDirtyQuickReplyLocales(prev =>
      prev.includes(locale) ? prev : [...prev, locale]
    );
  };

  const updateQuickReplyLocaleItems = (
    locale: WidgetLanguageCode,
    updater: (items: QuickReplyItem[]) => QuickReplyItem[]
  ) => {
    setLocalizedQuickReplies(prev => ({
      ...prev,
      [locale]: updater(prev[locale] || []),
    }));
  };

  const addQuickReply = (rawValue: string) => {
    const value = normalizeWidgetQuickReply(rawValue);
    if (!value) {
      return;
    }

    const normalizedCurrent = activeQuickReplyValues;

    if (normalizedCurrent.length >= MAX_WIDGET_QUICK_REPLIES) {
      toast.error(
        `You can only add up to ${MAX_WIDGET_QUICK_REPLIES} quick replies.`
      );
      return;
    }

    if (hasQuickReplyValue(value, normalizedCurrent)) {
      toast.error("That quick reply already exists.");
      return;
    }

    updateQuickReplyLocaleItems(activeQuickReplyLocale, prev => [
      ...prev,
      createQuickReplyItem(value),
    ]);
    markQuickReplyLocaleDirty(activeQuickReplyLocale);
    setQuickReplyDrafts(prev => ({
      ...prev,
      [activeQuickReplyLocale]: "",
    }));
  };

  const moveQuickReply = (index: number, direction: "up" | "down") => {
    updateQuickReplyLocaleItems(activeQuickReplyLocale, prev => {
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) {
        return prev;
      }

      const next = [...prev];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
    markQuickReplyLocaleDirty(activeQuickReplyLocale);
  };

  const updateQuickReply = (index: number, value: string) => {
    updateQuickReplyLocaleItems(activeQuickReplyLocale, prev => {
      const next = [...prev];
      next[index] = { ...next[index], value };
      return next;
    });
    markQuickReplyLocaleDirty(activeQuickReplyLocale);
  };

  const handleQuickReplyKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    addQuickReply(quickReplyDrafts[activeQuickReplyLocale] || "");
  };

  const quickReplyDraft = quickReplyDrafts[activeQuickReplyLocale] || "";
  const isEditingDefaultQuickReplyLocale =
    activeQuickReplyLocale === quickReplyDefaultLocale;

  const quickReplySuggestions = useMemo(
    () =>
      normalizedRecommendedQuickReplies
        .filter(
          suggestion => !hasQuickReplyValue(suggestion, defaultQuickReplyValues)
        )
        .slice(0, 4),
    [defaultQuickReplyValues, normalizedRecommendedQuickReplies]
  );

  const quickReplyTemplate = useMemo(
    () => normalizedRecommendedQuickReplies.slice(0, MAX_WIDGET_QUICK_REPLIES),
    [normalizedRecommendedQuickReplies]
  );

  const previewQuickReplies =
    activeQuickReplyValues.length > 0
      ? activeQuickReplyValues
      : defaultQuickReplyValues;

  const translateQuickRepliesForLocales = async (
    targetLocales: WidgetLanguageCode[]
  ) => {
    if (defaultQuickReplyValues.length === 0 || targetLocales.length === 0) {
      return {} as WidgetQuickRepliesTranslations;
    }

    const result = await translateWidgetQuickReplies(
      defaultQuickReplyValues,
      quickReplyDefaultLocale,
      targetLocales,
      source.id
    );

    if (result.error) {
      throw new Error(result.error);
    }

    return normalizeWidgetQuickRepliesTranslations(result.translations);
  };

  const handleAutoTranslateQuickReplies = () => {
    const targetLocales = SUPPORTED_WIDGET_LANGUAGE_CODES.filter(
      locale => locale !== quickReplyDefaultLocale
    );

    startQuickReplyTranslation(async () => {
      try {
        const translations =
          await translateQuickRepliesForLocales(targetLocales);
        setLocalizedQuickReplies(prev => {
          const next: LocalizedQuickReplyItems = {
            ...prev,
          };

          for (const locale of targetLocales) {
            const translatedReplies = translations[locale];
            if (translatedReplies?.length) {
              next[locale] = createQuickReplyItems(translatedReplies);
            }
          }

          return next;
        });
        setDirtyQuickReplyLocales(prev =>
          prev.filter(locale => locale === quickReplyDefaultLocale)
        );
        toast.success("Quick replies translated");
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to translate quick replies"
        );
      }
    });
  };

  const handleSave = () => {
    startTransition(async () => {
      let nextQuickRepliesByLocale = {
        ...quickReplyValuesByLocale,
      };
      const autoTranslateLocales = SUPPORTED_WIDGET_LANGUAGE_CODES.filter(
        locale =>
          locale !== quickReplyDefaultLocale &&
          !dirtyQuickReplyLocales.includes(locale)
      );

      if (
        autoTranslateLocales.length > 0 &&
        defaultQuickReplyValues.length > 0
      ) {
        try {
          const translations =
            await translateQuickRepliesForLocales(autoTranslateLocales);
          nextQuickRepliesByLocale = {
            ...nextQuickRepliesByLocale,
            ...translations,
          };
          setLocalizedQuickReplies(prev => {
            const next: LocalizedQuickReplyItems = {
              ...prev,
            };

            for (const locale of autoTranslateLocales) {
              const translatedReplies = translations[locale];
              if (translatedReplies?.length) {
                next[locale] = createQuickReplyItems(translatedReplies);
              }
            }

            return next;
          });
        } catch {
          toast.error("Saved without updating some translations");
        }
      }

      const defaultQuickReplies =
        nextQuickRepliesByLocale[quickReplyDefaultLocale] || [];
      const result = await updateWebWidgetBranding(source.id, {
        theme: {
          primary_color: primaryColor.trim(),
          bubble_color: bubbleColor.trim(),
          header_bg_color: headerBgColor.trim(),
          header_text_color: headerTextColor.trim(),
        },
        settings: {
          welcome_message: welcomeMessage.trim(),
        },
        content: {
          bot_name: botName.trim(),
          header_title: headerTitle.trim(),
          hero_title: heroTitle.trim(),
          cta_primary_text: ctaPrimaryText.trim(),
          cta_secondary_text: ctaSecondaryText.trim(),
          quick_replies: defaultQuickReplies,
          quick_replies_default_locale: quickReplyDefaultLocale,
          quick_replies_i18n: nextQuickRepliesByLocale,
        },
        branding: {
          bubble_mode: bubbleMode,
          bubble_text: bubbleText.trim(),
          bubble_svg_url: bubbleSvgUrl.trim(),
          logo_mode: logoMode,
          logo_text: logoText.trim(),
          logo_svg_url: logoSvgUrl.trim(),
        },
        layout: {
          home_variant: homeVariant,
          show_help_tab: showHelpTab,
          show_news_tab: showNewsTab,
        },
      });

      if (result.error) {
        toast.error(result.error);
        return;
      }

      toast.success("Widget branding updated");
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-primary/20">
        <CardContent className="p-0">
          <div className="bg-gradient-to-r from-primary/15 via-primary/5 to-transparent px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Live widget snapshot</p>
                <p className="text-xs text-muted-foreground">
                  Preview key home-screen content before publishing.
                </p>
              </div>
              <Badge variant="secondary">
                {homeVariant === "intercom"
                  ? "Intercom layout"
                  : "Simple layout"}
              </Badge>
            </div>
          </div>
          <div className="grid gap-4 p-5 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">
                {headerTitle.trim() || "Chat with us"}
              </p>
              <p className="mt-2 text-lg font-semibold">
                {heroTitle.trim() || "Hi, I'm Airi!"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {welcomeMessage.trim() || "Hello! How can we help you today?"}
              </p>
            </div>
            <div className="space-y-3">
              <div className="rounded-xl border bg-card p-4">
                <p className="text-sm font-medium">
                  {ctaPrimaryText.trim() || "Send us a message"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {ctaSecondaryText.trim() ||
                    "We typically reply in a few minutes"}
                </p>
              </div>
              {homeVariant === "intercom" && previewQuickReplies.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {previewQuickReplies.slice(0, 4).map(reply => (
                    <Badge key={reply} variant="outline" className="max-w-full">
                      {reply}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="content" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="content">
            <Sparkles className="h-4 w-4" />
            Content
          </TabsTrigger>
          <TabsTrigger value="appearance">
            <Palette className="h-4 w-4" />
            Appearance
          </TabsTrigger>
          <TabsTrigger value="branding">Branding</TabsTrigger>
        </TabsList>

        <TabsContent value="content" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                Text Content
              </CardTitle>
              <CardDescription>
                Customize text shown in the widget home screen and header.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="widget-bot-name">Bot name</Label>
                <Input
                  id="widget-bot-name"
                  value={botName}
                  onChange={e => setBotName(e.target.value)}
                  placeholder="Airi"
                  maxLength={40}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="widget-header-title">Header title</Label>
                <Input
                  id="widget-header-title"
                  value={headerTitle}
                  onChange={e => setHeaderTitle(e.target.value)}
                  placeholder="Chat with us"
                  maxLength={80}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="widget-hero-title">Hero title</Label>
                <Input
                  id="widget-hero-title"
                  value={heroTitle}
                  onChange={e => setHeroTitle(e.target.value)}
                  placeholder="Hi, I'm Airi!"
                  maxLength={120}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="widget-welcome-message">Welcome message</Label>
                <Textarea
                  id="widget-welcome-message"
                  value={welcomeMessage}
                  onChange={e => setWelcomeMessage(e.target.value)}
                  maxLength={300}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="widget-cta-primary">Primary CTA text</Label>
                <Input
                  id="widget-cta-primary"
                  value={ctaPrimaryText}
                  onChange={e => setCtaPrimaryText(e.target.value)}
                  placeholder="Send us a message"
                  maxLength={80}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="widget-cta-secondary">Secondary CTA text</Label>
                <Input
                  id="widget-cta-secondary"
                  value={ctaSecondaryText}
                  onChange={e => setCtaSecondaryText(e.target.value)}
                  placeholder="We typically reply in a few minutes"
                  maxLength={120}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle>Quick Replies</CardTitle>
                  <CardDescription>
                    Shown as tappable suggestions in the widget home card. Use
                    task-linked suggestions to keep prompts aligned with your AI
                    coverage.
                  </CardDescription>
                </div>
                <Badge variant="secondary">
                  {activeQuickReplyValues.length}/{MAX_WIDGET_QUICK_REPLIES}
                </Badge>
              </div>
              <div className="grid gap-3 rounded-lg border border-dashed p-3 md:grid-cols-[minmax(0,1fr)_auto]">
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Fallback language</Label>
                    <Select
                      value={quickReplyDefaultLocale}
                      onValueChange={value => {
                        const nextLocale = value as WidgetLanguageCode;
                        setQuickReplyDefaultLocale(nextLocale);
                        setActiveQuickReplyLocale(nextLocale);
                      }}
                    >
                      <SelectTrigger className="w-full md:max-w-48">
                        <SelectValue placeholder="Fallback language" />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_WIDGET_LANGUAGE_CODES.map(locale => (
                          <SelectItem key={locale} value={locale}>
                            {WIDGET_LANGUAGE_LABELS[locale]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Edit language</Label>
                    <div className="flex flex-wrap gap-2">
                      {SUPPORTED_WIDGET_LANGUAGE_CODES.map(locale => (
                        <Button
                          key={locale}
                          type="button"
                          variant={
                            activeQuickReplyLocale === locale
                              ? "default"
                              : "outline"
                          }
                          size="xs"
                          onClick={() => setActiveQuickReplyLocale(locale)}
                        >
                          {WIDGET_LANGUAGE_LABELS[locale]}
                          {quickReplyDefaultLocale === locale
                            ? " fallback"
                            : ""}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex items-start justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={handleAutoTranslateQuickReplies}
                    disabled={
                      isQuickReplyTranslationPending ||
                      defaultQuickReplyValues.length === 0
                    }
                  >
                    {isQuickReplyTranslationPending && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    Auto-translate
                  </Button>
                </div>
              </div>
              <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                The widget uses the visitor&apos;s browser or WebView locale. If
                a translation is missing, it falls back to{" "}
                <span className="font-medium text-foreground">
                  {WIDGET_LANGUAGE_LABELS[quickReplyDefaultLocale]}
                </span>
                .
              </div>
              {quickReplyTemplate.length > 0 ? (
                <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  Suggestions are generated from workspace signals and verified
                  Q/A context. Apply them to the fallback language, then
                  translate the other tabs automatically.
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  No workspace suggestions yet. Add verified Q/A context to
                  generate aligned quick replies.
                </div>
              )}
              {homeVariant === "simple" && (
                <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  Quick replies are only visible in Intercom-style home layout.
                </div>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {activeQuickReplyItems.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No quick replies for{" "}
                  {WIDGET_LANGUAGE_LABELS[activeQuickReplyLocale]}. Add one
                  below.
                </div>
              ) : (
                <div className="space-y-2">
                  {activeQuickReplyItems.map((replyItem, index) => (
                    <div
                      key={replyItem.id}
                      className="flex items-center gap-2 rounded-lg border bg-muted/20 p-2"
                    >
                      <Badge variant="outline">{index + 1}</Badge>
                      <Input
                        value={replyItem.value}
                        maxLength={MAX_WIDGET_QUICK_REPLY_LENGTH}
                        onChange={e => updateQuickReply(index, e.target.value)}
                        onBlur={e =>
                          updateQuickReply(
                            index,
                            normalizeWidgetQuickReply(e.target.value)
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => moveQuickReply(index, "up")}
                        disabled={index === 0}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => moveQuickReply(index, "down")}
                        disabled={index === activeQuickReplyItems.length - 1}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          updateQuickReplyLocaleItems(
                            activeQuickReplyLocale,
                            prev =>
                              prev.filter(item => item.id !== replyItem.id)
                          );
                          markQuickReplyLocaleDirty(activeQuickReplyLocale);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <Separator />

              <div className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={quickReplyDraft}
                    maxLength={MAX_WIDGET_QUICK_REPLY_LENGTH}
                    onChange={e =>
                      setQuickReplyDrafts(prev => ({
                        ...prev,
                        [activeQuickReplyLocale]: e.target.value,
                      }))
                    }
                    onKeyDown={handleQuickReplyKeyDown}
                    placeholder="Add a quick reply..."
                    disabled={
                      activeQuickReplyValues.length >= MAX_WIDGET_QUICK_REPLIES
                    }
                  />
                  <Button
                    type="button"
                    onClick={() => addQuickReply(quickReplyDraft)}
                    disabled={
                      !quickReplyDraft.trim() ||
                      activeQuickReplyValues.length >= MAX_WIDGET_QUICK_REPLIES
                    }
                  >
                    <Plus className="h-4 w-4" />
                    Add
                  </Button>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      setLocalizedQuickReplies(prev => ({
                        ...prev,
                        [quickReplyDefaultLocale]:
                          createQuickReplyItems(quickReplyTemplate),
                      }));
                      setActiveQuickReplyLocale(quickReplyDefaultLocale);
                      markQuickReplyLocaleDirty(quickReplyDefaultLocale);
                    }}
                    disabled={
                      quickReplyTemplate.length === 0 ||
                      !isEditingDefaultQuickReplyLocale
                    }
                  >
                    Use suggestions
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      updateQuickReplyLocaleItems(
                        activeQuickReplyLocale,
                        () => []
                      );
                      markQuickReplyLocaleDirty(activeQuickReplyLocale);
                    }}
                    disabled={activeQuickReplyItems.length === 0}
                  >
                    Clear all
                  </Button>
                  {quickReplySuggestions.map(suggestion => (
                    <Button
                      key={suggestion}
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => addQuickReply(suggestion)}
                      disabled={
                        !isEditingDefaultQuickReplyLocale ||
                        activeQuickReplyValues.length >=
                          MAX_WIDGET_QUICK_REPLIES
                      }
                    >
                      + {suggestion}
                    </Button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="appearance" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Palette className="h-4 w-4" />
                Theme Colors
              </CardTitle>
              <CardDescription>
                Control how the widget looks on your landing and client sites.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <ColorField
                id="widget-primary-color"
                label="Primary color"
                value={primaryColor}
                placeholder="#0B6BCB"
                onChange={setPrimaryColor}
              />
              <ColorField
                id="widget-bubble-color"
                label="Bubble color"
                value={bubbleColor}
                placeholder="#0B6BCB"
                onChange={setBubbleColor}
              />
              <ColorField
                id="widget-header-bg"
                label="Header background"
                value={headerBgColor}
                placeholder="#FFFFFF"
                onChange={setHeaderBgColor}
              />
              <ColorField
                id="widget-header-text"
                label="Header text color"
                value={headerTextColor}
                placeholder="#111827"
                onChange={setHeaderTextColor}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Layout Tweaks</CardTitle>
              <CardDescription>
                Control home variant and visibility of optional tabs.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Home variant</Label>
                <Select
                  value={homeVariant}
                  onValueChange={value => setHomeVariant(value as HomeVariant)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Home variant" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="intercom">
                      Intercom-style cards
                    </SelectItem>
                    <SelectItem value="simple">Simple layout</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="widget-show-help-tab">Show Help tab</Label>
                  <Switch
                    id="widget-show-help-tab"
                    checked={showHelpTab}
                    onCheckedChange={setShowHelpTab}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="widget-show-news-tab">Show News tab</Label>
                  <Switch
                    id="widget-show-news-tab"
                    checked={showNewsTab}
                    onCheckedChange={setShowNewsTab}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="branding" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Logo and Bubble Branding</CardTitle>
              <CardDescription>
                Choose default icon, custom text, or a hosted SVG URL.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Bubble mode</Label>
                <Select
                  value={bubbleMode}
                  onValueChange={value => setBubbleMode(value as BubbleMode)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Bubble mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="icon">Default icon</SelectItem>
                    <SelectItem value="text">Custom text</SelectItem>
                    <SelectItem value="svg">SVG URL</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Logo mode</Label>
                <Select
                  value={logoMode}
                  onValueChange={value => setLogoMode(value as LogoMode)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Logo mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default icon</SelectItem>
                    <SelectItem value="text">Custom text</SelectItem>
                    <SelectItem value="svg">SVG URL</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {bubbleMode === "text" && (
                <div className="space-y-2">
                  <Label htmlFor="widget-bubble-text">Bubble text</Label>
                  <Input
                    id="widget-bubble-text"
                    value={bubbleText}
                    onChange={e => setBubbleText(e.target.value)}
                    placeholder="Help"
                    maxLength={20}
                  />
                </div>
              )}

              {bubbleMode === "svg" && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="widget-bubble-svg-url">Bubble SVG URL</Label>
                  <Input
                    id="widget-bubble-svg-url"
                    value={bubbleSvgUrl}
                    onChange={e => setBubbleSvgUrl(e.target.value)}
                    placeholder="https://.../bubble.svg"
                  />
                </div>
              )}

              {logoMode === "text" && (
                <div className="space-y-2">
                  <Label htmlFor="widget-logo-text">Logo text</Label>
                  <Input
                    id="widget-logo-text"
                    value={logoText}
                    onChange={e => setLogoText(e.target.value)}
                    placeholder="ACME"
                    maxLength={20}
                  />
                </div>
              )}

              {logoMode === "svg" && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="widget-logo-svg-url">Logo SVG URL</Label>
                  <Input
                    id="widget-logo-svg-url"
                    value={logoSvgUrl}
                    onChange={e => setLogoSvgUrl(e.target.value)}
                    placeholder="https://.../logo.svg"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Saved changes immediately update the live widget configuration.
        </p>
        <Button onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save branding
        </Button>
      </div>
    </div>
  );
}
