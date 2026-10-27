"use client";

import type { CreativeAsset } from "@/components/assets/creative-assets-workspace";
import { createScribeMicrophone } from "@/lib/elevenlabs/scribe-microphone";
import {
  fetchElevenLabsScribeToken,
  fetchWorkspaceCreativeAsset,
  generateWorkspaceCreativeImage,
  planScenarioGeneratorRequest,
  searchCanvaBrandTemplatesRequest,
  uploadScenarioActionImage,
} from "@/lib/scenarios/client";
import {
  CommitStrategy,
  type RealtimeConnection,
  useScribe,
} from "@elevenlabs/react";
import type {
  ScenarioGeneratorAssetRef,
  ScenarioGeneratorBlueprint,
  ScenarioGeneratorCanvaTemplateRef,
  ScenarioGeneratorCanvaTemplatesResult,
  ScenarioGeneratorChannel,
  ScenarioGeneratorCreateInput,
  ScenarioGeneratorFollowUpQuestion,
  ScenarioGeneratorSendMode,
  ScenarioGeneratorSourceContext,
  ScenarioGeneratorWorkflowKind,
} from "@icecore/scenario-contracts";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { ScenarioSourceInstanceOption } from "../../scenario-onboarding";
import {
  type AiriFunnelTemplateDefinition,
  type AiriCreateDialogProps,
  type AttachmentNotice,
  type FollowUpAnswer,
  type GeneratorStatus,
  type ScenarioSourceMention,
  type SourceMentionSearch,
  buildFunnelTemplateBlueprint,
  buildFunnelTemplateSeed,
  buildPromptForFunnelTemplate,
  buildPromptWithAnswers,
  createAbortError,
  delay,
  EMPTY_SOURCE_IDS,
  EMPTY_SOURCE_MENTIONS,
  EMPTY_SOURCE_OPTIONS,
  extractSourceMentionsFromPrompt,
  findActiveSourceMentionSearch,
  formatSourceMentionLabel,
  getScribeErrorMessage,
  getSourceMentionToken,
  isAbortError,
  isDeliverySourceMention,
  isSourceMentionSelectable,
  joinPromptSegments,
  normalizeCreativeAssetRef,
  normalizeGeneratorAssetRef,
  SOURCE_MENTION_OPTIONS,
  sourceMentionsToChannels,
  stripSourceMentionsFromPrompt,
} from "./shared";

const AIRI_CREATE_WORKFLOW_KIND: ScenarioGeneratorWorkflowKind =
  "follow_up_workflow";
const AIRI_CREATE_SEND_MODE: ScenarioGeneratorSendMode = "trigger";

export function useScenarioGeneratorWizard({
  open,
  onOpenChange,
  templates: templateDefinitions,
  presets,
  isCreating,
  workspaceId,
  initialDraft,
  onCreateGeneratedScenario,
  sourceIds: providedSourceIds = EMPTY_SOURCE_IDS,
  connectedSourceMentions = EMPTY_SOURCE_MENTIONS,
  connectedSourceOptions = EMPTY_SOURCE_OPTIONS,
  hasGoogleCalendar = false,
  higgsfieldUnavailableReason = "",
}: AiriCreateDialogProps) {
  const t = useTranslations("Scenarios.airiCreate");
  const templates = templateDefinitions ?? presets ?? [];
  const sourceIds =
    providedSourceIds.length > 0
      ? providedSourceIds
      : (initialDraft?.sourceIds ?? EMPTY_SOURCE_IDS);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [assetRefs, setAssetRefs] = useState<ScenarioGeneratorAssetRef[]>([]);
  const [assetWarnings, setAssetWarnings] = useState<AttachmentNotice[]>([]);
  const [assetErrors, setAssetErrors] = useState<string[]>([]);
  const [sourceScopeByType, setSourceScopeByType] = useState<
    Partial<Record<ScenarioGeneratorChannel, string[]>>
  >({});
  const [followUpQuestions, setFollowUpQuestions] = useState<
    ScenarioGeneratorFollowUpQuestion[]
  >([]);
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>(
    {}
  );
  const [answers, setAnswers] = useState<FollowUpAnswer[]>([]);
  const [generatorStatus, setGeneratorStatus] =
    useState<GeneratorStatus>("idle");
  const [generatorSummary, setGeneratorSummary] = useState("");
  const [readyBlueprint, setReadyBlueprint] =
    useState<ScenarioGeneratorBlueprint | null>(null);
  const [templateSearchQuery, setTemplateSearchQuery] = useState("");
  const [canvaTemplateResult, setCanvaTemplateResult] =
    useState<ScenarioGeneratorCanvaTemplatesResult | null>(null);
  const [selectedCanvaTemplates, setSelectedCanvaTemplates] = useState<
    ScenarioGeneratorCanvaTemplateRef[]
  >([]);
  const [isHiggsfieldAssetDialogOpen, setIsHiggsfieldAssetDialogOpen] =
    useState(false);
  const [uploadingAssets, setUploadingAssets] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isVoiceStarting, setIsVoiceStarting] = useState(false);
  const [isVoiceSessionActive, setIsVoiceSessionActive] = useState(false);
  const [voiceSessionId, setVoiceSessionId] = useState(0);
  const assetInputRef = useRef<HTMLInputElement | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const promptHighlightRef = useRef<HTMLDivElement | null>(null);
  const isMountedRef = useRef(true);
  const higgsfieldGenerationAbortRef = useRef<AbortController | null>(null);
  const voicePromptBaseRef = useRef("");
  const voiceCommittedRef = useRef("");
  const voicePartialRef = useRef("");
  const voiceSessionIdRef = useRef(0);
  const voiceSessionActiveRef = useRef(false);
  const disconnectScribeRef = useRef<(() => void) | null>(null);
  const voiceSessionResourcesRef = useRef<{
    microphone: ReturnType<typeof createScribeMicrophone>;
    connection: RealtimeConnection | null;
    connected: boolean;
    stopping: boolean;
    finishTranscript: (() => void) | null;
  } | null>(null);
  const autoGeneratedInitialDraftIdRef = useRef<string | null>(null);
  const [sourceMentionSearch, setSourceMentionSearch] =
    useState<SourceMentionSearch | null>(null);
  const [sourceMentionHighlight, setSourceMentionHighlight] = useState({
    key: "",
    index: 0,
  });
  const [appliedInitialDraftId, setAppliedInitialDraftId] = useState<
    string | null
  >(null);
  const isInitialDraftHandoff = Boolean(initialDraft);

  useEffect(() => {
    isMountedRef.current = true;
    setVoiceSessionId(voiceSessionIdRef.current);
    return () => {
      isMountedRef.current = false;
      higgsfieldGenerationAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!open) {
      higgsfieldGenerationAbortRef.current?.abort();
    }
  }, [open]);

  if (open && initialDraft && appliedInitialDraftId !== initialDraft.id) {
    setAppliedInitialDraftId(initialDraft.id);
    setSelectedTemplateId("");
    setPrompt(initialDraft.prompt);
    setSubmittedPrompt("");
    setAssetRefs([]);
    setAssetWarnings([]);
    setAssetErrors([]);
    setFollowUpQuestions([]);
    setFollowUpDrafts({});
    setAnswers([]);
    setGeneratorStatus("idle");
    setGeneratorSummary("");
    setReadyBlueprint(null);
    setTemplateSearchQuery("");
    setCanvaTemplateResult(null);
    setSelectedCanvaTemplates([]);
    setSourceScopeByType({});
    setSourceMentionSearch(null);
  }

  const updateVoicePrompt = useCallback(
    (committed: string, partial: string) => {
      setPrompt(
        joinPromptSegments(voicePromptBaseRef.current, committed, partial)
      );
    },
    []
  );

  const invalidateVoiceSession = useCallback(() => {
    voiceSessionActiveRef.current = false;
    voiceSessionIdRef.current += 1;
    if (isMountedRef.current) {
      setVoiceSessionId(voiceSessionIdRef.current);
      setIsVoiceStarting(false);
      setIsVoiceSessionActive(false);
    }
  }, []);

  const isCurrentVoiceSession = useCallback(
    () =>
      isMountedRef.current &&
      voiceSessionActiveRef.current &&
      voiceSessionId === voiceSessionIdRef.current,
    [voiceSessionId]
  );

  const handleScribeError = useCallback(
    (error: unknown) => {
      if (!isCurrentVoiceSession()) return;
      const message = getScribeErrorMessage(error, t("errors.voiceFailed"));
      setVoiceError(message);
      toast.error(message);
      invalidateVoiceSession();
      disconnectScribeRef.current?.();
    },
    [invalidateVoiceSession, isCurrentVoiceSession, t]
  );

  const {
    connect: connectScribe,
    disconnect: disconnectScribe,
    status: scribeStatus,
    getConnection: getScribeConnection,
  } = useScribe({
    autoConnect: false,
    commitStrategy: CommitStrategy.VAD,
    includeTimestamps: false,
    modelId: "scribe_v2_realtime",
    vadSilenceThresholdSecs: 0.8,
    onPartialTranscript: data => {
      if (!isCurrentVoiceSession()) return;
      voicePartialRef.current = data.text;
      updateVoicePrompt(voiceCommittedRef.current, voicePartialRef.current);
    },
    onCommittedTranscript: data => {
      if (!isCurrentVoiceSession()) return;
      const nextText = data.text.trim();
      if (nextText) {
        voiceCommittedRef.current = joinPromptSegments(
          voiceCommittedRef.current,
          nextText
        );
      }
      voicePartialRef.current = "";
      updateVoicePrompt(voiceCommittedRef.current, "");
    },
    onError: handleScribeError,
    onAuthError: handleScribeError,
    onQuotaExceededError: handleScribeError,
    onRateLimitedError: handleScribeError,
    onTranscriberError: handleScribeError,
    onConnect: () => {
      if (!isCurrentVoiceSession()) return;
      const resources = voiceSessionResourcesRef.current;
      if (!resources?.connection) return;
      resources.connected = true;
      resources.microphone.sendAudioTo(audioBase64 => {
        if (!isCurrentVoiceSession()) return;
        try {
          resources.connection?.send({ audioBase64 });
        } catch (error) {
          handleScribeError(error);
        }
      });
    },
    onDisconnect: () => {
      if (isCurrentVoiceSession()) {
        invalidateVoiceSession();
        disconnectScribeRef.current?.();
      }
    },
  });

  const disconnectVoiceSession = useCallback(() => {
    const resources = voiceSessionResourcesRef.current;
    voiceSessionResourcesRef.current = null;
    resources?.finishTranscript?.();
    resources?.microphone.close();
    // A delayed CLOSE can clear the SDK ref for a newer connection. Always
    // close the instance owned by this session, then reset the SDK UI state.
    resources?.connection?.close();
    disconnectScribe();
  }, [disconnectScribe]);

  useEffect(() => {
    disconnectScribeRef.current = disconnectVoiceSession;
  }, [disconnectVoiceSession]);

  const handleStopVoiceDictation = useCallback(
    async (discard = false) => {
      if (!voiceSessionActiveRef.current) return;
      const resources = voiceSessionResourcesRef.current;
      if (discard || !resources?.connected) {
        invalidateVoiceSession();
        disconnectVoiceSession();
        return;
      }
      if (resources.stopping) return;
      resources.stopping = true;
      try {
        // Stop capture now, then send the bounded worklet tail before commit.
        await resources.microphone.stopAndFlush();
        if (voiceSessionResourcesRef.current !== resources) return;
        // VAD and manual commits share an event without a correlation ID.
        // Drain ordered final clauses for the full bounded window.
        await new Promise<void>(resolve => {
          const finish = () => {
            clearTimeout(timeout);
            resources.finishTranscript = null;
            resolve();
          };
          const timeout = setTimeout(finish, 1500);
          resources.finishTranscript = finish;
          try {
            resources.connection?.commit();
          } catch {
            // Preserve the partial transcript already shown if the socket closed.
            finish();
          }
        });
      } finally {
        if (voiceSessionResourcesRef.current === resources) {
          invalidateVoiceSession();
          disconnectVoiceSession();
        }
      }
    },
    [disconnectVoiceSession, invalidateVoiceSession]
  );

  const effectiveSelectedTemplateId =
    selectedTemplateId && templates.some(item => item.id === selectedTemplateId)
      ? selectedTemplateId
      : "";

  const selectedTemplate = useMemo(
    () =>
      templates.find(item => item.id === effectiveSelectedTemplateId) || null,
    [templates, effectiveSelectedTemplateId]
  );
  const selectedTemplateSeed = useMemo(
    () =>
      selectedTemplate ? buildFunnelTemplateSeed(selectedTemplate) : undefined,
    [selectedTemplate]
  );

  const connectedSourceMentionSet = useMemo(
    () => new Set<ScenarioSourceMention>(connectedSourceMentions),
    [connectedSourceMentions]
  );
  const connectedSourceMentionOptions = useMemo(
    () =>
      SOURCE_MENTION_OPTIONS.filter(option =>
        isSourceMentionSelectable(
          option.id,
          connectedSourceMentionSet,
          AIRI_CREATE_SEND_MODE
        )
      ),
    [connectedSourceMentionSet]
  );
  const selectedSourceMentions = useMemo(
    () =>
      extractSourceMentionsFromPrompt(
        prompt,
        connectedSourceMentionSet,
        AIRI_CREATE_SEND_MODE
      ),
    [connectedSourceMentionSet, prompt]
  );
  const channels = useMemo(
    () => sourceMentionsToChannels(selectedSourceMentions),
    [selectedSourceMentions]
  );
  const sourceOptionsByType = useMemo(() => {
    const map = new Map<
      ScenarioGeneratorChannel,
      ScenarioSourceInstanceOption[]
    >();
    for (const option of connectedSourceOptions) {
      if (!isDeliverySourceMention(option.type)) continue;
      const current = map.get(option.type) || [];
      current.push(option);
      map.set(option.type, current);
    }
    return map;
  }, [connectedSourceOptions]);
  const scopedSourceOptions = useMemo(
    () =>
      channels.flatMap(channel =>
        (sourceOptionsByType.get(channel) || []).map(option => ({
          ...option,
          channel,
        }))
      ),
    [channels, sourceOptionsByType]
  );
  const selectedSourceScopeIds = useMemo(() => {
    const ids = new Set<string>(sourceIds);
    for (const channel of channels) {
      const options = sourceOptionsByType.get(channel) || [];
      if (options.length === 0) continue;
      const existing = sourceScopeByType[channel];
      if (!existing && sourceIds.length > 0) continue;
      const selectedIds = existing ?? options.map(option => option.id);
      for (const id of selectedIds) {
        if (options.some(option => option.id === id)) {
          ids.add(id);
        }
      }
    }
    return Array.from(ids);
  }, [channels, sourceIds, sourceOptionsByType, sourceScopeByType]);
  const canvaMentionSelected = selectedSourceMentions.includes("canva");
  const higgsfieldMentionSelected =
    selectedSourceMentions.includes("higgsfield");
  const hasCreativeOnlySourceMentions = selectedSourceMentions.some(
    mention => !isDeliverySourceMention(mention)
  );
  const selectedSourceContext = useMemo<
    ScenarioGeneratorSourceContext[]
  >(() => {
    const records = new Map<string, ScenarioGeneratorSourceContext>();
    const scopedIds = new Set(selectedSourceScopeIds);

    for (const option of connectedSourceOptions) {
      if (!scopedIds.has(option.id)) continue;
      records.set(`${option.type}:${option.id}`, {
        id: option.id,
        type: option.type,
        label: option.label,
        role: "delivery",
      });
    }

    for (const mention of selectedSourceMentions) {
      if (mention === "canva" || mention === "higgsfield") {
        records.set(mention, {
          type: mention,
          label: formatSourceMentionLabel(mention),
          role: "creative",
        });
      } else if (
        !Array.from(records.values()).some(item => item.type === mention)
      ) {
        records.set(mention, {
          type: mention,
          label: formatSourceMentionLabel(mention),
          role: "delivery",
        });
      }
    }

    if (hasGoogleCalendar) {
      records.set("google_calendar", {
        type: "google_calendar",
        label: "Google Calendar",
        role: "context",
      });
    }

    return Array.from(records.values()).slice(0, 20);
  }, [
    connectedSourceOptions,
    hasGoogleCalendar,
    selectedSourceMentions,
    selectedSourceScopeIds,
  ]);
  const higgsfieldAssetRefs = useMemo(
    () => assetRefs.filter(asset => asset.source === "higgsfield"),
    [assetRefs]
  );
  const generatorStatusLabel = t(`status.${generatorStatus}`);
  const promptPlaceholder = useMemo(() => {
    if (connectedSourceMentionSet.has("whatsapp")) {
      return t("placeholder.whatsapp");
    }
    if (connectedSourceMentionSet.has("email")) {
      return t("placeholder.email");
    }
    return t("placeholder.default");
  }, [connectedSourceMentionSet, t]);
  const sourceMentionPanelOptions = useMemo(() => {
    if (!sourceMentionSearch) return [];
    const normalizedQuery = sourceMentionSearch.query.trim().toLowerCase();
    return SOURCE_MENTION_OPTIONS.filter(option =>
      isSourceMentionSelectable(
        option.id,
        connectedSourceMentionSet,
        AIRI_CREATE_SEND_MODE
      )
    ).filter(option => {
      if (!normalizedQuery) return true;
      return (
        option.id.toLowerCase().includes(normalizedQuery) ||
        option.label.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [connectedSourceMentionSet, sourceMentionSearch]);
  const sourceMentionHighlightTargetKey = [
    sourceMentionSearch?.query ?? "",
    sourceMentionPanelOptions.length,
  ].join(":");
  const effectiveHighlightedSourceMentionIndex =
    sourceMentionHighlight.key === sourceMentionHighlightTargetKey
      ? sourceMentionHighlight.index
      : 0;
  const assetWarningByKey = useMemo(() => {
    const warnings = new Map<string, AttachmentNotice>();
    for (const warning of assetWarnings) {
      if (warning.assetKey) {
        warnings.set(warning.assetKey, warning);
      }
    }
    return warnings;
  }, [assetWarnings]);
  const standaloneAssetWarnings = useMemo(
    () => assetWarnings.filter(warning => !warning.assetKey),
    [assetWarnings]
  );

  useEffect(() => {
    setSourceScopeByType(current => {
      const channelSet = new Set(channels);
      const next: Partial<Record<ScenarioGeneratorChannel, string[]>> = {};
      for (const channel of channels) {
        if (current[channel]) {
          next[channel] = current[channel];
        }
      }
      const unchanged =
        Object.keys(current).length === Object.keys(next).length &&
        Object.keys(current).every(key =>
          channelSet.has(key as ScenarioGeneratorChannel)
        );
      return unchanged ? current : next;
    });
  }, [channels]);

  const focusPromptAt = useCallback((cursorIndex: number) => {
    window.requestAnimationFrame(() => {
      const textarea = promptTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(cursorIndex, cursorIndex);
    });
  }, []);

  const updateSourceMentionSearchForCursor = useCallback(
    (text: string, cursorIndex: number) => {
      setSourceMentionSearch(findActiveSourceMentionSearch(text, cursorIndex));
    },
    []
  );

  const handlePromptChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const nextPrompt = event.currentTarget.value;
      const cursorIndex =
        event.currentTarget.selectionStart ?? nextPrompt.length;
      if (voiceSessionActiveRef.current) void handleStopVoiceDictation(true);
      setPrompt(nextPrompt);
      updateSourceMentionSearchForCursor(nextPrompt, cursorIndex);
    },
    [handleStopVoiceDictation, updateSourceMentionSearchForCursor]
  );

  const handlePromptSelectionUpdate = useCallback(() => {
    const textarea = promptTextareaRef.current;
    if (!textarea) return;
    updateSourceMentionSearchForCursor(prompt, textarea.selectionStart);
  }, [prompt, updateSourceMentionSearchForCursor]);

  const handlePromptScroll = useCallback(
    (event: UIEvent<HTMLTextAreaElement>) => {
      const highlight = promptHighlightRef.current;
      if (!highlight) return;
      highlight.scrollTop = event.currentTarget.scrollTop;
      highlight.scrollLeft = event.currentTarget.scrollLeft;
    },
    []
  );

  const handleOpenSourceMentionPicker = useCallback(() => {
    const textarea = promptTextareaRef.current;
    const cursorIndex = textarea?.selectionStart ?? prompt.length;
    const needsLeadingSpace =
      cursorIndex > 0 && !/\s/.test(prompt.charAt(cursorIndex - 1));
    const insertion = `${needsLeadingSpace ? " " : ""}@`;
    const nextPrompt =
      prompt.slice(0, cursorIndex) + insertion + prompt.slice(cursorIndex);
    const nextCursorIndex = cursorIndex + insertion.length;
    if (voiceSessionActiveRef.current) void handleStopVoiceDictation(true);
    setPrompt(nextPrompt);
    setSourceMentionSearch({
      query: "",
      triggerIndex: nextCursorIndex - 1,
      cursorIndex: nextCursorIndex,
    });
    focusPromptAt(nextCursorIndex);
  }, [focusPromptAt, handleStopVoiceDictation, prompt]);

  const handleSelectSourceMention = useCallback(
    (option: (typeof SOURCE_MENTION_OPTIONS)[number]) => {
      if (
        !isSourceMentionSelectable(
          option.id,
          connectedSourceMentionSet,
          AIRI_CREATE_SEND_MODE
        )
      ) {
        toast.error(
          option.id === "telegram"
            ? t("errors.telegramBulkOnly")
            : t("errors.sourceNotConnected", { source: option.label })
        );
        return;
      }

      const textarea = promptTextareaRef.current;
      const cursorIndex =
        sourceMentionSearch?.cursorIndex ??
        textarea?.selectionStart ??
        prompt.length;
      const triggerIndex = sourceMentionSearch?.triggerIndex ?? cursorIndex;
      const before = prompt.slice(0, triggerIndex);
      const after = prompt.slice(cursorIndex);
      const token = getSourceMentionToken(option);
      const leadingSpace = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const trailingSpace = after.length > 0 && !/^\s/.test(after) ? " " : " ";
      const nextPrompt = `${before}${leadingSpace}${token}${trailingSpace}${after}`;
      const nextCursorIndex =
        before.length +
        leadingSpace.length +
        token.length +
        trailingSpace.length;

      if (voiceSessionActiveRef.current) void handleStopVoiceDictation(true);
      setPrompt(nextPrompt);
      setSourceMentionSearch(null);
      focusPromptAt(nextCursorIndex);
    },
    [
      connectedSourceMentionSet,
      focusPromptAt,
      handleStopVoiceDictation,
      prompt,
      sourceMentionSearch,
      t,
    ]
  );

  const handleQuickSourceMention = useCallback(
    (option: (typeof SOURCE_MENTION_OPTIONS)[number]) => {
      if (selectedSourceMentions.includes(option.id)) {
        focusPromptAt(prompt.length);
        return;
      }
      handleSelectSourceMention(option);
    },
    [
      focusPromptAt,
      handleSelectSourceMention,
      prompt.length,
      selectedSourceMentions,
    ]
  );

  const handleSelectTemplate = useCallback(
    (template: AiriFunnelTemplateDefinition) => {
      const defaultDeliverySource =
        connectedSourceMentions.find(
          mention => mention === "whatsapp" || mention === "email"
        ) || null;
      const nextPrompt = buildPromptForFunnelTemplate(
        t("templates.prompt", {
          template: template.title,
          segment: template.segmentLabel,
          description: template.description,
        }),
        defaultDeliverySource
      );

      setSelectedTemplateId(template.id);
      if (voiceSessionActiveRef.current) void handleStopVoiceDictation(true);
      setPrompt(nextPrompt);
      setSubmittedPrompt("");
      setAnswers([]);
      setFollowUpQuestions([]);
      setFollowUpDrafts({});
      setReadyBlueprint(null);
      setCanvaTemplateResult(null);
      setSelectedCanvaTemplates([]);
      setGeneratorSummary("");
      setGeneratorStatus("idle");
      setSourceMentionSearch(null);
      focusPromptAt(nextPrompt.length);
    },
    [connectedSourceMentions, focusPromptAt, handleStopVoiceDictation, t]
  );

  const handleClearTemplate = useCallback(() => {
    setSelectedTemplateId("");
    setSubmittedPrompt("");
    setReadyBlueprint(null);
    setCanvaTemplateResult(null);
    setSelectedCanvaTemplates([]);
    setGeneratorSummary("");
    setGeneratorStatus("idle");
  }, []);

  const handlePromptKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!sourceMentionSearch) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setSourceMentionSearch(null);
        return;
      }
      if (sourceMentionPanelOptions.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSourceMentionHighlight(current => {
          const currentIndex =
            current.key === sourceMentionHighlightTargetKey ? current.index : 0;
          return {
            key: sourceMentionHighlightTargetKey,
            index: (currentIndex + 1) % sourceMentionPanelOptions.length,
          };
        });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSourceMentionHighlight(current => {
          const currentIndex =
            current.key === sourceMentionHighlightTargetKey ? current.index : 0;
          return {
            key: sourceMentionHighlightTargetKey,
            index:
              (currentIndex - 1 + sourceMentionPanelOptions.length) %
              sourceMentionPanelOptions.length,
          };
        });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const option =
          sourceMentionPanelOptions[
            Math.min(
              effectiveHighlightedSourceMentionIndex,
              sourceMentionPanelOptions.length - 1
            )
          ];
        if (option) {
          handleSelectSourceMention(option);
        }
      }
    },
    [
      handleSelectSourceMention,
      effectiveHighlightedSourceMentionIndex,
      sourceMentionHighlightTargetKey,
      sourceMentionPanelOptions,
      sourceMentionSearch,
    ]
  );

  const handleToggleSourceScope = useCallback(
    (channel: ScenarioGeneratorChannel, optionId: string) => {
      const options = sourceOptionsByType.get(channel) || [];
      if (options.length <= 1) return;

      const selected =
        sourceScopeByType[channel] ?? options.map(option => option.id);
      const hasSelected = selected.includes(optionId);
      const nextSelected = hasSelected
        ? selected.filter(id => id !== optionId)
        : [...selected, optionId];
      if (nextSelected.length === 0) {
        toast.error(
          t("errors.keepOneSource", {
            source: formatSourceMentionLabel(channel),
          })
        );
        return;
      }

      setSourceScopeByType(current => ({
        ...current,
        [channel]: nextSelected.filter(id =>
          options.some(option => option.id === id)
        ),
      }));
    },
    [sourceOptionsByType, sourceScopeByType, t]
  );

  const handleRemoveAsset = useCallback((asset: ScenarioGeneratorAssetRef) => {
    setAssetRefs(current => current.filter(item => item.url !== asset.url));
    setAssetWarnings(current =>
      current.filter(warning => warning.assetKey !== asset.url)
    );
  }, []);

  const handleSelectCreativeAsset = useCallback(
    (asset: CreativeAsset) => {
      const normalizedAsset = normalizeCreativeAssetRef(asset);
      if (!normalizedAsset) {
        toast.error(t("errors.higgsfieldIncomplete"));
        return;
      }

      setAssetRefs(current => {
        if (current.some(item => item.url === normalizedAsset.url)) {
          return current;
        }
        if (current.length >= 10) {
          toast.error(t("errors.attachmentLimit"));
          return current;
        }
        return [...current, normalizedAsset];
      });
      setAssetWarnings(current =>
        current.filter(warning => warning.assetKey !== normalizedAsset.url)
      );
    },
    [t]
  );

  const handleAssetFiles = useCallback(
    async (files: FileList | File[]) => {
      const selectedFiles = Array.from(files);
      const nextErrors: string[] = [];

      if (!workspaceId) {
        const error = t("errors.attachNoWorkspace");
        setAssetErrors(current => [...current, error].slice(-10));
        toast.error(error);
        return;
      }

      if (selectedFiles.length === 0) {
        return;
      }

      const remainingSlots = Math.max(0, 10 - assetRefs.length);
      if (remainingSlots === 0) {
        const error = t("errors.attachmentLimit");
        setAssetErrors(current => [...current, error].slice(-10));
        toast.error(error);
        return;
      }

      const candidates = selectedFiles.slice(0, remainingSlots);
      if (selectedFiles.length > candidates.length) {
        setAssetWarnings(current =>
          [
            ...current,
            {
              message: t("errors.attachmentsSkipped", {
                remaining: remainingSlots,
                skipped: selectedFiles.length - candidates.length,
              }),
            },
          ].slice(-10)
        );
      }

      setUploadingAssets(true);
      try {
        const uploaded: ScenarioGeneratorAssetRef[] = [];
        const warnings: AttachmentNotice[] = [];
        for (const file of candidates) {
          try {
            const result = await uploadScenarioActionImage({
              workspaceId,
              file,
            });
            const asset = normalizeGeneratorAssetRef(result);
            uploaded.push(asset);
            const mime = result.mimeType || file.type || "";
            if (
              mime &&
              !mime.startsWith("image/") &&
              !mime.startsWith("video/") &&
              mime !== "text/plain"
            ) {
              warnings.push({
                assetKey: asset.url,
                fileName: asset.fileName || file.name,
                message: t("errors.metadataOnly", {
                  name: asset.fileName || file.name,
                }),
              });
            }
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : t("errors.uploadFailed");
            nextErrors.push(
              `${file.name || t("errors.attachmentFallbackName")}: ${reason}`
            );
          }
        }
        if (uploaded.length > 0) {
          setAssetRefs(current => [...current, ...uploaded].slice(0, 10));
        }
        if (warnings.length > 0) {
          setAssetWarnings(current => [...current, ...warnings].slice(-10));
        }
        if (nextErrors.length > 0) {
          setAssetErrors(current => [...current, ...nextErrors].slice(-10));
          toast.error(nextErrors[0]);
        } else {
          setAssetErrors([]);
        }
      } finally {
        setUploadingAssets(false);
      }
    },
    [assetRefs.length, t, workspaceId]
  );

  const pollCreativeAssetUntilComplete = useCallback(
    async (
      assetId: string,
      signal?: AbortSignal
    ): Promise<ScenarioGeneratorAssetRef> => {
      if (!workspaceId) {
        throw new Error(t("errors.higgsfieldNoWorkspace"));
      }

      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (signal?.aborted) throw createAbortError();
        const payload = await fetchWorkspaceCreativeAsset({
          workspaceId,
          assetId,
          signal,
        });
        const asset = payload.asset as CreativeAsset | undefined;
        const normalizedAsset = asset ? normalizeCreativeAssetRef(asset) : null;
        if (normalizedAsset) return normalizedAsset;
        if (asset?.status === "failed" || asset?.status === "nsfw") {
          throw new Error(asset.error || t("errors.higgsfieldFailed"));
        }
        await delay(1500, signal);
      }

      throw new Error(t("errors.higgsfieldStillRunning"));
    },
    [t, workspaceId]
  );

  const generateHiggsfieldAssetFromPrompt = useCallback(
    async (generatorPrompt: string): Promise<ScenarioGeneratorAssetRef> => {
      if (!workspaceId) {
        throw new Error(t("errors.higgsfieldNoWorkspace"));
      }

      higgsfieldGenerationAbortRef.current?.abort();
      const abortController = new AbortController();
      higgsfieldGenerationAbortRef.current = abortController;
      setIsHiggsfieldAssetDialogOpen(false);
      setGeneratorStatus("media_queued");
      try {
        const payload = await generateWorkspaceCreativeImage({
          workspaceId,
          prompt: generatorPrompt,
          signal: abortController.signal,
        });
        const asset = payload.asset as CreativeAsset | undefined;
        const normalizedAsset = asset ? normalizeCreativeAssetRef(asset) : null;
        const completedAsset =
          normalizedAsset ||
          (asset?.id
            ? await pollCreativeAssetUntilComplete(
                asset.id,
                abortController.signal
              )
            : null);
        if (abortController.signal.aborted || !isMountedRef.current) {
          throw createAbortError();
        }
        if (!completedAsset) {
          throw new Error(t("errors.higgsfieldNoAsset"));
        }
        setAssetRefs(current =>
          current.some(item => item.url === completedAsset.url)
            ? current
            : [...current, completedAsset].slice(0, 10)
        );
        return completedAsset;
      } finally {
        if (higgsfieldGenerationAbortRef.current === abortController) {
          higgsfieldGenerationAbortRef.current = null;
        }
      }
    },
    [pollCreativeAssetUntilComplete, t, workspaceId]
  );

  const isVoiceActive = isVoiceStarting || isVoiceSessionActive;

  const handleStartVoiceDictation = useCallback(async () => {
    if (
      !open ||
      !isMountedRef.current ||
      isVoiceActive ||
      voiceSessionActiveRef.current ||
      voiceSessionId !== voiceSessionIdRef.current
    ) {
      return;
    }
    if (!workspaceId) {
      const error = t("errors.voiceNoWorkspace");
      setVoiceError(error);
      toast.error(error);
      return;
    }

    setVoiceError(null);
    const requestId = voiceSessionId;
    voiceSessionActiveRef.current = true;
    setIsVoiceSessionActive(true);
    setIsVoiceStarting(true);
    voicePromptBaseRef.current = prompt;
    voiceCommittedRef.current = "";
    voicePartialRef.current = "";

    try {
      const tokenResult = await fetchElevenLabsScribeToken({ workspaceId });
      if (!isCurrentVoiceSession()) return;
      const resources = {
        microphone: createScribeMicrophone(),
        connection: null as RealtimeConnection | null,
        connected: false,
        stopping: false,
        finishTranscript: null as (() => void) | null,
      };
      voiceSessionResourcesRef.current = resources;
      const audioOptions = await resources.microphone.prepare();
      if (!isCurrentVoiceSession()) return;
      const connecting = connectScribe({
        token: tokenResult.token,
        commitStrategy: CommitStrategy.VAD,
        ...audioOptions,
        modelId: "scribe_v2_realtime",
        vadSilenceThresholdSecs: 0.8,
      });
      // connect() registers its connection synchronously in the pinned SDK.
      resources.connection = getScribeConnection();
      await connecting;
    } catch (error) {
      handleScribeError(error);
      if (requestId === voiceSessionIdRef.current) {
        invalidateVoiceSession();
        disconnectVoiceSession();
      }
    } finally {
      if (isMountedRef.current && requestId === voiceSessionIdRef.current) {
        setIsVoiceStarting(false);
      }
    }
  }, [
    connectScribe,
    disconnectVoiceSession,
    getScribeConnection,
    handleScribeError,
    invalidateVoiceSession,
    isCurrentVoiceSession,
    isVoiceActive,
    open,
    prompt,
    t,
    voiceSessionId,
    workspaceId,
  ]);

  useEffect(() => {
    return () => {
      invalidateVoiceSession();
      disconnectVoiceSession();
    };
  }, [
    disconnectVoiceSession,
    initialDraft?.id,
    invalidateVoiceSession,
    open,
    workspaceId,
  ]);

  const buildGeneratorInput = useCallback(
    (
      campaignName?: string,
      selectedTemplates: ScenarioGeneratorCanvaTemplateRef[] = selectedCanvaTemplates,
      selectedAssets: ScenarioGeneratorAssetRef[] = assetRefs,
      blueprint?: ScenarioGeneratorBlueprint | null
    ): ScenarioGeneratorCreateInput => {
      return {
        workspaceId: workspaceId || "",
        prompt: buildPromptWithAnswers(
          stripSourceMentionsFromPrompt(prompt),
          answers
        ),
        answers,
        workflowKind: blueprint?.workflowKind ?? AIRI_CREATE_WORKFLOW_KIND,
        sendMode: blueprint?.sendMode ?? AIRI_CREATE_SEND_MODE,
        channels,
        recipientSourceSummary:
          blueprint?.recipientSourceSummary ?? t("triggeredAudience"),
        recipients: [],
        assetRefs: selectedAssets,
        sourceIds: selectedSourceScopeIds,
        sourceContext: selectedSourceContext,
        campaignName,
        selectedCanvaTemplates: selectedTemplates,
        presetSeed: selectedTemplateSeed,
      };
    },
    [
      answers,
      assetRefs,
      channels,
      prompt,
      selectedCanvaTemplates,
      selectedSourceContext,
      selectedTemplateSeed,
      selectedSourceScopeIds,
      t,
      workspaceId,
    ]
  );

  const handleAddAnswers = () => {
    const nextAnswers = followUpQuestions
      .map(item => ({
        question: item.question,
        answer: (followUpDrafts[item.question] || "").trim(),
      }))
      .filter(item => item.answer.length > 0);
    if (nextAnswers.length === 0) return;
    setAnswers(current => [...current, ...nextAnswers]);
    setFollowUpQuestions([]);
    setFollowUpDrafts({});
    setReadyBlueprint(null);
    setCanvaTemplateResult(null);
    setSelectedCanvaTemplates([]);
    setGeneratorStatus("idle");
  };

  const fetchCanvaTemplates = useCallback(
    async (params?: { continuation?: string | null; append?: boolean }) => {
      if (!workspaceId || !readyBlueprint) return;
      setGeneratorStatus("fetching_templates");
      try {
        const result = await searchCanvaBrandTemplatesRequest({
          workspaceId,
          prompt: buildPromptWithAnswers(
            stripSourceMentionsFromPrompt(prompt),
            answers
          ),
          blueprint: readyBlueprint,
          query: templateSearchQuery,
          continuation: params?.continuation || undefined,
        });
        setCanvaTemplateResult(current => ({
          ...result,
          items: params?.append
            ? [...(current?.items || []), ...result.items]
            : result.items,
        }));
      } catch (error) {
        setCanvaTemplateResult({
          status: "error",
          query: templateSearchQuery,
          items: [],
          continuation: null,
          error:
            error instanceof Error ? error.message : t("canva.fetchFailed"),
        });
      } finally {
        setGeneratorStatus("template_selection");
      }
    },
    [answers, prompt, readyBlueprint, t, templateSearchQuery, workspaceId]
  );

  const canUseGenerator = Boolean(workspaceId && onCreateGeneratedScenario);

  const handleGenerate = useCallback(async () => {
    if (!workspaceId || !onCreateGeneratedScenario) return;
    const generatorPrompt = stripSourceMentionsFromPrompt(prompt);
    if (!generatorPrompt) {
      toast.error(t("errors.promptRequired"));
      return;
    }
    if (channels.length === 0) {
      toast.error(
        hasCreativeOnlySourceMentions
          ? t("errors.creativeOnly")
          : t("errors.deliveryRequired")
      );
      return;
    }

    setSubmittedPrompt(
      selectedTemplate || isInitialDraftHandoff ? "" : prompt.trim()
    );
    setGeneratorStatus("planning");
    setGeneratorSummary("");
    setReadyBlueprint(null);
    setCanvaTemplateResult(null);
    setSelectedCanvaTemplates([]);
    try {
      let generatorAssets = assetRefs;
      if (higgsfieldMentionSelected && higgsfieldAssetRefs.length === 0) {
        const generatedAsset =
          await generateHiggsfieldAssetFromPrompt(generatorPrompt);
        generatorAssets = [...assetRefs, generatedAsset].slice(0, 10);
      }
      if (selectedTemplate && selectedTemplateSeed && channels.length > 0) {
        const templateBlueprint = buildFunnelTemplateBlueprint({
          template: selectedTemplate,
          channels,
          recipientSourceSummary: t("triggeredAudience"),
        });
        setGeneratorStatus(
          canvaMentionSelected ? "template_selection" : "ready"
        );
        setGeneratorSummary(templateBlueprint.summary);
        setReadyBlueprint(templateBlueprint);
        setTemplateSearchQuery(
          `${selectedTemplate.title} ${selectedTemplate.segmentLabel} ${selectedTemplate.description}`
        );
        return;
      }
      setGeneratorStatus("planning");
      const plan = await planScenarioGeneratorRequest(
        buildGeneratorInput(undefined, [], generatorAssets)
      );
      if (plan.status === "needs_input") {
        setFollowUpQuestions(plan.questions);
        setGeneratorStatus("needs_input");
        return;
      }

      setGeneratorStatus("ready");
      setGeneratorSummary(plan.blueprint.summary);
      setReadyBlueprint(plan.blueprint);
      setTemplateSearchQuery(plan.templateSearchQuery || "");
      if (canvaMentionSelected) {
        setGeneratorStatus("template_selection");
        return;
      }
    } catch (error) {
      if (isAbortError(error)) {
        setGeneratorStatus("idle");
        return;
      }
      setGeneratorStatus("failed");
      toast.error(
        error instanceof Error ? error.message : t("errors.generateFailed")
      );
    }
  }, [
    assetRefs,
    buildGeneratorInput,
    canvaMentionSelected,
    channels,
    generateHiggsfieldAssetFromPrompt,
    hasCreativeOnlySourceMentions,
    higgsfieldAssetRefs.length,
    higgsfieldMentionSelected,
    isInitialDraftHandoff,
    onCreateGeneratedScenario,
    prompt,
    selectedTemplate,
    selectedTemplateSeed,
    t,
    workspaceId,
  ]);

  useEffect(() => {
    if (!open || !initialDraft || !canUseGenerator) return;
    if (generatorStatus !== "idle") return;
    if (autoGeneratedInitialDraftIdRef.current === initialDraft.id) return;
    if (!prompt.trim() || channels.length === 0) return;
    autoGeneratedInitialDraftIdRef.current = initialDraft.id;
    void handleGenerate();
  }, [
    canUseGenerator,
    channels.length,
    generatorStatus,
    handleGenerate,
    initialDraft,
    open,
    prompt,
  ]);

  useEffect(() => {
    if (!canvaMentionSelected) return;
    if (generatorStatus !== "template_selection") return;
    if (!readyBlueprint || canvaTemplateResult) return;
    void fetchCanvaTemplates();
  }, [
    canvaMentionSelected,
    canvaTemplateResult,
    fetchCanvaTemplates,
    generatorStatus,
    readyBlueprint,
  ]);

  const handleToggleCanvaTemplate = (
    template: ScenarioGeneratorCanvaTemplateRef
  ) => {
    setSelectedCanvaTemplates(current => {
      if (current.some(item => item.id === template.id)) {
        return current.filter(item => item.id !== template.id);
      }
      if (current.length >= 3) {
        toast.error(t("canva.pickLimit"));
        return current;
      }
      return [...current, template];
    });
  };

  const handleCreateGeneratedScenario = async (
    selectedTemplates: ScenarioGeneratorCanvaTemplateRef[]
  ) => {
    if (!readyBlueprint || !workspaceId || !onCreateGeneratedScenario) return;
    setGeneratorStatus("creating");
    const created = await onCreateGeneratedScenario(
      buildGeneratorInput(
        readyBlueprint.campaignName,
        selectedTemplates,
        assetRefs,
        readyBlueprint
      )
    );
    setGeneratorStatus(created ? "created" : "failed");
    if (created) {
      onOpenChange(false);
    }
  };

  const isGeneratorBusy =
    generatorStatus === "planning" ||
    generatorStatus === "media_queued" ||
    generatorStatus === "fetching_templates" ||
    generatorStatus === "creating" ||
    uploadingAssets;
  const generatorActionDisabled = isGeneratorBusy;
  const createScenarioButtonDisabled = generatorStatus === "creating";

  const hasTemplateSelectionActions = Boolean(
    canvaMentionSelected &&
      readyBlueprint &&
      (generatorStatus === "template_selection" ||
        generatorStatus === "fetching_templates" ||
        generatorStatus === "creating")
  );
  const hasPlanReviewActions = Boolean(
    readyBlueprint &&
      !canvaMentionSelected &&
      (generatorStatus === "ready" || generatorStatus === "creating")
  );
  return {
    open,
    onOpenChange,
    templates,
    isCreating,
    workspaceId,
    higgsfieldUnavailableReason,
    selectedTemplateId: effectiveSelectedTemplateId,
    selectedTemplate,
    prompt,
    submittedPrompt,
    isInitialDraftHandoff,
    workflowKind: AIRI_CREATE_WORKFLOW_KIND,
    sendMode: AIRI_CREATE_SEND_MODE,
    assetRefs,
    assetWarnings,
    assetErrors,
    followUpQuestions,
    followUpDrafts,
    setFollowUpDrafts,
    answers,
    generatorStatus,
    generatorSummary,
    readyBlueprint,
    templateSearchQuery,
    canvaTemplateResult,
    selectedCanvaTemplates,
    isHiggsfieldAssetDialogOpen,
    setIsHiggsfieldAssetDialogOpen,
    uploadingAssets,
    voiceError,
    assetInputRef,
    promptTextareaRef,
    promptHighlightRef,
    sourceMentionSearch,
    highlightedSourceMentionIndex: effectiveHighlightedSourceMentionIndex,
    handlePromptChange,
    handlePromptSelectionUpdate,
    handlePromptScroll,
    handleOpenSourceMentionPicker,
    handleSelectSourceMention,
    handleQuickSourceMention,
    handleSelectTemplate,
    handleClearTemplate,
    handlePromptKeyDown,
    handleToggleSourceScope,
    handleRemoveAsset,
    handleSelectCreativeAsset,
    handleAssetFiles,
    handleStartVoiceDictation,
    handleStopVoiceDictation,
    handleAddAnswers,
    fetchCanvaTemplates,
    handleGenerate,
    handleToggleCanvaTemplate,
    handleCreateGeneratedScenario,
    connectedSourceMentionSet,
    connectedSourceMentionOptions,
    selectedSourceMentions,
    channels,
    sourceOptionsByType,
    scopedSourceOptions,
    sourceScopeByType,
    selectedSourceScopeIds,
    canvaMentionSelected,
    higgsfieldMentionSelected,
    higgsfieldAssetRefs,
    generatorStatusLabel,
    promptPlaceholder,
    sourceMentionPanelOptions,
    assetWarningByKey,
    standaloneAssetWarnings,
    isVoiceActive,
    scribeStatus,
    canUseGenerator,
    isGeneratorBusy,
    generatorActionDisabled,
    createScenarioButtonDisabled,
    hasTemplateSelectionActions,
    hasPlanReviewActions,
  };
}

export type ScenarioGeneratorWizardState = ReturnType<
  typeof useScenarioGeneratorWizard
>;

export type AiriCreateDialogStepProps<
  Keys extends
    keyof ScenarioGeneratorWizardState = keyof ScenarioGeneratorWizardState,
> = {
  wizard: Pick<ScenarioGeneratorWizardState, Keys>;
};
