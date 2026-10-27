"use client";

import type { ScenarioOptionBranchHandleLayout } from "@/components/scenarios/source-handle-types";
import type {
  ScenarioWhatsAppInteractiveOption,
  ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import type { ReactNode } from "react";
import type { TranslateFn } from "../../../types";
import type { WhatsAppActionRendererButton } from "../action-renderer";
import {
  ServiceMessageOpenFlowButton,
  ServiceMessageRemoveActionButton,
} from "./service-message-action-control";
import { ServiceMessageCommerceFields } from "./service-message-commerce-fields";
import {
  hasServiceMessageNativeFields,
  type ServiceMessageEditorIntent,
  type ServiceMessageEditorProjection,
} from "./service-message-editor-model";
import {
  fieldErrorMessage,
  type ServiceMessageFieldErrorMap,
} from "./service-message-field-errors";
import { ServiceMessageInteractiveFields } from "./service-message-interactive-fields";
import { ServiceMessageNativeFields } from "./service-message-native-fields";
import type { useWhatsAppServiceMessageResources } from "./service-message-resources";

type RenderOptionBranchHandle = (
  option: ScenarioWhatsAppInteractiveOption,
  layout?: ScenarioOptionBranchHandleLayout
) => ReactNode;

type UpdateMessage = (message: ScenarioWhatsAppServiceMessagePayload) => void;

type PreviewButtonsParams = {
  message: ScenarioWhatsAppServiceMessagePayload;
  fieldErrors: ServiceMessageFieldErrorMap;
  t: TranslateFn;
  renderOptionBranchHandle?: RenderOptionBranchHandle;
  onOpenFlowEditor?: () => void;
  apply: (intent: ServiceMessageEditorIntent) => void;
  updateMessage: UpdateMessage;
};

function replyButtonRows(
  message: Extract<
    ScenarioWhatsAppServiceMessagePayload,
    { kind: "reply_buttons" }
  >,
  {
    fieldErrors,
    t,
    renderOptionBranchHandle,
    apply,
    updateMessage,
  }: PreviewButtonsParams
): WhatsAppActionRendererButton[] {
  return message.options.map((option, optionIndex) => ({
    key: option.id,
    type: "quick_reply",
    label: option.label,
    fieldKey: `options.${optionIndex}.label`,
    error: fieldErrorMessage(fieldErrors, `options.${optionIndex}.label`),
    onLabelChange: label =>
      updateMessage({
        ...message,
        options: message.options.map(current =>
          current.id === option.id ? { ...current, label } : current
        ),
      }),
    rowActions: (
      <>
        {renderOptionBranchHandle?.(option, { local: true })}
        {message.options.length > 1 ? (
          <ServiceMessageRemoveActionButton
            label={t("whatsappServiceDeleteButton")}
            onRemove={() =>
              apply({ type: "remove_choice", optionId: option.id })
            }
          />
        ) : null}
      </>
    ),
  }));
}

function flowButtonRow(
  message: Extract<ScenarioWhatsAppServiceMessagePayload, { kind: "flow" }>,
  { t, onOpenFlowEditor, updateMessage }: PreviewButtonsParams
): WhatsAppActionRendererButton {
  const config = message.flowConfig;
  return {
    type: "flow",
    label: config?.ctaText || t("actionCtaFlowLabelPlaceholder"),
    onLabelChange: config
      ? (ctaText: string) =>
          updateMessage({ ...message, flowConfig: { ...config, ctaText } })
      : undefined,
    rowActions: onOpenFlowEditor ? (
      <ServiceMessageOpenFlowButton
        label={t("whatsappTemplateOpenFlow")}
        onOpen={onOpenFlowEditor}
      />
    ) : undefined,
  };
}

/** The button rows the preview bubble shows for each message type. */
export function serviceMessagePreviewButtons(
  params: PreviewButtonsParams
): WhatsAppActionRendererButton[] {
  const { message, t } = params;
  switch (message.kind) {
    case "reply_buttons":
      return replyButtonRows(message, params);
    case "list":
      return [
        {
          type: "quick_reply",
          label: message.buttonLabel || t("whatsappServiceListDefaultButton"),
        },
      ];
    case "cta_url":
      return [
        {
          type: "url",
          // Label edits live in the Website action grid; preview mirrors them.
          label:
            message.buttonLabel.trim() || t("actionCtaLinkLabelPlaceholder"),
          fieldKey: "buttonLabel",
          error: fieldErrorMessage(params.fieldErrors, "buttonLabel"),
        },
      ];
    case "flow":
      return [flowButtonRow(message, params)];
    case "appointment":
      return [{ type: "flow", label: t("whatsappServiceActionBookCall") }];
    case "voice_call":
      return [
        {
          type: "phone",
          label: message.buttonLabel || t("whatsappServiceFormatVoiceCall"),
        },
      ];
    case "request_contact_info":
      return [
        {
          type: "request_contact_info",
          label: t("whatsappServiceFormatContactRequest"),
        },
      ];
    case "location_request":
      return [
        {
          type: "location_request",
          label: t("whatsappServiceLocationRequestButton"),
        },
      ];
    default:
      return [];
  }
}

/** Type-specific fields under the bubble; undefined when the type has none. */
export function serviceMessageEditorTray({
  actionNodeId,
  message,
  tray,
  resources,
  renderOptionBranchHandle,
  updateMessage,
}: {
  actionNodeId: string;
  message: ScenarioWhatsAppServiceMessagePayload;
  tray: ServiceMessageEditorProjection["tray"];
  resources: Pick<
    ReturnType<typeof useWhatsAppServiceMessageResources>,
    "catalogs" | "products" | "loading" | "failedResources"
  >;
  renderOptionBranchHandle?: RenderOptionBranchHandle;
  updateMessage: UpdateMessage;
}): ReactNode {
  const nativeFields =
    tray === "native" && hasServiceMessageNativeFields(message) ? (
      <ServiceMessageNativeFields message={message} onChange={updateMessage} />
    ) : null;
  const interactiveFields =
    tray === "interactive" ? (
      <ServiceMessageInteractiveFields
        actionNodeId={actionNodeId}
        message={message}
        renderBranchHandle={renderOptionBranchHandle}
        onChange={updateMessage}
      />
    ) : null;
  const commerceFields =
    tray === "commerce" && message.kind === "commerce" ? (
      <ServiceMessageCommerceFields
        commerce={message.commerce}
        catalogs={resources.catalogs}
        products={resources.products}
        loading={resources.loading}
        failed={resources.failedResources.catalog}
        onChange={commerce => updateMessage({ ...message, commerce })}
      />
    ) : null;
  return nativeFields || interactiveFields || commerceFields ? (
    <>
      {nativeFields}
      {interactiveFields}
      {commerceFields}
    </>
  ) : undefined;
}
