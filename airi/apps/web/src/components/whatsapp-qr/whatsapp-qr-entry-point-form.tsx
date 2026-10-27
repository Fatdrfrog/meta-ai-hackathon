"use client";

import { WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH } from "@icecore/scenario-contracts";
import { useTranslations } from "next-intl";
import { useId } from "react";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import type { WhatsAppQrSourceOption } from "./types";

export const WHATSAPP_QR_PLACEMENT_NAME_MAX_LENGTH = 120;

export type WhatsAppQrEntryPointFormValue = {
  sourceId: string;
  placementName: string;
  desiredMessage: string;
};

export type WhatsAppQrEntryPointFormErrors = Partial<
  Record<keyof WhatsAppQrEntryPointFormValue, string>
>;

export type WhatsAppQrEntryPointValidationMessages = {
  chooseSource: string;
  enterPlacementName: string;
  enterDesiredMessage: string;
  maxCharacters(maximum: number): string;
};

export function useWhatsAppQrEntryPointValidationMessages(): WhatsAppQrEntryPointValidationMessages {
  const t = useTranslations("WhatsAppQr.form.errors");
  return {
    chooseSource: t("chooseSource"),
    enterPlacementName: t("enterPlacementName"),
    enterDesiredMessage: t("enterDesiredMessage"),
    maxCharacters: maximum => t("maxCharacters", { maximum }),
  };
}

export function validateWhatsAppQrEntryPointForm(
  value: WhatsAppQrEntryPointFormValue,
  options: {
    requireSource: boolean;
    requireMessage: boolean;
    messages: WhatsAppQrEntryPointValidationMessages;
  }
): WhatsAppQrEntryPointFormErrors {
  const messages = options.messages;
  const errors: WhatsAppQrEntryPointFormErrors = {};
  if (options.requireSource && !value.sourceId.trim()) {
    errors.sourceId = messages.chooseSource;
  }
  const placementName = value.placementName.trim();
  if (!placementName) {
    errors.placementName = messages.enterPlacementName;
  } else if (placementName.length > WHATSAPP_QR_PLACEMENT_NAME_MAX_LENGTH) {
    errors.placementName = messages.maxCharacters(
      WHATSAPP_QR_PLACEMENT_NAME_MAX_LENGTH
    );
  }
  const desiredMessage = value.desiredMessage.trim();
  if (options.requireMessage && !desiredMessage) {
    errors.desiredMessage = messages.enterDesiredMessage;
  } else if (desiredMessage.length > WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH) {
    errors.desiredMessage = messages.maxCharacters(
      WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH
    );
  }
  return errors;
}

export type WhatsAppQrEntryPointFormProps = {
  value: WhatsAppQrEntryPointFormValue;
  onChange(value: WhatsAppQrEntryPointFormValue): void;
  sourceOptions: readonly WhatsAppQrSourceOption[];
  disabled?: boolean;
  sourceDisabled?: boolean;
  showSource?: boolean;
  requireSource?: boolean;
  requireMessage?: boolean;
  showErrors?: boolean;
  idPrefix?: string;
};

export function WhatsAppQrEntryPointForm({
  value,
  onChange,
  sourceOptions,
  disabled = false,
  sourceDisabled = false,
  showSource = true,
  requireSource = true,
  requireMessage = false,
  showErrors = false,
  idPrefix,
}: WhatsAppQrEntryPointFormProps) {
  const t = useTranslations("WhatsAppQr.form");
  const validationMessages = useWhatsAppQrEntryPointValidationMessages();
  const generatedId = useId();
  const prefix = idPrefix || `whatsapp-qr-${generatedId}`;
  const selectedSourceLabel = sourceOptions.find(
    source => source.id === value.sourceId
  )?.label;
  const errors = showErrors
    ? validateWhatsAppQrEntryPointForm(value, {
        requireSource: showSource && requireSource,
        requireMessage,
        messages: validationMessages,
      })
    : {};

  return (
    <FieldGroup>
      {showSource ? (
        <Field
          data-disabled={disabled || sourceDisabled || undefined}
          data-invalid={Boolean(errors.sourceId) || undefined}
        >
          <FieldLabel htmlFor={`${prefix}-source`}>
            {t("sourceLabel")}
          </FieldLabel>
          <Select
            value={value.sourceId}
            onValueChange={sourceId => onChange({ ...value, sourceId })}
            disabled={disabled || sourceDisabled || sourceOptions.length === 0}
          >
            <SelectTrigger
              id={`${prefix}-source`}
              className="w-full min-w-0 max-w-full *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate"
              aria-label={
                selectedSourceLabel
                  ? `${t("sourceLabel")}: ${selectedSourceLabel}`
                  : t("sourcePlaceholder")
              }
              title={selectedSourceLabel}
              aria-invalid={Boolean(errors.sourceId) || undefined}
            >
              <SelectValue placeholder={t("sourcePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sourceOptions.map(source => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>{t("sourceDescription")}</FieldDescription>
          <FieldError>{errors.sourceId}</FieldError>
        </Field>
      ) : null}

      <Field
        data-disabled={disabled || undefined}
        data-invalid={Boolean(errors.placementName) || undefined}
      >
        <FieldLabel htmlFor={`${prefix}-placement`}>
          {t("placementLabel")}
        </FieldLabel>
        <Input
          id={`${prefix}-placement`}
          value={value.placementName}
          onChange={event =>
            onChange({ ...value, placementName: event.target.value })
          }
          maxLength={WHATSAPP_QR_PLACEMENT_NAME_MAX_LENGTH}
          disabled={disabled}
          aria-invalid={Boolean(errors.placementName) || undefined}
          autoComplete="off"
        />
        <FieldDescription>{t("placementDescription")}</FieldDescription>
        <FieldError>{errors.placementName}</FieldError>
      </Field>

      <Field
        data-disabled={disabled || undefined}
        data-invalid={Boolean(errors.desiredMessage) || undefined}
      >
        <FieldLabel htmlFor={`${prefix}-message`}>
          {t("messageLabel")}
          {requireMessage ? "" : ` ${t("optional")}`}
        </FieldLabel>
        <Textarea
          id={`${prefix}-message`}
          value={value.desiredMessage}
          onChange={event =>
            onChange({ ...value, desiredMessage: event.target.value })
          }
          rows={4}
          maxLength={WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH}
          disabled={disabled}
          aria-invalid={Boolean(errors.desiredMessage) || undefined}
        />
        <FieldDescription>
          {t("messageDescription", {
            count: value.desiredMessage.length,
            maximum: WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH,
          })}
        </FieldDescription>
        <FieldError>{errors.desiredMessage}</FieldError>
      </Field>
    </FieldGroup>
  );
}
