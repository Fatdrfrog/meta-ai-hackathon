import {
  configureWhatsAppVoiceReplyStorage,
  type WhatsAppVoiceReplyStoragePort,
} from "@icecore/airi-runtime/whatsapp-voice-reply-storage";
import {
  canonicalGcsUri,
  createCreativeAssetObjectPath,
} from "@icecore/airi-runtime/media-api";
import {
  getGcsCreativeAssetsBucketName,
  statGcsCreativeAssetObject,
  uploadGcsCreativeAssetBuffer,
} from "./gcs-creative-assets.js";

export function createGcsWhatsAppVoiceReplyStoragePort(): WhatsAppVoiceReplyStoragePort {
  const port: WhatsAppVoiceReplyStoragePort = {
    async find(ref) {
      const bucket = getGcsCreativeAssetsBucketName();
      const path = createCreativeAssetObjectPath({
        ...ref,
        kind: "audio",
        fileName: "reply.ogg",
      });
      const metadata = await statGcsCreativeAssetObject({
        workspaceId: ref.workspaceId,
        bucket,
        path,
      });
      if (
        !metadata.exists ||
        !metadata.fileSize ||
        metadata.fileSize > 1024 * 1024 ||
        metadata.mimeType !== "audio/ogg" ||
        metadata.customMetadata?.workspaceId !== ref.workspaceId ||
        metadata.customMetadata?.assetId !== ref.assetId ||
        metadata.customMetadata?.purpose !== "airi-whatsapp-voice-reply"
      )
        return null;
      return {
        url: canonicalGcsUri(bucket, path),
        bucket,
        path,
        mediaType: "audio",
        mimeType: "audio/ogg",
        fileName: "reply.ogg",
        fileSize: metadata.fileSize,
      };
    },
    async store(ref) {
      try {
        const stored = await uploadGcsCreativeAssetBuffer({
          ...ref,
          kind: "audio",
          mimeType: "audio/ogg",
          fileName: "reply.ogg",
          customMetadata: { purpose: "airi-whatsapp-voice-reply" },
          preconditionOpts: { ifGenerationMatch: 0 },
        });
        return { ...stored, mediaType: "audio" };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          Number(error.code) === 412
        ) {
          const existing = await port.find(ref);
          if (existing) return existing;
        }
        throw error;
      }
    },
  };
  return port;
}
export function configureGcsWhatsAppVoiceReplyStorage(): void {
  configureWhatsAppVoiceReplyStorage(createGcsWhatsAppVoiceReplyStoragePort());
}
