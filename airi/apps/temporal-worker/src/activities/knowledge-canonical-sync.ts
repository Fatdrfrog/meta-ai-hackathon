import { KNOWLEDGE_CANONICAL_SYNC_ACTIVITY } from "@icecore/temporal";
import { executeKnowledgeCanonicalSyncActivity } from "@icecore/airi-runtime";

export const knowledgeCanonicalSyncActivityHandlers = {
  [KNOWLEDGE_CANONICAL_SYNC_ACTIVITY]: executeKnowledgeCanonicalSyncActivity,
};
