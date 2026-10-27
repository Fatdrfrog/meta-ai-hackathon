"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CreativeAssetPickerDialog } from "@/components/assets/creative-asset-picker-dialog";
import type { CreativeAsset } from "@/components/assets/creative-assets-workspace";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { MentionTextarea } from "@/components/composer/mention-textarea";
import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { MetaAdsMcpConnectButton } from "@/components/integrations/meta-ads-mcp-connect-button";
import { buildIntegrationSelectionUrl } from "@/components/integrations/integration-selection-url";
import { panelSettingsHref } from "@/features/panel/shared/routing/hrefs";
import { getIntegrationById } from "@/components/integrations/integration-registry";
import {
  buildAiriChatMetaSkillRef,
  buildAiriChatSourceOptionId,
  type AiriChatSourceOption,
  type AiriChatSourceRef,
} from "@/lib/airi-chats/source-types";
import {
  afterNextPaint,
  filterMentionsStillInText,
  getActiveMention,
  mentionTokenFromLabel,
  replaceActiveMention,
  type ActiveMention,
} from "@/lib/composer/mention";
import { cn } from "@/lib/utils";
import { useCommandState } from "cmdk";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  ArrowLeft,
  Database,
  FileUp,
  ImageIcon,
  Loader2,
  Megaphone,
  MessageSquare,
  Paperclip,
  Plug,
  Plus,
  SendHorizonal,
  Square,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";

type AiriChatComposerProps = {
  workspaceId: string;
  disabled?: boolean;
  /** Keeps typing available but holds sending (e.g. while history loads). */
  sendDisabled?: boolean;
  autoFocus?: boolean;
  variant?: "dock" | "hero" | "compact";
  placeholder?: string;
  prefetchedSourceOptions?: AiriChatSourceOption[];
  isLoadingPrefetchedSources?: boolean;
  prefetchedSourceError?: string | null;
  className?: string;
  onSourcesRefresh?: () => void;
  onSend: (
    content: string,
    selectedSources: AiriChatSourceRef[],
    attachedFiles: File[],
    attachedCreativeAssets?: CreativeAsset[]
  ) => Promise<boolean> | boolean;
  /** An answer is running: Send becomes Stop (when `onStop` is given). */
  running?: boolean;
  /** Stop was pressed and the server has not finished stopping yet. */
  stopping?: boolean;
  onStop?: () => void;
};

type SelectableAiriChatSourceOption = Extract<
  AiriChatSourceOption,
  { ref: AiriChatSourceRef }
>;

const COMPOSER_TEXTAREA_MIN_HEIGHT = 40;
const COMPOSER_TEXTAREA_MAX_HEIGHT = 144;
const MAX_ATTACHED_FILES = 8;
const CHAT_MENTION_SEARCH_DEBOUNCE_MS = 250;

// cmdk owns the generated list/option IDs. Connect its real selection to the
// external multiline input, which keeps focus while the portalled list is open.
type SourcePickerAria = { controls?: string; activeDescendant?: string };

function SourcePickerAccessibility({
  commandRef,
  onChange,
}: {
  commandRef: RefObject<HTMLDivElement | null>;
  onChange: (value: SourcePickerAria) => void;
}) {
  const selectedValue = useCommandState(state => state.value);
  useEffect(() => {
    const list = commandRef.current?.querySelector("[cmdk-list]");
    const selected = list?.querySelector('[aria-selected="true"]');
    onChange({ controls: list?.id, activeDescendant: selected?.id });
    return () => onChange({});
  }, [commandRef, selectedValue, onChange]);
  return null;
}

function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function isSelectableSourceOption(
  option: AiriChatSourceOption
): option is SelectableAiriChatSourceOption {
  return "ref" in option;
}

function fileIdentity(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function mergeAttachedFiles(current: File[], incoming: File[], limit: number) {
  const byIdentity = new Map(current.map(file => [fileIdentity(file), file]));
  for (const file of incoming) {
    byIdentity.set(fileIdentity(file), file);
  }
  return Array.from(byIdentity.values()).slice(0, Math.max(0, limit));
}

function sourceMentionToken(ref: AiriChatSourceRef): string {
  return mentionTokenFromLabel(ref.label);
}

function integrationIdForSource(ref: AiriChatSourceRef): string | null {
  if (ref.kind === "connector") {
    return ref.connector;
  }
  if (ref.kind === "workspace_source" || ref.kind === "channel_source") {
    return String(ref.sourceType || "");
  }
  if (ref.kind === "skill" && ref.skillId === "meta") {
    return "meta_ads";
  }
  return null;
}

function SourceMentionInlineIcon({
  source,
  className,
}: {
  source: AiriChatSourceRef;
  className: string;
}) {
  const integrationId = integrationIdForSource(source);
  if (integrationId) {
    const integration = getIntegrationById(integrationId);
    if (integration) {
      if (integration.icon.light === integration.icon.dark) {
        return (
          <IntegrationIcon
            integration={integration}
            alt=""
            className={className}
          />
        );
      }

      return (
        <>
          <IntegrationIcon
            integration={integration}
            alt=""
            className={cn(className, "dark:hidden")}
          />
          <IntegrationIcon
            integration={integration}
            alt=""
            theme="dark"
            className={cn(className, "hidden dark:block")}
          />
        </>
      );
    }
  }

  if (source.kind === "chat_thread")
    return <MessageSquare className={className} />;

  return <Plug className={className} />;
}

function SourceOptionIcon({ option }: { option: AiriChatSourceOption }) {
  if (isSelectableSourceOption(option)) {
    return (
      <SourceMentionInlineIcon
        source={option.ref}
        className="mt-0.5 size-4 shrink-0"
      />
    );
  }
  return <MessageSquare className="mt-0.5 size-4 shrink-0" />;
}

function sourceOptionMatchesQuery(option: AiriChatSourceOption, query: string) {
  if (!query) return true;
  const ref = isSelectableSourceOption(option) ? option.ref : null;
  return [
    option.label,
    option.group,
    ref?.kind === "workspace_source" ? ref.sourceType : null,
    ref?.kind === "connector" ? ref.connector : null,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function renderInputWithSourceMentions(
  value: string,
  selectedSources: AiriChatSourceRef[]
) {
  if (!value) return null;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let partIndex = 0;
  const sourceTokens = selectedSources
    .map(source => ({ source, token: sourceMentionToken(source) }))
    .sort((a, b) => b.token.length - a.token.length);

  while (cursor < value.length) {
    let next: {
      source: AiriChatSourceRef;
      token: string;
      index: number;
    } | null = null;
    for (const item of sourceTokens) {
      const index = value.indexOf(item.token, cursor);
      if (index === -1) continue;
      if (!next || index < next.index) {
        next = { ...item, index };
      }
    }

    if (!next) {
      parts.push(
        <span key={`text-${partIndex++}`}>{value.slice(cursor)}</span>
      );
      break;
    }

    if (next.index > cursor) {
      parts.push(
        <span key={`text-${partIndex++}`}>
          {value.slice(cursor, next.index)}
        </span>
      );
    }
    parts.push(
      <span
        key={`source-${partIndex++}`}
        className="relative inline-block text-transparent align-baseline"
      >
        {next.token}
        <span className="absolute left-0 top-1/2 flex h-5 w-full -translate-y-1/2 items-center gap-0.5 overflow-hidden px-0.5 text-[12px] font-medium leading-none text-foreground">
          <SourceMentionInlineIcon
            source={next.source}
            className="size-3 shrink-0 object-contain"
          />
          <span className="min-w-0 truncate">{next.token.slice(1)}</span>
        </span>
      </span>
    );
    cursor = next.index + next.token.length;
  }

  return parts;
}

export function AiriChatComposer({
  workspaceId,
  disabled = false,
  sendDisabled = false,
  autoFocus = false,
  variant = "dock",
  placeholder: placeholderProp,
  prefetchedSourceOptions,
  isLoadingPrefetchedSources = false,
  prefetchedSourceError = null,
  className,
  onSourcesRefresh,
  onSend,
  running = false,
  stopping = false,
  onStop,
}: AiriChatComposerProps) {
  const chatT = useTranslations("AiriChat");
  const placeholder = placeholderProp ?? chatT("askAiri");
  const showStop = running && Boolean(onStop);
  const [input, setInput] = useState("");
  const [selectedSources, setSelectedSources] = useState<AiriChatSourceRef[]>(
    []
  );
  const [sourceOptions, setSourceOptions] = useState<AiriChatSourceOption[]>(
    []
  );
  const [chatOptions, setChatOptions] = useState<AiriChatSourceOption[]>([]);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [isLoadingSources, setIsLoadingSources] = useState(false);
  const [isLoadingChats, setIsLoadingChats] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"sources" | "chats">("sources");
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(
    null
  );
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [attachedCreativeAssets, setAttachedCreativeAssets] = useState<
    CreativeAsset[]
  >([]);
  const [creativeAssetPickerOpen, setCreativeAssetPickerOpen] = useState(false);
  const [highlightedSourceId, setHighlightedSourceId] = useState("");
  const [pickerAria, setPickerAria] = useState<SourcePickerAria>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submissionLockRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerBarRef = useRef<HTMLDivElement | null>(null);
  const commandRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputDisabled = disabled || isSubmitting;
  const showPicker = pickerOpen && !inputDisabled;
  const [previousInputDisabled, setPreviousInputDisabled] =
    useState(inputDisabled);
  if (previousInputDisabled !== inputDisabled) {
    setPreviousInputDisabled(inputDisabled);
    if (inputDisabled) {
      setPickerOpen(false);
      setActionMenuOpen(false);
      setCreativeAssetPickerOpen(false);
      setActiveMention(null);
    }
  }
  const canSubmit = Boolean(
    !sendDisabled && input.trim() && input.trim() !== "@"
  );
  const isCompact = variant === "compact";
  const textareaMinHeight = isCompact ? 32 : COMPOSER_TEXTAREA_MIN_HEIGHT;
  const textareaMaxHeight = isCompact ? 96 : COMPOSER_TEXTAREA_MAX_HEIGHT;

  const mentionQuery = activeMention?.query ?? "";
  const selectedSourceIds = useMemo(
    () =>
      new Set(
        selectedSources.map(source => buildAiriChatSourceOptionId(source))
      ),
    [selectedSources]
  );
  const hasPrefetchedSourceOptions = prefetchedSourceOptions !== undefined;

  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (hasPrefetchedSourceOptions) return;
    let cancelled = false;
    const loadingTimer = window.setTimeout(() => {
      if (cancelled) return;
      setIsLoadingSources(true);
      setSourceError(null);
    }, 0);

    const search = new URLSearchParams({
      q: "",
      limit: "100",
      mode: "sources",
    });

    void fetch(
      `/api/workspaces/${workspaceId}/airi-chats/sources?${search.toString()}`,
      { cache: "no-store" }
    )
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to load sources: ${response.status}`);
        }
        return readJson<{ sources: AiriChatSourceOption[] }>(response);
      })
      .then(payload => {
        if (cancelled) return;
        setSourceOptions(payload.sources || []);
      })
      .catch(error => {
        if (cancelled) return;
        setSourceError(
          error instanceof Error
            ? error.message
            : chatT("composer.sourcesFailed")
        );
        setSourceOptions([]);
      })
      .finally(() => {
        window.clearTimeout(loadingTimer);
        if (!cancelled) setIsLoadingSources(false);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(loadingTimer);
    };
  }, [chatT, hasPrefetchedSourceOptions, workspaceId]);

  useEffect(() => {
    if (pickerMode !== "chats" || (!pickerOpen && !actionMenuOpen)) return;

    const controller = new AbortController();
    const loadingTimer = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      setIsLoadingChats(true);
      setChatError(null);
    }, 0);

    const search = new URLSearchParams({
      q: mentionQuery,
      limit: "50",
      mode: "chats",
    });

    // Typing an @mention searches once the user pauses, and a newer query
    // aborts the older request instead of racing it.
    const searchTimer = window.setTimeout(
      () => {
        void fetch(
          `/api/workspaces/${workspaceId}/airi-chats/sources?${search.toString()}`,
          { cache: "no-store", signal: controller.signal }
        )
          .then(response => {
            if (!response.ok) {
              throw new Error(`Failed to load chats: ${response.status}`);
            }
            return readJson<{ sources: AiriChatSourceOption[] }>(response);
          })
          .then(payload => {
            if (controller.signal.aborted) return;
            setChatOptions(payload.sources || []);
          })
          .catch(error => {
            if (controller.signal.aborted) return;
            setChatError(
              error instanceof Error
                ? error.message
                : chatT("composer.chatsFailed")
            );
            setChatOptions([]);
          })
          .finally(() => {
            window.clearTimeout(loadingTimer);
            if (!controller.signal.aborted) setIsLoadingChats(false);
          });
      },
      mentionQuery ? CHAT_MENTION_SEARCH_DEBOUNCE_MS : 0
    );

    return () => {
      controller.abort();
      window.clearTimeout(loadingTimer);
      window.clearTimeout(searchTimer);
    };
  }, [
    actionMenuOpen,
    chatT,
    mentionQuery,
    pickerMode,
    pickerOpen,
    workspaceId,
  ]);

  const updateActiveMention = useCallback(
    (value: string, caret: number) => {
      if (inputDisabled) return;
      const mention = getActiveMention(value, caret);
      setActiveMention(mention);
      setHighlightedSourceId("");
      if (mention) {
        if (!pickerOpen || mention.start !== activeMention?.start)
          setPickerMode("sources");
        setPickerOpen(true);
      } else setPickerOpen(false);
    },
    [activeMention?.start, inputDisabled, pickerOpen]
  );

  const selectOption = useCallback(
    (option: AiriChatSourceOption) => {
      if (inputDisabled) return;
      if (option.type === "action") {
        if (option.action === "choose_chats") {
          setPickerMode("chats");
          setHighlightedSourceId("");
          if (!actionMenuOpen) setPickerOpen(true);
        }
        return;
      }
      if (option.disabled || !isSelectableSourceOption(option)) return;

      const sourceId = buildAiriChatSourceOptionId(option.ref);
      setSelectedSources(current =>
        current.some(source => buildAiriChatSourceOptionId(source) === sourceId)
          ? current
          : [...current, option.ref].slice(0, 12)
      );

      const token = sourceMentionToken(option.ref);
      const replaced = replaceActiveMention({
        value: input,
        mention: activeMention,
        token,
      });
      setInput(replaced.value);
      afterNextPaint(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(replaced.caret, replaced.caret);
      });

      setActiveMention(null);
      setPickerOpen(false);
      setActionMenuOpen(false);
    },
    [actionMenuOpen, activeMention, input, inputDisabled]
  );

  const syncInput = useCallback(
    (target: HTMLTextAreaElement) => {
      const value = target.value;
      setInput(value);
      setSelectedSources(current =>
        filterMentionsStillInText({
          value,
          items: current,
          getToken: sourceMentionToken,
        })
      );
      updateActiveMention(value, target.selectionStart ?? value.length);
    },
    [updateActiveMention]
  );

  const handleCaretChange = useCallback(
    (
      event:
        | ReactMouseEvent<HTMLTextAreaElement>
        | ReactKeyboardEvent<HTMLTextAreaElement>
    ) => {
      if (inputDisabled) return;
      if (
        "key" in event &&
        ["Escape", "Enter", "Tab", "ArrowUp", "ArrowDown"].includes(event.key)
      )
        return;
      const target = event.currentTarget;
      updateActiveMention(
        target.value,
        target.selectionStart ?? target.value.length
      );
    },
    [inputDisabled, updateActiveMention]
  );

  const submit = useCallback(async () => {
    const content = (textareaRef.current?.value ?? input).trim();
    if (
      !content ||
      content === "@" ||
      disabled ||
      sendDisabled ||
      submissionLockRef.current
    )
      return;
    submissionLockRef.current = true;
    setIsSubmitting(true);
    setPickerOpen(false);
    setActionMenuOpen(false);
    setActiveMention(null);
    try {
      const sent =
        attachedCreativeAssets.length > 0
          ? await onSend(
              content,
              selectedSources,
              attachedFiles,
              attachedCreativeAssets
            )
          : await onSend(content, selectedSources, attachedFiles);
      if (sent) {
        setInput("");
        setSelectedSources([]);
        setAttachedFiles([]);
        setAttachedCreativeAssets([]);
        setActiveMention(null);
        setPickerOpen(false);
        setActionMenuOpen(false);
        setPickerMode("sources");
      }
    } catch {
      toast.error(
        "Could not send your message. Your draft is saved. Try again."
      );
    } finally {
      submissionLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    attachedCreativeAssets,
    attachedFiles,
    disabled,
    input,
    onSend,
    selectedSources,
    sendDisabled,
  ]);

  const selectCreativeAsset = useCallback(
    (asset: CreativeAsset) => {
      if (inputDisabled) return;
      if (asset.kind !== "image" && asset.kind !== "video") return;
      if (
        attachedFiles.length + attachedCreativeAssets.length >=
        MAX_ATTACHED_FILES
      ) {
        toast.error(
          `Attach up to ${MAX_ATTACHED_FILES} files or Creative Assets`
        );
        return;
      }
      setAttachedCreativeAssets(current =>
        current.some(item => item.id === asset.id)
          ? current
          : [...current, asset]
      );
      setCreativeAssetPickerOpen(false);
    },
    [attachedCreativeAssets.length, attachedFiles.length, inputDisabled]
  );

  const metaT = useTranslations("AiriMetaAds");
  const sourceOptionsForPicker = useMemo(
    () =>
      (prefetchedSourceOptions ?? sourceOptions).map(option =>
        option.type !== "action" && option.metaAdsMcp
          ? {
              ...option,
              description: metaT(
                `skill.description.${option.metaAdsMcp.descriptionKey}`
              ),
            }
          : option
      ),
    [metaT, prefetchedSourceOptions, sourceOptions]
  );
  const sourceLoadingForPicker = hasPrefetchedSourceOptions
    ? isLoadingPrefetchedSources
    : isLoadingSources;
  const sourceErrorForPicker = hasPrefetchedSourceOptions
    ? prefetchedSourceError
    : sourceError;

  const metaSkillConnectHint = useMemo(() => {
    if (sourceLoadingForPicker) return null;
    const metaOptionId = buildAiriChatSourceOptionId(
      buildAiriChatMetaSkillRef()
    );
    const metaOption = sourceOptionsForPicker.find(
      option => option.id === metaOptionId
    );
    if (!metaOption || !metaOption.disabled) return null;
    const capability =
      metaOption.type !== "action" ? metaOption.metaAdsMcp : undefined;
    // An older catalog has no recovery evidence; direct users to the canonical
    // connection screen rather than inferring authorization from prose.
    const recovery = capability?.recovery ?? "settings";
    return {
      label: metaT(`skill.recovery.${recovery}`),
      authorize:
        recovery === "connect" ||
        recovery === "authorize" ||
        recovery === "reconnect",
      allowCreateGraphSource: recovery === "connect",
      href: buildIntegrationSelectionUrl({
        pathname: panelSettingsHref(workspaceId),
        currentSearch: "",
        integrationId: "meta_ads",
      }).href,
    };
  }, [metaT, sourceLoadingForPicker, sourceOptionsForPicker, workspaceId]);

  const activeSourceOptions = useMemo(() => {
    if (pickerMode === "chats") return chatOptions;
    const query = mentionQuery.trim().toLowerCase();
    return sourceOptionsForPicker.filter(option =>
      sourceOptionMatchesQuery(option, query)
    );
  }, [chatOptions, mentionQuery, pickerMode, sourceOptionsForPicker]);

  const activeLoading =
    pickerMode === "chats" ? isLoadingChats : sourceLoadingForPicker;
  const activeError = pickerMode === "chats" ? chatError : sourceErrorForPicker;

  const selectableOptions = useMemo(
    () =>
      activeLoading || activeError
        ? []
        : activeSourceOptions.filter(
            option => !option.disabled && !selectedSourceIds.has(option.id)
          ),
    [activeError, activeLoading, activeSourceOptions, selectedSourceIds]
  );
  const highlightedIndex = Math.max(
    0,
    selectableOptions.findIndex(option => option.id === highlightedSourceId)
  );
  const highlightedOption = selectableOptions[highlightedIndex];

  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (showPicker) {
      if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        selectableOptions.length > 0
      ) {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next =
          selectableOptions[
            (highlightedIndex + delta + selectableOptions.length) %
              selectableOptions.length
          ];
        if (next) setHighlightedSourceId(next.id);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && highlightedOption) {
        event.preventDefault();
        selectOption(highlightedOption);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && activeLoading) {
        // Matches for the @mention are still loading: wait for them rather
        // than sending the raw "@query" as the message.
        event.preventDefault();
        return;
      }
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
        setPickerOpen(false);
        setActiveMention(null);
        setPickerMode("sources");
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const groupedOptions = useMemo(() => {
    const groups = new Map<string, AiriChatSourceOption[]>();
    for (const option of activeSourceOptions) {
      const items = groups.get(option.group) || [];
      items.push(option);
      groups.set(option.group, items);
    }
    return Array.from(groups.entries());
  }, [activeSourceOptions]);

  const sourceCommandList = (
    <Command
      ref={commandRef}
      className="max-h-[var(--radix-popover-content-available-height,24rem)]"
      shouldFilter={false}
      value={highlightedOption?.id ?? ""}
      onValueChange={setHighlightedSourceId}
    >
      {showPicker ? (
        <SourcePickerAccessibility
          commandRef={commandRef}
          onChange={setPickerAria}
        />
      ) : null}
      {pickerMode === "chats" ? (
        <div className="flex shrink-0 items-center gap-2 px-2 py-2">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={chatT("composer.backToSources")}
            onClick={() => setPickerMode("sources")}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="text-xs font-medium text-muted-foreground">
            {chatT("composer.chooseFromChats")}
          </span>
        </div>
      ) : null}
      <CommandList
        label={chatT("composer.pickerLabel")}
        className="min-h-0 max-h-80 flex-1 overscroll-contain"
      >
        {activeLoading ? (
          <output
            aria-label={chatT("composer.loadingSources")}
            className="block space-y-2 px-3 py-3"
          >
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-5 w-2/3" />
          </output>
        ) : null}
        {activeError ? (
          <div role="alert" className="px-3 py-4 text-sm text-destructive">
            {activeError}
          </div>
        ) : null}
        {!activeLoading && !activeError ? (
          groupedOptions.length > 0 ? (
            groupedOptions.map(([group, options]) => (
              <CommandGroup key={group} heading={group}>
                {options.map(option => {
                  const selectable = isSelectableSourceOption(option);
                  const selected =
                    selectable && selectedSourceIds.has(option.id);
                  return (
                    <CommandItem
                      key={option.id}
                      disabled={option.disabled || selected}
                      value={option.id}
                      onSelect={() => selectOption(option)}
                      className={cn(
                        "items-start gap-3 py-2.5",
                        selected && "opacity-60"
                      )}
                    >
                      <SourceOptionIcon option={option} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">
                            {option.label}
                          </span>
                          {typeof option.count === "number" ? (
                            <span className="text-xs text-muted-foreground">
                              {option.count}
                            </span>
                          ) : null}
                        </span>
                        <span className="block whitespace-normal break-words text-xs text-muted-foreground">
                          {selected
                            ? chatT("composer.alreadySelected")
                            : option.description}
                        </span>
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))
          ) : (
            <CommandEmpty>
              {pickerMode === "chats"
                ? chatT("composer.noChatsFound")
                : chatT("composer.noSourcesFound")}
            </CommandEmpty>
          )
        ) : null}
      </CommandList>
    </Command>
  );

  return (
    <form
      data-testid="airi-chat-composer"
      data-airi-composer-variant={variant}
      className={cn(
        "min-w-0 shrink-0",
        variant === "dock"
          ? "px-4 py-3 shadow-[0_-12px_28px_-28px_rgba(15,23,42,0.55)]"
          : "w-full",
        className
      )}
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <div
        className={cn(
          "relative mx-auto w-full min-w-0 max-w-3xl text-left",
          isCompact ? "space-y-1.5" : "space-y-2",
          variant === "hero" &&
            "rounded-[1.65rem] bg-background/96 p-2 shadow-[0_18px_60px_-42px_rgba(15,23,42,0.65)]"
        )}
      >
        {attachedFiles.length > 0 || attachedCreativeAssets.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {attachedFiles.map(file => (
              <Badge
                key={fileIdentity(file)}
                variant="outline"
                className="max-w-full gap-1 rounded-full py-1"
              >
                <Paperclip className="size-3" />
                <span className="max-w-48 truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  disabled={inputDisabled}
                  className="rounded-full p-0.5 hover:bg-background/80"
                  onClick={() =>
                    setAttachedFiles(current =>
                      current.filter(
                        item => fileIdentity(item) !== fileIdentity(file)
                      )
                    )
                  }
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            {attachedCreativeAssets.map(asset => (
              <Badge
                key={asset.id}
                variant="outline"
                className="max-w-full gap-1 rounded-full py-1"
              >
                <ImageIcon className="size-3" />
                <span className="max-w-48 truncate">
                  {asset.fileName || asset.prompt || `${asset.kind} asset`}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${asset.fileName || asset.kind}`}
                  disabled={inputDisabled}
                  className="rounded-full p-0.5 hover:bg-background/80"
                  onClick={() =>
                    setAttachedCreativeAssets(current =>
                      current.filter(item => item.id !== asset.id)
                    )
                  }
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          disabled={inputDisabled}
          multiple
          accept="image/*,.pdf,.doc,.docx,.txt,.csv,.xlsx"
          className="hidden"
          onChange={event => {
            const files = Array.from(event.currentTarget.files || []);
            if (files.length > 0) {
              setAttachedFiles(current =>
                mergeAttachedFiles(
                  current,
                  files,
                  MAX_ATTACHED_FILES - attachedCreativeAssets.length
                )
              );
            }
            event.currentTarget.value = "";
          }}
        />

        {creativeAssetPickerOpen && !inputDisabled ? (
          <CreativeAssetPickerDialog
            workspaceId={workspaceId}
            open
            onOpenChange={setCreativeAssetPickerOpen}
            selectedUrls={attachedCreativeAssets.flatMap(asset =>
              asset.url ? [asset.url] : []
            )}
            assetFilter={asset =>
              asset.kind === "image" || asset.kind === "video"
            }
            onSelect={selectCreativeAsset}
          />
        ) : null}

        <Popover open={showPicker} onOpenChange={setPickerOpen}>
          <PopoverAnchor asChild>
            <div
              ref={composerBarRef}
              className={cn(
                "flex min-w-0 items-center bg-muted/60 shadow-[0_16px_46px_-38px_rgba(15,23,42,0.85)]",
                isCompact
                  ? "gap-1 rounded-xl p-1"
                  : "gap-2 rounded-[1.45rem] p-1.5"
              )}
            >
              <DropdownMenu
                open={actionMenuOpen && !inputDisabled}
                onOpenChange={open => {
                  setActionMenuOpen(open);
                  if (open) {
                    setActiveMention(null);
                    setPickerOpen(false);
                    setPickerMode("sources");
                  }
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={inputDisabled}
                    aria-label={chatT("composer.openTools")}
                    className={cn(
                      "grid shrink-0 place-items-center rounded-full",
                      isCompact ? "size-8" : "size-10"
                    )}
                  >
                    <Plus className={isCompact ? "size-4" : "size-5"} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  sideOffset={8}
                  className="w-72 border-0 p-1.5 shadow-[0_24px_80px_-36px_rgba(15,23,42,0.9)]"
                >
                  <DropdownMenuItem
                    onClick={() => {
                      fileInputRef.current?.click();
                    }}
                  >
                    <FileUp className="size-4" />
                    {chatT("composer.attachFile")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setCreativeAssetPickerOpen(true)}
                  >
                    <ImageIcon className="size-4" />
                    {chatT("composer.chooseCreativeAsset")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Database className="size-4" />
                      {chatT("composer.addSources")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-[min(24rem,calc(100vw-2rem))] border-0 p-0 shadow-[0_24px_80px_-36px_rgba(15,23,42,0.9)]">
                      {sourceCommandList}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>

              <div
                className={cn(
                  "relative min-w-0 flex-1 text-left",
                  isCompact ? "min-h-8" : "min-h-10"
                )}
              >
                <MentionTextarea
                  ref={textareaRef}
                  value={input}
                  onValueChange={(_, target) => syncInput(target)}
                  renderValue={value =>
                    renderInputWithSourceMentions(value, selectedSources)
                  }
                  placeholder={placeholder}
                  minHeight={textareaMinHeight}
                  maxHeight={textareaMaxHeight}
                  onClick={handleCaretChange}
                  onKeyUp={handleCaretChange}
                  onKeyDown={handleComposerKeyDown}
                  aria-label={placeholder}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={showPicker}
                  aria-controls={showPicker ? pickerAria.controls : undefined}
                  aria-activedescendant={
                    showPicker ? pickerAria.activeDescendant : undefined
                  }
                  aria-haspopup="listbox"
                  rows={1}
                  textareaClassName={cn(
                    "relative z-10 resize-none overflow-hidden border-0 bg-transparent px-1 text-left text-sm leading-6 text-transparent caret-foreground shadow-none selection:bg-primary/20 focus-visible:ring-0",
                    isCompact
                      ? "max-h-24 min-h-8 py-1"
                      : "max-h-36 min-h-10 py-2"
                  )}
                  overlayClassName={cn(
                    "whitespace-pre-wrap break-words px-1 text-left text-sm leading-6 text-foreground",
                    isCompact ? "py-1" : "py-2"
                  )}
                  disabled={inputDisabled}
                />
              </div>
              {showStop ? (
                // The answer goes on when the drawer closes; only this
                // stops it.
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  disabled={stopping}
                  aria-label={
                    stopping ? chatT("stoppingAnswer") : chatT("stopAnswer")
                  }
                  title={
                    stopping ? chatT("stoppingAnswer") : chatT("stopAnswer")
                  }
                  className={cn(
                    "shrink-0 rounded-full",
                    isCompact ? "size-8" : "size-10"
                  )}
                  onClick={onStop}
                >
                  {stopping ? (
                    <Loader2
                      aria-hidden="true"
                      className="size-4 animate-spin motion-reduce:animate-none"
                    />
                  ) : (
                    <Square
                      aria-hidden="true"
                      className="size-3.5 fill-current"
                    />
                  )}
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  disabled={inputDisabled || !canSubmit}
                  aria-label={chatT("composer.sendMessage")}
                  className={cn(
                    "shrink-0 rounded-full",
                    isCompact ? "size-8" : "size-10"
                  )}
                >
                  <SendHorizonal
                    className={cn("size-4", disabled && "opacity-50")}
                  />
                </Button>
              )}
            </div>
          </PopoverAnchor>
          <PopoverContent
            data-testid="airi-source-picker"
            aria-label={
              pickerMode === "chats"
                ? chatT("composer.chooseFromChats")
                : chatT("composer.addSourcesAndSkills")
            }
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className="z-[60] max-h-[var(--radix-popover-content-available-height)] w-[min(24rem,var(--radix-popover-trigger-width))] overflow-hidden rounded-xl p-0 shadow-lg"
            onOpenAutoFocus={event => event.preventDefault()}
            onCloseAutoFocus={event => event.preventDefault()}
            onInteractOutside={event => {
              if (
                event.target instanceof Node &&
                composerBarRef.current?.contains(event.target)
              )
                event.preventDefault();
            }}
          >
            {sourceCommandList}
          </PopoverContent>
        </Popover>

        {metaSkillConnectHint ? (
          <div className="flex flex-wrap items-center gap-1.5 px-1">
            {metaSkillConnectHint.authorize ? (
              <MetaAdsMcpConnectButton
                workspaceId={workspaceId}
                allowCreateGraphSource={
                  metaSkillConnectHint.allowCreateGraphSource
                }
                disabled={inputDisabled}
                onConnected={onSourcesRefresh}
                variant="outline"
                className="h-auto min-h-7 max-w-full gap-1.5 whitespace-normal rounded-full border-rose-500/25 bg-rose-500/[0.06] px-2.5 text-left text-[11px] font-medium text-foreground hover:bg-rose-500/[0.1]"
                label={
                  <>
                    <Megaphone className="size-3 text-rose-600 dark:text-rose-400" />
                    <span>{metaSkillConnectHint.label}</span>
                  </>
                }
              />
            ) : (
              <Button
                asChild
                variant="outline"
                className="h-auto min-h-7 max-w-full gap-1.5 whitespace-normal rounded-full border-rose-500/25 bg-rose-500/[0.06] px-2.5 text-left text-[11px] font-medium text-foreground hover:bg-rose-500/[0.1]"
              >
                <Link href={metaSkillConnectHint.href}>
                  <Megaphone className="size-3 text-rose-600 dark:text-rose-400" />
                  <span>{metaSkillConnectHint.label}</span>
                </Link>
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </form>
  );
}
