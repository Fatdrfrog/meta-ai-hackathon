import { PUBLIC_TEMPLATE_EXAMPLES } from "./public-template-examples";
import type { PublicTemplateLocale } from "./template-request";

export const PUBLIC_TEMPLATE_INDUSTRIES = [
  "retail",
  "services",
  "education",
  "finance",
] as const;
export const PUBLIC_TEMPLATE_GOALS = [
  "acquire",
  "convert",
  "retain",
  "inform",
] as const;
export const PUBLIC_TEMPLATE_USE_CASES = [
  "follow-up",
  "booking",
  "service",
  "commerce",
  "information",
  "contacts",
  "learning",
  "retention",
] as const;
export const PUBLIC_TEMPLATE_FORMATS = [
  "text",
  "image",
  "carousel",
  "flow",
  "document",
  "location",
  "video",
] as const;

export type PublicTemplateIndustry =
  (typeof PUBLIC_TEMPLATE_INDUSTRIES)[number];
export type PublicTemplateGoal = (typeof PUBLIC_TEMPLATE_GOALS)[number];
export type PublicTemplateUseCase = (typeof PUBLIC_TEMPLATE_USE_CASES)[number];
export type PublicTemplateFormat = (typeof PUBLIC_TEMPLATE_FORMATS)[number];

export type PublicTemplatePreviewButton = {
  type: "URL" | "QUICK_REPLY" | "PHONE_NUMBER" | "FLOW";
  text: string;
  url?: string;
  phoneNumber?: string;
};

type LocalizedPreviewButton = Omit<PublicTemplatePreviewButton, "text"> & {
  textKey: string;
};

export type PublicTemplate = {
  id: string;
  industry: PublicTemplateIndustry;
  goal: PublicTemplateGoal;
  useCase: PublicTemplateUseCase;
  format: PublicTemplateFormat;
  titleKey?: string;
  bodyKey?: string;
  bodyPrefixKey?: string;
  bodySuffixKey?: string;
  footerKey?: string;
  descriptionKey?: string;
  title?: string;
  description?: string;
  buttonKey?: string;
  buttonKeys?: readonly LocalizedPreviewButton[];
  /** Omitted for the original examples shared across all public locales. */
  locales?: readonly PublicTemplateLocale[];
  preview?: {
    body: string;
    buttons: readonly PublicTemplatePreviewButton[];
    footer?: string;
  };
  /** Public artwork; approved send-time media is configured separately. */
  imagePath?: string;
  carouselImagePaths?: readonly string[];
  carouselPreviews?: readonly {
    body: string;
    buttons: readonly PublicTemplatePreviewButton[];
  }[];
  carouselPreviewKeys?: readonly {
    bodyKey: string;
    buttonKeys: readonly LocalizedPreviewButton[];
  }[];
  documentPath?: string;
  documentFilename?: string;
  videoPath?: string;
  videoPosterPath?: string;
  location?: {
    name: string;
    address: string;
    latitude: number;
    longitude: number;
  };
  /** Locale-specific attachments share the same catalog and preview owners. */
  localeAttachments?: Partial<
    Record<
      PublicTemplateLocale,
      Pick<
        PublicTemplate,
        "documentPath" | "documentFilename" | "videoPath" | "location"
      >
    >
  >;
};

/** Public inspiration only. Provider-ready bindings live on the server. */
const LOCALIZED_TEMPLATE_BUTTON_TYPES: Record<
  string,
  readonly PublicTemplatePreviewButton["type"][]
> = {
  "seasonal-offer": ["URL"],
  "abandoned-cart": ["QUICK_REPLY", "QUICK_REPLY"],
  "repeat-purchase": ["URL"],
  welcome: ["QUICK_REPLY", "QUICK_REPLY"],
  "order-confirmation": ["QUICK_REPLY", "QUICK_REPLY"],
  "shipping-update": ["URL"],
  "appointment-reminder": ["QUICK_REPLY", "QUICK_REPLY"],
  "course-enrollment": ["FLOW"],
  "payment-reminder": ["QUICK_REPLY", "QUICK_REPLY"],
  feedback: ["QUICK_REPLY", "QUICK_REPLY"],
  "back-in-stock": ["URL"],
  "birthday-offer": ["URL"],
};

function localizedPreviewButtons(id: string) {
  return LOCALIZED_TEMPLATE_BUTTON_TYPES[id].map((type, index) => ({
    type,
    textKey: `LandingDemo.templates.catalog.${id}.buttons.${index}`,
    ...(type === "URL" ? { url: "https://www.airi.chat/" } : {}),
  }));
}

function localizedPreviewText(id: string) {
  const unsubscribeKey = "LandingDemo.templates.unsubscribe";
  return {
    bodyPrefixKey: `LandingDemo.templates.catalog.${id}.demoPrefix`,
    ...(id === "back-in-stock"
      ? { bodySuffixKey: unsubscribeKey }
      : { footerKey: unsubscribeKey }),
  };
}

export const PUBLIC_TEMPLATES: readonly PublicTemplate[] = [
  {
    id: "seasonal-offer",
    industry: "retail",
    goal: "acquire",
    useCase: "commerce",
    format: "image",
    titleKey: "LandingDemo.templates.catalog.seasonal-offer.title",
    bodyKey: "LandingDemo.revenueWorkflows.campaign.message",
    ...localizedPreviewText("seasonal-offer"),
    descriptionKey: "LandingDemo.templates.catalog.seasonal-offer.description",
    buttonKey: "LandingDemo.templates.catalog.seasonal-offer.button",
    buttonKeys: localizedPreviewButtons("seasonal-offer"),
    imagePath: "/templates/seasonal-offer.png",
  },
  {
    id: "abandoned-cart",
    industry: "retail",
    goal: "convert",
    useCase: "follow-up",
    format: "text",
    titleKey: "LandingDemo.templates.catalog.abandoned-cart.title",
    bodyKey: "LandingDemo.revenueWorkflows.recovery.message",
    ...localizedPreviewText("abandoned-cart"),
    descriptionKey: "LandingDemo.templates.catalog.abandoned-cart.description",
    buttonKey: "LandingDemo.templates.catalog.abandoned-cart.button",
    buttonKeys: localizedPreviewButtons("abandoned-cart"),
  },
  {
    id: "repeat-purchase",
    industry: "retail",
    goal: "retain",
    useCase: "retention",
    format: "image",
    titleKey: "LandingDemo.revenueWorkflows.repeat.title",
    bodyKey: "LandingDemo.revenueWorkflows.repeat.message",
    ...localizedPreviewText("repeat-purchase"),
    descriptionKey: "LandingDemo.templates.catalog.repeat-purchase.description",
    buttonKey: "LandingDemo.templates.catalog.repeat-purchase.button",
    buttonKeys: localizedPreviewButtons("repeat-purchase"),
    imagePath: "/templates/repeat-purchase.png",
  },
  ...(
    [
      ["welcome", "services", "acquire", "text", "information"],
      ["order-confirmation", "retail", "inform", "text", "service"],
      ["shipping-update", "retail", "inform", "image", "service"],
      ["appointment-reminder", "services", "inform", "text", "booking"],
      ["course-enrollment", "education", "convert", "flow", "booking"],
      ["payment-reminder", "finance", "inform", "text", "service"],
      ["feedback", "services", "retain", "text", "retention"],
      ["back-in-stock", "retail", "convert", "carousel", "retention"],
      ["birthday-offer", "retail", "retain", "image", "retention"],
    ] as const
  ).map(([id, industry, goal, format, useCase]) => ({
    id,
    industry,
    goal,
    useCase,
    format,
    titleKey: `LandingDemo.templates.catalog.${id}.title`,
    bodyKey: `LandingDemo.templates.catalog.${id}.body`,
    ...localizedPreviewText(id),
    descriptionKey: `LandingDemo.templates.catalog.${id}.description`,
    buttonKey: `LandingDemo.templates.catalog.${id}.button`,
    buttonKeys: id === "back-in-stock" ? [] : localizedPreviewButtons(id),
    carouselPreviewKeys:
      id === "back-in-stock"
        ? [0, 1, 2].map(index => ({
            bodyKey: `LandingDemo.templates.catalog.${id}.cards.${index}.body`,
            buttonKeys: localizedPreviewButtons(id),
          }))
        : undefined,
    imagePath:
      id === "shipping-update" || id === "birthday-offer"
        ? `/templates/${id}.png`
        : undefined,
    carouselImagePaths:
      id === "back-in-stock"
        ? [
            "/templates/back-in-stock-01.png",
            "/templates/back-in-stock-02.png",
            "/templates/back-in-stock-03.png",
          ]
        : undefined,
  })),
  ...PUBLIC_TEMPLATE_EXAMPLES,
];

export function isPublicTemplateAvailableInLocale(
  template: PublicTemplate,
  locale: PublicTemplateLocale
): boolean {
  return !template.locales || template.locales.includes(locale);
}

export function getPublicTemplate(
  id: string,
  locale?: PublicTemplateLocale
): PublicTemplate | undefined {
  const template = PUBLIC_TEMPLATES.find(
    template =>
      template.id === id &&
      (!locale || isPublicTemplateAvailableInLocale(template, locale))
  );
  return template && locale
    ? withLocaleAttachments(template, locale)
    : template;
}

function withLocaleAttachments(
  template: PublicTemplate,
  locale: PublicTemplateLocale
): PublicTemplate {
  const attachments = template.localeAttachments?.[locale];
  return attachments ? { ...template, ...attachments } : template;
}

export function getPublicTemplateText(
  template: PublicTemplate,
  field: "title" | "body" | "description",
  translate: (key: string) => string
): string {
  if (field === "body" && template.preview) return template.preview.body;
  if (field !== "body" && template[field]) return template[field]!;
  const key = template[`${field}Key`];
  const text = key ? translate(key) : "";
  return field === "body"
    ? [
        template.bodyPrefixKey ? translate(template.bodyPrefixKey) : "",
        text,
        template.bodySuffixKey ? translate(template.bodySuffixKey) : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : text;
}

export function getPublicTemplateFooter(
  template: PublicTemplate,
  translate: (key: string) => string
): string {
  return (
    template.preview?.footer ??
    (template.footerKey ? translate(template.footerKey) : "")
  );
}

function translatePreviewButtons(
  buttons: readonly LocalizedPreviewButton[],
  translate: (key: string) => string
): PublicTemplatePreviewButton[] {
  return buttons.map(({ textKey, ...button }) => ({
    ...button,
    text: translate(textKey),
  }));
}

export function getPublicTemplateButtons(
  template: PublicTemplate,
  translate: (key: string) => string
): readonly PublicTemplatePreviewButton[] {
  if (template.preview) return template.preview.buttons;
  if (template.buttonKeys)
    return translatePreviewButtons(template.buttonKeys, translate);
  return template.buttonKey
    ? [
        {
          type: template.format === "flow" ? "FLOW" : "URL",
          text: translate(template.buttonKey),
        },
      ]
    : [];
}

export function getPublicTemplateCarouselPreviews(
  template: PublicTemplate,
  translate: (key: string) => string
): readonly {
  body: string;
  buttons: readonly PublicTemplatePreviewButton[];
}[] {
  return (
    template.carouselPreviews ??
    template.carouselPreviewKeys?.map(card => ({
      body: translate(card.bodyKey),
      buttons: translatePreviewButtons(card.buttonKeys, translate),
    })) ??
    []
  );
}

export type PublicTemplateFilters = {
  q: string;
  industry: PublicTemplateIndustry | "";
  goal: PublicTemplateGoal | "";
  format: PublicTemplateFormat | "";
  /** Existing callers without a use-case choice continue to browse all jobs. */
  useCase?: PublicTemplateUseCase | "";
};

function recognizedValue<T extends string>(
  value: string | null,
  values: readonly T[]
): T | "" {
  return values.includes(value as T) ? (value as T) : "";
}

export function getPublicTemplateFilters(
  params: Pick<URLSearchParams, "get">
): PublicTemplateFilters {
  return {
    q: (params.get("q") ?? "").trim().slice(0, 120),
    industry: recognizedValue(
      params.get("industry"),
      PUBLIC_TEMPLATE_INDUSTRIES
    ),
    goal: recognizedValue(params.get("goal"), PUBLIC_TEMPLATE_GOALS),
    format: recognizedValue(params.get("format"), PUBLIC_TEMPLATE_FORMATS),
    useCase: recognizedValue(params.get("useCase"), PUBLIC_TEMPLATE_USE_CASES),
  };
}

export function filterPublicTemplates(
  filters: PublicTemplateFilters,
  translate: (key: string) => string = key => key,
  locale: PublicTemplateLocale = "en"
): readonly PublicTemplate[] {
  const query = filters.q.toLocaleLowerCase();
  return PUBLIC_TEMPLATES.filter(template => {
    if (!isPublicTemplateAvailableInLocale(template, locale)) return false;
    if (filters.industry && template.industry !== filters.industry)
      return false;
    if (filters.goal && template.goal !== filters.goal) return false;
    if (filters.format && template.format !== filters.format) return false;
    if (filters.useCase && template.useCase !== filters.useCase) return false;
    if (!query) return true;
    return [
      template.id,
      getPublicTemplateText(template, "title", translate),
      getPublicTemplateText(template, "body", translate),
      getPublicTemplateText(template, "description", translate),
      translate(`LandingDemo.templates.useCases.${template.useCase}`),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  }).map(template => withLocaleAttachments(template, locale));
}
