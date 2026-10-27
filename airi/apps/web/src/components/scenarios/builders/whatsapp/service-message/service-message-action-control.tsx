"use client";

import { Button } from "@/components/ui/button";
import type {
  ScenarioWhatsAppCarouselCard,
  ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import { ExternalLink, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { ServiceMessageButtonEditor } from "./service-message-button-editor";
import { ServiceMessageCarouselControls } from "./service-message-carousel-fields";
import { ServiceMessageCtaUrlFields } from "./service-message-cta-url-fields";
import type {
  ServiceMessageEditorAction,
  ServiceMessageEditorProjection,
} from "./service-message-editor-model";
import { ServiceGroupError } from "./service-message-field";
import type { ServiceMessageFieldErrorMap } from "./service-message-field-errors";
import type { WhatsAppServiceSignupLink } from "./service-message-resources";
import type { ServiceMessageEditor } from "./use-service-message-editor";

/** Fields the current button type adds under its menu. */
function currentActionFields({
  message,
  signupLinks,
  signupLinksLoading,
  fieldErrors,
  onChange,
}: {
  message: ScenarioWhatsAppServiceMessagePayload;
  signupLinks: WhatsAppServiceSignupLink[];
  signupLinksLoading: boolean;
  fieldErrors: ServiceMessageFieldErrorMap;
  onChange: (message: ScenarioWhatsAppServiceMessagePayload) => void;
}): ReactNode {
  if (message.kind === "cta_url") {
    return (
      <ServiceMessageCtaUrlFields
        message={message}
        signupLinks={signupLinks}
        signupLinksLoading={signupLinksLoading}
        fieldErrors={fieldErrors}
        onChange={onChange}
      />
    );
  }
  if (message.kind === "reply_buttons") {
    // The button count is an error of the whole group.
    return (
      <ServiceGroupError fieldKey="options" asField className="px-2.5 pb-1.5" />
    );
  }
  return undefined;
}

/** The button type menu of the message, with the fields that type adds. */
export function ServiceMessageActionControl({
  message,
  projection,
  availableActions,
  loadingActions,
  signupLinks,
  signupLinksLoading,
  fieldErrors,
  editor,
}: {
  message: ScenarioWhatsAppServiceMessagePayload;
  projection: ServiceMessageEditorProjection;
  availableActions: ServiceMessageEditorAction[];
  loadingActions: ServiceMessageEditorAction[];
  signupLinks: WhatsAppServiceSignupLink[];
  signupLinksLoading: boolean;
  fieldErrors: ServiceMessageFieldErrorMap;
  editor: Pick<
    ServiceMessageEditor,
    "selectAction" | "addChoice" | "removeAction" | "updateMessage"
  >;
}) {
  const canAddChoice = projection.canAddChoice && message.kind !== "list";
  const actionFields = currentActionFields({
    message,
    signupLinks,
    signupLinksLoading,
    fieldErrors,
    onChange: editor.updateMessage,
  });
  return (
    <ServiceMessageButtonEditor
      currentAction={projection.action}
      availableActions={availableActions}
      loadingActions={loadingActions}
      canAddChoice={canAddChoice}
      actionFields={actionFields}
      onSelectAction={editor.selectAction}
      onAddChoice={canAddChoice ? editor.addChoice : undefined}
      onRemoveAction={projection.action ? editor.removeAction : undefined}
    />
  );
}

/** Carousel card controls and its type menu, below the card strip. */
export function ServiceMessageCarouselActions({
  cards,
  availableActions,
  loadingActions,
  editor,
  onCardsChange,
}: {
  cards: ScenarioWhatsAppCarouselCard[];
  availableActions: ServiceMessageEditorAction[];
  loadingActions: ServiceMessageEditorAction[];
  editor: Pick<
    ServiceMessageEditor,
    "createOptionId" | "selectAction" | "removeAction"
  >;
  onCardsChange: (cards: ScenarioWhatsAppCarouselCard[]) => void;
}) {
  return (
    <div className="mt-2 space-y-2">
      <ServiceMessageCarouselControls
        cards={cards}
        createOptionId={editor.createOptionId}
        onChange={onCardsChange}
      />
      <ServiceMessageButtonEditor
        currentAction="media_carousel"
        availableActions={availableActions}
        loadingActions={loadingActions}
        canAddChoice={false}
        onSelectAction={editor.selectAction}
        onRemoveAction={editor.removeAction}
      />
    </div>
  );
}

export function ServiceMessageRemoveActionButton({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="nodrag nopan h-7 w-7 rounded-full text-muted-foreground hover:text-destructive"
      aria-label={label}
      title={label}
      onPointerDown={event => event.stopPropagation()}
      onClick={onRemove}
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

export function ServiceMessageOpenFlowButton({
  label,
  onOpen,
}: {
  label: string;
  onOpen: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="nodrag nopan h-7 w-7 rounded-full text-muted-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800/80"
      aria-label={label}
      title={label}
      onPointerDown={event => event.stopPropagation()}
      onClick={onOpen}
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}
