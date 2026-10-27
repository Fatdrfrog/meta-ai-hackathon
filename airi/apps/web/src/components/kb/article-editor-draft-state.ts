export type KBDraftSnapshot = {
  title: string;
  content: string;
  normalizedContent: string;
};

export type KBDraftUpdatePayload = {
  title?: string;
  content_mdx?: string;
};

export function normalizeEditorHtml(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "<p></p>" || trimmed === "<p><br></p>") {
    return "";
  }
  return trimmed;
}

export function createKBDraftSnapshot(
  title: string,
  content: string
): KBDraftSnapshot {
  return {
    title,
    content,
    normalizedContent: normalizeEditorHtml(content),
  };
}

export function isKBDraftSnapshotCurrent(
  savedSnapshot: Pick<KBDraftSnapshot, "title" | "normalizedContent">,
  latestSnapshot: Pick<KBDraftSnapshot, "title" | "normalizedContent">
): boolean {
  return (
    savedSnapshot.title === latestSnapshot.title &&
    savedSnapshot.normalizedContent === latestSnapshot.normalizedContent
  );
}

export function buildKBDraftUpdatePayload({
  previousTitle,
  previousNormalizedContent,
  snapshot,
}: {
  previousTitle: string;
  previousNormalizedContent: string;
  snapshot: KBDraftSnapshot;
}): {
  hasChanges: boolean;
  hasTitleChanged: boolean;
  hasContentChanged: boolean;
  payload: KBDraftUpdatePayload;
} {
  const hasTitleChanged = previousTitle !== snapshot.title;
  const hasContentChanged =
    previousNormalizedContent !== snapshot.normalizedContent;
  const payload: KBDraftUpdatePayload = {};

  if (hasTitleChanged) {
    payload.title = snapshot.title;
  }
  if (hasContentChanged) {
    payload.content_mdx = snapshot.content;
  }

  return {
    hasChanges: hasTitleChanged || hasContentChanged,
    hasTitleChanged,
    hasContentChanged,
    payload,
  };
}
