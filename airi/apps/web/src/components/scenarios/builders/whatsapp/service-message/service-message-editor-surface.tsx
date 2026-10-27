"use client";

import type { ScenarioActionNodeEnrichment } from "../../../view/node-enrichment/types";
import { SCENARIO_NODE_CHANNEL_PREVIEW_BLEED_CLASS } from "@/components/scenarios/nodes/node-card";
import type { ScenarioOptionBranchHandleLayout } from "@/components/scenarios/source-handle-types";
import { cn } from "@/lib/utils";
import {
  WHATSAPP_ACTION_ATTACHMENT_ACCEPT,
  WHATSAPP_OFFICIAL_MEDIA_ACCEPT,
} from "@/lib/whatsapp/media-types";
import type {
  ScenarioWhatsAppInteractiveOption,
  ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import type { ReactNode } from "react";
import type { TranslateFn } from "../../../types";
import { WhatsAppActionRenderer } from "../action-renderer";
import type { WhatsAppInlineEditorInsertApi } from "../inline-editor";
import { ServiceMessageActionControl } from "./service-message-action-control";
import {
  bodyText,
  serviceMessageMediaFormat,
} from "./service-message-builder-model";
import { ServiceMessageCarouselFields } from "./service-message-carousel-fields";
import type {
  ServiceMessageEditorAction,
  ServiceMessageEditorIntent,
  ServiceMessageEditorProjection,
} from "./service-message-editor-model";
import {
  fieldErrorMessage,
  type ServiceMessageFieldErrorMap,
} from "./service-message-field-errors";
import { ServiceMessageMediaField } from "./service-message-media-field";
import {
  serviceMessageEditorTray,
  serviceMessagePreviewButtons,
} from "./service-message-preview-slots";
import type { useWhatsAppServiceMessageResources } from "./service-message-resources";
import type { ServiceMessageEditor } from "./use-service-message-editor";

type Apply = (intent: ServiceMessageEditorIntent) => void;
type UiMedia = ScenarioActionNodeEnrichment["uiMedia"];

/**
 * The media slot. Empty, it sits above the body; filled, it becomes the
 * header editor, so header text stays available until media is attached.
 */
function ServiceMessageMediaCanvas({
  message,
  projection,
  fieldErrors,
  upload,
  generateVoice,
  t,
  apply,
}: {
  message: ScenarioWhatsAppServiceMessagePayload;
  projection: ServiceMessageEditorProjection;
  fieldErrors: ServiceMessageFieldErrorMap;
  upload?: UiMedia["upload"];
  generateVoice?: UiMedia["generateVoice"];
  t: TranslateFn;
  apply: Apply;
}) {
  const attachment = projection.media;
  const body = projection.body;
  const standalone = projection.allowsStandaloneAudio;
  return (
    <ServiceMessageMediaField
      attachment={attachment?.url ? attachment : undefined}
      compactEmpty={message.kind !== "media"}
      upload={upload}
      generateVoice={standalone ? generateVoice : undefined}
      uploadLabel={t("whatsappServiceAddMedia")}
      dropHint={
        standalone
          ? t("whatsappServiceMediaDropHintStandalone")
          : t("whatsappServiceMediaDropHintInteractive")
      }
      removeLabel={t("whatsappServiceRemoveMedia")}
      accept={
        standalone
          ? WHATSAPP_OFFICIAL_MEDIA_ACCEPT
          : WHATSAPP_ACTION_ATTACHMENT_ACCEPT
      }
      allowAudio={standalone}
      error={
        fieldErrorMessage(fieldErrors, "attachment") ||
        fieldErrorMessage(fieldErrors, "header.attachment")
      }
      fieldKey={message.kind === "media" ? "attachment" : "header.attachment"}
      deliverAsVoice={
        message.kind === "media" ? message.deliverAsVoice === true : false
      }
      onDeliverAsVoiceChange={
        standalone
          ? value => apply({ type: "set_deliver_as_voice", value })
          : undefined
      }
      voiceScriptDefault={body?.mode === "fixed" ? body.text : ""}
      onChange={(next, options) =>
        next
          ? apply({
              type: "attach_media",
              attachment: next,
              ...(options?.deliverAsVoice ? { deliverAsVoice: true } : {}),
            })
          : apply({ type: "remove_media" })
      }
    />
  );
}

function previewBody(
  projection: ServiceMessageEditorProjection,
  t: TranslateFn,
  apply: Apply,
  onInsertApiChange: (api: WhatsAppInlineEditorInsertApi | null) => void
) {
  const body = projection.body;
  const fixed = body?.mode === "fixed";
  return {
    text: body?.mode === "ai" ? t("whatsappServiceAiPreview") : bodyText(body),
    onTextChange: fixed
      ? (next: string) => apply({ type: "set_body", value: next })
      : undefined,
    onInsertApiChange: fixed ? onInsertApiChange : undefined,
  };
}

/** Header and footer text; a carousel shows neither. */
function previewHeaderAndFooter(
  projection: ServiceMessageEditorProjection,
  apply: Apply
) {
  if (projection.isCarousel) return {};
  return {
    headerText: projection.headerText,
    onHeaderTextChange: projection.supportsTextHeader
      ? (header: string) => apply({ type: "set_header_text", value: header })
      : undefined,
    footerText: projection.footerText,
    onFooterTextChange: projection.supportsFooter
      ? (footer: string) => apply({ type: "set_footer_text", value: footer })
      : undefined,
  };
}

/** Where the media slot goes: the header once filled, above the body before. */
function previewMedia(
  projection: ServiceMessageEditorProjection,
  mediaCanvas: ReactNode
) {
  const attachment = projection.media;
  const hasMediaPreview = Boolean(attachment?.url);
  if (projection.isCarousel) return {};
  if (!hasMediaPreview) {
    return {
      bodyTopAction: projection.supportsMedia ? mediaCanvas : undefined,
    };
  }
  return {
    headerMediaFormat: serviceMessageMediaFormat(attachment),
    headerMediaUrl: attachment?.url,
    headerMediaEditor: mediaCanvas,
  };
}

/**
 * The message preview with its inline editors, or, for types the preview
 * cannot show, the type menu and tray on their own.
 */
export function ServiceMessageEditorSurface({
  actionNodeId,
  message,
  projection,
  fieldErrors,
  resources,
  availableActions,
  loadingActions,
  editor,
  upload,
  generateVoice,
  renderOptionBranchHandle,
  connectedOptionIds,
  onBranchHandleViewportChange,
  onOpenFlowEditor,
  onBodyInsertApiChange,
  t,
}: {
  actionNodeId: string;
  message: ScenarioWhatsAppServiceMessagePayload;
  projection: ServiceMessageEditorProjection;
  fieldErrors: ServiceMessageFieldErrorMap;
  resources: ReturnType<typeof useWhatsAppServiceMessageResources>;
  availableActions: ServiceMessageEditorAction[];
  loadingActions: ServiceMessageEditorAction[];
  editor: ServiceMessageEditor;
  upload?: UiMedia["upload"];
  generateVoice?: UiMedia["generateVoice"];
  renderOptionBranchHandle?: (
    option: ScenarioWhatsAppInteractiveOption,
    layout?: ScenarioOptionBranchHandleLayout
  ) => ReactNode;
  connectedOptionIds?: ReadonlySet<string>;
  onBranchHandleViewportChange?: () => void;
  onOpenFlowEditor?: () => void;
  onBodyInsertApiChange: (api: WhatsAppInlineEditorInsertApi | null) => void;
  t: TranslateFn;
}) {
  const actionControl = (
    <ServiceMessageActionControl
      message={message}
      projection={projection}
      availableActions={availableActions}
      loadingActions={loadingActions}
      signupLinks={resources.signupLinks}
      signupLinksLoading={resources.loading}
      fieldErrors={fieldErrors}
      editor={editor}
    />
  );
  const tray = serviceMessageEditorTray({
    actionNodeId,
    message,
    tray: projection.tray,
    resources,
    renderOptionBranchHandle,
    updateMessage: editor.updateMessage,
  });
  if (!projection.supportsRenderer) {
    return (
      <div className="space-y-2">
        <div className="flex justify-end">{actionControl}</div>
        {tray}
      </div>
    );
  }

  const isCarousel = projection.isCarousel;
  const mediaCanvas = projection.supportsMedia ? (
    <ServiceMessageMediaCanvas
      key={message.kind}
      message={message}
      projection={projection}
      fieldErrors={fieldErrors}
      upload={upload}
      generateVoice={generateVoice}
      t={t}
      apply={editor.apply}
    />
  ) : null;
  // Carousel replaces media header + bubble actions with an editable card strip.
  const carouselContent =
    message.kind === "media_carousel" ? (
      <ServiceMessageCarouselFields
        cards={message.cards}
        upload={upload}
        createOptionId={editor.createOptionId}
        renderBranchHandle={renderOptionBranchHandle}
        connectedOptionIds={connectedOptionIds}
        onViewportChange={onBranchHandleViewportChange}
        fieldErrors={fieldErrors}
        onChange={editor.updateCarouselCards}
      />
    ) : undefined;
  const body = previewBody(projection, t, editor.apply, onBodyInsertApiChange);
  const chrome = previewHeaderAndFooter(projection, editor.apply);
  const media = previewMedia(projection, mediaCanvas);
  return (
    <WhatsAppActionRenderer
      bodyText={body.text}
      onBodyTextChange={body.onTextChange}
      onBodyInsertApiChange={body.onInsertApiChange}
      bodyPlaceholder={t("actionReplyTextPlaceholder")}
      bodyError={fieldErrorMessage(fieldErrors, "body")}
      headerText={chrome.headerText}
      headerPlaceholder={t("headerTextPlaceholder")}
      headerError={
        fieldErrorMessage(fieldErrors, "header.text") ||
        fieldErrorMessage(fieldErrors, "headerText")
      }
      onHeaderTextChange={chrome.onHeaderTextChange}
      headerMediaFormat={media.headerMediaFormat}
      headerMediaUrl={media.headerMediaUrl}
      headerMediaEditor={media.headerMediaEditor}
      bodyTopAction={media.bodyTopAction}
      footerText={chrome.footerText}
      footerError={fieldErrorMessage(fieldErrors, "footerText")}
      onFooterTextChange={chrome.onFooterTextChange}
      footerPlaceholder={t("footerTextPlaceholder")}
      buttons={
        isCarousel
          ? []
          : serviceMessagePreviewButtons({
              message,
              fieldErrors,
              t,
              renderOptionBranchHandle,
              onOpenFlowEditor,
              apply: editor.apply,
              updateMessage: editor.updateMessage,
            })
      }
      buttonEditor={isCarousel ? undefined : actionControl}
      bubbleTrailingContent={carouselContent}
      editorTray={isCarousel ? undefined : tray}
      fitContent
      embedded
      previewClassName={cn(
        SCENARIO_NODE_CHANNEL_PREVIEW_BLEED_CLASS,
        "shrink-0"
      )}
    />
  );
}
