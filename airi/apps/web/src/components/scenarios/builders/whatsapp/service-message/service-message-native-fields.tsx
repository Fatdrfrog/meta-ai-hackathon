"use client";

import {
  ServiceGroupError,
  ServiceMessageFieldErrorsContext,
  ServiceMessageIntegerInput as ScenarioIntegerInput,
  ServiceMessageInput as Input,
  useServiceGroupError,
} from "./service-message-field";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import { useTranslations } from "next-intl";
import { useContext, useId } from "react";
import { ScenarioCollapsibleSection } from "../../../scenario-collapsible-section";
import { ServiceMessageContactFields } from "./service-message-contact-fields";
import { hasServiceMessageNativeFields } from "./service-message-editor-model";

type NativeMessage<Kind extends ScenarioWhatsAppServiceMessagePayload["kind"]> =
  Extract<ScenarioWhatsAppServiceMessagePayload, { kind: Kind }>;

function ServiceMessageLinkPreviewField({
  message,
  onChange,
}: {
  message: NativeMessage<"text">;
  onChange: (message: ScenarioWhatsAppServiceMessagePayload) => void;
}) {
  const t = useTranslations("Scenarios");
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
      <Label htmlFor={id} className="text-xs font-normal">
        {t("whatsappServiceLinkPreview")}
      </Label>
      <Switch
        id={id}
        className="nodrag nopan nokey"
        checked={message.previewUrl !== false}
        onCheckedChange={checked =>
          onChange({ ...message, previewUrl: checked })
        }
      />
    </div>
  );
}

function ServiceMessageAppointmentFields({
  message,
  onChange,
}: {
  message: NativeMessage<"appointment">;
  onChange: (message: ScenarioWhatsAppServiceMessagePayload) => void;
}) {
  const t = useTranslations("Scenarios");
  const configError = useServiceGroupError("config");
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2" data-sm-field="config">
        <ScenarioIntegerInput
          fieldKey="config.maxSlots"
          label={t("whatsappBookCallMaxSlotsLabel")}
          className="nodrag h-8 text-xs"
          min={1}
          max={10}
          defaultValue={5}
          value={message.config.maxSlots}
          {...configError.inputProps}
          onValueCommit={maxSlots =>
            onChange({
              ...message,
              config: { ...message.config, maxSlots },
            })
          }
        />
        <ScenarioIntegerInput
          fieldKey="config.durationMinutes"
          label={t("whatsappBookCallDurationLabel")}
          className="nodrag h-8 text-xs"
          min={5}
          max={480}
          defaultValue={30}
          value={message.config.durationMinutes}
          onValueCommit={durationMinutes =>
            onChange({
              ...message,
              config: { ...message.config, durationMinutes },
            })
          }
        />
        <Input
          fieldKey="config.timeZone"
          label={t("whatsappBookCallTimeZoneLabel")}
          className="nodrag col-span-2 h-8 text-xs"
          value={message.config.timeZone || ""}
          placeholder={t("whatsappBookCallTimeZonePlaceholder")}
          onChange={event =>
            onChange({
              ...message,
              config: { ...message.config, timeZone: event.target.value },
            })
          }
        />
        <Input
          fieldKey="config.eventTitle"
          label={t("whatsappBookCallEventTitleLabel")}
          className="nodrag col-span-2 h-8 text-xs"
          value={message.config.eventTitle || ""}
          placeholder={t("whatsappBookCallEventTitlePlaceholder")}
          onChange={event =>
            onChange({
              ...message,
              config: { ...message.config, eventTitle: event.target.value },
            })
          }
        />
      </div>
      <ServiceGroupError fieldKey="config" id={configError.id} />
    </div>
  );
}

function ServiceMessageLocationFields({
  message,
  onChange,
}: {
  message: NativeMessage<"location">;
  onChange: (message: ScenarioWhatsAppServiceMessagePayload) => void;
}) {
  const t = useTranslations("Scenarios");
  const coordinatesError = useServiceGroupError("location");
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <Input
          className="nodrag col-span-2 h-8 text-xs"
          fieldKey="location.name"
          label={t("whatsappLocationNameLabel")}
          value={message.location.name || ""}
          placeholder={t("whatsappLocationNamePlaceholder")}
          onChange={event =>
            onChange({
              ...message,
              location: { ...message.location, name: event.target.value },
            })
          }
        />
        <Input
          className="nodrag col-span-2 h-8 text-xs"
          fieldKey="location.address"
          label={t("whatsappLocationAddressLabel")}
          value={message.location.address || ""}
          placeholder={t("whatsappLocationAddressPlaceholder")}
          onChange={event =>
            onChange({
              ...message,
              location: { ...message.location, address: event.target.value },
            })
          }
        />
      </div>
      {/* The coordinates error targets this pair, so Show lands on latitude. */}
      <div className="grid grid-cols-2 gap-2" data-sm-field="location">
        <Input
          className="nodrag h-8 text-xs"
          inputMode="decimal"
          fieldKey="location.latitude"
          label={t("whatsappLocationLatitudeLabel")}
          value={String(message.location.latitude ?? "")}
          placeholder={t("whatsappLocationLatitudePlaceholder")}
          {...coordinatesError.inputProps}
          onChange={event =>
            onChange({
              ...message,
              location: { ...message.location, latitude: event.target.value },
            })
          }
        />
        <Input
          className="nodrag h-8 text-xs"
          inputMode="decimal"
          fieldKey="location.longitude"
          label={t("whatsappLocationLongitudeLabel")}
          value={String(message.location.longitude ?? "")}
          placeholder={t("whatsappLocationLongitudePlaceholder")}
          {...coordinatesError.inputProps}
          onChange={event =>
            onChange({
              ...message,
              location: {
                ...message.location,
                longitude: event.target.value,
              },
            })
          }
        />
      </div>
      <ServiceGroupError fieldKey="location" id={coordinatesError.id} />
    </div>
  );
}

function ServiceMessageVoiceCallFields({
  message,
  onChange,
}: {
  message: NativeMessage<"voice_call">;
  onChange: (message: ScenarioWhatsAppServiceMessagePayload) => void;
}) {
  const t = useTranslations("Scenarios");
  const fieldErrors = useContext(ServiceMessageFieldErrorsContext);
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <Input
          className="nodrag h-8 text-xs"
          maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label}
          fieldKey="buttonLabel"
          label={t("buttonText")}
          value={message.buttonLabel}
          placeholder={t("whatsappServiceFormatVoiceCall")}
          onChange={event =>
            onChange({ ...message, buttonLabel: event.target.value })
          }
        />
        <ScenarioIntegerInput
          fieldKey="ttlMinutes"
          label={t("whatsappServiceCallTtl")}
          className="nodrag h-8 text-xs"
          min={WHATSAPP_SERVICE_MESSAGE_LIMITS.voice.ttlMinutes.min}
          max={WHATSAPP_SERVICE_MESSAGE_LIMITS.voice.ttlMinutes.max}
          defaultValue={60}
          value={message.ttlMinutes}
          onValueCommit={ttlMinutes => onChange({ ...message, ttlMinutes })}
        />
      </div>
      <ScenarioCollapsibleSection
        variant="inline"
        title={t("whatsappServiceAdvanced")}
        defaultOpen={Boolean(message.payload?.trim())}
        errorCount={fieldErrors.has("payload") ? 1 : 0}
        keepMounted
      >
        <div className="pt-1">
          <Input
            className="nodrag h-8 text-xs"
            maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.voice.payloadBytes}
            fieldKey="payload"
            label={t("whatsappServicePayloadPlaceholder")}
            value={message.payload}
            onChange={event =>
              onChange({ ...message, payload: event.target.value })
            }
          />
        </div>
      </ScenarioCollapsibleSection>
    </div>
  );
}

export function ServiceMessageNativeFields({
  message,
  onChange,
}: {
  message: ScenarioWhatsAppServiceMessagePayload;
  onChange: (message: ScenarioWhatsAppServiceMessagePayload) => void;
}) {
  if (!hasServiceMessageNativeFields(message)) return null;
  switch (message.kind) {
    case "text":
      return (
        <ServiceMessageLinkPreviewField message={message} onChange={onChange} />
      );
    case "appointment":
      return (
        <ServiceMessageAppointmentFields
          message={message}
          onChange={onChange}
        />
      );
    case "contacts":
      return (
        <ServiceMessageContactFields
          contacts={message.contacts}
          onChange={contacts => onChange({ ...message, contacts })}
        />
      );
    case "location":
      return (
        <ServiceMessageLocationFields message={message} onChange={onChange} />
      );
    case "voice_call":
      return (
        <ServiceMessageVoiceCallFields message={message} onChange={onChange} />
      );
    default:
      return null;
  }
}
