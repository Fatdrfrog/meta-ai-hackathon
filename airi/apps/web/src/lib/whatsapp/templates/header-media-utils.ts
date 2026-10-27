import {
  WHATSAPP_TEMPLATE_HEADER_FORMAT_MEDIA_TYPES,
  type WhatsAppTemplateHeaderMediaFormat,
} from "@/lib/whatsapp/media-types";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";

export type TemplateHeaderMediaFormat = WhatsAppTemplateHeaderMediaFormat;

export type TemplateHeaderMedia = {
  format: TemplateHeaderMediaFormat;
  value?: string;
  url?: string;
  rawHandle?: string;
  isRenderable: boolean;
};

const MEDIA_HEADER_FORMATS = new Set(
  Object.keys(WHATSAPP_TEMPLATE_HEADER_FORMAT_MEDIA_TYPES)
);

export function isTemplateHeaderMediaFormat(
  value: unknown
): value is TemplateHeaderMediaFormat {
  return typeof value === "string" && MEDIA_HEADER_FORMATS.has(value);
}

/** Meta-hosted media links expire; our own links do not. */
export function isWhatsAppCdnUrl(link: string): boolean {
  try {
    const hostname = new URL(link).hostname.toLowerCase();
    return (
      hostname === "scontent.whatsapp.net" || hostname.endsWith(".whatsapp.net")
    );
  } catch {
    return false;
  }
}

export function isBrowserRenderableMediaUrl(
  value: string | null | undefined
): value is string {
  const trimmed = value?.trim();
  if (!trimmed) return false;

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getTemplateHeaderMedia(
  components: WhatsAppComponent[] | null | undefined
): TemplateHeaderMedia | null {
  const header = components?.find(component => component.type === "HEADER");
  if (!header || header.type !== "HEADER") return null;
  if (!isTemplateHeaderMediaFormat(header.format)) return null;

  const rawValue = header.example?.header_handle?.[0];
  const value =
    typeof rawValue === "string" && rawValue.trim()
      ? rawValue.trim()
      : undefined;
  const url = isBrowserRenderableMediaUrl(value) ? value : undefined;

  return {
    format: header.format,
    value,
    url,
    rawHandle: url ? undefined : value,
    isRenderable: Boolean(url),
  };
}

function getCarouselComponent(
  components: WhatsAppComponent[] | null | undefined
) {
  const carousel = components?.find(component => component.type === "CAROUSEL");
  return carousel && carousel.type === "CAROUSEL" ? carousel : null;
}

function shouldPreferUnifiedCarouselCardMedia(params: {
  metaComponents: WhatsAppComponent[] | null | undefined;
  unifiedComponents: WhatsAppComponent[] | null | undefined;
}): boolean {
  const unifiedCarousel = getCarouselComponent(params.unifiedComponents);
  if (!unifiedCarousel) return false;

  const metaCarousel = getCarouselComponent(params.metaComponents);
  if (!metaCarousel) {
    return unifiedCarousel.cards.some(card =>
      Boolean(getTemplateHeaderMedia(card.components)?.url)
    );
  }

  return unifiedCarousel.cards.some((card, index) => {
    const unifiedMedia = getTemplateHeaderMedia(card.components);
    if (!unifiedMedia?.url) return false;
    const metaMedia = getTemplateHeaderMedia(
      metaCarousel.cards[index]?.components
    );
    if (!metaMedia) return true;
    if (metaMedia.url) return false;
    return metaMedia.format === unifiedMedia.format;
  });
}

export function shouldPreferUnifiedMediaComponents(params: {
  metaComponents: WhatsAppComponent[] | null | undefined;
  unifiedComponents: WhatsAppComponent[] | null | undefined;
}): boolean {
  const unifiedMedia = getTemplateHeaderMedia(params.unifiedComponents);
  if (unifiedMedia?.url) {
    const metaMedia = getTemplateHeaderMedia(params.metaComponents);
    if (!metaMedia) return true;
    if (metaMedia.url) return false;
    return metaMedia.format === unifiedMedia.format;
  }

  return shouldPreferUnifiedCarouselCardMedia(params);
}

function mergeCarouselCardHeaderMedia(params: {
  metaComponents: WhatsAppComponent[];
  unifiedComponents: WhatsAppComponent[];
}): WhatsAppComponent[] {
  const unifiedCarousel = getCarouselComponent(params.unifiedComponents);
  if (!unifiedCarousel) return params.metaComponents;

  let replacedCard = false;
  const merged = params.metaComponents.map(component => {
    if (component.type !== "CAROUSEL") return component;
    return {
      ...component,
      cards: component.cards.map((card, index) => {
        const unifiedCard = unifiedCarousel.cards[index];
        const unifiedHeader = unifiedCard?.components.find(
          item => item.type === "HEADER"
        );
        if (!unifiedHeader || unifiedHeader.type !== "HEADER") return card;
        const unifiedMedia = getTemplateHeaderMedia(unifiedCard.components);
        if (!unifiedMedia?.url) return card;
        const metaMedia = getTemplateHeaderMedia(card.components);
        if (metaMedia?.url) return card;
        if (metaMedia && metaMedia.format !== unifiedMedia.format) return card;

        let replacedHeader = false;
        const components = card.components.map(cardComponent => {
          if (cardComponent.type !== "HEADER") return cardComponent;
          if (cardComponent.format !== unifiedHeader.format) {
            return cardComponent;
          }
          replacedHeader = true;
          return {
            ...cardComponent,
            example: unifiedHeader.example,
          };
        });
        if (!replacedHeader) return card;
        replacedCard = true;
        return { ...card, components };
      }),
    };
  });

  return replacedCard ? merged : params.metaComponents;
}

export function mergeComponentsWithUnifiedHeaderMediaUrl(params: {
  metaComponents: WhatsAppComponent[] | null | undefined;
  unifiedComponents: WhatsAppComponent[] | null | undefined;
}): WhatsAppComponent[] | undefined {
  if (!shouldPreferUnifiedMediaComponents(params)) {
    return params.metaComponents ?? undefined;
  }

  const metaComponents = params.metaComponents ?? [];
  const unifiedComponents = params.unifiedComponents ?? [];
  if (metaComponents.length === 0) {
    return unifiedComponents.length > 0 ? unifiedComponents : undefined;
  }

  let merged = metaComponents;
  const unifiedHeader = unifiedComponents.find(
    component => component.type === "HEADER"
  );
  if (unifiedHeader && unifiedHeader.type === "HEADER") {
    let replacedHeader = false;
    merged = merged.map(component => {
      if (component.type !== "HEADER") return component;
      if (component.format !== unifiedHeader.format) return component;
      replacedHeader = true;
      return {
        ...component,
        example: unifiedHeader.example,
      };
    });
    if (!replacedHeader) {
      return unifiedComponents;
    }
  }

  return mergeCarouselCardHeaderMedia({
    metaComponents: merged,
    unifiedComponents,
  });
}
