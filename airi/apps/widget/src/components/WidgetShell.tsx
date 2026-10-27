import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { WidgetAnalytics } from "../lib/analytics";
import {
  WidgetAPI,
  WidgetConversationNotFoundError,
  WidgetRealtimeTokenError,
} from "../lib/api";
import { exposeSimpleContextAPI, setupBridge } from "../lib/bridge";
import {
  getEffectivePageIdentifier,
  getEffectiveRoute,
  getMobileAppContext,
} from "../lib/mobile";
import type { AiriThinkingEvent, AiriTypingEvent } from "../lib/realtime";
import type { WidgetCommerce } from "../lib/commerce";
import { getRAGContext } from "../lib/rag-indexer";
import {
  clearVisitorToken,
  getConversationIdForUrl,
  getVisitorId,
  removeConversationIdEverywhere,
  setConversationIdForUrl,
  setLastSeenMessageCount,
  setWidgetOpenState,
} from "../lib/storage";
import { reconcileOptimisticById, upsertById } from "../lib/utils";
import type {
  MessageDTO,
  WidgetConfig,
  WidgetConfigResponse,
  WidgetConversationSummary,
} from "../types";
import type { VoiceClipPayload } from "./VoiceComposer";
import { WidgetBubble } from "./WidgetBubble";
import { WidgetCartRecovery } from "./WidgetCartRecovery";
import { WidgetWindow } from "./WidgetWindow";
interface WidgetShellProps {
  config?: WidgetConfig;
  serverConfig?: WidgetConfigResponse["config"] | null;
  commerce?: WidgetCommerce;
}

export const WidgetShell = ({ config, serverConfig, commerce }: WidgetShellProps) => {
  // Start closed; user opens via bubble (saved state still applied on toggle)
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allConversations, setAllConversations] = useState<
    WidgetConversationSummary[]
  >([]);
  const [currentPageUrl, setCurrentPageUrl] = useState(() =>
    getEffectivePageIdentifier(),
  );
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(null);
  const [isAiriTyping, setIsAiriTyping] = useState(false);
  const [airiThinking, setAiriThinking] = useState<{
    reasoning: string;
    phase?: string;
  } | null>(null);

  const apiRef = useRef<WidgetAPI | null>(null);
  const analyticsRef = useRef<WidgetAnalytics | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const realtimeModuleRef = useRef<Promise<
    typeof import("../lib/realtime")
  > | null>(null);
  const realtimeRequestRef = useRef(0);

  const cleanupRealtime = useCallback(() => {
    realtimeRequestRef.current += 1;
    const cleanup = cleanupRef.current;
    cleanupRef.current = null;
    cleanup?.();
  }, []);

  // Initialize API client
  useEffect(() => {
    if (!apiRef.current) {
      // Use relative URL by default (same domain as widget is embedded)
      const apiUrl = config?.apiUrl || "https://www.airi.chat/api/widget";
      apiRef.current = new WidgetAPI(apiUrl);
    }
  }, [config?.apiUrl]);

  // Initialize analytics
  useEffect(() => {
    if (!serverConfig || analyticsRef.current) return;

    const apiUrl = config?.apiUrl || "https://www.airi.chat/api/widget";
    analyticsRef.current = new WidgetAnalytics({
      workspaceId: serverConfig.workspaceId,
      companyId: serverConfig.companyId || "",
      clientKey: config?.clientKey || "",
      apiUrl,
      enabled: true,
    });

    // Start tracking
    analyticsRef.current.start();

    // Cleanup on unmount
    return () => {
      if (analyticsRef.current) {
        analyticsRef.current.stop();
      }
    };
  }, [serverConfig, config?.clientKey, config?.apiUrl]);

  useEffect(() => {
    setupBridge({
      isOpen,
      getCurrentRoute: () => getEffectivePageIdentifier(),
    });
    exposeSimpleContextAPI();
  }, [isOpen]);

  useEffect(() => {
    return cleanupRealtime;
  }, [cleanupRealtime]);

  useEffect(() => {
    setWidgetOpenState(isOpen);
  }, [isOpen]);

  const loadAllConversations = useCallback(
    async (visitorId: string): Promise<WidgetConversationSummary[] | null> => {
      if (!apiRef.current || !config?.clientKey) return null;

      try {
        const result = await apiRef.current.loadConversationHistory(
          config.clientKey,
          visitorId,
        );
        if (result.success && result.conversations) {
          setAllConversations(result.conversations);
          return result.conversations;
        }
        return null;
      } catch (err) {
        console.error("Failed to load conversation history:", err);
        // Don't show error to user, this is background loading
        return null;
      }
    },
    [config?.clientKey],
  );

  // A stored conversation the server no longer serves to this visitor
  // (deleted, or saved under another identity) is dropped, not retried.
  const forgetConversation = useCallback((conversationId: string) => {
    removeConversationIdEverywhere(conversationId);
    setCurrentConversationId((current) =>
      current === conversationId ? null : current,
    );
  }, []);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      if (!apiRef.current || !config?.clientKey) return;

      try {
        setIsLoading(true);
        setError(null);
        const loadedMessages = await apiRef.current.loadMessages(
          conversationId,
          config.clientKey,
          getVisitorId(config.identity),
        );
        setMessages(loadedMessages);

        // Mark all messages as seen when loading conversation
        setLastSeenMessageCount(conversationId, loadedMessages.length);
      } catch (err) {
        if (err instanceof WidgetConversationNotFoundError) {
          forgetConversation(conversationId);
          setMessages([]);
          return;
        }
        console.error("Failed to load messages:", err);
        const errorMessage =
          err instanceof Error
            ? err.message.includes("Failed to fetch") ||
              err.message.includes("NetworkError")
              ? "Connection error. Please check your internet connection and try again."
              : err.message
            : "Failed to load messages";
        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [config?.clientKey, config?.identity, forgetConversation],
  );

  const handleNewMessage = useCallback(
    (message: MessageDTO) => {
      console.log("Airi.chat Widget: Received new message via realtime", {
        messageId: message.id,
        conversationId: message.conversationId,
        direction: message.direction,
        text: message.text?.substring(0, 50),
      });

      // Only process messages for the current conversation
      if (message.conversationId !== currentConversationId) {
        console.log(
          "Airi.chat Widget: Ignoring message from different conversation",
          {
            messageConvId: message.conversationId,
            currentConvId: currentConversationId,
          },
        );
        return;
      }

      // Stop typing indicator when message arrives (if it's from Airi)
      if (message.direction === "outbound") {
        setIsAiriTyping(false);
        setAiriThinking(null);
      }

      // Add or update message by id (prevents duplicates and allows reconciliation).
      setMessages((prev) => {
        const exists = prev.some((m) => m.id === message.id);
        const newMessages = upsertById(prev, message);
        console.log(
          exists
            ? "Airi.chat Widget: Message already exists, updating in UI"
            : "Airi.chat Widget: Adding new message to UI",
          message.id,
        );

        // Update last seen count for current conversation
        if (currentConversationId && !exists) {
          setLastSeenMessageCount(currentConversationId, newMessages.length);
        }

        return newMessages;
      });
    },
    [currentConversationId],
  );

  const handleAiriTyping = useCallback((data: AiriTypingEvent) => {
    console.log("💬 Airi.chat Widget: Airi typing event received", data);
    if (data.started) {
      setIsAiriTyping(true);
    }
  }, []);

  const handleAiriThinking = useCallback((data: AiriThinkingEvent) => {
    console.log("💭 Airi.chat Widget: Airi thinking event received", data);
    setAiriThinking({ reasoning: data.reasoning, phase: data.phase });
  }, []);

  const handleAiriTypingStop = useCallback(() => {
    console.log("🛑 Airi.chat Widget: Airi typing stopped");
    setIsAiriTyping(false);
    // Don't clear thinking here - let it stay until message arrives for better UX
  }, []);

  const setupRealtime = useCallback(
    (conversationId: string) => {
      cleanupRealtime();

      const requestId = realtimeRequestRef.current + 1;
      realtimeRequestRef.current = requestId;

      const workspaceId = serverConfig?.workspaceId;
      const api = apiRef.current;
      if (!workspaceId || !api) {
        console.warn("Airi.chat Widget: Realtime scope is not available");
        return;
      }

      console.log(
        `Airi.chat Widget: Setting up realtime for conversation ${conversationId}`,
      );
      let realtimeModulePromise = realtimeModuleRef.current;
      if (!realtimeModulePromise) {
        const freshPromise = import("../lib/realtime");
        realtimeModuleRef.current = freshPromise;
        // Reset cached promise on failure so subsequent setupRealtime calls can
        // retry after a transient chunk/network error instead of being stuck
        // on a permanently-rejected promise.
        freshPromise.catch(() => {
          if (realtimeModuleRef.current === freshPromise) {
            realtimeModuleRef.current = null;
          }
        });
        realtimeModulePromise = freshPromise;
      }

      void realtimeModulePromise
        .then(({ subscribeToConversation }) => {
          if (requestId !== realtimeRequestRef.current) return;

          const cleanup = subscribeToConversation({
            workspaceId,
            conversationId,
            getToken: async () => {
              try {
                return await api.getRealtimeToken({
                  workspaceId,
                  conversationId,
                });
              } catch (error) {
                if (error instanceof WidgetRealtimeTokenError) {
                  if (error.code === "widget_conversation_not_found") {
                    forgetConversation(conversationId);
                  }
                  if (
                    error.code === "widget_visitor_token_invalid" ||
                    error.code === "widget_visitor_workspace_mismatch"
                  ) {
                    clearVisitorToken();
                  }
                }
                throw error;
              }
            },
            onNewMessage: handleNewMessage,
            onHydrate: () => {
              void loadMessages(conversationId);
            },
            onAiriTyping: handleAiriTyping,
            onAiriThinking: handleAiriThinking,
            onAiriTypingStop: handleAiriTypingStop,
          });

          if (requestId !== realtimeRequestRef.current) {
            cleanup?.();
            return;
          }

          if (cleanup) {
            cleanupRef.current = cleanup;
            console.log(
              `Airi.chat Widget: Realtime subscription active for conversation ${conversationId}`,
            );
          } else {
            console.error(
              "Airi.chat Widget: Failed to subscribe to realtime channel",
            );
          }
        })
        .catch((error) => {
          if (requestId === realtimeRequestRef.current) {
            console.error(
              "Airi.chat Widget: Failed to load realtime client",
              error,
            );
          }
        });
    },
    [
      cleanupRealtime,
      serverConfig?.workspaceId,
      handleNewMessage,
      handleAiriTyping,
      handleAiriThinking,
      handleAiriTypingStop,
      loadMessages,
      forgetConversation,
    ],
  );

  // Listen for mobile app context updates (must be after loadMessages/setupRealtime are defined)
  useEffect(() => {
    const handleContextUpdate = (event: CustomEvent) => {
      console.log("[Widget] Mobile app context updated:", event.detail);

      // Update current page URL to reflect new context
      const newPageUrl = getEffectivePageIdentifier();
      setCurrentPageUrl(newPageUrl);

      // If conversation exists for old URL but not new, switch conversation
      const oldConversationId = getConversationIdForUrl(currentPageUrl);
      const newConversationId = getConversationIdForUrl(newPageUrl);

      if (newConversationId && newConversationId !== oldConversationId) {
        // Switch to conversation for new tab/screen
        setCurrentConversationId(newConversationId);
        setCurrentPageUrl(newPageUrl);
        loadMessages(newConversationId);
        setupRealtime(newConversationId);
      } else if (!newConversationId && oldConversationId) {
        // New tab/screen, but no conversation yet
        // Keep current conversation but update page URL
        setCurrentPageUrl(newPageUrl);
      }
    };

    window.addEventListener(
      "icecore:context:updated",
      handleContextUpdate as EventListener,
    );

    return () => {
      window.removeEventListener(
        "icecore:context:updated",
        handleContextUpdate as EventListener,
      );
    };
  }, [currentPageUrl, config?.identity, loadMessages, setupRealtime]);

  // Load conversation history on mount (must be after loadMessages/setupRealtime are defined)
  useEffect(() => {
    if (!serverConfig || !config?.clientKey) return;

    const visitorId = getVisitorId(config?.identity);
    const pageUrl = getEffectivePageIdentifier();

    // Load all conversations for this visitor
    loadAllConversations(visitorId).then((conversations) => {
      // Load conversation for current URL first
      const existingConversationId = getConversationIdForUrl(pageUrl);

      if (existingConversationId) {
        setCurrentConversationId(existingConversationId);
        loadMessages(existingConversationId);
        setupRealtime(existingConversationId);
      } else if (conversations && conversations.length > 0) {
        // No conversation for current URL, but visitor has conversations from other pages
        // Load most recent conversation by default
        const mostRecent = conversations[0]; // Already sorted by lastMessageAt DESC
        setCurrentConversationId(mostRecent.id);
        setCurrentPageUrl(mostRecent.pageUrl);
        loadMessages(mostRecent.id);
        setupRealtime(mostRecent.id);

        console.log(
          "[Widget] Loaded most recent conversation from other page:",
          {
            conversationId: mostRecent.id,
            pageUrl: mostRecent.pageUrl,
            messageCount: mostRecent.messageCount,
          },
        );
      }
    });
  }, [
    serverConfig,
    config?.clientKey,
    config?.identity,
    loadAllConversations,
    loadMessages,
    setupRealtime,
  ]);

  const handleToggle = () => {
    setIsOpen((prev) => !prev);
  };

  const handleDismissError = () => {
    setError(null);
  };

  const handleSendMessage = async (
    text: string,
    imageFile?: File,
    voiceClip?: VoiceClipPayload,
  ) => {
    if (!apiRef.current || !config?.clientKey) return;
    if (!text.trim() && !imageFile && !voiceClip) return;

    const visitorId = getVisitorId(config?.identity);
    const pageUrl = getEffectivePageIdentifier();
    const existingConversationId = getConversationIdForUrl(pageUrl);

    // Upload media file first if provided
    let mediaUrl: string | undefined;
    let mediaType:
      | "image"
      | "video"
      | "audio"
      | "document"
      | "sticker"
      | "voice"
      | "file"
      | undefined;
    let mimeType: string | undefined;
    let fileName: string | undefined;
    let fileSize: number | undefined;

    const mediaFile = imageFile || voiceClip?.file;
    if (mediaFile) {
      try {
        const uploadResult = await apiRef.current.uploadFile(
          mediaFile,
          config.clientKey,
          (progress) => {
            // Could show progress UI here
            console.log(`Upload progress: ${progress}%`);
          },
        );

        if (!uploadResult.success || !uploadResult.url) {
          throw new Error(uploadResult.error || "Failed to upload media");
        }

        mediaUrl = uploadResult.url;
        mediaType = uploadResult.mediaType || (imageFile ? "image" : "voice");
        mimeType =
          uploadResult.mimeType ||
          voiceClip?.mimeType ||
          mediaFile.type ||
          undefined;
        fileName = uploadResult.fileName || mediaFile.name || undefined;
        fileSize = uploadResult.fileSize || mediaFile.size || undefined;
      } catch (err) {
        console.error("Failed to upload media:", err);
        analyticsRef.current?.trackEvent("widget_error", {
          error_type: "media_upload_failed",
          has_media: true,
          media_type: imageFile ? "image" : "voice",
          page_url: getEffectiveRoute(),
        });
        setError(
          err instanceof Error
            ? err.message
            : "Failed to upload media. Please try again.",
        );
        return;
      }
    }

    const resolvedText = text.trim() || (voiceClip ? "[Voice message]" : "");

    // Optimistic UI: Add message immediately (Notion-style)
    const optimisticMessage: MessageDTO = {
      id: `temp-${Date.now()}`,
      conversationId: existingConversationId || "",
      text: resolvedText,
      direction: "inbound",
      timestamp: new Date().toISOString(),
      authorName: config?.identity?.userName || "You",
      imageUrl: mediaUrl, // Legacy field used by existing renderer/API
      mediaUrl,
      mediaType: mediaType || null,
      mimeType: mimeType || null,
      fileName: fileName || null,
      fileSize: typeof fileSize === "number" ? fileSize : null,
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    setIsSending(true);
    setError(null);

    try {
      // Get RAG context for current tab/page
      const ragContext = getRAGContext();
      const appContext = getMobileAppContext();

      const sendRequest: Parameters<WidgetAPI["sendMessage"]>[0] = {
        text: typeof resolvedText === "string" ? resolvedText : "",
        clientKey: config.clientKey,
        imageUrl: mediaType === "image" ? mediaUrl : undefined,
        mediaUrl,
        mediaType,
        mimeType,
        fileName,
        fileSize,
        metadata: {
          customerId: visitorId,
          pageUrl: getEffectiveRoute(),
          pageIdentifier: pageUrl, // Full identifier including tab/screen
          userAgent: navigator.userAgent,
          referrer:
            typeof document !== "undefined"
              ? document.referrer || undefined
              : undefined,
          // Include user identity if provided (for authenticated users)
          userEmail: config?.identity?.userEmail || undefined,
          userName: config?.identity?.userName || undefined,
          // Mobile app context
          ...(appContext
            ? {
                currentTab: appContext.currentTab,
                screenName: appContext.screenName,
                route: appContext.route,
                appMetadata: appContext.metadata,
              }
            : {}),
          // RAG context for AI
          ...(ragContext
            ? {
                ragContext: ragContext.substring(0, 2000), // Limit size
              }
            : {}),
        },
      };
      let sentConversationId = existingConversationId || undefined;
      let response;
      try {
        response = await apiRef.current.sendMessage({
          ...sendRequest,
          conversationId: sentConversationId,
        });
      } catch (sendError) {
        if (
          !sentConversationId ||
          !(sendError instanceof WidgetConversationNotFoundError)
        ) {
          throw sendError;
        }
        // The stored conversation is not this visitor's; start a new one.
        forgetConversation(sentConversationId);
        sentConversationId = undefined;
        response = await apiRef.current.sendMessage(sendRequest);
      }

      if (response.success && response.message) {
        // Reconcile optimistic + realtime copies without creating duplicates.
        const confirmedMessage = response.message;
        setMessages((prev) =>
          reconcileOptimisticById(prev, optimisticMessage.id, confirmedMessage),
        );
        analyticsRef.current?.trackEvent("widget_message_send", {
          conversation_started: Boolean(
            response.conversationId && !sentConversationId,
          ),
          has_media: Boolean(mediaUrl),
          media_type: mediaType || (voiceClip ? "voice" : "text"),
          page_url: getEffectiveRoute(),
        });

        // Save conversation ID if this was the first message
        if (response.conversationId && !sentConversationId) {
          setConversationIdForUrl(pageUrl, response.conversationId);
          setCurrentConversationId(response.conversationId);
          setupRealtime(response.conversationId);
          // Reload conversation list to include new conversation
          loadAllConversations(visitorId);
        }
      }
    } catch (err) {
      // Remove optimistic message on error
      setMessages((prev) =>
        prev.filter((msg) => msg.id !== optimisticMessage.id),
      );
      console.error("Failed to send message:", err);
      analyticsRef.current?.trackEvent("widget_error", {
        error_type: "message_send_failed",
        has_media: Boolean(mediaUrl),
        media_type: mediaType || (voiceClip ? "voice" : "text"),
        page_url: getEffectiveRoute(),
      });

      // Provide user-friendly error messages
      let errorMessage = "Failed to send message";
      if (err instanceof Error) {
        if (
          err.message.includes("Failed to fetch") ||
          err.message.includes("NetworkError")
        ) {
          errorMessage =
            "Connection error. Please check your internet connection and try again.";
        } else if (
          err.message.includes("timeout") ||
          err.message.includes("Timeout")
        ) {
          errorMessage = "Request timed out. Please try again.";
        } else {
          errorMessage = err.message;
        }
      }
      setError(errorMessage);
    } finally {
      setIsSending(false);
    }
  };

  const handleStartConversation = useCallback(() => {
    setMessages((prev) => {
      if (prev.length > 0) return prev; // Already have messages, don't add greeting
      const welcomeMessage =
        serverConfig?.settings?.welcomeMessage || "How can we help you today?";
      const greetingMessage: MessageDTO = {
        id: "greeting-local",
        conversationId: "",
        text: welcomeMessage,
        direction: "outbound",
        timestamp: new Date().toISOString(),
      };
      return [greetingMessage, ...prev];
    });
  }, [serverConfig?.settings?.welcomeMessage]);

  const handleSwitchConversation = useCallback(
    (conversationId: string, pageUrl: string) => {
      cleanupRealtime();

      // Update state
      setCurrentConversationId(conversationId);
      setCurrentPageUrl(pageUrl);
      setMessages([]);
      setIsAiriTyping(false);
      setAiriThinking(null);

      // Load messages for the selected conversation
      loadMessages(conversationId);
      setupRealtime(conversationId);
    },
    [cleanupRealtime, loadMessages, setupRealtime],
  );

  // Fallback config when API fails — window still opens, user sees error banner
  const FALLBACK_CONFIG: NonNullable<WidgetConfigResponse["config"]> = {
    sourceId: "",
    workspaceId: "",
    companyId: "",
    theme: {
      primaryColor: "#0B6BCB",
      bubbleColor: "#0B6BCB",
      headerBgColor: "#FFFFFF",
      headerTextColor: "#111827",
    },
    settings: {
      welcomeMessage: "How can we help you today?",
      responseTime: "Usually within a few hours",
      aiEnabled: true,
      autoOpen: false,
      position: "bottom-right",
    },
    content: {
      botName: "Support",
      headerTitle: "Chat with us",
      heroTitle: "",
      ctaPrimaryText: "Send us a message",
      ctaSecondaryText: "We typically reply in a few minutes",
      quickReplies: [
        "How can I get support?",
        "What are your business hours?",
        "How do I track my order?",
        "Do you offer refunds?",
      ],
    },
    branding: {
      bubbleMode: "icon",
      bubbleText: "",
      bubbleSvgUrl: "",
      logoMode: "default",
      logoText: "",
      logoSvgUrl: "",
    },
    layout: {
      homeVariant: "intercom",
      showHelpTab: true,
      showNewsTab: true,
    },
    locale: "en",
    realtime: { url: "" },
  };

  const effectiveConfig = serverConfig ?? FALLBACK_CONFIG;
  const configLoadFailed = !serverConfig;

  return (
    <div className="widget-container">
      {!isOpen && commerce ? (
        <WidgetCartRecovery
          commerce={commerce}
          locale={serverConfig?.locale ?? config?.locale}
        />
      ) : null}
      <WidgetBubble
        onClick={handleToggle}
        disabled={false}
        isOpen={isOpen}
        bubbleMode={effectiveConfig.branding?.bubbleMode}
        bubbleText={effectiveConfig.branding?.bubbleText}
        bubbleSvgUrl={effectiveConfig.branding?.bubbleSvgUrl}
      />
      {isOpen && (
        <WidgetWindow
          onClose={handleToggle}
          onSendMessage={handleSendMessage}
          onStartConversation={handleStartConversation}
          onSwitchConversation={handleSwitchConversation}
          serverConfig={effectiveConfig}
          configLoadFailed={configLoadFailed}
          messages={messages}
          isLoading={isLoading}
          isSending={isSending}
          error={error}
          onDismissError={handleDismissError}
          allConversations={allConversations}
          currentConversationId={currentConversationId}
          currentPageUrl={currentPageUrl}
          isAiriTyping={isAiriTyping}
          airiThinking={airiThinking}
          clientKey={config?.clientKey}
          apiUrl={config?.apiUrl || "https://www.airi.chat/api/widget"}
        />
      )}
    </div>
  );
};
