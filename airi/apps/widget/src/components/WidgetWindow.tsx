import type { MessageDTO } from "@icecore/shared/types/message";
import { lazy, Suspense } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  ChatIcon,
  ChevronLeftIcon,
  CloseIcon,
  HelpIcon,
  HomeIcon,
} from "../assets/icons";
import {
  getWidgetPosition,
  setWidgetPosition,
  type WidgetPosition,
} from "../lib/storage";
import type { WidgetConfigResponse, WidgetConversationSummary } from "../types";
import { ArticleListView, type HelpArticleItem } from "./ArticleListView";
import { ArticleView } from "./ArticleView";
import { HelpView, type HelpCollection, type HelpViewStatus } from "./HelpView";
import { MessageList } from "./MessageList";
import { ConversationSwitcher } from "./ConversationSwitcher";
import { WidgetWelcome } from "./WidgetWelcome";
import type { VoiceClipPayload } from "./VoiceComposer";
import { Conversation, ConversationScrollButton } from "./ui/conversation";

interface WidgetWindowProps {
  onClose: () => void;
  onSendMessage?: (
    message: string,
    imageFile?: File,
    voiceClip?: VoiceClipPayload,
  ) => void;
  onStartConversation?: () => void;
  onSwitchConversation?: (conversationId: string, pageUrl: string) => void;
  serverConfig: WidgetConfigResponse["config"];
  configLoadFailed?: boolean;
  messages?: MessageDTO[];
  isLoading?: boolean;
  isSending?: boolean;
  error?: string | null;
  onDismissError?: () => void;
  allConversations?: WidgetConversationSummary[];
  currentConversationId?: string | null;
  currentPageUrl?: string;
  isAiriTyping?: boolean;
  airiThinking?: { reasoning: string; phase?: string } | null;
  /** Client key for API calls */
  clientKey?: string;
  /** API URL base for widget endpoints */
  apiUrl?: string;
}

const DEFAULT_QUICK_REPLIES = [
  "How can I get support?",
  "What are your business hours?",
  "How do I track my order?",
  "Do you offer refunds?",
];

const EMPTY_MESSAGES: MessageDTO[] = [];
const EMPTY_CONVERSATIONS: WidgetConversationSummary[] = [];

const VoiceComposer = lazy(() =>
  import("./VoiceComposer").then((module) => ({
    default: module.VoiceComposer,
  })),
);

export const WidgetWindow = ({
  onClose,
  onSendMessage,
  onStartConversation,
  onSwitchConversation,
  serverConfig,
  messages = EMPTY_MESSAGES,
  isLoading = false,
  isSending = false,
  error = null,
  onDismissError,
  allConversations = EMPTY_CONVERSATIONS,
  currentConversationId = null,
  currentPageUrl = "",
  isAiriTyping = false,
  airiThinking = null,
  clientKey,
  apiUrl = "https://www.airi.chat/api/widget",
}: WidgetWindowProps) => {
  const [position, setPosition] = useState<WidgetPosition>(() =>
    getWidgetPosition(),
  );
  const [isDragging, setIsDragging] = useState(false);
  const [rawSpace, setSpace] = useState<"home" | "chat" | "help">("home");
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);

  // Help collections state (lazy-loaded on first Help tab visit)
  const [helpCollections, setHelpCollections] = useState<HelpCollection[]>([]);
  const [helpStatus, setHelpStatus] = useState<HelpViewStatus>("idle");
  const helpLoadedRef = useRef(false);

  // Phase 2: Help view navigation (collections → article list → article)
  const [helpViewMode, setHelpViewMode] = useState<
    "collections" | "articles" | "article"
  >("collections");
  const [selectedCollection, setSelectedCollection] =
    useState<HelpCollection | null>(null);
  const [selectedArticle, setSelectedArticle] =
    useState<HelpArticleItem | null>(null);

  // Active Chat View hides bottom nav and shows back button.
  const isActiveChatView = rawSpace === "chat";

  // Expanded reading mode: true when viewing an article in the Help tab
  const isExpandedMode = helpViewMode === "article" && selectedArticle !== null;

  const content = serverConfig?.content ?? {};
  const branding = serverConfig?.branding ?? {};
  const layout = serverConfig?.layout ?? {};

  const welcomeMessage =
    serverConfig?.settings?.welcomeMessage || "How can we help you today?";
  const headerTitle = content.headerTitle?.trim() || "Chat with us";
  const heroTitle = content.heroTitle?.trim() ?? "";
  const ctaPrimaryText = content.ctaPrimaryText?.trim() || "Send us a message";
  const ctaSecondaryText =
    content.ctaSecondaryText?.trim() || "We typically reply in a few minutes";
  const quickReplies = Array.isArray(content.quickReplies)
    ? content.quickReplies.flatMap((item) => {
        if (typeof item !== "string") return [];
        const trimmed = item.trim();
        return trimmed ? [trimmed] : [];
      })
    : DEFAULT_QUICK_REPLIES;

  const logoMode = branding.logoMode || "default";
  const logoText = branding.logoText?.trim();
  const logoSvgUrl = branding.logoSvgUrl?.trim();
  const homeVariant = layout.homeVariant || "intercom";
  const showHelpTab = layout.showHelpTab ?? true;
  const tabCount = showHelpTab ? 2 : 1;
  const space = !showHelpTab && rawSpace === "help" ? "home" : rawSpace;
  const activeConversationId =
    currentConversationId ?? messages[0]?.conversationId;

  const renderHeaderLogo = () => {
    if (logoMode === "svg" && logoSvgUrl) {
      return (
        <img
          src={logoSvgUrl}
          alt=""
          className="widget-header-logo-image"
          loading="lazy"
          decoding="async"
        />
      );
    }

    if (logoMode === "text" && logoText) {
      return <span className="widget-header-logo-text">{logoText}</span>;
    }

    return (
      <span className="widget-header-logo-default-icon" aria-hidden="true">
        <ChatIcon />
      </span>
    );
  };

  // Keyboard shortcuts (Notion-like)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ESC to close widget
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Draggable functionality
  const handleMouseDown = (e: MouseEvent) => {
    // Only drag from header, not from close button
    const target = e.target as HTMLElement;
    if (target.closest(".widget-close-button")) {
      return;
    }

    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
    };
  };

  // Double-click header to reset position (Notion-style)
  const handleDoubleClick = () => {
    const defaultPos = { bottom: 20, right: 20 };
    setPosition(defaultPos);
    setWidgetPosition(defaultPos);
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current || !windowRef.current) return;

      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      // Get widget dimensions
      const rect = windowRef.current.getBoundingClientRect();
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      // Calculate new position (widget is positioned from bottom-right)
      // When dragging right (positive deltaX), right should decrease
      // When dragging up (negative deltaY), bottom should increase
      let newRight = position.right - deltaX;
      let newBottom = position.bottom - deltaY; // ✅ FIXED: Inverted to match drag direction

      // Boundary checks (keep widget on screen)
      const minMargin = 10;
      newRight = Math.max(
        minMargin,
        Math.min(newRight, windowWidth - rect.width - minMargin),
      );
      newBottom = Math.max(
        minMargin,
        Math.min(newBottom, windowHeight - rect.height - minMargin),
      );

      // Update position
      const newPosition = { right: newRight, bottom: newBottom };
      setPosition(newPosition);

      // Update drag start for next move
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
      };
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;

      // Save position to localStorage
      setWidgetPosition(position);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, position]);

  // Lazy-load Help collections when Help tab is first visited
  const fetchHelpCollections = async () => {
    if (!clientKey) {
      setHelpStatus("error");
      return;
    }

    try {
      setHelpStatus("loading");
      const response = await fetch(
        `${apiUrl}/help/collections?client_key=${encodeURIComponent(clientKey)}`,
        {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.success && Array.isArray(data.collections)) {
        setHelpCollections(data.collections);
        setHelpStatus("success");
      } else {
        throw new Error(data.error || "Failed to load collections");
      }
    } catch (err) {
      console.error("[Widget] Failed to fetch help collections:", err);
      setHelpStatus("error");
    }
  };

  // Trigger fetch when Help tab is opened for the first time
  useEffect(() => {
    if (space === "help" && !helpLoadedRef.current && helpStatus === "idle") {
      helpLoadedRef.current = true;
      fetchHelpCollections();
    }
  }, [space, helpStatus, clientKey, apiUrl]);

  const handleRetryHelpCollections = () => {
    setHelpStatus("idle");
    helpLoadedRef.current = false;
    fetchHelpCollections();
  };

  return (
    <div
      ref={windowRef}
      className={`widget-window ${isDragging ? "dragging" : ""} ${space === "home" ? "widget-window--home" : ""} ${isExpandedMode ? "widget-window--expanded" : ""}`}
      style={{
        position: "fixed",
        bottom: `${position.bottom}px`,
        right: `${position.right}px`,
      }}
      role="dialog"
      aria-label="Chat widget"
    >
      <div
        className={`widget-header ${space === "home" ? "widget-header--home" : ""} ${space === "chat" ? "widget-header--messages" : ""} ${space === "help" ? "widget-header--help" : ""}`}
        onMouseDown={handleMouseDown}
        onDblClick={handleDoubleClick}
        title="Drag to reposition • Double-click to reset"
      >
        {space === "help" ? (
          <h2 className="widget-header-help-title">Help</h2>
        ) : space === "chat" ? (
          <>
            <button
              type="button"
              className="widget-header-back-button"
              onClick={() => setSpace("home")}
              aria-label="Back to home"
            >
              <ChevronLeftIcon />
            </button>
            <h2 className="widget-header-messages-title">Chat</h2>
          </>
        ) : (
          <div className="widget-header-brand">
            <div className="widget-header-logo">{renderHeaderLogo()}</div>
            <div className="widget-header-title">{headerTitle}</div>
          </div>
        )}
        <button
          className="widget-close-button"
          onClick={onClose}
          type="button"
          aria-label="Close chat (Esc)"
        >
          <CloseIcon />
        </button>
      </div>

      <div
        className={`widget-window-body ${isActiveChatView ? "widget-window-body--chat-view" : ""}`}
      >
        {space === "home" ? (
          <div className="widget-messages widget-messages--home">
            <WidgetWelcome
              heroTitle={heroTitle}
              welcomeMessage={welcomeMessage}
              ctaPrimaryText={ctaPrimaryText}
              ctaSecondaryText={ctaSecondaryText}
              quickReplies={quickReplies}
              variant={homeVariant}
              onOpenMessages={() => {
                onStartConversation?.();
                setSpace("chat");
              }}
              onSuggestionSelect={(text) => {
                setSpace("chat");
                onSendMessage?.(text);
              }}
              onSearchClick={() => setSpace("help")}
            />
          </div>
        ) : space === "help" ? (
          helpViewMode === "article" && selectedArticle ? (
            <ArticleView
              articleId={selectedArticle.id}
              articleTitle={selectedArticle.title}
              articleUrl={selectedArticle.url}
              clientKey={clientKey || ""}
              apiUrl={apiUrl}
              onBack={() => {
                if (selectedCollection) {
                  // Came from article list → go back to article list
                  setHelpViewMode("articles");
                } else {
                  // Came from direct leaf click → go back to collections
                  setHelpViewMode("collections");
                }
                setSelectedArticle(null);
              }}
            />
          ) : helpViewMode === "articles" && selectedCollection ? (
            <ArticleListView
              collectionId={selectedCollection.id}
              collectionTitle={selectedCollection.title}
              clientKey={clientKey || ""}
              apiUrl={apiUrl}
              onArticleSelect={(article) => {
                setSelectedArticle(article);
                setHelpViewMode("article");
              }}
              onBack={() => {
                setHelpViewMode("collections");
                setSelectedCollection(null);
              }}
            />
          ) : (
            <HelpView
              collections={helpCollections}
              status={helpStatus}
              onRetry={handleRetryHelpCollections}
              clientKey={clientKey}
              apiUrl={apiUrl}
              onCollectionSelect={(collection) => {
                setSelectedCollection(collection);
                setHelpViewMode("articles");
              }}
              onArticleSelect={(collection) => {
                // Leaf article: skip article list, go directly to expanded reader
                setSelectedArticle({
                  id: collection.id,
                  title: collection.title,
                  url: collection.url,
                });
                setSelectedCollection(null); // Mark as direct leaf (no parent collection)
                setHelpViewMode("article");
              }}
            />
          )
        ) : (
          <div
            className="widget-view-transition widget-view-slide-right widget-chat-view"
            key="chat"
          >
            {onSwitchConversation && (
              <ConversationSwitcher
                conversations={allConversations}
                currentConversationId={currentConversationId}
                currentPageUrl={currentPageUrl}
                onSwitch={onSwitchConversation}
              />
            )}
            <Conversation
              className="widget-chat-view-messages"
              initial="instant"
            >
              <MessageList
                messages={messages}
                isLoading={isLoading || isSending}
                error={error}
                onSuggestionSelect={(text) => onSendMessage?.(text)}
                onStartConversation={onStartConversation}
                welcomeMessage={welcomeMessage}
                onDismissError={onDismissError}
                isAiriTyping={isAiriTyping}
                airiThinking={airiThinking}
                conversationId={activeConversationId ?? undefined}
                apiUrl={apiUrl}
                clientKey={clientKey}
              />
              <ConversationScrollButton className="widget-conversation-scroll-button" />
            </Conversation>
            <Suspense fallback={null}>
              <VoiceComposer onSend={onSendMessage} disabled={isSending} />
            </Suspense>
          </div>
        )}
      </div>

      {showHelpTab && !isActiveChatView && !isExpandedMode && (
        <div
          className={`widget-space-tabs widget-space-tabs--bottom widget-space-tabs--${tabCount}`}
          role="tablist"
          aria-label="Spaces"
        >
          <button
            type="button"
            role="tab"
            aria-selected={space === "home"}
            className={`widget-space-tab ${space === "home" ? "active" : ""}`}
            onClick={() => setSpace("home")}
          >
            <HomeIcon />
            <span>Home</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={space === "help"}
            className={`widget-space-tab ${space === "help" ? "active" : ""}`}
            onClick={() => setSpace("help")}
          >
            <HelpIcon />
            <span>Help</span>
          </button>
        </div>
      )}
    </div>
  );
};
