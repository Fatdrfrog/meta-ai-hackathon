"use client";

import { getButtonTypeIcon } from "@/components/scenarios/builders/whatsapp/action-renderer";
import { SCENARIO_HANDLE_ANCHOR_CLASS } from "@/components/scenarios/source-handle-anchor";
import { CarouselCardsScroller } from "@/components/whatsapp/carousel-cards-scroller";
import { isBrowserRenderableMediaUrl } from "@/lib/whatsapp/templates/header-media-utils";
import { cn } from "@/lib/utils";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  getWhatsAppTemplateCarouselComponent,
  type TemplateCarouselButtonType,
} from "./template-carousel-model";

/** The preview button type whose icon the message preview shows. */
const PREVIEW_BUTTON_TYPE = {
  QUICK_REPLY: "quick_reply",
  URL: "url",
  PHONE_NUMBER: "phone",
} as const satisfies Record<TemplateCarouselButtonType, string>;

/**
 * Route dots reach out 44px, over the next-cards arrow beside them; keep the
 * arrows on top. A dot under an arrow is reachable once its card scrolls left.
 */
const ARROWS_ABOVE_ROUTES_CLASS = "z-30";

/** A card quick reply's route on the scenario canvas. */
export type TemplateCarouselButtonRoute = {
  /** Names the button among every card's buttons. */
  optionId: string;
  /** The route dot, or `null` while its card is scrolled away. */
  handle: ReactNode;
};

export function TemplateCarouselPreview({
  components,
  onViewportChange,
  renderButtonRoute,
}: {
  components?: WhatsAppComponent[] | null;
  /** Runs when the cards scroll or resize. */
  onViewportChange?: () => void;
  /** A card quick reply's route, or `null` when it has none. */
  renderButtonRoute?: (button: {
    cardIndex: number;
    buttonIndex: number;
  }) => TemplateCarouselButtonRoute | null;
}) {
  const tTemplates = useTranslations("templates");
  const carousel = getWhatsAppTemplateCarouselComponent(components);
  if (!carousel?.cards.length) return null;

  return (
    <div data-testid="template-carousel-preview">
      <CarouselCardsScroller
        onViewportChange={onViewportChange}
        previousLabel={tTemplates("form.carouselScrollPrevious")}
        nextLabel={tTemplates("form.carouselScrollNext")}
        navigationClassName={
          renderButtonRoute ? ARROWS_ABOVE_ROUTES_CLASS : undefined
        }
      >
        {carousel.cards.map((card, index) => {
          const header = card.components.find(item => item.type === "HEADER");
          const body = card.components.find(item => item.type === "BODY");
          const buttons = card.components.find(item => item.type === "BUTTONS");
          const mediaUrl =
            header && header.type === "HEADER"
              ? header.example?.header_handle?.find(isBrowserRenderableMediaUrl) ||
                ""
              : "";
          const isVideo =
            header && header.type === "HEADER" && header.format === "VIDEO";
          const bodyText =
            body && body.type === "BODY" ? body.text?.trim() || "" : "";

          return (
            <div
              key={`preview-card-${index}`}
              data-carousel-card-id={String(index)}
              className="w-[160px] shrink-0 overflow-hidden rounded-lg border bg-white text-[#111b21]"
            >
              {mediaUrl ? (
                isVideo ? (
                  <video
                    src={mediaUrl}
                    muted
                    playsInline
                    preload="metadata"
                    className="h-20 w-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={mediaUrl}
                    alt=""
                    className="h-20 w-full object-cover"
                  />
                )
              ) : (
                <div className="h-20 w-full bg-[#e9edef]" />
              )}
              <div className="space-y-1.5 p-2">
                {bodyText ? (
                  <p className="line-clamp-3 text-[11px] leading-snug">
                    {bodyText}
                  </p>
                ) : null}
                {buttons && buttons.type === "BUTTONS"
                  ? buttons.buttons.map((button, buttonIndex) => {
                      const Icon = getButtonTypeIcon(
                        PREVIEW_BUTTON_TYPE[button.type]
                      );
                      const route =
                        button.type === "QUICK_REPLY"
                          ? (renderButtonRoute?.({
                              cardIndex: index,
                              buttonIndex,
                            }) ?? null)
                          : null;
                      return (
                        <div
                          key={`preview-card-${index}-btn-${buttonIndex}`}
                          data-button-type={button.type}
                          data-carousel-option-id={route?.optionId}
                          data-carousel-option-index={
                            route ? String(buttonIndex) : undefined
                          }
                          className={cn(
                            "flex items-center justify-center gap-1 rounded-md border border-black/10 px-2 py-1 text-center text-[11px] font-medium text-[#027eb5]",
                            route && SCENARIO_HANDLE_ANCHOR_CLASS
                          )}
                        >
                          <Icon
                            className="h-3 w-3 shrink-0"
                            strokeWidth={1.75}
                            aria-hidden
                          />
                          <span className="min-w-0 break-words">
                            {button.text || " "}
                          </span>
                          {route?.handle}
                        </div>
                      );
                    })
                  : null}
              </div>
            </div>
          );
        })}
      </CarouselCardsScroller>
    </div>
  );
}
