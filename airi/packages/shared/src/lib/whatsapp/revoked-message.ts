/** Media fields cleared when a WhatsApp message is revoked/deleted. */
export const WHATSAPP_REVOKED_MEDIA_UNSET = {
  imageUrl: 1,
  attachments: 1,
  mediaType: 1,
  mimeType: 1,
  fileName: 1,
  fileSize: 1,
  whatsappMediaId: 1,
  imageAnalysis: 1,
  audioAnalysis: 1,
  videoAnalysis: 1,
  mediaAnalysis: 1,
} as const;

export const WHATSAPP_DELETED_MESSAGE_TEXT = "[Message deleted]";
