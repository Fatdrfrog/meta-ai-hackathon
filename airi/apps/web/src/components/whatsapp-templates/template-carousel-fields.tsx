"use client";

import { Button } from "@/components/ui/button";
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CarouselCardsScroller } from "@/components/whatsapp/carousel-cards-scroller";
import { cn } from "@/lib/utils";
import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import { ImagePlus, Images, Loader2, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
  useFieldArray,
  useFormContext,
  useFormState,
  useWatch,
  type UseFieldArrayReturn,
} from "react-hook-form";
import { readTemplateCarouselCountError } from "./template-carousel-errors";
import {
  applyTemplateCarouselIntent,
  canSetTemplateCarouselButtonType,
  projectTemplateCarousel,
  TEMPLATE_CAROUSEL_BUTTON_TYPES,
  type TemplateCarouselButtonType,
  type TemplateCarouselCardFormValue,
} from "./template-carousel-model";
import type { TemplateFormValues } from "./template-editor-form-utils";
import {
  TEMPLATE_FORM_FIELD_ITEM_CLASS,
  TEMPLATE_FORM_SELECT_TRIGGER_CLASS,
} from "./template-editor-form-layout";

const CAROUSEL_BUTTON_TYPE_LABEL_KEYS = {
  QUICK_REPLY: "form.quickReply",
  URL: "form.url",
  PHONE_NUMBER: "form.phoneNumber",
} as const satisfies Record<TemplateCarouselButtonType, string>;

export function TemplateCarouselFields({
  fieldArray,
  disabled,
  onUploadMedia,
  onPickAsset,
}: {
  fieldArray: UseFieldArrayReturn<TemplateFormValues, "carouselCards">;
  disabled?: boolean;
  onUploadMedia: (file: File) => Promise<string | null>;
  onPickAsset?: (clientId: string) => void;
}) {
  const tTemplates = useTranslations("templates");
  const { control, getValues, setValue, trigger } =
    useFormContext<TemplateFormValues>();
  const { fields, append, remove, replace } = fieldArray;
  const { isSubmitted, errors } = useFormState({
    control,
    name: "carouselCards",
  });
  const cards =
    useWatch({ control, name: "carouselCards" }) ??
    ([] as TemplateCarouselCardFormValue[]);
  const projection = projectTemplateCarousel(cards);
  const countError = isSubmitted
    ? readTemplateCarouselCountError(errors.carouselCards)
    : undefined;

  const applyIntent = (
    intent: Parameters<typeof applyTemplateCarouselIntent>[1]
  ) => {
    replace(
      applyTemplateCarouselIntent(getValues("carouselCards") || [], intent)
    );
    if (intent.type === "set_header_format") {
      setValue("carouselHeaderFormat", intent.format, { shouldDirty: true });
    }
    if (isSubmitted) {
      void trigger("carouselCards");
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={TEMPLATE_FORM_FIELD_ITEM_CLASS}>
          <span className="text-sm font-medium">
            {tTemplates("form.carouselHeaderFormat")}
          </span>
          <Select
            value={projection.headerFormat}
            disabled={disabled}
            onValueChange={value =>
              applyIntent({
                type: "set_header_format",
                format: value === "VIDEO" ? "VIDEO" : "IMAGE",
              })
            }
          >
            <SelectTrigger
              className={TEMPLATE_FORM_SELECT_TRIGGER_CLASS}
              aria-label={tTemplates("form.carouselHeaderFormat")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="IMAGE">{tTemplates("form.image")}</SelectItem>
              <SelectItem value="VIDEO">{tTemplates("form.video")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className={TEMPLATE_FORM_FIELD_ITEM_CLASS}>
          <span className="text-sm font-medium">
            {tTemplates("form.carouselButtons")}
          </span>
          <ol className="space-y-2">
            {projection.buttonTypes.map((buttonType, slot) => (
              <li key={slot} className="flex items-center gap-2">
                <span className="w-16 shrink-0 truncate text-xs font-medium text-muted-foreground">
                  {tTemplates("form.button")} {slot + 1}
                </span>
                <Select
                  value={buttonType}
                  disabled={disabled}
                  onValueChange={value =>
                    applyIntent({
                      type: "set_button_type",
                      slot,
                      buttonType: value as TemplateCarouselButtonType,
                    })
                  }
                >
                  <SelectTrigger
                    className={TEMPLATE_FORM_SELECT_TRIGGER_CLASS}
                    aria-label={tTemplates("form.carouselButtonSlotType", {
                      index: slot + 1,
                    })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_CAROUSEL_BUTTON_TYPES.map(option => (
                      <SelectItem
                        key={option}
                        value={option}
                        disabled={
                          !canSetTemplateCarouselButtonType(
                            projection.buttonTypes,
                            slot,
                            option
                          )
                        }
                      >
                        {tTemplates(CAROUSEL_BUTTON_TYPE_LABEL_KEYS[option])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {projection.canRemoveButton ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground"
                    aria-label={tTemplates("form.removeCarouselButtonSlot", {
                      index: slot + 1,
                    })}
                    disabled={disabled}
                    onClick={() => applyIntent({ type: "remove_button", slot })}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
          {projection.canAddButton ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={disabled}
              onClick={() => applyIntent({ type: "add_button" })}
            >
              <Plus className="h-4 w-4" aria-hidden />
              {tTemplates("form.addButton")}
            </Button>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {tTemplates("form.carouselButtonsHint", {
          count: projection.buttonTypes.length,
          max: WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BUTTONS_MAX_COUNT,
        })}
      </p>

      {countError ? (
        <p className="text-sm font-medium text-destructive">{countError}</p>
      ) : null}

      <CarouselCardsScroller
        previousLabel={tTemplates("form.carouselScrollPrevious")}
        nextLabel={tTemplates("form.carouselScrollNext")}
      >
        {fields.map((field, index) => (
          <TemplateCarouselCardEditor
            key={field.id}
            index={index}
            canRemove={projection.canRemoveCard}
            disabled={disabled}
            onRemove={() => {
              remove(index);
              if (isSubmitted) {
                void trigger("carouselCards");
              }
            }}
            onUploadMedia={onUploadMedia}
            onPickAsset={
              onPickAsset
                ? () =>
                    onPickAsset(
                      cards[index]?.clientId || field.clientId || field.id
                    )
                : undefined
            }
          />
        ))}
        {projection.canAddCard ? (
          <button
            type="button"
            disabled={disabled}
            className="flex w-[72px] shrink-0 flex-col items-center justify-center gap-1 self-stretch rounded-lg border border-dashed bg-muted/20 text-muted-foreground transition-colors hover:bg-muted/40 disabled:opacity-50"
            aria-label={tTemplates("form.addCarouselCard")}
            onClick={() => {
              const next = applyTemplateCarouselIntent(
                getValues("carouselCards") || [],
                { type: "add_card" }
              );
              const added = next[next.length - 1];
              if (added) {
                append(added, { shouldFocus: false });
              }
              if (isSubmitted) {
                void trigger("carouselCards");
              }
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            <span className="px-1 text-center text-[10px] leading-tight">
              {tTemplates("form.addCarouselCard")}
            </span>
          </button>
        ) : null}
      </CarouselCardsScroller>
    </div>
  );
}

function TemplateCarouselCardEditor({
  index,
  canRemove,
  disabled,
  onRemove,
  onUploadMedia,
  onPickAsset,
}: {
  index: number;
  canRemove: boolean;
  disabled?: boolean;
  onRemove: () => void;
  onUploadMedia: (file: File) => Promise<string | null>;
  onPickAsset?: () => void;
}) {
  const tTemplates = useTranslations("templates");
  const { control, getValues, setValue } = useFormContext<TemplateFormValues>();
  const { isSubmitted } = useFormState({ control });
  const { fields: buttonFields } = useFieldArray({
    control,
    name: `carouselCards.${index}.buttons` as `carouselCards.${number}.buttons`,
  });
  const headerFormat = useWatch({
    control,
    name: `carouselCards.${index}.headerFormat`,
  });
  const clientId = useWatch({
    control,
    name: `carouselCards.${index}.clientId`,
  });
  const mediaUrl = (
    useWatch({
      control,
      name: `carouselCards.${index}.headerMediaExample`,
    }) || ""
  ).trim();
  const isVideo = headerFormat === "VIDEO";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadEpochRef = useRef(0);

  useEffect(() => {
    return () => {
      uploadEpochRef.current += 1;
    };
  }, []);

  const handleFiles = async (files: File[]) => {
    const file = files[0];
    if (!file || disabled) return;
    const startedClientId = clientId;
    const startedFormat = headerFormat;
    const epoch = ++uploadEpochRef.current;
    setUploading(true);
    try {
      const url = await onUploadMedia(file);
      if (!url || epoch !== uploadEpochRef.current) return;
      const cards = getValues("carouselCards") ?? [];
      const nextIndex = cards.findIndex(
        card =>
          card.clientId === startedClientId &&
          card.headerFormat === startedFormat
      );
      if (nextIndex < 0) return;
      setValue(`carouselCards.${nextIndex}.headerMediaExample`, url, {
        shouldDirty: true,
        shouldTouch: true,
        shouldValidate: isSubmitted,
      });
    } finally {
      if (epoch === uploadEpochRef.current) {
        setUploading(false);
      }
    }
  };

  return (
    <div className="relative w-[200px] shrink-0 overflow-hidden rounded-lg border bg-background">
      {canRemove ? (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="absolute left-1 top-1 z-[1] h-6 w-6 rounded-full"
          aria-label={tTemplates("form.removeCarouselCard")}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
        </Button>
      ) : null}

      <FormField
        control={control}
        name={`carouselCards.${index}.headerMediaExample`}
        render={({ field, fieldState }) => {
          const commitMedia = (url: string) => {
            field.onChange(url);
            field.onBlur();
          };
          return (
            <FormItem className="space-y-0">
              <input
                ref={inputRef}
                className="sr-only"
                type="file"
                accept={isVideo ? "video/*" : "image/*"}
                aria-label={tTemplates("form.attachMedia")}
                onChange={event => {
                  void handleFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              {mediaUrl ? (
                <div className="group relative">
                  <button
                    type="button"
                    ref={field.ref}
                    onBlur={field.onBlur}
                    className="block w-full"
                    disabled={disabled || uploading}
                    aria-label={tTemplates("form.attachMedia")}
                    onClick={() => inputRef.current?.click()}
                  >
                    {isVideo ? (
                      <video
                        src={mediaUrl}
                        muted
                        playsInline
                        preload="metadata"
                        className="h-24 w-full object-cover"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaUrl}
                        alt=""
                        className="h-24 w-full object-cover"
                      />
                    )}
                  </button>
                  <div className="absolute right-1 top-1 z-[1] flex gap-1">
                    {onPickAsset ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="h-6 w-6 rounded-full"
                        disabled={disabled || uploading}
                        aria-label={tTemplates("form.chooseAsset")}
                        onClick={onPickAsset}
                      >
                        <Images className="h-3 w-3" aria-hidden />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="h-6 w-6 rounded-full"
                      disabled={disabled || uploading}
                      aria-label={tTemplates("form.removeMedia")}
                      onClick={() => commitMedia("")}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  className={cn(
                    "flex h-24 w-full flex-col",
                    fieldState.error && "ring-1 ring-inset ring-destructive/70"
                  )}
                >
                  <button
                    type="button"
                    ref={field.ref}
                    onBlur={field.onBlur}
                    className={cn(
                      "flex min-h-0 flex-1 flex-col items-center justify-center gap-1 bg-muted/40 text-muted-foreground hover:bg-muted/60 disabled:opacity-50",
                      uploading && "cursor-wait"
                    )}
                    disabled={disabled || uploading}
                    aria-label={tTemplates("form.attachMedia")}
                    onClick={() => inputRef.current?.click()}
                    onDragOver={event => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                    }}
                    onDrop={event => {
                      event.preventDefault();
                      void handleFiles(
                        Array.from(event.dataTransfer.files ?? [])
                      );
                    }}
                  >
                    {uploading ? (
                      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                    ) : (
                      <ImagePlus className="h-5 w-5" aria-hidden />
                    )}
                    <span className="text-[10px]">
                      {tTemplates("form.attachMedia")}
                    </span>
                  </button>
                  {onPickAsset ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 rounded-none border-t text-[10px]"
                      disabled={disabled || uploading}
                      onClick={onPickAsset}
                    >
                      <Images className="h-3 w-3" aria-hidden />
                      {tTemplates("form.chooseAsset")}
                    </Button>
                  ) : null}
                </div>
              )}
              <FormMessage className="px-2.5 pt-1 text-[10px] leading-snug" />
            </FormItem>
          );
        }}
      />

      <div className="space-y-2 p-2.5">
        <p className="text-[10px] font-medium text-muted-foreground">
          {tTemplates("form.carouselCard")} {index + 1}
        </p>
        <FormField
          control={control}
          name={`carouselCards.${index}.bodyText`}
          render={({ field, fieldState }) => (
            <FormItem className="space-y-1">
              <FormControl>
                <Textarea
                  {...field}
                  maxLength={
                    WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BODY_MAX_LENGTH
                  }
                  rows={3}
                  disabled={disabled}
                  placeholder={tTemplates("form.carouselCardBodyPlaceholder")}
                  aria-label={tTemplates("form.carouselCardBody")}
                  className={cn(
                    "min-h-[4.5rem] resize-none text-xs",
                    fieldState.error && "border-destructive"
                  )}
                />
              </FormControl>
              <div className="flex items-start justify-between gap-2">
                <FormMessage className="text-[10px] leading-snug" />
                <p className="shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {(field.value || "").length}/
                  {WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BODY_MAX_LENGTH}
                </p>
              </div>
            </FormItem>
          )}
        />
        {buttonFields.map((buttonField, buttonIndex) => {
          const buttonType =
            getValues(`carouselCards.${index}.buttons.${buttonIndex}.type`) ||
            "QUICK_REPLY";
          return (
            <div key={buttonField.id} className="space-y-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">
                {tTemplates("form.button")} {buttonIndex + 1} ·{" "}
                {tTemplates(CAROUSEL_BUTTON_TYPE_LABEL_KEYS[buttonType])}
              </p>
              <FormField
                control={control}
                name={`carouselCards.${index}.buttons.${buttonIndex}.text`}
                render={({ field, fieldState }) => (
                  <FormItem className="space-y-1">
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value || ""}
                        maxLength={
                          WHATSAPP_TEMPLATE_LIMITS.BUTTON_TEXT_MAX_LENGTH
                        }
                        disabled={disabled}
                        placeholder={tTemplates(
                          "form.carouselButtonTextPlaceholder"
                        )}
                        aria-label={`${tTemplates("form.buttonText")} ${buttonIndex + 1}`}
                        className={cn(
                          "h-8 text-xs",
                          fieldState.error && "border-destructive"
                        )}
                      />
                    </FormControl>
                    <FormMessage className="text-[10px] leading-snug" />
                  </FormItem>
                )}
              />
              {buttonType === "URL" ? (
                <FormField
                  control={control}
                  name={`carouselCards.${index}.buttons.${buttonIndex}.url`}
                  render={({ field, fieldState }) => (
                    <FormItem className="space-y-1">
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value || ""}
                          disabled={disabled}
                          placeholder="https://"
                          maxLength={
                            WHATSAPP_TEMPLATE_LIMITS.BUTTON_URL_MAX_LENGTH
                          }
                          aria-label={tTemplates("form.url")}
                          className={cn(
                            "h-8 text-xs",
                            fieldState.error && "border-destructive"
                          )}
                        />
                      </FormControl>
                      <FormMessage className="text-[10px] leading-snug" />
                    </FormItem>
                  )}
                />
              ) : null}
              {buttonType === "PHONE_NUMBER" ? (
                <FormField
                  control={control}
                  name={`carouselCards.${index}.buttons.${buttonIndex}.phone_number`}
                  render={({ field, fieldState }) => (
                    <FormItem className="space-y-1">
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value || ""}
                          disabled={disabled}
                          placeholder="+1..."
                          aria-label={tTemplates("form.phoneNumber")}
                          className={cn(
                            "h-8 text-xs",
                            fieldState.error && "border-destructive"
                          )}
                        />
                      </FormControl>
                      <FormMessage className="text-[10px] leading-snug" />
                    </FormItem>
                  )}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
