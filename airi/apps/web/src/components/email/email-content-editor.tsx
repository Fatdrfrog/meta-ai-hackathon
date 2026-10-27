"use client";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { renderMarkdownEmailTemplate } from "@/lib/email/email-template-rendering";
import { cn } from "@/lib/utils";
import { Bold, Heading2, ImageIcon, Link, List, Loader2 } from "lucide-react";
import {
  useMemo,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { normalizeMediaMimeType } from "@/lib/whatsapp/media-types";

type EmailStarterTemplate = {
  key: string;
  label: string;
  subject: string;
  markdown: string;
};

export type EmailContentValue = {
  subject: string;
  markdown: string;
};

type EmailContentEditorProps = {
  idPrefix: string;
  workspaceId: string;
  value: EmailContentValue;
  onChange: (value: EmailContentValue) => void;
  disabled?: boolean;
  variables?: string[];
  previewVariables?: Record<string, string>;
  starterTemplates?: EmailStarterTemplate[];
  actions?: ReactNode;
  className?: string;
  draftStorageKey?: string;
};

const EMPTY_EMAIL_VARIABLES: string[] = [];
const EMPTY_EMAIL_PREVIEW_VARIABLES: Record<string, string> = {};
const EMPTY_EMAIL_STARTER_TEMPLATES: EmailStarterTemplate[] = [];

const EMAIL_IMAGE_ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif";
const EMAIL_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const EMAIL_IMAGE_EXTENSION_PATTERN = /\.(jpe?g|png|webp|gif)$/i;

function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after = before,
  fallback = ""
) {
  const selected = value.slice(start, end) || fallback;
  return `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
}

function sanitizeMarkdownImageAlt(filename: string): string {
  const withoutExtension = filename.replace(/\.[a-zA-Z0-9]{1,8}$/, "");
  const cleaned = withoutExtension
    .replace(/[\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "image";
}

function isEmailImageFile(file: File | null | undefined): file is File {
  if (!file) return false;
  const mimeType = normalizeMediaMimeType(file.type);
  if (EMAIL_IMAGE_MIME_TYPES.has(mimeType)) return true;
  return EMAIL_IMAGE_EXTENSION_PATTERN.test(file.name || "");
}

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (Array.from(dataTransfer.types || []).includes("Files")) return true;
  return Array.from(dataTransfer.items || []).some(
    item => item.kind === "file"
  );
}

function getImageExtension(mimeType: string): string {
  const normalized = normalizeMediaMimeType(mimeType);
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/webp") return "webp";
  return "png";
}

function ensureEmailImageFileName(file: File, prefix: string): File {
  if (file.name.trim()) return file;

  const mimeType = normalizeMediaMimeType(file.type) || "image/png";
  return new File(
    [file],
    `${prefix}-${Date.now()}.${getImageExtension(mimeType)}`,
    {
      type: mimeType,
      lastModified: file.lastModified || Date.now(),
    }
  );
}

function getImageFileFromItems(items: DataTransferItemList | undefined | null) {
  for (const item of Array.from(items || [])) {
    if (item.kind !== "file") continue;
    if (!normalizeMediaMimeType(item.type).startsWith("image/")) continue;
    const file = item.getAsFile();
    if (isEmailImageFile(file)) return file;
  }
  return null;
}

function getImageFileFromFileList(files: FileList | File[] | undefined | null) {
  return Array.from(files || []).find(isEmailImageFile) ?? null;
}

function getImageFileFromDataTransfer(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return null;
  return (
    getImageFileFromItems(dataTransfer.items) ||
    getImageFileFromFileList(dataTransfer.files)
  );
}

function readEmailDraft(storageKey: string): EmailContentValue | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EmailContentValue>;
    const draft = {
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      markdown: typeof parsed.markdown === "string" ? parsed.markdown : "",
    };
    if (!draft.subject.trim() && !draft.markdown.trim()) return null;
    return draft;
  } catch {
    return null;
  }
}

function writeEmailDraft(storageKey: string, value: EmailContentValue) {
  try {
    if (!value.subject.trim() && !value.markdown.trim()) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Draft persistence should never block composing or sending an email.
  }
}

export function EmailContentEditor({
  idPrefix,
  workspaceId,
  value,
  onChange,
  disabled = false,
  variables = EMPTY_EMAIL_VARIABLES,
  previewVariables = EMPTY_EMAIL_PREVIEW_VARIABLES,
  starterTemplates = EMPTY_EMAIL_STARTER_TEMPLATES,
  actions,
  className,
  draftStorageKey,
}: EmailContentEditorProps) {
  const markdownRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedDraftKeyRef = useRef<string | null>(null);
  const skipNextPersistRef = useRef(false);
  const lastPersistedDraftRef = useRef<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const imageInputId = `${idPrefix}-image-upload`;

  useEffect(() => {
    if (!draftStorageKey || loadedDraftKeyRef.current === draftStorageKey) {
      return;
    }
    loadedDraftKeyRef.current = draftStorageKey;
    lastPersistedDraftRef.current = null;

    const draft = readEmailDraft(draftStorageKey);
    if (!draft) return;

    const draftSnapshot = JSON.stringify(draft);
    lastPersistedDraftRef.current = draftSnapshot;

    if (draft.subject !== value.subject || draft.markdown !== value.markdown) {
      skipNextPersistRef.current = true;
      onChange(draft);
    }
  }, [draftStorageKey, onChange, value.markdown, value.subject]);

  useEffect(() => {
    if (!draftStorageKey || loadedDraftKeyRef.current !== draftStorageKey) {
      return;
    }

    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }

    const snapshot = JSON.stringify(value);
    if (snapshot === lastPersistedDraftRef.current) return;

    writeEmailDraft(draftStorageKey, value);
    lastPersistedDraftRef.current = snapshot;
  }, [draftStorageKey, value]);

  const preview = useMemo(
    () =>
      renderMarkdownEmailTemplate({
        subject: value.subject || "Update",
        markdown: value.markdown,
        variables: previewVariables,
      }),
    [previewVariables, value.markdown, value.subject]
  );
  const previewBodyHtml = useMemo(
    () =>
      preview.html
        .replace(/^<!doctype html>/i, "")
        .replace(/^[\s\S]*<td[^>]*>/i, "")
        .replace(/<\/td>[\s\S]*$/i, ""),
    [preview.html]
  );
  const previewSrcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8" /></head><body style="margin:0;padding:20px;font:14px/1.7 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;background:#fff;">${previewBodyHtml}</body></html>`,
    [previewBodyHtml]
  );

  const updateSubject = (subject: string) => onChange({ ...value, subject });
  const updateMarkdown = (markdown: string) => onChange({ ...value, markdown });

  const insertMarkdown = (snippet: string) => {
    const input = markdownRef.current;
    if (!input) {
      updateMarkdown(`${value.markdown}${snippet}`);
      return;
    }
    const start = input.selectionStart ?? value.markdown.length;
    const end = input.selectionEnd ?? start;
    const next = `${value.markdown.slice(0, start)}${snippet}${value.markdown.slice(end)}`;
    updateMarkdown(next);
    window.requestAnimationFrame(() => {
      input.focus();
      const cursor = start + snippet.length;
      input.setSelectionRange(cursor, cursor);
    });
  };

  const formatSelection = (
    before: string,
    after = before,
    fallback = "text"
  ) => {
    const input = markdownRef.current;
    if (!input) return insertMarkdown(`${before}${fallback}${after}`);
    updateMarkdown(
      wrapSelection(
        value.markdown,
        input.selectionStart,
        input.selectionEnd,
        before,
        after,
        fallback
      )
    );
    window.requestAnimationFrame(() => input.focus());
  };

  const insertLink = () => {
    const url = window.prompt("URL");
    if (!url) return;
    formatSelection("[", `](${url.trim()})`, "Link");
  };

  const uploadImageFile = async (
    imageFile: File | null | undefined,
    source: "selected" | "pasted" | "dropped" = "selected"
  ) => {
    const file = imageFile
      ? ensureEmailImageFileName(imageFile, `${source}-image`)
      : null;
    if (!file) return;
    if (!isEmailImageFile(file)) {
      toast.error("Only JPEG, PNG, GIF, and WebP images are allowed.");
      return;
    }

    setUploadingImage(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch(
        `/api/workspaces/${workspaceId}/email-assets`,
        {
          method: "POST",
          body: formData,
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || "Image upload failed");
      }
      const imageUrl = String(payload?.image?.url || "");
      if (!imageUrl) throw new Error("Image upload returned no URL");
      insertMarkdown(
        `\n\n![${sanitizeMarkdownImageAlt(file.name)}](${imageUrl})\n\n`
      );
      toast.success("Image uploaded");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Image upload failed"
      );
    } finally {
      setUploadingImage(false);
    }
  };

  const uploadImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    void uploadImageFile(file, "selected");
  };

  const handleMarkdownPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || uploadingImage) return;

    const file = getImageFileFromDataTransfer(event.clipboardData);
    if (!file) return;

    event.preventDefault();
    void uploadImageFile(file, "pasted");
  };

  const handleImageDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || uploadingImage) return;
    if (!dataTransferHasFiles(event.dataTransfer)) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setImageDragActive(true);
  };

  const handleImageDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setImageDragActive(false);
  };

  const handleImageDrop = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || uploadingImage) return;
    if (!dataTransferHasFiles(event.dataTransfer)) return;

    event.preventDefault();
    setImageDragActive(false);
    const file = getImageFileFromDataTransfer(event.dataTransfer);
    if (!file) {
      toast.error("Only JPEG, PNG, GIF, and WebP images are allowed.");
      return;
    }

    void uploadImageFile(file, "dropped");
  };

  return (
    <div
      className={cn(
        "grid min-h-0 gap-6 xl:grid-cols-[minmax(0,1fr)_430px]",
        className
      )}
    >
      <div className="min-w-0 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor={`${idPrefix}-subject`}>Subject</Label>
            <Input
              id={`${idPrefix}-subject`}
              value={value.subject}
              disabled={disabled}
              onChange={event => updateSubject(event.target.value)}
              placeholder="Hello {{recipientName}}"
            />
          </div>
          {actions ? (
            <div className="flex flex-wrap gap-2">{actions}</div>
          ) : null}
        </div>

        {starterTemplates.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {starterTemplates.map(template => (
              <Button
                key={template.key}
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    subject: template.subject,
                    markdown: template.markdown,
                  })
                }
              >
                {template.label}
              </Button>
            ))}
          </div>
        ) : null}

        <div
          className={cn(
            "rounded-lg border bg-background transition-colors",
            imageDragActive && "border-primary/60 bg-primary/5"
          )}
          onDragOver={handleImageDragOver}
          onDragLeave={handleImageDragLeave}
          onDrop={handleImageDrop}
        >
          <Label htmlFor={`${idPrefix}-markdown`} className="sr-only">
            Body markdown
          </Label>
          <div className="flex flex-wrap items-center gap-1 border-b px-2 py-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label="Bold"
              onClick={() => formatSelection("**", "**", "bold text")}
            >
              <Bold className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label="Heading"
              onClick={() => insertMarkdown("\n\n## Heading\n\n")}
            >
              <Heading2 className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label="List"
              onClick={() => insertMarkdown("\n\n- Item\n")}
            >
              <List className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label="Link"
              onClick={insertLink}
            >
              <Link className="size-4" aria-hidden="true" />
            </Button>
            <input
              id={imageInputId}
              ref={fileInputRef}
              type="file"
              accept={EMAIL_IMAGE_ACCEPT}
              className="peer sr-only"
              onChange={uploadImage}
              disabled={disabled || uploadingImage}
            />
            <Label
              htmlFor={imageInputId}
              aria-label="Upload image"
              title="Upload image"
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon" }),
                "cursor-pointer",
                (disabled || uploadingImage) && "pointer-events-none opacity-50"
              )}
            >
              {uploadingImage ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <ImageIcon className="size-4" aria-hidden="true" />
              )}
              <span className="sr-only">Upload image</span>
            </Label>
          </div>
          <Textarea
            ref={markdownRef}
            id={`${idPrefix}-markdown`}
            value={value.markdown}
            disabled={disabled}
            onChange={event => updateMarkdown(event.target.value)}
            onPaste={handleMarkdownPaste}
            className="h-[min(52svh,560px)] min-h-[320px] resize-none rounded-none border-0 font-mono text-sm leading-6 shadow-none focus-visible:ring-0"
            placeholder="# Hi {{recipientName}}"
          />
        </div>

        {variables.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Variables</p>
            <div className="flex flex-wrap gap-2">
              {variables.map(variable => (
                <button
                  key={variable}
                  type="button"
                  disabled={disabled}
                  onClick={() => insertMarkdown(`{{${variable}}}`)}
                  className="rounded-md bg-muted px-2 py-1 text-xs text-foreground disabled:opacity-50"
                >
                  {`{{${variable}}}`}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="min-w-0 space-y-4 xl:sticky xl:top-5 xl:self-start">
        <div className="rounded-lg bg-muted/30 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Preview
            </p>
            <Badge variant="outline">Email</Badge>
          </div>
          <p className="mb-3 text-sm font-semibold text-foreground">
            {preview.subject}
          </p>
          <ScrollArea className="h-[min(52svh,560px)] min-h-[320px] rounded-md bg-background">
            <iframe
              title="Email preview"
              className="h-[min(52svh,560px)] min-h-[320px] w-full rounded-md bg-background"
              sandbox=""
              srcDoc={previewSrcDoc}
            />
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
