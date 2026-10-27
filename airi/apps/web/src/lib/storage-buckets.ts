export const DEFAULT_CONVERSATION_ATTACHMENTS_BUCKET_NAME =
  "conversation-attachments";
export const CONVERSATION_IMAGES_BUCKET_NAME = "conversation-images";

/** Buckets that hold end-customer chat media. */
export const CUSTOMER_MEDIA_BUCKET_NAMES = [
  CONVERSATION_IMAGES_BUCKET_NAME,
  DEFAULT_CONVERSATION_ATTACHMENTS_BUCKET_NAME,
] as const;
