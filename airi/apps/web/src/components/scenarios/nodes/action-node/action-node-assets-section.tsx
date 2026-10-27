"use client";

import type {
  ScenarioActionAttachment,
  ScenarioNodeData,
  ScenarioReplyCtaType,
} from "@/components/scenarios/types";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { normalizeScenarioActionAttachments } from "@/lib/scenarios/action-attachments";
import {
  GENERIC_ACTION_ATTACHMENT_ACCEPT,
  WHATSAPP_ACTION_ATTACHMENT_ACCEPT,
} from "@/lib/whatsapp/media-types";
import { useCallback, useId, useRef, useState, type ChangeEvent } from "react";
import { ScenarioActionAssetsFields } from "../../view/action/assets-fields";
import { appendUniqueString, uniqueStrings } from "./action-node-utils";

export function ActionNodeAssetsSection({
  nodeData,
  patchNode,
  replyCtaType,
  replyFixedAssets,
  telegramCompactAssets,
  whatsAppFlowsLoading,
  whatsAppFlowsRefreshing,
}: {
  nodeData: ScenarioActionEditorNodeData;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
  replyCtaType: ScenarioReplyCtaType;
  replyFixedAssets: boolean;
  telegramCompactAssets: boolean;
  whatsAppFlowsLoading: boolean;
  whatsAppFlowsRefreshing: boolean;
}) {
  const actionImageInputRef = useRef<HTMLInputElement | null>(null);
  const actionImageInputId = useId();
  const [isUploadingActionImage, setIsUploadingActionImage] = useState(false);
  const isWhatsAppReplyAction =
    !telegramCompactAssets && nodeData.actionReplyChannel === "whatsapp";
  const generatedMediaCount = nodeData.actionMediaAssets?.length ?? 0;
  const maxActionAttachmentCount = isWhatsAppReplyAction
    ? 1
    : generatedMediaCount > 0
      ? 10
      : 6;
  const actionAttachments = normalizeScenarioActionAttachments({
    attachments: nodeData.actionAttachments,
    legacyUrls: nodeData.actionImageUrls,
    generatedAssets: nodeData.actionMediaAssets,
    limit: maxActionAttachmentCount,
  });
  const actionAttachmentUrls = uniqueStrings(
    actionAttachments.map(attachment => attachment.url)
  );
  const actionAttachmentAccept = isWhatsAppReplyAction
    ? WHATSAPP_ACTION_ATTACHMENT_ACCEPT
    : GENERIC_ACTION_ATTACHMENT_ACCEPT;
  const uploadActionImage = nodeData.uiMedia.upload;

  const uploadActionFiles = useCallback(
    async (files: File[] | FileList | null | undefined) => {
      const queuedFiles = Array.from(files || []).filter(Boolean);
      if (queuedFiles.length === 0) return;

      const remainingSlots = Math.max(
        maxActionAttachmentCount - actionAttachmentUrls.length,
        0
      );
      const filesToUpload = queuedFiles.slice(0, remainingSlots);
      if (filesToUpload.length === 0) return;

      try {
        setIsUploadingActionImage(true);
        for (const file of filesToUpload) {
          await uploadActionImage(file);
        }
      } finally {
        setIsUploadingActionImage(false);
      }
    },
    [actionAttachmentUrls.length, maxActionAttachmentCount, uploadActionImage]
  );

  const handleActionImageUpload = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await uploadActionFiles(files);
  };

  return (
    <>
      <input
        ref={actionImageInputRef}
        id={actionImageInputId}
        type="file"
        accept={actionAttachmentAccept}
        multiple={!isWhatsAppReplyAction}
        className="sr-only"
        onChange={handleActionImageUpload}
      />
      <ScenarioActionAssetsFields
        linkUrls={nodeData.actionLinkUrls || []}
        imageUrls={actionAttachmentUrls}
        maxImageCount={maxActionAttachmentCount}
        isUploadingActionImage={isUploadingActionImage}
        hideReplyCtaChrome={telegramCompactAssets}
        telegramUrlButtonLabel={
          telegramCompactAssets ? nodeData.actionReplyCtaLabel || "" : undefined
        }
        onTelegramUrlButtonLabelChange={
          telegramCompactAssets
            ? value =>
                patchNode({
                  actionReplyCtaLabel: value,
                })
            : undefined
        }
        ctaType={replyFixedAssets ? replyCtaType : undefined}
        ctaButtonLabel={
          replyFixedAssets ? nodeData.actionReplyCtaLabel || "" : undefined
        }
        ctaFlowId={
          replyFixedAssets ? nodeData.actionReplyCtaFlowId || "" : undefined
        }
        ctaFlowName={
          replyFixedAssets ? nodeData.actionReplyCtaFlowName || "" : undefined
        }
        ctaFlowOptions={
          replyFixedAssets ? nodeData.uiWhatsAppFlows.options : undefined
        }
        ctaFlowLoading={
          replyFixedAssets
            ? Boolean(whatsAppFlowsLoading || whatsAppFlowsRefreshing)
            : undefined
        }
        onAddLinkUrl={linkUrl =>
          patchNode({
            actionLinkUrls: appendUniqueString(
              nodeData.actionLinkUrls || [],
              linkUrl
            ),
          })
        }
        onReplacePrimaryLinkUrl={
          replyFixedAssets
            ? linkUrl =>
                patchNode({
                  actionLinkUrls: linkUrl ? [linkUrl] : [],
                })
            : undefined
        }
        onRemoveLinkUrl={linkUrl =>
          patchNode({
            actionLinkUrls: (nodeData.actionLinkUrls || []).filter(
              current => current !== linkUrl
            ),
          })
        }
        onCtaTypeChange={
          replyFixedAssets
            ? nextType =>
                patchNode({
                  actionReplyCtaType: nextType,
                  actionReplyCtaFlowId:
                    nextType === "flow"
                      ? nodeData.actionReplyCtaFlowId
                      : undefined,
                  actionReplyCtaFlowName:
                    nextType === "flow"
                      ? nodeData.actionReplyCtaFlowName
                      : undefined,
                })
            : undefined
        }
        onCtaButtonLabelChange={
          replyFixedAssets
            ? value =>
                patchNode({
                  actionReplyCtaLabel: value,
                })
            : undefined
        }
        onCtaFlowIdChange={
          replyFixedAssets
            ? flowId => {
                const selectedFlow = nodeData.uiWhatsAppFlows.options.find(
                  flow => flow.id === flowId
                );
                patchNode({
                  actionReplyCtaFlowId: flowId || undefined,
                  actionReplyCtaFlowName:
                    selectedFlow?.name || (flowId ? flowId : undefined),
                });
              }
            : undefined
        }
        onCtaFlowOptionsOpen={
          replyFixedAssets
            ? nodeData.uiWhatsAppFlows.onCtaOptionsOpenChange
            : undefined
        }
        uploadInputId={actionImageInputId}
        onUploadImageClick={() => actionImageInputRef.current?.click()}
        onUploadFiles={files => void uploadActionFiles(files)}
        onRemoveImageUrl={imageUrl =>
          nodeData.actionAttachments?.some(
            (attachment: ScenarioActionAttachment) =>
              attachment.url === imageUrl
          ) || nodeData.actionImageUrls?.includes(imageUrl)
            ? nodeData.uiMedia.remove(imageUrl)
            : patchNode({
                actionMediaAssets: (nodeData.actionMediaAssets || []).filter(
                  asset => asset.url !== imageUrl
                ),
              })
        }
      />
    </>
  );
}
