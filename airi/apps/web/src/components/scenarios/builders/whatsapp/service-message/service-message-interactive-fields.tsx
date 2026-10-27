"use client";

import { ServiceMessageInput as Input } from "./service-message-field";
import {
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppInteractiveOption,
  type ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { applyServiceMessageEditorIntent } from "./service-message-editor-model";
import {
  createServiceMessageEntityId,
  createServiceMessageOptionId,
} from "./service-message-ids";
import { ServiceMessageListFields } from "./service-message-list-fields";

/** List-only tray fields. Website CTA fields live in the button action grid. */
export function ServiceMessageInteractiveFields({
  actionNodeId,
  message,
  renderBranchHandle,
  onChange,
}: {
  actionNodeId: string;
  message: ScenarioWhatsAppServiceMessagePayload;
  renderBranchHandle?: (option: ScenarioWhatsAppInteractiveOption) => ReactNode;
  onChange: (message: ScenarioWhatsAppServiceMessagePayload) => void;
}) {
  const t = useTranslations("Scenarios");

  if (message.kind !== "list") return null;
  const apply = (
    intent: Parameters<typeof applyServiceMessageEditorIntent>[1]
  ) => {
    const next = applyServiceMessageEditorIntent(
      { version: 1, message },
      intent
    ).message;
    if (next !== message) onChange(next);
  };

  return (
    <div className="space-y-2">
      <Input
        className="nodrag h-8 text-xs"
        maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label}
        fieldKey="buttonLabel"
        label={t("whatsappServiceListButtonLabel")}
        value={message.buttonLabel}
        placeholder={t("whatsappServiceListButtonPlaceholder")}
        onChange={event =>
          apply({ type: "set_list_button_label", value: event.target.value })
        }
      />
      <ServiceMessageListFields
        sections={message.sections}
        createEntityId={createServiceMessageEntityId}
        createOptionId={() => createServiceMessageOptionId(actionNodeId)}
        renderBranchHandle={renderBranchHandle}
        onIntent={apply}
      />
    </div>
  );
}
