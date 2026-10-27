"use client";

import type { ScenarioActionNodeEnrichment } from "../../../view/node-enrichment/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CarouselCardsScroller } from "@/components/whatsapp/carousel-cards-scroller";
import type { ScenarioOptionBranchHandleLayout } from "@/components/scenarios/source-handle-types";
import { SCENARIO_HANDLE_ANCHOR_CLASS } from "@/components/scenarios/source-handle-button";
import { useLatestRef } from "@/components/scenarios/view/use-latest-ref";
import { cn } from "@/lib/utils";
import {
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppCarouselCard,
  type ScenarioWhatsAppInteractiveOption,
} from "@icecore/scenario-contracts";
import { ChevronDown, Link2, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState, type ReactNode } from "react";
import { waActionButton } from "../action-colors";
import {
  CarouselOptionHandleRail,
  useCarouselOptionHandleRail,
} from "./carousel-option-handle-rail-view";
import {
  fieldErrorMessage,
  type ServiceMessageFieldErrorMap,
} from "./service-message-field-errors";
import { createServiceMessageEntityId } from "./service-message-ids";
import { ServiceMessageMediaField } from "./service-message-media-field";
import {
  applyServiceMessageCarouselIntent,
  createCarouselDraftCards as createCarouselDraftCardsModel,
  projectServiceMessageCarousel,
  type ServiceMessageCarouselInteractionKind,
} from "./service-message-carousel-model";

/** Hairline between caption and button rows (matches the WhatsApp bubble). */
const CARD_DIVIDER = "rgba(11, 20, 26, 0.12)";

/** Current-card width with a next-card peek, matching WhatsApp carousel density. */
export const SERVICE_MESSAGE_CAROUSEL_CARD_WIDTH_CLASS =
  "w-[min(16.25rem,82%)]";

/** Minimum WhatsApp-valid draft (2 quick-reply cards) shown after "add carousel". */
export function createCarouselDraftCards(
  createOptionId: () => string
): ScenarioWhatsAppCarouselCard[] {
  return createCarouselDraftCardsModel({
    createCardId: createServiceMessageEntityId,
    createOptionId,
  });
}

export function ServiceMessageCarouselFields({
  cards,
  upload,
  createOptionId,
  renderBranchHandle,
  connectedOptionIds,
  onViewportChange,
  fieldErrors,
  onChange,
}: {
  cards: ScenarioWhatsAppCarouselCard[];
  upload?: ScenarioActionNodeEnrichment["uiMedia"]["upload"];
  createOptionId: () => string;
  renderBranchHandle?: (
    option: ScenarioWhatsAppInteractiveOption,
    layout?: ScenarioOptionBranchHandleLayout
  ) => ReactNode;
  connectedOptionIds?: ReadonlySet<string>;
  onViewportChange?: () => void;
  fieldErrors?: ServiceMessageFieldErrorMap;
  onChange: (cards: ScenarioWhatsAppCarouselCard[]) => void;
}) {
  const t = useTranslations("Scenarios");
  const carouselDependencies = {
    createCardId: createServiceMessageEntityId,
    createOptionId,
  };
  const cardsRef = useLatestRef(cards);
  const errors = fieldErrors ?? new Map();
  const cardsShapeError = fieldErrorMessage(errors, "cards");

  const updateCard = (
    cardId: string,
    update: (card: ScenarioWhatsAppCarouselCard) => ScenarioWhatsAppCarouselCard
  ) => {
    const next = cardsRef.current.map(current =>
      current.id === cardId ? update(current) : current
    );
    cardsRef.current = next;
    onChange(next);
  };

  const optionsById = useMemo(() => {
    const options = new Map<string, ScenarioWhatsAppInteractiveOption>();
    for (const card of cards) {
      if (card.interaction.kind !== "quick_replies") continue;
      for (const option of card.interaction.options) {
        options.set(option.id, option);
      }
    }
    return options;
  }, [cards]);

  const handleRail = useCarouselOptionHandleRail({
    enabled: Boolean(renderBranchHandle),
    layoutKey: cards,
    connectedOptionIds,
    onViewportChange,
  });
  const { wrapRef, handleViewportChange, hiddenConnectionClusters } =
    handleRail;
  const activeCardIds =
    handleRail.activeCardIds.length > 0
      ? handleRail.activeCardIds
      : cards[0]
        ? [cards[0].id]
        : [];

  return (
    <div className="space-y-1" data-sm-field="cards">
      {cardsShapeError ? (
        <p className="px-0.5 text-[10px] leading-snug text-destructive">
          {cardsShapeError}
        </p>
      ) : null}
      <div ref={wrapRef} className="relative overflow-visible">
        <CarouselCardsScroller
          onViewportChange={handleViewportChange}
          previousLabel={t("whatsappServiceCarouselScrollPrevious")}
          nextLabel={t("whatsappServiceCarouselScrollNext")}
        >
          {cards.map((card, index) => {
            const mediaKey = `cards.${index}.media`;
            const mediaError = fieldErrorMessage(errors, mediaKey);
            const bodyKey = `cards.${index}.bodyText`;
            const bodyError = fieldErrorMessage(errors, bodyKey);
            const urlLabelKey = `cards.${index}.interaction.buttonLabel`;
            const urlKey = `cards.${index}.interaction.url`;
            const urlLabelError = fieldErrorMessage(errors, urlLabelKey);
            const urlError = fieldErrorMessage(errors, urlKey);
            const isActiveCard = activeCardIds.includes(card.id);
            return (
              <div
                key={card.id}
                data-carousel-card-id={card.id}
                className={cn(
                  "service-message-carousel-card group/card relative shrink-0 overflow-visible rounded-lg bg-white ring-1 ring-black/[0.08] dark:bg-[#1f2c33] dark:ring-white/10",
                  SERVICE_MESSAGE_CAROUSEL_CARD_WIDTH_CLASS
                )}
              >
                {cards.length >
                WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cards.min ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="nodrag nopan absolute left-1 top-1 z-[1] h-6 w-6 rounded-full bg-black/60 text-white hover:bg-black/75"
                    title={t("whatsappServiceDeleteCard")}
                    aria-label={t("whatsappServiceDeleteCard")}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={() =>
                      onChange(
                        applyServiceMessageCarouselIntent(
                          cards,
                          { type: "remove_card", cardId: card.id },
                          carouselDependencies
                        )
                      )
                    }
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </Button>
                ) : null}

                <ServiceMessageMediaField
                  carousel
                  attachment={card.media}
                  allowAudio={false}
                  accept="image/*,video/*"
                  removeLabel={t("whatsappServiceRemoveMedia")}
                  upload={upload}
                  uploadLabel={t("whatsappServiceCarouselAddMedia")}
                  error={mediaError}
                  fieldKey={mediaKey}
                  onChange={media =>
                    updateCard(card.id, current => ({
                      ...current,
                      media:
                        media &&
                        (media.mediaType === "image" ||
                          media.mediaType === "video")
                          ? { ...media, mediaType: media.mediaType }
                          : { url: "", mediaType: "image" },
                    }))
                  }
                />

                <div className="px-2.5 pb-1 pt-1.5">
                  <textarea
                    className={cn(
                      "nodrag nowheel field-sizing-content min-h-10 max-h-24 w-full resize-none overflow-y-auto bg-transparent text-[12.4px] leading-[1.45] text-[#111b21] outline-none placeholder:text-[#667781]/60 dark:text-[#e9edef] dark:placeholder:text-[#8696a0]/60 [scrollbar-width:thin]",
                      bodyError &&
                        "rounded-sm text-destructive ring-1 ring-destructive/70"
                    )}
                    rows={2}
                    maxLength={
                      WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cardBody
                    }
                    value={card.bodyText || ""}
                    placeholder={t(
                      "whatsappServiceCarouselCardTextPlaceholder"
                    )}
                    aria-label={t("whatsappServiceCarouselCardTextLabel", {
                      n: index + 1,
                    })}
                    data-sm-field={bodyKey}
                    onPointerDown={event => event.stopPropagation()}
                    onKeyDown={event => event.stopPropagation()}
                    onChange={event =>
                      updateCard(card.id, current => ({
                        ...current,
                        bodyText: event.target.value,
                      }))
                    }
                  />
                  {bodyError ? (
                    <p className="pt-1 text-[10px] leading-snug text-destructive">
                      {bodyError}
                    </p>
                  ) : null}
                  <p className="pt-0.5 text-right text-[10px] leading-none tabular-nums text-[#667781] dark:text-[#8696a0]">
                    {(card.bodyText || "").length}/
                    {WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cardBody}
                  </p>
                </div>

                {card.interaction.kind === "url" ? (
                  <div style={{ borderTop: `1px solid ${CARD_DIVIDER}` }}>
                    <div className="flex items-center justify-center gap-1.5 px-2 py-2">
                      <Link2
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          waActionButton.icon
                        )}
                        aria-hidden
                      />
                      <input
                        type="text"
                        maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label}
                        value={card.interaction.buttonLabel}
                        placeholder={t("actionCtaLinkLabelPlaceholder")}
                        aria-label={t("whatsappServiceCarouselButtonAria", {
                          card: index + 1,
                          n: 1,
                        })}
                        data-sm-field={urlLabelKey}
                        className={cn(
                          "nodrag w-24 min-w-0 bg-transparent text-center text-[13px] outline-none",
                          waActionButton.text,
                          waActionButton.placeholder,
                          urlLabelError &&
                            "rounded-sm text-destructive ring-1 ring-destructive/70"
                        )}
                        onPointerDown={event => event.stopPropagation()}
                        onKeyDown={event => event.stopPropagation()}
                        onChange={event =>
                          updateCard(card.id, current =>
                            current.interaction.kind === "url"
                              ? {
                                  ...current,
                                  interaction: {
                                    ...current.interaction,
                                    buttonLabel: event.target.value,
                                  },
                                }
                              : current
                          )
                        }
                      />
                    </div>
                    {urlLabelError ? (
                      <p className="px-2 pb-1 text-[10px] leading-snug text-destructive">
                        {urlLabelError}
                      </p>
                    ) : null}
                    <div
                      className="px-2 pb-2"
                      style={{ borderTop: `1px solid ${CARD_DIVIDER}` }}
                    >
                      <input
                        type="url"
                        value={card.interaction.url}
                        placeholder={t("actionCtaLinkPlaceholder")}
                        aria-label={t("whatsappServiceCarouselCardLink", {
                          n: index + 1,
                        })}
                        data-sm-field={urlKey}
                        className={cn(
                          "nodrag mt-1.5 w-full bg-transparent text-center text-[11px] text-[#667781] outline-none placeholder:text-[#667781]/50 dark:text-[#8696a0]",
                          urlError &&
                            "rounded-sm text-destructive ring-1 ring-destructive/70"
                        )}
                        onPointerDown={event => event.stopPropagation()}
                        onKeyDown={event => event.stopPropagation()}
                        onChange={event =>
                          updateCard(card.id, current =>
                            current.interaction.kind === "url"
                              ? {
                                  ...current,
                                  interaction: {
                                    ...current.interaction,
                                    url: event.target.value,
                                  },
                                }
                              : current
                          )
                        }
                      />
                      {urlError ? (
                        <p className="pt-1 text-[10px] leading-snug text-destructive">
                          {urlError}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div>
                    {card.interaction.options.map((option, optionIndex) => {
                      const optionLabelKey = `cards.${index}.interaction.options.${optionIndex}.label`;
                      const optionError = fieldErrorMessage(
                        errors,
                        optionLabelKey
                      );
                      return (
                        <div
                          key={option.id}
                          className={cn(
                            "group/option flex min-w-0 flex-col overflow-visible",
                            isActiveCard && SCENARIO_HANDLE_ANCHOR_CLASS
                          )}
                          style={{ borderTop: `1px solid ${CARD_DIVIDER}` }}
                          data-sm-field={optionLabelKey}
                          data-carousel-option-id={option.id}
                          data-carousel-option-index={optionIndex}
                        >
                          <div className="z-[2] flex min-w-0 items-center gap-1 overflow-visible px-2 py-2">
                            <MessageSquare
                              className={cn(
                                "ms-1 h-3.5 w-3.5 shrink-0",
                                waActionButton.icon
                              )}
                              aria-hidden
                            />
                            <input
                              type="text"
                              maxLength={
                                WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label
                              }
                              value={option.label}
                              placeholder={t("buttonText")}
                              aria-label={t(
                                "whatsappServiceCarouselButtonAria",
                                { card: index + 1, n: optionIndex + 1 }
                              )}
                              className={cn(
                                "nodrag min-w-0 flex-1 bg-transparent text-center text-[13px] outline-none",
                                waActionButton.text,
                                waActionButton.placeholder,
                                optionError && "text-destructive"
                              )}
                              onPointerDown={event => event.stopPropagation()}
                              onKeyDown={event => event.stopPropagation()}
                              onChange={event =>
                                updateCard(card.id, current =>
                                  current.interaction.kind === "quick_replies"
                                    ? {
                                        ...current,
                                        interaction: {
                                          ...current.interaction,
                                          options:
                                            current.interaction.options.map(
                                              item =>
                                                item.id === option.id
                                                  ? {
                                                      ...item,
                                                      label: event.target.value,
                                                    }
                                                  : item
                                            ),
                                        },
                                      }
                                    : current
                                )
                              }
                            />
                            {isActiveCard
                              ? renderBranchHandle?.(option, { local: true })
                              : null}
                          </div>
                          {optionError ? (
                            <p className="px-2 pb-1.5 text-[10px] leading-snug text-destructive">
                              {optionError}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {cards.length < WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cards.max ? (
            <button
              type="button"
              className="nodrag flex w-[72px] shrink-0 flex-col items-center justify-center gap-1 self-stretch rounded-lg border border-dashed border-black/15 bg-white/60 text-[#667781] transition-colors hover:bg-white dark:border-white/15 dark:bg-white/[0.04] dark:text-[#8696a0]"
              aria-label={t("whatsappServiceAddCard")}
              title={t("whatsappServiceAddCard")}
              onPointerDown={event => event.stopPropagation()}
              onClick={() =>
                onChange(
                  applyServiceMessageCarouselIntent(
                    cards,
                    { type: "add_card" },
                    carouselDependencies
                  )
                )
              }
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="px-1 text-center text-[10px] leading-tight">
                {t("whatsappServiceAddCard")}
              </span>
            </button>
          ) : null}
        </CarouselCardsScroller>
        {renderBranchHandle ? (
          <CarouselOptionHandleRail
            clusters={hiddenConnectionClusters}
            renderHandle={optionId => {
              const option = optionsById.get(optionId);
              return option
                ? renderBranchHandle(option, { local: true })
                : null;
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Carousel-wide settings rendered below the whole service message: interaction
 * family (uniform across cards per WhatsApp contract) and carousel removal.
 */
export function ServiceMessageCarouselControls({
  cards,
  createOptionId,
  removeControl,
  onChange,
}: {
  cards: ScenarioWhatsAppCarouselCard[];
  createOptionId: () => string;
  /** Control that removes the whole carousel. */
  removeControl?: ReactNode;
  onChange: (cards: ScenarioWhatsAppCarouselCard[]) => void;
}) {
  const t = useTranslations("Scenarios");
  const projection = projectServiceMessageCarousel(cards);
  const { interactionKind } = projection;
  const carouselDependencies = {
    createCardId: createServiceMessageEntityId,
    createOptionId,
  };
  const [pendingInteractionKind, setPendingInteractionKind] =
    useState<ServiceMessageCarouselInteractionKind | null>(null);
  const interactionLabelId = useId();

  const applyInteractionKind = (
    kind: ServiceMessageCarouselInteractionKind
  ) => {
    onChange(
      applyServiceMessageCarouselIntent(
        cards,
        { type: "set_interaction_kind", kind },
        carouselDependencies
      )
    );
  };

  const setInteractionKind = (kind: ServiceMessageCarouselInteractionKind) => {
    if (kind === interactionKind && projection.uniform) return;
    if (projection.hasUserInteractionContent) {
      setPendingInteractionKind(kind);
      return;
    }
    applyInteractionKind(kind);
  };

  const addOptionToAllCards = () => {
    onChange(
      applyServiceMessageCarouselIntent(
        cards,
        { type: "add_option" },
        carouselDependencies
      )
    );
  };

  const removeLastOptionFromAllCards = () => {
    onChange(
      applyServiceMessageCarouselIntent(
        cards,
        { type: "remove_option" },
        carouselDependencies
      )
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="nodrag nopan h-6 rounded-full px-2 text-[10px] text-muted-foreground"
              aria-label={t("whatsappServiceCarouselButtonCount")}
              aria-describedby={interactionLabelId}
            >
              <span id={interactionLabelId}>
                {interactionKind === "url"
                  ? t("whatsappServiceCarouselWebsite")
                  : t("whatsappServiceCarouselQuickReplies")}
              </span>
              <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" portalled={false}>
            <DropdownMenuItem
              onSelect={() => setInteractionKind("quick_replies")}
            >
              <MessageSquare aria-hidden />
              {t("whatsappServiceCarouselQuickReplies")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setInteractionKind("url")}>
              <Link2 aria-hidden />
              {t("whatsappServiceCarouselWebsite")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {projection.canAddOption ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="nodrag nopan h-6 rounded-full px-2 text-[10px] text-muted-foreground"
            onPointerDown={event => event.stopPropagation()}
            onClick={addOptionToAllCards}
          >
            <Plus className="h-3 w-3" aria-hidden />
            {t("whatsappServiceCarouselAddButtonEveryCard")}
          </Button>
        ) : null}
        {projection.canRemoveOption ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="nodrag nopan h-6 rounded-full px-2 text-[10px] text-muted-foreground hover:text-destructive"
            onPointerDown={event => event.stopPropagation()}
            onClick={removeLastOptionFromAllCards}
          >
            <Trash2 className="h-3 w-3" aria-hidden />
            {t("whatsappServiceCarouselDeleteButtonEveryCard")}
          </Button>
        ) : null}
        {removeControl ? <div className="ms-auto">{removeControl}</div> : null}
      </div>
      <AlertDialog
        open={pendingInteractionKind !== null}
        onOpenChange={open => {
          if (!open) setPendingInteractionKind(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("whatsappServiceCarouselInteractionChangeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("whatsappServiceCarouselInteractionChangeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingInteractionKind) {
                  applyInteractionKind(pendingInteractionKind);
                }
                setPendingInteractionKind(null);
              }}
            >
              {t("whatsappServiceCarouselInteractionChangeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
