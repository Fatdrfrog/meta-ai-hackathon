"use client";

import { WhatsAppActionRenderer } from "@/components/scenarios/builders/whatsapp/action-renderer";
import type {
  ScenarioWhatsAppPreviewButton,
  ScenarioWhatsAppTemplatePreview,
} from "@/components/scenarios/types";
import { buildWhatsAppTemplatePreview } from "@/components/scenarios/view/preview/utils";
import { cn } from "@/lib/utils";
import {
  getTemplateHeaderMedia,
  type TemplateHeaderMedia,
} from "@/lib/whatsapp/templates/header-media-utils";
import type { WhatsAppTemplateSelectionItem } from "@/lib/whatsapp/templates/selection-utils";
import { MessageCircle } from "lucide-react";
import type { ReactNode } from "react";
import { TemplateCarouselPreview } from "./template-carousel-preview";

const IPHONE_15_WIDTH = 393;
const CARD_PREVIEW_WIDTH = 300;

type TemplatePhonePreviewMode = "card" | "modal";

export type TemplatePhonePreviewModel = {
  channel: "whatsapp" | "telegram";
  preview: ScenarioWhatsAppTemplatePreview | null;
  telegramText: string;
  headerMedia: TemplateHeaderMedia | null;
  height: number;
};

type InlineEditBindings = {
  headerText?: string;
  bodyText: string;
  footerText?: string;
  buttons?: ScenarioWhatsAppPreviewButton[];
  headerMediaFormat?: "IMAGE" | "VIDEO" | "DOCUMENT";
  headerMediaUrl?: string;
  onHeaderTextChange?: (value: string) => void;
  onBodyTextChange?: (value: string) => void;
  onFooterTextChange?: (value: string) => void;
  onButtonLabelChange?: (index: number, value: string) => void;
};

type TemplatePhonePreviewProps = {
  template: WhatsAppTemplateSelectionItem;
  model?: TemplatePhonePreviewModel;
  mode?: TemplatePhonePreviewMode;
  className?: string;
  inlineEdit?: InlineEditBindings;
  /** Shown in the bubble while the template has no body yet (live editors). */
  emptyBodyText?: string;
  footer?: ReactNode;
};

function collectPreviewTokens(
  value: string | null | undefined,
  out: Set<string>
) {
  if (!value) return;
  for (const match of value.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
    const token = match[1]?.trim();
    if (token) out.add(token);
  }
  for (const match of value.matchAll(
    /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_.-]+)+)\}/g
  )) {
    const token = match[1]?.trim();
    if (token) out.add(token);
  }
}

function assignPreviewToken(
  context: Record<string, unknown>,
  token: string,
  value: string
) {
  const parts = token.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cursor = context;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    const next = cursor[part];
    if (!next || typeof next !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  });
}

function buildLiteralPreviewContext(template: WhatsAppTemplateSelectionItem) {
  const tokens = new Set<string>();
  for (const component of template.components || []) {
    if (
      component.type === "HEADER" ||
      component.type === "BODY" ||
      component.type === "FOOTER"
    ) {
      collectPreviewTokens(component.text, tokens);
    }
    if (component.type === "BUTTONS") {
      component.buttons?.forEach(button => {
        if (button.type === "URL") {
          collectPreviewTokens(button.url, tokens);
        }
      });
    }
    if (component.type === "CAROUSEL") {
      component.cards?.forEach(card => {
        card.components?.forEach(cardComponent => {
          if (cardComponent.type === "BODY") {
            collectPreviewTokens(cardComponent.text, tokens);
          }
          if (cardComponent.type === "BUTTONS") {
            cardComponent.buttons?.forEach(button => {
              if (button.type === "URL") {
                collectPreviewTokens(button.url, tokens);
              }
            });
          }
        });
      });
    }
  }
  const context: Record<string, unknown> = {};
  tokens.forEach(token => assignPreviewToken(context, token, `{{${token}}}`));
  return context;
}

function estimatePreviewHeight(params: {
  preview: ScenarioWhatsAppTemplatePreview | null;
  telegramText: string;
  channel: "whatsapp" | "telegram";
  carouselCardCount?: number;
}) {
  const lineHeight = 19;
  if (params.channel === "telegram") {
    return Math.min(
      520,
      Math.max(
        150,
        92 + Math.ceil(params.telegramText.length / 40) * lineHeight
      )
    );
  }
  const preview = params.preview;
  const textLines =
    Math.ceil((preview?.headerText?.length ?? 0) / 38) +
    Math.max(1, Math.ceil((preview?.bodyText?.length ?? 0) / 42)) +
    Math.ceil((preview?.footerText?.length ?? 0) / 42);
  const buttonHeight = (preview?.buttons.length ?? 0) * 44;
  const mediaHeight = preview?.headerMediaFormat ? 126 : 0;
  const carouselHeight = (params.carouselCardCount ?? 0) > 0 ? 180 : 0;
  return Math.min(
    carouselHeight > 0 ? 720 : 620,
    Math.max(
      170,
      112 + textLines * lineHeight + buttonHeight + mediaHeight + carouselHeight
    )
  );
}

export function buildTemplatePhonePreviewModel(
  template: WhatsAppTemplateSelectionItem
): TemplatePhonePreviewModel {
  const channel = template.channel === "telegram" ? "telegram" : "whatsapp";
  const telegramText = template.telegramData?.text || "";
  const basePreview =
    channel === "whatsapp"
      ? buildWhatsAppTemplatePreview({
          components: template.components,
          context: buildLiteralPreviewContext(template),
        })
      : null;
  const headerMedia = getTemplateHeaderMedia(template.components);
  const preview =
    basePreview && headerMedia?.url
      ? { ...basePreview, headerMediaUrl: headerMedia.url }
      : basePreview;
  const carouselCardCount =
    template.components?.find(component => component.type === "CAROUSEL")
      ?.cards?.length ?? 0;

  return {
    channel,
    preview,
    telegramText,
    headerMedia,
    height: estimatePreviewHeight({
      preview,
      telegramText,
      channel,
      carouselCardCount,
    }),
  };
}

function PhoneFrame({
  children,
  mode,
  className,
}: {
  children: ReactNode;
  mode: TemplatePhonePreviewMode;
  className?: string;
}) {
  const width = mode === "modal" ? IPHONE_15_WIDTH : CARD_PREVIEW_WIDTH;

  return (
    <div
      className={cn("mx-auto w-full overflow-visible", className)}
      style={{ maxWidth: width }}
    >
      {children}
    </div>
  );
}

function renderEditableButtons(bindings: InlineEditBindings) {
  return (bindings.buttons || []).map((button, index) => ({
    ...button,
    key: `template-preview-button-${index}`,
    onLabelChange:
      button.type === "quick_reply" || button.type === "flow"
        ? (value: string) => bindings.onButtonLabelChange?.(index, value)
        : undefined,
  }));
}

export function TemplatePhonePreview({
  template,
  model: providedModel,
  mode = "card",
  className,
  inlineEdit,
  emptyBodyText,
  footer,
}: TemplatePhonePreviewProps) {
  const model = providedModel ?? buildTemplatePhonePreviewModel(template);
  const label = `${template.name}${template.language ? ` [${template.language}]` : ""}`;
  const hasCarousel = Boolean(
    template.components?.some(component => component.type === "CAROUSEL")
  );

  return (
    <div
      data-testid="template-phone-preview"
      data-channel={model.channel}
      className={cn("space-y-3", className)}
    >
      <PhoneFrame mode={mode}>
        {model.channel === "telegram" ? (
          <div className="overflow-hidden rounded-[28px] bg-[#dceaf6] shadow-sm">
            <div className="flex items-center gap-2 bg-[#2aabee] px-4 py-3 text-white">
              <MessageCircle className="h-5 w-5" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">Telegram</p>
                <p className="text-[11px] text-white/75">{label}</p>
              </div>
            </div>
            <div className="p-3">
              <div className="max-w-[86%] rounded-2xl rounded-bl-md bg-white px-3 py-2 text-[13px] leading-relaxed text-[#17212b] shadow-sm">
                <p className="whitespace-pre-wrap break-words">
                  {model.telegramText || template.name}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <WhatsAppActionRenderer
            headerText={inlineEdit?.headerText ?? model.preview?.headerText}
            onHeaderTextChange={inlineEdit?.onHeaderTextChange}
            headerMediaFormat={
              inlineEdit?.headerMediaFormat ?? model.preview?.headerMediaFormat
            }
            headerMediaUrl={
              inlineEdit?.headerMediaUrl ?? model.preview?.headerMediaUrl
            }
            bodyText={
              inlineEdit?.bodyText ??
              (emptyBodyText && !model.preview?.bodyText
                ? emptyBodyText
                : (model.preview?.bodyText ?? template.name))
            }
            onBodyTextChange={inlineEdit?.onBodyTextChange}
            footerText={inlineEdit?.footerText ?? model.preview?.footerText}
            onFooterTextChange={inlineEdit?.onFooterTextChange}
            buttons={
              inlineEdit
                ? renderEditableButtons(inlineEdit)
                : model.preview?.buttons || []
            }
            appBarContent={
              <span className="block truncate text-[13px] font-medium text-white">
                {label}
              </span>
            }
            previewClassName="w-full"
            className="w-full"
            mediaLoading={mode === "modal" ? "eager" : "lazy"}
            showVideoControls={mode === "modal"}
            videoPreload="metadata"
            fitContent
            align="start"
            bubbleTrailingContent={
              hasCarousel ? (
                <TemplateCarouselPreview components={template.components} />
              ) : undefined
            }
          />
        )}
      </PhoneFrame>
      {footer ? <div>{footer}</div> : null}
    </div>
  );
}
