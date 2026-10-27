import type { TemplateFormValues } from "./template-editor-form-utils";

const TEMPLATE_EDITOR_DRAFT_KEY_PREFIX = "airi.templateEditorDraft.v1:";
export const TEMPLATE_EDITOR_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredTemplateEditorDraft = {
  savedAt: number;
  values: TemplateFormValues;
};

/** One unsaved new template per workspace, and one draft per existing template. */
export function getTemplateEditorDraftKey(params: {
  workspaceId: string;
  templateId?: string | null;
}): string {
  const identity = params.templateId ? `edit:${params.templateId}` : "new";
  return `${TEMPLATE_EDITOR_DRAFT_KEY_PREFIX}${params.workspaceId}:${identity}`;
}

/** Compares form values regardless of key order and per-load client ids. */
export function snapshotTemplateEditorValues(
  values: TemplateFormValues
): string {
  return JSON.stringify(values, (key, value: unknown) => {
    if (key === "clientId") return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    );
  });
}

/** Fields an author types or attaches; settings alone don't make a draft. */
const TEMPLATE_DRAFT_CONTENT_KEYS = new Set([
  "name",
  "headerText",
  "headerMediaExample",
  "bodyText",
  "footerText",
  "telegramText",
  "variableExamples",
  "text",
  "url",
  "phone_number",
  "callbackData",
]);

function hasTypedContent(value: unknown, isContent: boolean): boolean {
  if (typeof value === "string") return isContent && value.trim() !== "";
  if (Array.isArray(value)) {
    return value.some(item => hasTypedContent(item, isContent));
  }
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    hasTypedContent(item, isContent || TEMPLATE_DRAFT_CONTENT_KEYS.has(key))
  );
}

/** Whether the form holds anything an author would mind losing. */
export function hasTemplateEditorDraftContent(
  values: TemplateFormValues
): boolean {
  return hasTypedContent(values, false);
}

function isTemplateFormValues(value: unknown): value is TemplateFormValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<Record<keyof TemplateFormValues, unknown>>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.targetPlatform === "string"
  );
}

function parseStoredDraft(
  raw: string | null,
  now: number
): StoredTemplateEditorDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTemplateEditorDraft>;
    if (
      typeof parsed?.savedAt !== "number" ||
      now - parsed.savedAt > TEMPLATE_EDITOR_DRAFT_TTL_MS ||
      !isTemplateFormValues(parsed.values)
    ) {
      return null;
    }
    return { savedAt: parsed.savedAt, values: parsed.values };
  } catch {
    return null;
  }
}

export function readTemplateEditorDraft(
  storageKey: string,
  now = Date.now()
): StoredTemplateEditorDraft | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const draft = parseStoredDraft(raw, now);
    if (raw && !draft) window.localStorage.removeItem(storageKey);
    return draft;
  } catch {
    return null;
  }
}

function pruneExpiredTemplateEditorDrafts(now: number) {
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(TEMPLATE_EDITOR_DRAFT_KEY_PREFIX)) continue;
    if (!parseStoredDraft(window.localStorage.getItem(key), now)) {
      window.localStorage.removeItem(key);
    }
  }
}

/** Drafts this page load wrote; a reload starts empty, so older drafts stand out. */
const draftsSavedByThisPage = new Map<string, number>();

export function isTemplateEditorDraftFromThisPage(
  storageKey: string,
  draft: StoredTemplateEditorDraft
): boolean {
  return draftsSavedByThisPage.get(storageKey) === draft.savedAt;
}

/** The saved edits to open the editor with, or null when nothing is worth restoring. */
export function readRestorableTemplateEditorDraft(
  storageKey: string,
  defaults: TemplateFormValues
): { values: TemplateFormValues; fromThisPage: boolean } | null {
  const draft = readTemplateEditorDraft(storageKey);
  if (!draft) return null;
  // Fields added to the form after the draft was saved keep their defaults.
  const values = { ...defaults, ...draft.values };
  if (
    !hasTemplateEditorDraftContent(values) ||
    snapshotTemplateEditorValues(values) ===
      snapshotTemplateEditorValues(defaults)
  ) {
    return null;
  }
  return {
    values,
    fromThisPage: isTemplateEditorDraftFromThisPage(storageKey, draft),
  };
}

export function writeTemplateEditorDraft(
  storageKey: string,
  values: TemplateFormValues,
  now = Date.now()
) {
  try {
    pruneExpiredTemplateEditorDrafts(now);
    const draft: StoredTemplateEditorDraft = { savedAt: now, values };
    window.localStorage.setItem(storageKey, JSON.stringify(draft));
    draftsSavedByThisPage.set(storageKey, now);
  } catch {
    // Draft persistence should never block editing or submitting a template.
  }
}

export function clearTemplateEditorDraft(storageKey: string) {
  draftsSavedByThisPage.delete(storageKey);
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}
