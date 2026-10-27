"use client";

import { Badge } from "@/components/ui/badge";
import { PlanUpgradeDialog } from "@/components/billing/plan-upgrade-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { CustomAvailableActionSchema } from "@/lib/airi/workspace-bot-schema";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { captureClientEvent } from "@/lib/posthog/client";
import { Check, Loader2, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS,
  EMPTY_AGENT_SETTINGS_FORM,
  ESCALATION_BEHAVIORS,
  GREETING_BEHAVIORS,
  RESPONSE_STYLES,
  RETRIEVAL_QUERY_MODES,
  WORKSPACE_LANGUAGE_BIASES,
  coerceEscalationBehavior,
  coerceGreetingBehavior,
  coerceResponseStyle,
  coerceWorkspaceBotRetrievalQueryMode,
  coerceWorkspaceLanguageBias,
  type AgentSettingsFormState,
  type ChannelInstructions,
  type CustomAvailableAction,
  type WorkspaceBotSettingsApiResponse,
} from "@/lib/airi/workspace-bot-contract";

type AgentSettingsViewProps = {
  workspaceId: string;
  onLoadingChange?: (loading: boolean) => void;
};

function toAgentSettingsFormState(
  data: WorkspaceBotSettingsApiResponse
): AgentSettingsFormState {
  return {
    ...EMPTY_AGENT_SETTINGS_FORM,
    agentPersona: data.agentPersona || null,
    customInstructions: data.customInstructions || null,
    greetingBehavior: coerceGreetingBehavior(
      data.greetingBehavior,
      DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS.greetingBehavior
    ),
    escalationBehavior: coerceEscalationBehavior(
      data.escalationBehavior,
      DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS.escalationBehavior
    ),
    responseStyle: coerceResponseStyle(
      data.responseStyle,
      DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS.responseStyle
    ),
    retrievalQueryMode: coerceWorkspaceBotRetrievalQueryMode(
      data.retrievalQueryMode,
      DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS.retrievalQueryMode
    ),
    includeRecentConversationInRetrievalContext:
      data.includeRecentConversationInRetrievalContext ??
      DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS.includeRecentConversationInRetrievalContext,
    sendKbArticleLinksToUserChannels:
      data.sendKbArticleLinksToUserChannels ??
      DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS.sendKbArticleLinksToUserChannels,
    elevenlabsAgentId: data.elevenlabsAgentId?.trim() || null,
    whatsappVoiceRepliesEnabled: data.whatsappVoiceRepliesEnabled === true,
    languageBias: coerceWorkspaceLanguageBias(
      data.languageBias,
      DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS.languageBias
    ),
    customAvailableActions: data.customAvailableActions || [],
    channelInstructions: data.channelInstructions || null,
  };
}

type AgentSettingsSaveResult = "success" | "error" | null;

type AgentSettingsUiState = {
  loading: boolean;
  saving: boolean;
  saveResult: AgentSettingsSaveResult;
};

type AgentSettingsUiAction =
  | { type: "load-start" }
  | { type: "load-success" }
  | { type: "load-error" }
  | { type: "save-start" }
  | { type: "save-success" }
  | { type: "save-error" }
  | { type: "clear-save-result" };

const INITIAL_AGENT_SETTINGS_UI_STATE: AgentSettingsUiState = {
  loading: true,
  saving: false,
  saveResult: null,
};

function reduceAgentSettingsUiState(
  state: AgentSettingsUiState,
  action: AgentSettingsUiAction
): AgentSettingsUiState {
  switch (action.type) {
    case "load-start":
      return {
        ...state,
        loading: true,
        saving: false,
        saveResult: null,
      };
    case "load-success":
      return {
        ...state,
        loading: false,
      };
    case "load-error":
      return {
        ...state,
        loading: false,
        saveResult: "error",
      };
    case "save-start":
      return {
        ...state,
        saving: true,
        saveResult: null,
      };
    case "save-success":
      return {
        ...state,
        saving: false,
        saveResult: "success",
      };
    case "save-error":
      return {
        ...state,
        saving: false,
        saveResult: "error",
      };
    case "clear-save-result":
      return state.saveResult === null
        ? state
        : {
            ...state,
            saveResult: null,
          };
  }
}

export default function AgentSettingsView({
  workspaceId,
  onLoadingChange,
}: AgentSettingsViewProps) {
  const t = useTranslations("AgentSettings");
  const [settings, setSettings] = useState<AgentSettingsFormState>(
    EMPTY_AGENT_SETTINGS_FORM
  );
  const [{ loading, saving, saveResult }, dispatchUiState] = useReducer(
    reduceAgentSettingsUiState,
    INITIAL_AGENT_SETTINGS_UI_STATE
  );
  const [savedSettings, setSavedSettings] =
    useState<AgentSettingsFormState | null>(null);
  const [voiceReplyAccess, setVoiceReplyAccess] =
    useState<WorkspaceBotSettingsApiResponse["voiceReplyAccess"]>();
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const hasChanges =
    savedSettings !== null &&
    JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const hasIncompleteActions = settings.customAvailableActions.some(
    action =>
      (action.action.trim() || action.when.trim()) &&
      !CustomAvailableActionSchema.safeParse(action).success
  );
  const [topicInput, setTopicInput] = useState("");
  const requestGenerationRef = useRef(0);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLoadingChangeRef = useRef(onLoadingChange);
  onLoadingChangeRef.current = onLoadingChange;
  const completeCustomAvailableActions: CustomAvailableAction[] = useMemo(
    () =>
      settings.customAvailableActions
        .map(action => ({
          action: action.action.trim(),
          when: action.when.trim(),
        }))
        .filter(action => action.action && action.when),
    [settings.customAvailableActions]
  );

  useEffect(() => {
    let cancelled = false;
    const requestGeneration = ++requestGenerationRef.current;
    dispatchUiState({ type: "load-start" });
    setLoadError(false);
    setSavedSettings(null);
    setVoiceReplyAccess(undefined);
    setUpgradeDialogOpen(false);
    onLoadingChangeRef.current?.(true);

    async function loadSettings() {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/airi-bot`);
        const data = (await response.json()) as WorkspaceBotSettingsApiResponse;
        if (!response.ok || data.success !== true)
          throw new Error("load failed");
        if (cancelled) return;
        const next = toAgentSettingsFormState(data);
        setSettings(next);
        setSavedSettings(next);
        setVoiceReplyAccess(data.voiceReplyAccess);
        dispatchUiState({ type: "load-success" });
      } catch {
        if (!cancelled) {
          setLoadError(true);
          dispatchUiState({ type: "load-error" });
        }
      } finally {
        if (!cancelled) {
          onLoadingChangeRef.current?.(false);
        }
      }
    }

    loadSettings();

    return () => {
      cancelled = true;
      requestGenerationRef.current = requestGeneration + 1;
    };
  }, [workspaceId, loadAttempt]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, []);

  const handleSave = useCallback(async () => {
    if (!savedSettings || !hasChanges || hasIncompleteActions || saving) return;
    const voiceReplySettingChanged =
      settings.whatsappVoiceRepliesEnabled !==
      savedSettings.whatsappVoiceRepliesEnabled;
    const requestGeneration = requestGenerationRef.current;
    dispatchUiState({ type: "save-start" });
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/airi-bot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentPersona: settings.agentPersona,
          customInstructions: settings.customInstructions,
          elevenlabsAgentId: settings.elevenlabsAgentId?.trim() || null,
          ...(voiceReplySettingChanged
            ? {
                whatsappVoiceRepliesEnabled:
                  settings.whatsappVoiceRepliesEnabled,
              }
            : {}),
          greetingBehavior: settings.greetingBehavior,
          escalationBehavior: settings.escalationBehavior,
          responseStyle: settings.responseStyle,
          retrievalQueryMode: settings.retrievalQueryMode,
          includeRecentConversationInRetrievalContext:
            settings.includeRecentConversationInRetrievalContext,
          sendKbArticleLinksToUserChannels:
            settings.sendKbArticleLinksToUserChannels,
          languageBias: settings.languageBias,
          customAvailableActions:
            completeCustomAvailableActions.length > 0
              ? completeCustomAvailableActions
              : null,
          channelInstructions: settings.channelInstructions,
        }),
      });

      const data = await res.json();
      if (requestGeneration !== requestGenerationRef.current) return;
      if (data.voiceReplyAccess) setVoiceReplyAccess(data.voiceReplyAccess);
      if (!res.ok || data.success !== true) throw new Error("save failed");
      const next = toAgentSettingsFormState(data);
      if (
        voiceReplySettingChanged &&
        next.whatsappVoiceRepliesEnabled !==
          savedSettings.whatsappVoiceRepliesEnabled
      ) {
        captureClientEvent("airi_voice_reply_setting_saved", {
          workspace_id: workspaceId,
          enabled: next.whatsappVoiceRepliesEnabled,
        });
      }
      setSettings(next);
      setSavedSettings(next);
      setVoiceReplyAccess(data.voiceReplyAccess);
      dispatchUiState({ type: "save-success" });
      saveTimeoutRef.current = setTimeout(
        () => dispatchUiState({ type: "clear-save-result" }),
        3000
      );
    } catch {
      if (requestGeneration !== requestGenerationRef.current) return;
      dispatchUiState({ type: "save-error" });
      saveTimeoutRef.current = setTimeout(
        () => dispatchUiState({ type: "clear-save-result" }),
        5000
      );
    }
  }, [
    workspaceId,
    settings,
    completeCustomAvailableActions,
    savedSettings,
    hasChanges,
    hasIncompleteActions,
    saving,
  ]);

  const updatePersona = useCallback(
    (patch: Partial<NonNullable<AgentSettingsFormState["agentPersona"]>>) => {
      setSettings(prev => ({
        ...prev,
        agentPersona: { ...(prev.agentPersona || {}), ...patch },
      }));
    },
    []
  );

  const addTopicRestriction = useCallback((topic: string) => {
    const trimmed = topic.trim();
    if (!trimmed) return;
    setSettings(prev => {
      const existing = prev.agentPersona?.topicRestrictions || [];
      if (
        existing.length >= 20 ||
        existing.some(
          item => item.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
        )
      )
        return prev;
      return {
        ...prev,
        agentPersona: {
          ...(prev.agentPersona || {}),
          topicRestrictions: [...existing, trimmed],
        },
      };
    });
    setTopicInput("");
  }, []);

  const removeTopicRestriction = useCallback((topic: string) => {
    setSettings(prev => ({
      ...prev,
      agentPersona: {
        ...(prev.agentPersona || {}),
        topicRestrictions: (prev.agentPersona?.topicRestrictions || []).filter(
          t => t !== topic
        ),
      },
    }));
  }, []);

  const updateChannelInstruction = useCallback(
    (channel: keyof ChannelInstructions, value: string) => {
      setSettings(prev => ({
        ...prev,
        channelInstructions: {
          ...prev.channelInstructions,
          [channel]: value || undefined,
        },
      }));
    },
    []
  );

  const addCustomAction = useCallback(() => {
    setSettings(prev => ({
      ...prev,
      customAvailableActions: [
        ...prev.customAvailableActions,
        { action: "", when: "" },
      ],
    }));
  }, []);

  const updateCustomAction = useCallback(
    (index: number, field: "action" | "when", value: string) => {
      setSettings(prev => ({
        ...prev,
        customAvailableActions: prev.customAvailableActions.map((a, i) =>
          i === index ? { ...a, [field]: value } : a
        ),
      }));
    },
    []
  );

  const removeCustomAction = useCallback((index: number) => {
    setSettings(prev => ({
      ...prev,
      customAvailableActions: prev.customAvailableActions.filter(
        (_, i) => i !== index
      ),
    }));
  }, []);

  const handleTopicKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addTopicRestriction(topicInput);
      }
    },
    [topicInput, addTopicRestriction]
  );

  const loadingMessage = t("loading");

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="animate-pulse transition-all duration-500">
          {loadingMessage}
        </span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4 text-sm"
      >
        <span>{t("agentLoadFailed")}</span>
        <Button
          variant="outline"
          onClick={() => setLoadAttempt(value => value + 1)}
        >
          {t("retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <fieldset
        disabled={saving}
        className="@container/agent-form min-w-0 space-y-4"
      >
        {/* Identity */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("agentSectionIdentity")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 @min-[24rem]/agent-form:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="agent-name">{t("agentDisplayName")}</Label>
              <Input
                id="agent-name"
                value={settings.agentPersona?.displayName || ""}
                onChange={e => updatePersona({ displayName: e.target.value })}
                placeholder={t("agentDisplayNamePlaceholder")}
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-tone">{t("agentTone")}</Label>
              <Input
                id="agent-tone"
                value={settings.agentPersona?.tone || ""}
                onChange={e => updatePersona({ tone: e.target.value })}
                placeholder={t("agentTonePlaceholder")}
                maxLength={500}
              />
            </div>
            <div className="space-y-2 @min-[24rem]/agent-form:col-span-2">
              <Label htmlFor="agent-topics">
                {t("agentTopicRestrictions")}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="agent-topics"
                  value={topicInput}
                  onChange={e => setTopicInput(e.target.value)}
                  onKeyDown={handleTopicKeyDown}
                  placeholder={t("agentTopicRestrictionsPlaceholder")}
                  maxLength={200}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => addTopicRestriction(topicInput)}
                  disabled={
                    !topicInput.trim() ||
                    (settings.agentPersona?.topicRestrictions?.length ?? 0) >=
                      20
                  }
                  aria-label={t("agentAddTopic")}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {(settings.agentPersona?.topicRestrictions?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {settings.agentPersona?.topicRestrictions?.map(topic => (
                    <Badge
                      key={topic}
                      variant="secondary"
                      className="gap-1 pr-1"
                    >
                      {topic}
                      <button
                        type="button"
                        aria-label={t("agentRemoveTopic", { topic })}
                        onClick={() => removeTopicRestriction(topic)}
                        className="ml-0.5 rounded-sm hover:bg-muted"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t("agentTopicRestrictionsHint")}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Instructions */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("agentSectionInstructions")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Label htmlFor="custom-instructions">
              {t("agentCustomInstructions")}
            </Label>
            <Textarea
              id="custom-instructions"
              value={settings.customInstructions || ""}
              onChange={e =>
                setSettings(prev => ({
                  ...prev,
                  customInstructions: e.target.value || null,
                }))
              }
              placeholder={t("agentCustomInstructionsPlaceholder")}
              maxLength={2000}
              rows={4}
            />
            <p className="text-right text-xs text-muted-foreground">
              {t("agentCustomInstructionsCount", {
                count: (settings.customInstructions || "").length,
              })}
            </p>
          </CardContent>
        </Card>

        {/* Behavior */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("agentSectionBehavior")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 @min-[28rem]/agent-form:grid-cols-3">
            {(
              [
                [
                  "greetingBehavior",
                  "agentGreetingBehavior",
                  GREETING_BEHAVIORS,
                  {
                    auto: "agentGreetingAuto",
                    brief_only: "agentGreetingBriefOnly",
                    disabled: "agentGreetingDisabled",
                  },
                ],
                [
                  "escalationBehavior",
                  "agentEscalationBehavior",
                  ESCALATION_BEHAVIORS,
                  {
                    suggest_human: "agentEscalationSuggestHuman",
                    auto_handoff: "agentEscalationAutoHandoff",
                    never: "agentEscalationNever",
                  },
                ],
                [
                  "responseStyle",
                  "agentResponseStyle",
                  RESPONSE_STYLES,
                  {
                    concise: "agentResponseConcise",
                    balanced: "agentResponseBalanced",
                    detailed: "agentResponseDetailed",
                  },
                ],
              ] as const
            ).map(([field, label, options, labels]) => (
              <div key={field} className="min-w-0 space-y-2">
                <Label htmlFor={`agent-${field}`}>{t(label)}</Label>
                <Select
                  value={settings[field]}
                  onValueChange={value =>
                    setSettings(previous => ({ ...previous, [field]: value }))
                  }
                >
                  <SelectTrigger id={`agent-${field}`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map(value => (
                      <SelectItem key={value} value={value}>
                        {t((labels as Record<string, string>)[value])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t(
                    `${(labels as Record<string, string>)[settings[field]]}Desc`
                  )}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Accordion type="multiple" className="rounded-lg border px-4">
          <AccordionItem value="retrieval">
            <AccordionTrigger>{t("agentSectionRetrieval")}</AccordionTrigger>
            <AccordionContent>
              <div>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>{t("agentRetrievalQueryMode")}</Label>
                    <Select
                      value={settings.retrievalQueryMode}
                      onValueChange={v =>
                        setSettings(prev => ({
                          ...prev,
                          retrievalQueryMode:
                            v as AgentSettingsFormState["retrievalQueryMode"],
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RETRIEVAL_QUERY_MODES.map(mode => (
                          <SelectItem key={mode} value={mode}>
                            {t(
                              mode === "adaptive"
                                ? "agentRetrievalAdaptive"
                                : "agentRetrievalLastMessageOnly"
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="include-conversation" className="flex-1">
                      {t("agentIncludeConversation")}
                    </Label>
                    <Switch
                      id="include-conversation"
                      checked={
                        settings.includeRecentConversationInRetrievalContext
                      }
                      onCheckedChange={v =>
                        setSettings(prev => ({
                          ...prev,
                          includeRecentConversationInRetrievalContext: v,
                        }))
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="send-kb-links" className="flex-1">
                      {t("agentSendKbLinks")}
                    </Label>
                    <Switch
                      id="send-kb-links"
                      checked={settings.sendKbArticleLinksToUserChannels}
                      onCheckedChange={v =>
                        setSettings(prev => ({
                          ...prev,
                          sendKbArticleLinksToUserChannels: v,
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>{t("agentLanguageBias")}</Label>
                    <Select
                      value={settings.languageBias}
                      onValueChange={v =>
                        setSettings(prev => ({
                          ...prev,
                          languageBias:
                            v as AgentSettingsFormState["languageBias"],
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WORKSPACE_LANGUAGE_BIASES.map(bias => (
                          <SelectItem key={bias} value={bias}>
                            {bias === "none"
                              ? t("agentLanguageBiasNone")
                              : bias === "kz"
                                ? t("agentLanguageBiasKazakh")
                                : bias === "ru"
                                  ? t("agentLanguageBiasRussian")
                                  : t("agentLanguageBiasUzbek")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="channel">
            <AccordionTrigger>{t("agentSectionChannel")}</AccordionTrigger>
            <AccordionContent>
              <div>
                <div className="space-y-4">
                  {(
                    [
                      ["whatsapp", "agentChannelWhatsApp"],
                      ["telegram", "agentChannelTelegram"],
                      ["instagram", "agentChannelInstagram"],
                      ["webWidget", "agentChannelWebWidget"],
                    ] as const
                  ).map(([key, labelKey]) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={`channel-${key}`}>{t(labelKey)}</Label>
                      <Textarea
                        id={`channel-${key}`}
                        value={settings.channelInstructions?.[key] || ""}
                        onChange={e =>
                          updateChannelInstruction(key, e.target.value)
                        }
                        placeholder={t("agentChannelPlaceholder")}
                        maxLength={1000}
                        rows={2}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="voice">
            <AccordionTrigger>{t("agentSectionVoice")}</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-4">
                <div className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor="whatsapp-voice-replies">
                          {t("whatsappVoiceRepliesTitle")}
                        </Label>
                        <Badge variant="outline">Pro</Badge>
                      </div>
                      <p
                        id="whatsapp-voice-replies-description"
                        className="text-xs text-muted-foreground"
                      >
                        {t("whatsappVoiceRepliesDescription")}
                      </p>
                    </div>
                    <Switch
                      id="whatsapp-voice-replies"
                      aria-describedby="whatsapp-voice-replies-description"
                      className="mt-1 shrink-0"
                      checked={settings.whatsappVoiceRepliesEnabled}
                      disabled={
                        !voiceReplyAccess?.available &&
                        !settings.whatsappVoiceRepliesEnabled
                      }
                      onCheckedChange={enabled =>
                        setSettings(prev => ({
                          ...prev,
                          whatsappVoiceRepliesEnabled: enabled,
                        }))
                      }
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("whatsappVoiceRepliesBillingHint")}
                  </p>
                  {voiceReplyAccess?.reason === "subscription_required" && (
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="min-w-0 text-xs text-muted-foreground">
                        {t("whatsappVoiceRepliesSubscriptionRequired")}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          captureClientEvent(
                            "airi_voice_reply_upgrade_clicked",
                            { workspace_id: workspaceId }
                          );
                          setUpgradeDialogOpen(true);
                        }}
                      >
                        {t("whatsappVoiceRepliesUpgrade")}
                      </Button>
                    </div>
                  )}
                  {voiceReplyAccess?.reason === "elevenlabs_required" && (
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="min-w-0 text-xs text-muted-foreground">
                        {t("whatsappVoiceRepliesElevenlabsRequired")}
                      </p>
                      <Button asChild size="sm" variant="outline">
                        <a
                          href={`/panel/w/${workspaceId}/settings/integrations`}
                        >
                          {t("whatsappVoiceRepliesConnect")}
                        </a>
                      </Button>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="elevenlabs-agent-id">
                    {t("elevenlabsAgentIdLabel")}
                  </Label>
                  <Input
                    id="elevenlabs-agent-id"
                    value={settings.elevenlabsAgentId || ""}
                    onChange={e =>
                      setSettings(prev => ({
                        ...prev,
                        elevenlabsAgentId: e.target.value || null,
                      }))
                    }
                    placeholder={t("elevenlabsAgentIdPlaceholder")}
                    maxLength={200}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("elevenlabsAgentIdHint")}
                  </p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="actions">
            <AccordionTrigger>{t("agentSectionActions")}</AccordionTrigger>
            <AccordionContent>
              <div>
                <div className="space-y-4">
                  {settings.customAvailableActions.map((action, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded-md border p-3"
                    >
                      <div className="flex-1 space-y-2">
                        <div className="space-y-1">
                          <Label htmlFor={`action-${i}`} className="text-xs">
                            {t("agentActionName")}
                          </Label>
                          <Input
                            id={`action-${i}`}
                            value={action.action}
                            onChange={e =>
                              updateCustomAction(i, "action", e.target.value)
                            }
                            placeholder={t("agentActionNamePlaceholder")}
                            maxLength={200}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label
                            htmlFor={`action-when-${i}`}
                            className="text-xs"
                          >
                            {t("agentActionWhen")}
                          </Label>
                          <Input
                            id={`action-when-${i}`}
                            value={action.when}
                            onChange={e =>
                              updateCustomAction(i, "when", e.target.value)
                            }
                            placeholder={t("agentActionWhenPlaceholder")}
                            maxLength={400}
                          />
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="mt-5 shrink-0"
                        onClick={() => removeCustomAction(i)}
                        aria-label={t("agentRemoveAction")}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  ))}
                  {settings.customAvailableActions.length < 10 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addCustomAction}
                      className="gap-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("agentAddAction")}
                    </Button>
                  )}
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </fieldset>
      {/* Save */}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t bg-background/95 py-3 backdrop-blur">
        {hasIncompleteActions && (
          <p role="alert" className="mr-auto text-sm text-destructive">
            {t("agentIncompleteAction")}
          </p>
        )}
        {hasChanges && !hasIncompleteActions && (
          <p className="mr-auto text-xs text-muted-foreground">
            {t("agentUnsavedChanges")}
          </p>
        )}
        {saveResult === "success" && !hasChanges && (
          <span className="flex items-center gap-1.5 text-sm text-green-600">
            <Check className="h-4 w-4" />
            {t("agentSaveSuccess")}
          </span>
        )}
        {saveResult === "error" && (
          <span className="text-sm text-destructive">
            {t("agentSaveFailed")}
          </span>
        )}
        <Button
          onClick={handleSave}
          disabled={saving || !hasChanges || hasIncompleteActions}
        >
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("agentSaving")}
            </>
          ) : (
            t("agentSave")
          )}
        </Button>
      </div>
      {upgradeDialogOpen && (
        <PlanUpgradeDialog
          workspaceId={workspaceId}
          subscriptionType="free"
          open
          onOpenChange={setUpgradeDialogOpen}
          reason="feature_limit"
          featureLabel={t("whatsappVoiceRepliesTitle")}
        />
      )}
    </div>
  );
}
