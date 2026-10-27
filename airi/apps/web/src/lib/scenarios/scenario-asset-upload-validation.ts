import type { ScenarioActionAttachmentMediaType } from "@icecore/scenario-contracts";
import { validateConversationAttachmentFile } from "@/lib/conversation-attachments";
import {
  classifyWhatsAppUploadMedia,
  getWhatsAppOfficialMediaMaxBytes,
  isGenericActionAttachmentMimeType,
  resolveGenericActionAttachmentMimeType,
} from "@/lib/whatsapp/media-types";

export type ScenarioAssetUploadMetadata = {
  fileName: string;
  mimeType: string;
  fileSize: number;
  channel?: "whatsapp";
};

export class ScenarioAssetUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "ScenarioAssetUploadError";
  }
}

const MAX_GENERIC_FILE_SIZE = 20 * 1024 * 1024;

/** One metadata policy for browser preflight, multipart uploads and GCS completion. */
export function validateScenarioAssetUploadMetadata(
  input: ScenarioAssetUploadMetadata
): ScenarioAssetUploadMetadata & {
  mediaType?: ScenarioActionAttachmentMediaType;
} {
  const fileName = input.fileName || "scenario-asset";
  if (!Number.isSafeInteger(input.fileSize) || input.fileSize <= 0) {
    throw new ScenarioAssetUploadError(
      "Empty or invalid file",
      400,
      "scenario_asset_upload_unsupported_file"
    );
  }
  const mimeType = resolveGenericActionAttachmentMimeType({
    mimeType: input.mimeType,
    fileName,
  });
  if (input.channel === "whatsapp") {
    const validation = validateConversationAttachmentFile({
      channel: "whatsapp",
      fileName,
      mimeType,
      fileSize: input.fileSize,
    });
    if (!validation.ok) {
      const classification = classifyWhatsAppUploadMedia({
        fileName,
        mimeType,
      });
      const tooLarge =
        classification.mediaType &&
        input.fileSize >
          getWhatsAppOfficialMediaMaxBytes(classification.mediaType);
      throw new ScenarioAssetUploadError(
        validation.error,
        tooLarge ? 413 : 400,
        tooLarge
          ? "scenario_asset_upload_too_large"
          : "scenario_asset_upload_unsupported_file"
      );
    }
    return {
      ...input,
      fileName,
      mimeType: validation.attachment.mimeType,
      mediaType: validation.attachment.mediaType,
    };
  }
  if (input.fileSize > MAX_GENERIC_FILE_SIZE) {
    throw new ScenarioAssetUploadError(
      "File is too large. Maximum size is 20MB",
      413,
      "scenario_asset_upload_too_large"
    );
  }
  if (!isGenericActionAttachmentMimeType(mimeType)) {
    throw new ScenarioAssetUploadError(
      "Unsupported file type. Allowed: images, MP4/WebM/MOV videos, PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT",
      400,
      "scenario_asset_upload_unsupported_file"
    );
  }
  return { ...input, fileName, mimeType };
}
