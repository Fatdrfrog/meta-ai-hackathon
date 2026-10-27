"use client";

import { cn } from "@/lib/utils";
import {
  parseWhatsAppTextFormatting,
  type WhatsAppTextFormatSegment,
} from "@/lib/whatsapp-format";
import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  Contact,
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  MapPin,
  MessageSquare,
  Music,
  Phone,
  Sticker,
  Video,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, type ReactNode } from "react";
import { createScenarioTokenLabelResolver } from "@/components/scenarios/view/scenario-template-utils";
import type { ScenarioWhatsAppPreviewButton } from "../../types";
import { waActionButton } from "./action-colors";
import { WhatsAppHeaderMediaPreview } from "./header-media-preview";
import type { WhatsAppInlineEditorProps } from "./inline-editor";
import { LazyWhatsAppInlineEditor as WhatsAppInlineEditor } from "./lazy-inline-editor";

/** Only values still driven by `style` (not in Tailwind theme). */
const WA = {
  wallpaper: "#e5ddd5",
  /** Hairline between body and button rows (matches light incoming bubble) */
  divider: "rgba(11, 20, 26, 0.12)",
  /** Bubble shadow from WhatsApp (very light card elevation) */
  bubbleShadow:
    "0 1px 0.5px rgba(11, 20, 26, 0.13), 0 0.5px 0.5px rgba(11, 20, 26, 0.1)",
} as const;

const BUTTON_TYPE_ICON: Record<string, LucideIcon> = {
  url: Link2,
  phone: Phone,
  quick_reply: MessageSquare,
  flow: ClipboardList,
  request_contact_info: Contact,
  location_request: MapPin,
};

export function getButtonTypeIcon(type: string) {
  return BUTTON_TYPE_ICON[type] ?? ClipboardList;
}

type HeaderMediaFormat = "IMAGE" | "VIDEO" | "DOCUMENT" | "AUDIO" | "STICKER";

const HEADER_MEDIA_PLACEHOLDER: Record<
  HeaderMediaFormat,
  { icon: LucideIcon; labelKey: string }
> = {
  IMAGE: { icon: ImageIcon, labelKey: "whatsappServiceMediaImage" },
  VIDEO: { icon: Video, labelKey: "whatsappServiceMediaVideo" },
  DOCUMENT: { icon: FileText, labelKey: "whatsappServiceMediaDocument" },
  AUDIO: { icon: Music, labelKey: "whatsappServiceMediaAudio" },
  STICKER: { icon: Sticker, labelKey: "whatsappServiceMediaSticker" },
};

function renderWhatsAppFormattedSegments(
  segments: WhatsAppTextFormatSegment[],
  keyPrefix: string
): ReactNode[] {
  return segments.map((segment, index) => {
    const key = `${keyPrefix}-${index}`;
    if (segment.type === "text") {
      return <span key={key}>{segment.text}</span>;
    }
    if (segment.kind === "monospace") {
      return (
        <code
          key={key}
          className="rounded bg-black/[0.04] px-0.5 font-mono text-[0.95em] dark:bg-white/[0.08]"
        >
          {segment.text}
        </code>
      );
    }
    const children = renderWhatsAppFormattedSegments(segment.children, key);
    if (segment.kind === "bold") {
      return <strong key={key}>{children}</strong>;
    }
    if (segment.kind === "italic") {
      return <em key={key}>{children}</em>;
    }
    return <s key={key}>{children}</s>;
  });
}

function WhatsAppFormattedText({
  text,
  className,
  testId,
}: {
  text: string;
  className: string;
  testId?: string;
}) {
  const segments = useMemo(() => parseWhatsAppTextFormatting(text), [text]);
  return (
    <p data-testid={testId} className={className}>
      {renderWhatsAppFormattedSegments(segments, testId || "wa-text")}
    </p>
  );
}

export type WhatsAppActionRendererButton = ScenarioWhatsAppPreviewButton & {
  key?: string;
  description?: string | null;
  disabled?: boolean;
  isLoading?: boolean;
  onClick?: () => void;
  /** Custom leading control for Flow rows, such as an editor opener inside the preview. */
  leadingAction?: ReactNode;
  /** When set, the list row is an input (e.g. template flow CTA) — use I-beam cursor, not a separate strip. */
  onLabelChange?: (value: string) => void;
  /** Commit hook for editable labels that should defer expensive side effects until blur. */
  onLabelCommit?: () => void;
  /** Extra controls (e.g. open flow, delete) aligned on the same row as the CTA preview. */
  rowActions?: ReactNode;
  /** Field-level validation helper shown under the button row. */
  error?: string;
  /** Stable field key for scroll-to-error (`data-sm-field`). */
  fieldKey?: string;
};

type WhatsAppActionRendererProps = {
  surface?: "phone" | "message";
  headerText?: string;
  onHeaderTextChange?: (value: string) => void;
  headerPlaceholder?: string;
  headerError?: string;
  /** Standalone service media may also be AUDIO / STICKER (not template headers). */
  headerMediaFormat?: HeaderMediaFormat;
  headerMediaUrl?: string;
  headerMediaEditor?: ReactNode;
  mediaLoading?: "eager" | "lazy";
  showVideoControls?: boolean;
  videoPreload?: "auto" | "metadata" | "none";
  bodyText: string;
  onBodyTextChange?: (value: string) => void;
  onBodyTextCommit?: () => void;
  onBodyInsertApiChange?: WhatsAppInlineEditorProps["onInsertApiChange"];
  bodyPlaceholder?: string;
  bodyError?: string;
  bodyOutputFormat?: "whatsapp" | "plain_text";
  footerText?: string;
  onFooterTextChange?: (value: string) => void;
  footerPlaceholder?: string;
  footerError?: string;
  footerOutputFormat?: "whatsapp" | "plain_text";
  buttons?: WhatsAppActionRendererButton[];
  buttonLabelPlaceholder?: string;
  ctaText?: string;
  onCtaTextChange?: (value: string) => void;
  ctaPlaceholder?: string;
  ctaFallbackLabel?: string;
  statusBarAction?: ReactNode;
  appBarContent?: ReactNode;
  /** Compact editor affordance rendered above the message body, for example media attachment. */
  bodyTopAction?: ReactNode;
  buttonEditor?: ReactNode;
  /** Content rendered on the chat wallpaper after the bubble, for example an editable carousel strip. */
  bubbleTrailingContent?: ReactNode;
  editorTray?: ReactNode;
  fitContent?: boolean;
  /**
   * Canvas-node embedding: drop the nested phone bezel so wallpaper meets the
   * ScenarioNodeCard edge. Handles stay paintable (`overflow-visible`).
   */
  embedded?: boolean;
  previewClassName?: string;
  /** start/center: incoming-style stack; end: align stack to the end of the available width. */
  align?: "center" | "start" | "end";
  className?: string;
};

export function WhatsAppActionRenderer({
  headerText,
  onHeaderTextChange,
  headerPlaceholder,
  headerError,
  headerMediaFormat,
  headerMediaUrl,
  headerMediaEditor,
  mediaLoading = "lazy",
  showVideoControls = true,
  videoPreload = "metadata",
  bodyText,
  onBodyTextChange,
  onBodyTextCommit,
  onBodyInsertApiChange,
  bodyPlaceholder,
  bodyError,
  bodyOutputFormat = "whatsapp",
  footerText,
  onFooterTextChange,
  footerPlaceholder,
  footerError,
  footerOutputFormat = "whatsapp",
  buttons = [],
  buttonLabelPlaceholder,
  ctaText,
  onCtaTextChange,
  ctaPlaceholder = "Open",
  ctaFallbackLabel,
  statusBarAction,
  appBarContent,
  bodyTopAction,
  buttonEditor,
  bubbleTrailingContent,
  editorTray,
  fitContent = false,
  embedded = false,
  surface = "phone",
  previewClassName,
  align = "center",
  className,
}: WhatsAppActionRendererProps) {
  const t = useTranslations("Scenarios");
  const buttonLabelPlaceholderText =
    buttonLabelPlaceholder ?? t("whatsappTemplateButtonLabelPlaceholder");
  const ctaFallbackText = ctaFallbackLabel ?? t("actionCtaFlowPlaceholder");
  const resolveTokenLabel = createScenarioTokenLabelResolver(key => t(key));
  const hasButtonSection = buttons.length > 0 || Boolean(buttonEditor);
  const mediaPlaceholder = headerMediaFormat
    ? HEADER_MEDIA_PLACEHOLDER[headerMediaFormat]
    : undefined;
  const hasMediaHeader = Boolean(mediaPlaceholder);
  const MediaPlaceholderIcon = mediaPlaceholder?.icon;
  const mediaPlaceholderContent =
    mediaPlaceholder && MediaPlaceholderIcon ? (
      <>
        <MediaPlaceholderIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t(mediaPlaceholder.labelKey)}</span>
      </>
    ) : null;
  const messageEditorLabel = t("scenarioMessageEditorLabel");

  return (
    <div
      data-testid="whatsapp-action-renderer"
      className={cn(
        "flex w-full cursor-auto flex-row-reverse",
        align === "start" && "justify-start",
        align === "end" && "justify-end",
        align === "center" && "justify-center",
        fitContent && (align === "center" ? "items-center" : "items-start"),
        className
      )}
    >
      <div
        className={cn(
          "mx-auto w-full space-y-2",
          !fitContent && "h-full",
          /** Cancel default `mx-auto` so a wider parent can pin the phone with the outer `justify-end`. */
          align === "end" && "!mx-0 ms-auto",
          previewClassName
        )}
      >
        <div
          data-testid={
            surface === "phone" ? "whatsapp-action-phone" : undefined
          }
          className={cn(
            "flex min-h-0 flex-col overflow-visible",
            surface === "phone" &&
              (embedded
                ? "rounded-none border-0 bg-transparent shadow-none"
                : "rounded-2xl border border-black/[0.08] bg-white shadow-none dark:border-white/10 dark:bg-[#0b141a]"),
            !fitContent && "h-full"
          )}
        >
          {surface === "phone" && (
            <>
              <div className="flex items-center justify-between bg-[#075e54] px-3 py-1.5">
                <span className="text-xs font-medium text-white/90">9:41</span>
                <div className="flex items-center gap-1">
                  {statusBarAction ?? (
                    <span className="text-[11px] text-white/70">...</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 bg-[#075e54] px-3 pb-2">
                <div className="h-6 w-6 rounded-full bg-white/20" />
                <div className="min-w-0 flex-1">
                  {appBarContent ?? (
                    <span className="text-[13px] font-medium text-white">
                      WhatsApp
                    </span>
                  )}
                </div>
              </div>
            </>
          )}
          <div
            data-testid="whatsapp-action-message-area"
            className={cn(
              surface === "phone" && "px-2 py-2",
              fitContent
                ? "overflow-visible"
                : "min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
            )}
            style={
              surface === "phone"
                ? { backgroundColor: WA.wallpaper }
                : undefined
            }
          >
            <div
              className={cn(
                "flex w-full flex-col gap-2.5",
                align === "end" && "items-end",
                !fitContent && "min-h-full"
              )}
            >
              <div
                className={cn(
                  // Interactive WhatsApp bubbles span the chat column; avoid
                  // shrink-to-content so the editor matches the phone preview.
                  "relative w-[95%] max-w-[95%] overflow-visible",
                  align === "end" ? "self-end" : "self-start"
                )}
                style={{ boxShadow: WA.bubbleShadow, borderRadius: 8 }}
              >
                {align === "end" ? (
                  <div
                    className="absolute -right-0.5 top-3 -z-0 h-2.5 w-2.5 rotate-45 rounded-[1px] bg-[#fff] dark:bg-[#1f2c33]"
                    style={{ boxShadow: "0.5px 0.5px 0 rgba(0,0,0,0.12)" }}
                    aria-hidden
                  />
                ) : (
                  <div
                    className="absolute -left-0.5 top-3 -z-0 h-2.5 w-2.5 rotate-45 rounded-[1px] bg-[#fff] dark:bg-[#1f2c33]"
                    style={{ boxShadow: "-0.5px 0.5px 0 rgba(0,0,0,0.12)" }}
                    aria-hidden
                  />
                )}
                <div className="relative z-[1] overflow-visible rounded-lg bg-white dark:bg-[#1f2c33]">
                  <div className="space-y-1.5 px-3 pb-0 pt-2.5">
                    {bodyTopAction ? (
                      <div className="w-full">{bodyTopAction}</div>
                    ) : null}
                    {/* WhatsApp sets a text header in bold, a step above the
                        body, and shows its characters as typed: headers take
                        no *bold* or _italic_ markup. */}
                    {!hasMediaHeader && onHeaderTextChange ? (
                      <WhatsAppInlineEditor
                        value={headerText ?? ""}
                        onChange={onHeaderTextChange}
                        placeholder={headerPlaceholder}
                        ariaLabel={headerPlaceholder || messageEditorLabel}
                        outputFormat="whatsapp"
                        error={headerError}
                        className="text-[13.5px] font-bold leading-snug text-[#111b21] dark:text-[#e9edef] [&_.ProseMirror]:text-[#111b21] dark:[&_.ProseMirror]:text-[#e9edef]"
                      />
                    ) : !hasMediaHeader && headerText ? (
                      <p
                        data-testid="whatsapp-header-text"
                        className="whitespace-pre-wrap break-words text-[13.5px] font-bold leading-snug text-[#111b21] dark:text-[#e9edef]"
                      >
                        {headerText}
                      </p>
                    ) : null}

                    {hasMediaHeader && headerMediaEditor ? (
                      headerMediaEditor
                    ) : hasMediaHeader ? (
                      <WhatsAppHeaderMediaPreview
                        url={headerMediaUrl}
                        format={headerMediaFormat}
                        placeholderContent={mediaPlaceholderContent}
                        mediaLoading={mediaLoading}
                        showVideoControls={showVideoControls}
                        videoPreload={videoPreload}
                      />
                    ) : null}

                    {onBodyTextChange ? (
                      <div data-sm-field="body">
                        <WhatsAppInlineEditor
                          value={bodyText}
                          onChange={onBodyTextChange}
                          onBlur={onBodyTextCommit}
                          onInsertApiChange={onBodyInsertApiChange}
                          resolveVariableLabel={resolveTokenLabel}
                          placeholder={bodyPlaceholder}
                          ariaLabel={messageEditorLabel}
                          outputFormat={bodyOutputFormat}
                          error={bodyError}
                          className={cn(
                            "text-[12.4px] leading-[1.45] text-[#111b21] dark:text-[#e9edef] [&_.ProseMirror]:text-[#111b21] dark:[&_.ProseMirror]:text-[#e9edef]",
                            bodyError && "rounded-sm ring-1 ring-destructive/70"
                          )}
                          multiline
                        />
                      </div>
                    ) : (
                      <WhatsAppFormattedText
                        text={bodyText || bodyPlaceholder || ""}
                        testId="whatsapp-formatted-body"
                        className="whitespace-pre-wrap break-words text-[12.4px] leading-[1.45] text-[#111b21] dark:text-[#e9edef]"
                      />
                    )}

                    {onFooterTextChange ? (
                      <WhatsAppInlineEditor
                        value={footerText ?? ""}
                        onChange={onFooterTextChange}
                        placeholder={footerPlaceholder}
                        ariaLabel={footerPlaceholder || messageEditorLabel}
                        outputFormat={footerOutputFormat}
                        error={footerError}
                        className="text-[12px] leading-snug text-[#667781] dark:text-[#8696a0] [&_.ProseMirror]:text-[#667781] dark:[&_.ProseMirror]:text-[#8696a0]"
                        multiline
                      />
                    ) : footerText ? (
                      <WhatsAppFormattedText
                        text={footerText}
                        testId="whatsapp-formatted-footer"
                        className="whitespace-pre-wrap break-words text-[12px] leading-snug text-[#667781] dark:text-[#8696a0]"
                      />
                    ) : null}
                  </div>

                  {hasButtonSection ? (
                    <div
                      className="bg-white dark:bg-[#1f2c33]"
                      style={{ borderTop: `1px solid ${WA.divider}` }}
                    >
                      {buttons.map((button, index) => {
                        const key = button.key || `${button.type}-${index}`;
                        const isLabelEditable =
                          typeof button.onLabelChange === "function";
                        const clickable =
                          typeof button.onClick === "function" &&
                          !isLabelEditable;
                        const Icon = getButtonTypeIcon(button.type);
                        const isFlowRow = button.type === "flow";
                        const isFirst = index === 0;
                        const labelCharWidth = Math.max(
                          10,
                          Math.min(36, (button.label || "").length + 3)
                        );
                        const rowSlot = button.rowActions;
                        const flowLeadingAction =
                          isFlowRow && isLabelEditable
                            ? button.leadingAction
                            : null;
                        const buttonClassName = cn(
                          "flex w-full min-w-0 items-stretch px-3 py-2.5 text-center text-[15px] font-normal leading-tight",
                          !isFlowRow && "gap-2",
                          isFlowRow && "gap-0",
                          !rowSlot && "items-center justify-center",
                          rowSlot && "items-stretch",
                          waActionButton.text,
                          "transition-[background-color] duration-75",
                          !isLabelEditable && "focus-visible:outline-none",
                          !isLabelEditable && waActionButton.focusRing,
                          isLabelEditable && "cursor-text",
                          !isFirst && "border-t",
                          "border-[rgba(11,20,26,0.12)] dark:border-white/10",
                          clickable &&
                            "hover:bg-black/[0.02] active:bg-black/[0.04] dark:hover:bg-white/[0.04] dark:active:bg-white/[0.06]",
                          isLabelEditable &&
                            "hover:bg-black/[0.02] dark:hover:bg-white/[0.04]",
                          button.disabled && "cursor-not-allowed opacity-50"
                        );

                        const buttonContent = isLabelEditable ? (
                          isFlowRow ? (
                            <div className="inline-flex max-w-full items-center justify-center gap-1.5">
                              {button.isLoading ? (
                                <Loader2
                                  className={cn(
                                    "h-4 w-4 shrink-0 animate-spin",
                                    waActionButton.icon
                                  )}
                                />
                              ) : null}
                              {!button.isLoading
                                ? (flowLeadingAction ?? (
                                    <Icon
                                      className={cn(
                                        "pointer-events-none h-4 w-4 shrink-0",
                                        waActionButton.icon
                                      )}
                                      strokeWidth={1.5}
                                      aria-hidden
                                    />
                                  ))
                                : null}
                              {!button.isLoading ? (
                                <input
                                  type="text"
                                  name={`wa-template-button-label-${key}`}
                                  value={button.label}
                                  onChange={event =>
                                    button.onLabelChange?.(event.target.value)
                                  }
                                  placeholder={buttonLabelPlaceholderText}
                                  size={labelCharWidth}
                                  className={cn(
                                    "nodrag w-auto min-w-0 max-w-full shrink cursor-text bg-transparent text-center text-[15px] font-normal outline-none ring-0 placeholder:text-[#1b8755]/45 focus:ring-0",
                                    waActionButton.text
                                  )}
                                  onPointerDown={event =>
                                    event.stopPropagation()
                                  }
                                  onClick={event => event.stopPropagation()}
                                  onKeyDown={event => {
                                    event.stopPropagation();
                                  }}
                                  onBlur={button.onLabelCommit}
                                  spellCheck={false}
                                  autoComplete="off"
                                  aria-label={buttonLabelPlaceholderText}
                                />
                              ) : null}
                            </div>
                          ) : (
                            <>
                              {button.isLoading ? (
                                <Loader2
                                  className={cn(
                                    "h-4 w-4 shrink-0 animate-spin",
                                    waActionButton.icon
                                  )}
                                />
                              ) : (
                                <Icon
                                  className={cn(
                                    "h-4 w-4 shrink-0",
                                    waActionButton.icon
                                  )}
                                  strokeWidth={2}
                                  aria-hidden
                                />
                              )}
                              <input
                                type="text"
                                name={`wa-template-button-label-${key}`}
                                value={button.label}
                                onChange={event =>
                                  button.onLabelChange?.(event.target.value)
                                }
                                placeholder={buttonLabelPlaceholderText}
                                className={cn(
                                  "nodrag min-w-0 flex-1 cursor-text bg-transparent text-center text-[15px] font-normal outline-none ring-0 placeholder:text-[#1b8755]/45 focus:ring-0",
                                  waActionButton.text,
                                  button.error && "text-destructive"
                                )}
                                onPointerDown={event => event.stopPropagation()}
                                onClick={event => event.stopPropagation()}
                                onKeyDown={event => {
                                  event.stopPropagation();
                                }}
                                onBlur={button.onLabelCommit}
                                spellCheck={false}
                                autoComplete="off"
                                aria-label={buttonLabelPlaceholderText}
                              />
                            </>
                          )
                        ) : isFlowRow ? (
                          <div className="inline-flex max-w-full items-center justify-center gap-1.5">
                            {button.isLoading ? (
                              <Loader2
                                className={cn(
                                  "h-4 w-4 shrink-0 animate-spin",
                                  waActionButton.icon
                                )}
                              />
                            ) : null}
                            {!button.isLoading ? (
                              <>
                                <Icon
                                  className={cn(
                                    "h-4 w-4 shrink-0",
                                    waActionButton.icon
                                  )}
                                  strokeWidth={1.5}
                                  aria-hidden
                                />
                                <span className="min-w-0 truncate text-center font-normal">
                                  {button.label}
                                </span>
                              </>
                            ) : null}
                          </div>
                        ) : (
                          <>
                            {button.isLoading ? (
                              <Loader2
                                className={cn(
                                  "h-4 w-4 shrink-0 animate-spin",
                                  waActionButton.icon
                                )}
                              />
                            ) : (
                              <Icon
                                className={cn(
                                  "h-4 w-4 shrink-0",
                                  waActionButton.icon
                                )}
                                strokeWidth={2}
                                aria-hidden
                              />
                            )}
                            <span className="min-w-0 truncate font-normal">
                              {button.label}
                            </span>
                          </>
                        );

                        const buttonMain = rowSlot ? (
                          <div className="flex w-full min-w-0 items-stretch">
                            <div className="flex min-w-0 flex-1 items-center justify-center">
                              {buttonContent}
                            </div>
                            <div
                              className="w-px shrink-0 self-stretch bg-[rgba(11,20,26,0.12)] dark:bg-white/10"
                              aria-hidden
                            />
                            <div className="inline-flex shrink-0 items-center gap-0.5 ps-0.5">
                              {rowSlot}
                            </div>
                          </div>
                        ) : (
                          buttonContent
                        );

                        return (
                          <div
                            key={key}
                            data-sm-field={button.fieldKey || undefined}
                            className="relative w-full min-w-0 overflow-visible"
                          >
                            {clickable ? (
                              <button
                                type="button"
                                className={cn(
                                  buttonClassName,
                                  button.error && "bg-destructive/[0.04]"
                                )}
                                onClick={button.onClick}
                                disabled={button.disabled}
                              >
                                {buttonMain}
                              </button>
                            ) : (
                              <div
                                className={cn(
                                  buttonClassName,
                                  button.error && "bg-destructive/[0.04]"
                                )}
                                onPointerDown={e => {
                                  if (isLabelEditable) e.stopPropagation();
                                }}
                              >
                                {buttonMain}
                              </div>
                            )}
                            {button.error ? (
                              <p className="px-3 pb-1.5 text-[10px] leading-snug text-destructive">
                                {button.error}
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                      {buttonEditor ? (
                        <div
                          data-testid="whatsapp-action-button-editor"
                          className="w-full min-w-0 pt-1.5"
                        >
                          {buttonEditor}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {bubbleTrailingContent ? (
                <div
                  data-testid="whatsapp-bubble-trailing-content"
                  className="mt-1 w-full min-w-0 overflow-visible"
                >
                  {bubbleTrailingContent}
                </div>
              ) : null}

              {ctaText !== undefined || onCtaTextChange ? (
                <div
                  className={cn(
                    "flex w-full px-1",
                    align === "end" ? "justify-end" : "justify-center"
                  )}
                >
                  {onCtaTextChange ? (
                    <WhatsAppInlineEditor
                      value={ctaText ?? ""}
                      onChange={onCtaTextChange}
                      placeholder={ctaPlaceholder}
                      ariaLabel={ctaPlaceholder}
                      outputFormat="plain_text"
                      className={cn(
                        "min-w-16 text-center",
                        waActionButton.inlineEditText
                      )}
                      multiline={false}
                    />
                  ) : (
                    <span
                      className={cn(
                        "text-[15px] font-normal",
                        waActionButton.text
                      )}
                    >
                      {(ctaText || "").trim() || ctaFallbackText}
                    </span>
                  )}
                </div>
              ) : null}

              {editorTray ? (
                <div
                  data-testid="whatsapp-action-editor-tray"
                  className="mt-0.5 rounded-xl bg-zinc-200/80 p-1 dark:bg-zinc-800/90"
                >
                  {editorTray}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
