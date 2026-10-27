/** Id of the Requests read-model projector's single checkpoint document. */
export const REQUESTS_PROJECTION_CHECKPOINT_ID =
  "requests-read-model:v2" as const;

/** Mongo collection that holds the projector checkpoint. */
export const REQUESTS_PROJECTION_CHECKPOINT_COLLECTION =
  "requests_projection_checkpoint_v2" as const;
