// Conversation fixtures for suites that check a classification is reused only
// while it is current (contract v2, ready, applied at the requested revision,
// with v2 provenance for that revision).

/** The classification fields of a conversation classified at `revision`. */
export function readyClassificationFields(
  revision: number,
  analysisRevisionId = `analysis-${revision}`
) {
  return {
    is_classified: true,
    classification_revision: revision,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: revision,
      appliedRevision: revision,
    },
    classification_meta: {
      provenance_kind: "v2",
      source_revision: revision,
      analysis_revision_id: analysisRevisionId,
    },
  };
}

type ClassifiedConversation = ReturnType<typeof readyClassificationFields>;

/** Status and provenance changes that make a ready classification non-current. */
export const NON_READY_CLASSIFICATION_CASES: ReadonlyArray<{
  name: string;
  mutate: (conversation: ClassifiedConversation) => void;
}> = [
  {
    name: "pending",
    mutate: conversation => {
      conversation.is_classified = false;
      conversation.classification_state.status = "pending";
    },
  },
  {
    name: "review-required",
    mutate: conversation => {
      conversation.is_classified = false;
      conversation.classification_state.status = "review_required";
    },
  },
  {
    name: "failed",
    mutate: conversation => {
      conversation.is_classified = false;
      conversation.classification_state.status = "failed";
    },
  },
  {
    name: "blocked",
    mutate: conversation => {
      conversation.is_classified = false;
      conversation.classification_state.status = "blocked";
    },
  },
  {
    name: "legacy",
    mutate: conversation => {
      conversation.classification_meta.provenance_kind = "legacy_unknown";
    },
  },
];

/** Overrides that make readyClassificationFields(7) non-current. */
export const NON_CURRENT_REVISION_7_OVERRIDES = [
  {
    name: "revision-mismatch stale",
    overrides: {
      classification_state: {
        contractVersion: 2,
        status: "ready",
        requestedRevision: 8,
        appliedRevision: 7,
      },
    },
  },
  {
    name: "legacy",
    overrides: {
      classification_state: {
        contractVersion: 1,
        status: "ready",
        requestedRevision: 7,
        appliedRevision: 7,
      },
      classification_meta: {
        source_revision: 7,
        provenance_kind: "legacy_unknown",
        analysis_revision_id: "legacy-analysis-7",
      },
    },
  },
  {
    name: "partial",
    overrides: {
      classification_meta: {
        source_revision: 7,
        provenance_kind: "v2",
      },
    },
  },
  {
    name: "malformed",
    overrides: { classification_state: "ready" },
  },
];
