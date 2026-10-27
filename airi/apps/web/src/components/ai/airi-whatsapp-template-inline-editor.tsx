"use client";

import {
  WhatsAppActionRenderer,
  type WhatsAppActionRendererButton,
} from "@/components/scenarios/builders/whatsapp/action-renderer";
import {
  addWhatsAppTemplateButton,
  editableWhatsAppTemplateEditorFormSchema,
  getEditableWhatsAppTemplateButtons,
  getEnglishWhatsAppTemplateEditorError,
  getWhatsAppTemplateBodyText,
  getWhatsAppTemplateFooterText,
  getWhatsAppTemplateHeaderMediaFormat,
  getWhatsAppTemplateHeaderText,
  normalizeWhatsAppTemplateComponentsForMeta,
  removeWhatsAppTemplateButton,
  updateWhatsAppTemplateButton,
  type EditableWhatsAppTemplateButton,
} from "@/components/scenarios/builders/whatsapp/template-editor-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { panelWorkspaceHref } from "@/features/panel/shared/routing";
import type { AiriWhatsAppTemplateDraft } from "@/lib/airi-chats/whatsapp-template-drafts";
import { cn } from "@/lib/utils";
import { WHATSAPP_TEMPLATE_VIDEO_HEADER_MAX_BYTES } from "@icecore/whatsapp/mediaTypes";
import { getWhatsAppTemplateHeaderMediaValidationIssue } from "@/lib/whatsapp/templates/header-media-constraints";
import {
  getTemplateHeaderMedia,
  type TemplateHeaderMediaFormat,
} from "@/lib/whatsapp/templates/header-media-utils";
import {
  buildWhatsAppTemplateTextExample,
  readWhatsAppTemplateNamedParamExamples,
} from "@/lib/whatsapp/templates/parameter-format";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { normalizeWhatsAppTemplateLanguageCode } from "@icecore/shared/constants/whatsapp-templates";
import type {
  WhatsAppComponent,
  WhatsAppFlowActionType,
  WhatsAppHeaderFormat,
  WhatsAppTemplateCategory,
} from "@icecore/shared/types/whatsapp";
import {
  FileText,
  ImageIcon,
  Loader2,
  Plus,
  Save,
  Trash2,
  Video,
  Workflow,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { toast } from "sonner";
import Link from "next/link";
import { useTranslations } from "next-intl";

type AiriWhatsAppTemplateInlineEditorProps = {
  workspaceId: string;
  artifactId?: string | null;
  templateDraft: AiriWhatsAppTemplateDraft;
  flowConfig?: WhatsAppFlowConfig | null;
  activeFlowButtonIndex?: number | null;
  onTemplateDraftChange: (draft: AiriWhatsAppTemplateDraft) => void;
  onOpenFlowButton?: (button: EditableWhatsAppTemplateButton) => void;
  openingFlowButtonIndex?: number | null;
  onSaved: () => void;
};

type HeaderChoice = "NONE" | WhatsAppHeaderFormat;

const TEMPLATE_COMPONENT_ORDER = [
  "HEADER",
  "BODY",
  "FOOTER",
  "BUTTONS",
] as const satisfies ReadonlyArray<WhatsAppComponent["type"]>;

const TEMPLATE_CATEGORIES = [
  "MARKETING",
  "UTILITY",
  "AUTHENTICATION",
] as const satisfies ReadonlyArray<WhatsAppTemplateCategory>;

const BUTTON_TYPE_OPTIONS = [
  { value: "quick_reply", label: "Reply" },
  { value: "url", label: "URL" },
  { value: "phone", label: "Phone" },
  { value: "flow", label: "Flow" },
] as const;

const FLOW_ACTION_OPTIONS: Array<{
  value: WhatsAppFlowActionType;
  label: string;
}> = [
  { value: "navigate", label: "Navigate" },
  { value: "data_exchange", label: "Data exchange" },
];

function orderTemplateComponents(
  components: WhatsAppComponent[]
): WhatsAppComponent[] {
  return TEMPLATE_COMPONENT_ORDER.flatMap(type =>
    components.filter(component => component.type === type)
  );
}

function removeComponent(
  components: WhatsAppComponent[],
  type: WhatsAppComponent["type"]
): WhatsAppComponent[] {
  return orderTemplateComponents(
    components.filter(component => component.type !== type)
  );
}

function replaceComponent(
  components: WhatsAppComponent[],
  component: WhatsAppComponent
): WhatsAppComponent[] {
  return orderTemplateComponents([
    ...components.filter(existing => existing.type !== component.type),
    component,
  ]);
}

function findHeader(
  components: WhatsAppComponent[]
): Extract<WhatsAppComponent, { type: "HEADER" }> | null {
  const header = components.find(component => component.type === "HEADER");
  return header && header.type === "HEADER" ? header : null;
}

/** Samples for the text's variables; named samples the draft already has stay. */
function buildTextExample(
  components: WhatsAppComponent[],
  kind: "header" | "body",
  text: string
) {
  return buildWhatsAppTemplateTextExample({
    text,
    kind,
    sample: variable => `${variable}_example`,
    namedExamples: readWhatsAppTemplateNamedParamExamples(components),
  });
}

function updateBodyComponent(
  components: WhatsAppComponent[],
  text: string
): WhatsAppComponent[] {
  const example = buildTextExample(components, "body", text);
  return replaceComponent(components, {
    type: "BODY",
    text,
    ...(example ? { example } : {}),
  });
}

function updateFooterComponent(
  components: WhatsAppComponent[],
  text: string
): WhatsAppComponent[] {
  if (!text.trim()) return removeComponent(components, "FOOTER");
  return replaceComponent(components, {
    type: "FOOTER",
    text,
  });
}

function updateTextHeaderComponent(
  components: WhatsAppComponent[],
  text: string
): WhatsAppComponent[] {
  const example = buildTextExample(components, "header", text);
  return replaceComponent(components, {
    type: "HEADER",
    format: "TEXT",
    text,
    ...(example ? { example } : {}),
  });
}

function updateMediaHeaderComponent(
  components: WhatsAppComponent[],
  format: TemplateHeaderMediaFormat,
  headerHandle?: string
): WhatsAppComponent[] {
  return replaceComponent(components, {
    type: "HEADER",
    format,
    ...(headerHandle?.trim()
      ? { example: { header_handle: [headerHandle.trim()] } }
      : {}),
  });
}

function getHeaderChoice(components: WhatsAppComponent[]): HeaderChoice {
  const header = findHeader(components);
  return header?.format ?? "NONE";
}

function normalizeTemplateNameInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+/, "")
    .slice(0, 512);
}

function normalizeLanguageInput(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 16);
}

function getMediaAccept(format: TemplateHeaderMediaFormat): string {
  if (format === "IMAGE") return "image/*";
  if (format === "VIDEO") return "video/mp4,video/3gpp,.mp4,.3gp";
  return "*/*";
}

function getMediaLabel(format: TemplateHeaderMediaFormat): string {
  if (format === "IMAGE") return "image";
  if (format === "VIDEO") return "video";
  return "document";
}

function getMediaIcon(format: TemplateHeaderMediaFormat) {
  if (format === "IMAGE") return ImageIcon;
  if (format === "VIDEO") return Video;
  return FileText;
}

function getHeaderMediaValidationMessage(
  issue: "templateVideoTooLarge" | "templateVideoUnsupported"
): string {
  if (issue === "templateVideoTooLarge") {
    return `Video template headers must be ${Math.round(
      WHATSAPP_TEMPLATE_VIDEO_HEADER_MAX_BYTES / (1024 * 1024)
    )}MB or smaller.`;
  }
  return "Template videos must be MP4 or 3GP. MOV is not supported for WhatsApp templates.";
}

function firstEditorIssueMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray((error as { issues?: unknown }).issues)
  ) {
    const issue = (error as { issues: Array<{ message?: string }> }).issues[0];
    if (issue?.message)
      return getEnglishWhatsAppTemplateEditorError(issue.message);
  }
  return "Check the template fields before submitting.";
}

export function AiriWhatsAppTemplateInlineEditor({
  workspaceId,
  artifactId,
  templateDraft,
  flowConfig,
  activeFlowButtonIndex = null,
  onTemplateDraftChange,
  onOpenFlowButton,
  openingFlowButtonIndex = null,
  onSaved,
}: AiriWhatsAppTemplateInlineEditorProps) {
  const t = useTranslations("templates.form");
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaDragActive, setMediaDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const authenticationUnsupported = templateDraft.category === "AUTHENTICATION";

  const components = templateDraft.components;
  const headerChoice = getHeaderChoice(components);
  const headerMediaFormat = getWhatsAppTemplateHeaderMediaFormat(components);
  const headerMedia = getTemplateHeaderMedia(components);
  const headerText = getWhatsAppTemplateHeaderText(components);
  const bodyText = getWhatsAppTemplateBodyText(components);
  const footerText = getWhatsAppTemplateFooterText(components);
  const editableButtons = useMemo(
    () => getEditableWhatsAppTemplateButtons(components),
    [components]
  );
  const flowButtonCount = useMemo(
    () => editableButtons.filter(button => button.type === "flow").length,
    [editableButtons]
  );

  const getFlowScreenOptions = useCallback(
    (button: EditableWhatsAppTemplateButton): string[] => {
      const buttonFlowId = button.flowId?.trim();
      const activeFlowId = flowConfig?.metaFlowId?.trim();
      const isActiveButton = activeFlowButtonIndex === button.index;
      const isAttachedActiveFlow =
        buttonFlowId && activeFlowId && buttonFlowId === activeFlowId;
      if (!isActiveButton && !isAttachedActiveFlow) return [];
      return (flowConfig?.screens || [])
        .map(screen => screen.id?.trim())
        .filter((screenId): screenId is string => Boolean(screenId));
    },
    [activeFlowButtonIndex, flowConfig]
  );

  const patchDraft = useCallback(
    (patch: Partial<AiriWhatsAppTemplateDraft>) => {
      onTemplateDraftChange({
        ...templateDraft,
        ...patch,
        kind: "whatsapp_template",
      });
    },
    [onTemplateDraftChange, templateDraft]
  );

  const patchComponents = useCallback(
    (nextComponents: WhatsAppComponent[]) => {
      patchDraft({ components: orderTemplateComponents(nextComponents) });
    },
    [patchDraft]
  );

  const patchButton = useCallback(
    (
      buttonIndex: number,
      patch: Parameters<typeof updateWhatsAppTemplateButton>[2]
    ) => {
      patchComponents(
        updateWhatsAppTemplateButton(components, buttonIndex, patch)
      );
    },
    [components, patchComponents]
  );

  const handleHeaderChoiceChange = useCallback(
    (nextChoice: HeaderChoice) => {
      if (nextChoice === "NONE") {
        patchComponents(removeComponent(components, "HEADER"));
        return;
      }
      if (nextChoice === "TEXT") {
        patchComponents(updateTextHeaderComponent(components, headerText));
        return;
      }
      if (nextChoice === "LOCATION") {
        patchComponents(
          replaceComponent(components, { type: "HEADER", format: "LOCATION" })
        );
        return;
      }
      const existingHandle =
        headerMedia?.format === nextChoice ? headerMedia.value : undefined;
      patchComponents(
        updateMediaHeaderComponent(components, nextChoice, existingHandle)
      );
    },
    [components, headerMedia, headerText, patchComponents]
  );

  const handleUploadHeaderMedia = useCallback(
    async (file: File | null | undefined) => {
      if (!file || !headerMediaFormat) return;

      const validationIssue = getWhatsAppTemplateHeaderMediaValidationIssue({
        format: headerMediaFormat,
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
      });
      if (validationIssue) {
        toast.error(getHeaderMediaValidationMessage(validationIssue));
        return;
      }

      setMediaUploading(true);
      try {
        const formData = new FormData();
        formData.set("file", file);
        formData.set("format", headerMediaFormat);

        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(
            workspaceId
          )}/whatsapp-template-header-media`,
          {
            method: "POST",
            body: formData,
          }
        );
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          media?: { url?: string };
        } | null;
        const mediaUrl = payload?.media?.url?.trim();
        if (!response.ok || !mediaUrl) {
          throw new Error(payload?.error || "Failed to upload media.");
        }
        patchComponents(
          updateMediaHeaderComponent(components, headerMediaFormat, mediaUrl)
        );
        toast.success("Header media uploaded.");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to upload media."
        );
      } finally {
        setMediaUploading(false);
        if (mediaInputRef.current) {
          mediaInputRef.current.value = "";
        }
      }
    },
    [components, headerMediaFormat, patchComponents, workspaceId]
  );

  const handleMediaDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setMediaDragActive(false);
      void handleUploadHeaderMedia(event.dataTransfer.files?.[0]);
    },
    [handleUploadHeaderMedia]
  );

  const handleMediaInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void handleUploadHeaderMedia(event.target.files?.[0]);
    },
    [handleUploadHeaderMedia]
  );

  const templatePreviewButtons = useMemo(
    (): WhatsAppActionRendererButton[] =>
      editableButtons.map(button => {
        const flowButtonOpening = openingFlowButtonIndex === button.index;
        return {
          key: `airi-template-button-${button.index}`,
          type: button.type,
          label: button.label,
          value: button.value,
          flowId: button.flowId,
          flowAction: button.flowAction,
          onLabelChange: value => patchButton(button.index, { label: value }),
          leadingAction:
            button.type === "flow" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-md text-[#1b8755] hover:bg-[#e7f7ef] hover:text-[#0b5f3a] dark:text-[#34b7a8] dark:hover:bg-white/10"
                aria-label={`Open Flow builder for button ${button.index + 1}`}
                title={`Open Flow builder for ${button.label || "button"}`}
                onClick={event => {
                  event.stopPropagation();
                  onOpenFlowButton?.(button);
                }}
                disabled={!onOpenFlowButton || flowButtonOpening}
              >
                {flowButtonOpening ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Workflow className="h-3.5 w-3.5" />
                )}
              </Button>
            ) : undefined,
          rowActions: (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={`Remove button ${button.index + 1}`}
              onClick={event => {
                event.stopPropagation();
                patchComponents(
                  removeWhatsAppTemplateButton(components, button.index)
                );
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ),
        };
      }),
    [
      components,
      editableButtons,
      onOpenFlowButton,
      openingFlowButtonIndex,
      patchButton,
      patchComponents,
    ]
  );

  const buttonEditor = (
    <div className="space-y-1.5 px-2.5 py-1.5">
      {editableButtons.map(button => {
        const flowScreenOptions =
          button.type === "flow" ? getFlowScreenOptions(button) : [];
        const flowAction = button.flowAction || "navigate";
        const flowButtonOpening = openingFlowButtonIndex === button.index;
        const flowButtonAttached = Boolean(button.flowId?.trim());
        return (
          <div
            key={`airi-template-button-editor-${button.index}`}
            className="grid grid-cols-[5.7rem_minmax(0,1fr)] gap-1.5"
          >
            <select
              aria-label={`Button ${button.index + 1} type`}
              value={button.type}
              onChange={event =>
                patchButton(button.index, {
                  type: event.target
                    .value as (typeof BUTTON_TYPE_OPTIONS)[number]["value"],
                })
              }
              className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-[11px] shadow-none outline-none dark:border-zinc-700 dark:bg-zinc-950"
            >
              {BUTTON_TYPE_OPTIONS.map(option => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={
                    option.value === "flow" &&
                    button.type !== "flow" &&
                    flowButtonCount >= 1
                  }
                >
                  {option.label}
                </option>
              ))}
            </select>
            {button.type === "url" ? (
              <Input
                aria-label={`Button ${button.index + 1} URL`}
                value={button.value || ""}
                onChange={event =>
                  patchButton(button.index, { value: event.target.value })
                }
                placeholder="https://example.com"
                className="h-8 bg-white text-[11px] shadow-none dark:bg-zinc-950"
              />
            ) : button.type === "phone" ? (
              <Input
                aria-label={`Button ${button.index + 1} phone`}
                value={button.value || ""}
                onChange={event =>
                  patchButton(button.index, { value: event.target.value })
                }
                placeholder="+15551234567"
                className="h-8 bg-white text-[11px] shadow-none dark:bg-zinc-950"
              />
            ) : button.type === "flow" ? (
              <div className="space-y-1.5">
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 w-full justify-between gap-2 bg-white px-2 text-[11px] font-medium shadow-none dark:bg-zinc-950"
                  aria-label={`Build or edit Flow for button ${button.index + 1}`}
                  title={
                    flowButtonAttached
                      ? "Open attached Flow"
                      : "Build a Flow for this button"
                  }
                  onClick={() => onOpenFlowButton?.(button)}
                  disabled={!onOpenFlowButton || flowButtonOpening}
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    {flowButtonOpening ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : (
                      <Workflow className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="truncate">
                      {flowButtonAttached ? "Edit Flow" : "Build Flow"}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none",
                      flowButtonAttached
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                        : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                    )}
                  >
                    {flowButtonAttached ? "Attached" : "Required"}
                  </span>
                </Button>
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    aria-label={`Button ${button.index + 1} Flow action`}
                    value={flowAction}
                    onChange={event => {
                      const nextFlowAction = event.target
                        .value as WhatsAppFlowActionType;
                      patchButton(button.index, {
                        flowAction: nextFlowAction,
                        navigateScreen:
                          nextFlowAction === "navigate"
                            ? button.navigateScreen ||
                              flowScreenOptions[0] ||
                              ""
                            : "",
                      });
                    }}
                    className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-[11px] shadow-none outline-none dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    {FLOW_ACTION_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {flowAction === "navigate" ? (
                    flowScreenOptions.length > 0 ? (
                      <select
                        aria-label={`Button ${button.index + 1} Flow start screen`}
                        value={button.navigateScreen || ""}
                        onChange={event =>
                          patchButton(button.index, {
                            navigateScreen: event.target.value,
                          })
                        }
                        className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-[11px] shadow-none outline-none dark:border-zinc-700 dark:bg-zinc-950"
                      >
                        <option value="" disabled>
                          Start screen
                        </option>
                        {flowScreenOptions.map(screenId => (
                          <option key={screenId} value={screenId}>
                            {screenId}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div
                        aria-label={`Button ${button.index + 1} Flow start screen`}
                        className="flex h-8 min-w-0 items-center rounded-md border border-dashed border-zinc-300 px-2 text-[11px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
                        title={
                          button.navigateScreen ||
                          (flowButtonAttached
                            ? "Open Flow to load screens"
                            : "Build and save the Flow to attach a start screen")
                        }
                      >
                        <span className="truncate">
                          {button.navigateScreen ||
                            (flowButtonAttached
                              ? "Load screens"
                              : "Start later")}
                        </span>
                      </div>
                    )
                  ) : (
                    <div
                      aria-label={`Button ${button.index + 1} Flow endpoint mode`}
                      className="flex h-8 min-w-0 items-center rounded-md border border-dashed border-zinc-300 px-2 text-[11px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
                    >
                      <span className="truncate">Data endpoint</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-8 items-center rounded-md border border-dashed border-zinc-300 px-2 text-[11px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                Quick reply
              </div>
            )}
          </div>
        );
      })}
      {editableButtons.length < 3 ? (
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-center rounded-lg border border-dashed border-zinc-400/70 bg-white/80 text-[11px] font-medium text-zinc-700 hover:bg-white hover:text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:bg-zinc-900"
          onClick={() =>
            patchComponents(
              addWhatsAppTemplateButton(components, "quick_reply")
            )
          }
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add button
        </Button>
      ) : null}
    </div>
  );

  const mediaEditor =
    headerMediaFormat != null ? (
      <div
        role="button"
        tabIndex={0}
        data-testid="airi-template-media-dropzone"
        className={cn(
          "group relative flex min-h-32 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-md border border-dashed border-black/15 bg-white/70 text-center text-[#667781] outline-none transition dark:border-white/10 dark:bg-white/5 dark:text-[#aebac1]",
          mediaDragActive &&
            "border-[#1b8755] bg-[#e7f7ef] text-[#0b5f3a] dark:bg-[#10382a] dark:text-[#b7f0d2]"
        )}
        onClick={() => mediaInputRef.current?.click()}
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            mediaInputRef.current?.click();
          }
        }}
        onDragOver={event => {
          event.preventDefault();
          setMediaDragActive(true);
        }}
        onDragLeave={() => setMediaDragActive(false)}
        onDrop={handleMediaDrop}
      >
        <input
          ref={mediaInputRef}
          type="file"
          accept={getMediaAccept(headerMediaFormat)}
          className="sr-only"
          onChange={handleMediaInputChange}
        />
        {headerMedia?.url && headerMediaFormat === "IMAGE" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={headerMedia.url}
            alt="WhatsApp template header"
            className="h-full max-h-44 w-full object-cover"
          />
        ) : headerMedia?.url && headerMediaFormat === "VIDEO" ? (
          <video
            src={headerMedia.url}
            controls
            playsInline
            preload="metadata"
            className="h-full max-h-44 w-full bg-black object-cover"
            aria-label="WhatsApp template video header"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 px-3 py-5">
            {mediaUploading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              (() => {
                const Icon = getMediaIcon(headerMediaFormat);
                return <Icon className="h-5 w-5" />;
              })()
            )}
            <div className="space-y-0.5">
              <p className="text-[11px] font-medium uppercase tracking-wide">
                {mediaUploading
                  ? "Uploading..."
                  : `Drop ${getMediaLabel(headerMediaFormat)} here`}
              </p>
              <p className="text-[10px]">
                {headerMedia?.rawHandle
                  ? "Media handle saved"
                  : "Click to upload"}
              </p>
            </div>
          </div>
        )}
        {headerMedia?.url ? (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded bg-black/55 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition group-hover:opacity-100">
            Drop to replace
          </div>
        ) : null}
      </div>
    ) : undefined;

  const handleSubmit = async () => {
    if (authenticationUnsupported) {
      toast.error(t("inlineAuthenticationUnsupported"));
      return;
    }
    const normalizedComponents =
      normalizeWhatsAppTemplateComponentsForMeta(components);
    const editorValues = {
      headerText: getWhatsAppTemplateHeaderText(normalizedComponents),
      bodyText: getWhatsAppTemplateBodyText(normalizedComponents),
      footerText: getWhatsAppTemplateFooterText(normalizedComponents),
      buttons: getEditableWhatsAppTemplateButtons(normalizedComponents),
    };
    const parsed =
      editableWhatsAppTemplateEditorFormSchema.safeParse(editorValues);
    if (!parsed.success) {
      toast.error(firstEditorIssueMessage(parsed.error));
      return;
    }
    const mediaHeader = getTemplateHeaderMedia(normalizedComponents);
    if (mediaHeader && !mediaHeader.value) {
      toast.error("Upload media for the header before submitting.");
      return;
    }
    if (!templateDraft.name.trim()) {
      toast.error("Template name is required.");
      return;
    }
    const templateLanguage = normalizeWhatsAppTemplateLanguageCode(
      templateDraft.language
    );
    if (!templateLanguage) {
      toast.error("Template language is not supported by WhatsApp.");
      return;
    }

    setSubmitting(true);
    try {
      if (!artifactId) {
        toast.error("Save this template draft before submitting.");
        return;
      }
      const response = await fetch(
        `/api/workspaces/${workspaceId}/airi-artifacts/${artifactId}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        toast.error(result.error || "Failed to submit template.");
        return;
      }
      toast.success("Template submitted.");
      onSaved();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to submit template."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <WhatsAppActionRenderer
          headerText={headerText}
          onHeaderTextChange={
            headerChoice === "TEXT"
              ? value =>
                  patchComponents(updateTextHeaderComponent(components, value))
              : undefined
          }
          headerPlaceholder="Template header"
          headerMediaFormat={headerMediaFormat}
          headerMediaUrl={headerMedia?.url}
          headerMediaEditor={mediaEditor}
          bodyText={bodyText}
          onBodyTextChange={value =>
            patchComponents(updateBodyComponent(components, value))
          }
          bodyPlaceholder="Template body"
          footerText={footerText}
          onFooterTextChange={value =>
            patchComponents(updateFooterComponent(components, value))
          }
          footerPlaceholder="Footer"
          buttons={templatePreviewButtons}
          buttonEditor={buttonEditor}
          buttonLabelPlaceholder="Button label"
          ctaFallbackLabel="Select a WhatsApp Flow"
          appBarContent={
            <Input
              aria-label="Template name"
              value={templateDraft.name}
              onChange={event =>
                patchDraft({
                  name: normalizeTemplateNameInput(event.target.value),
                })
              }
              className="h-7 min-w-0 border-0 bg-transparent px-0 text-[13px] font-semibold text-white shadow-none outline-none placeholder:text-white/50 focus-visible:ring-0"
              spellCheck={false}
            />
          }
          fitContent
          align="start"
          previewClassName="w-full max-w-[393px]"
          className="w-full"
          mediaLoading="eager"
          showVideoControls
        />
      </div>

      <div className="shrink-0 border-t bg-background px-3 py-3">
        {authenticationUnsupported && (
          <div
            role="status"
            className="mb-3 space-y-2 rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground"
          >
            <p>{t("inlineAuthenticationUnsupported")}</p>
            <Link
              href={panelWorkspaceHref(
                workspaceId,
                "messengers/whatsapp-templates"
              )}
              className="inline-block font-medium text-foreground underline underline-offset-4"
            >
              {t("openWhatsAppManager")}
            </Link>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
            <span>Header</span>
            <select
              aria-label="Header type"
              value={headerChoice}
              onChange={event =>
                handleHeaderChoiceChange(event.target.value as HeaderChoice)
              }
              className="h-9 w-full rounded-md border bg-background px-2 text-xs text-foreground shadow-sm outline-none"
            >
              <option value="NONE">None</option>
              <option value="TEXT">Text</option>
              <option value="IMAGE">Image</option>
              <option value="VIDEO">Video</option>
              <option value="DOCUMENT">Document</option>
              {headerChoice === "LOCATION" && (
                <option value="LOCATION">Location</option>
              )}
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
            <span>Language</span>
            <Input
              aria-label="Template language"
              value={templateDraft.language}
              onChange={event =>
                patchDraft({
                  language: normalizeLanguageInput(event.target.value),
                })
              }
              className="h-9 text-xs"
              spellCheck={false}
            />
          </label>
          <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
            <span>Category</span>
            <select
              aria-label="Template category"
              value={templateDraft.category}
              onChange={event =>
                patchDraft({
                  category: event.target.value as WhatsAppTemplateCategory,
                })
              }
              className="h-9 w-full rounded-md border bg-background px-2 text-xs text-foreground shadow-sm outline-none"
            >
              {TEMPLATE_CATEGORIES.map(category => (
                <option key={category} value={category}>
                  {category[0] + category.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            className="mt-5 h-9 gap-2"
            disabled={submitting || mediaUploading || authenticationUnsupported}
            onClick={() => void handleSubmit()}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
}
