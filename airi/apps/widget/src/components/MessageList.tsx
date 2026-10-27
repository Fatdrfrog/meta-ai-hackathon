import type { MessageDTO } from "@icecore/shared/types/message";
import { useState } from "preact/hooks";
import {
  CheckIcon,
  ChatIcon,
  ChevronRightIcon,
  CopyIcon,
} from "../assets/icons";
import { ConversationContent, ConversationEmptyState } from "./ui/conversation";
import { CsatRequestMessage } from "./CsatRequestMessage";
import { hasMarkdown, parseMarkdown, type MarkdownNode } from "../lib/markdown";
import { getAbsoluteTime, getRelativeTime } from "../lib/relative-time";

interface MessageListProps {
  messages?: MessageDTO[];
  isLoading?: boolean;
  error?: string | null;
  onSuggestionSelect?: (text: string) => void;
  onStartConversation?: () => void;
  welcomeMessage?: string;
  onDismissError?: () => void;
  isAiriTyping?: boolean;
  airiThinking?: { reasoning: string; phase?: string } | null;
  conversationId?: string;
  apiUrl?: string;
  clientKey?: string;
}

const EMPTY_MESSAGES: MessageDTO[] = [];

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function sanitizeMessageHref(url: string): string | null {
  const trimmed = String(url || "").trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed, "https://airi.chat");
    const hasProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
    if (hasProtocol && !SAFE_LINK_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function renderMarkdownNode(node: MarkdownNode, key: string) {
  switch (node.type) {
    case "text":
      return node.content;
    case "bold":
      return <strong key={key}>{node.content}</strong>;
    case "italic":
      return <em key={key}>{node.content}</em>;
    case "link": {
      const href = sanitizeMessageHref(node.url);
      if (!href) return <span key={key}>{node.text}</span>;
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="message-link"
        >
          {node.text}
        </a>
      );
    }
  }
}

function renderMarkdownText(text: string) {
  return text.split("\n").flatMap((line, lineIndex, lines) => {
    const nodes = parseMarkdown(line).map((node, nodeIndex) =>
      renderMarkdownNode(node, `${lineIndex}-${nodeIndex}`),
    );
    return lineIndex < lines.length - 1
      ? [...nodes, <br key={`br-${lineIndex}`} />]
      : nodes;
  });
}

// Separate component to handle hover state (avoids hooks in map)
const MessageItem = ({
  message,
  index,
  conversationId,
  apiUrl,
  clientKey,
}: {
  message: MessageDTO;
  index: number;
  conversationId?: string;
  apiUrl?: string;
  clientKey?: string;
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  // CSAT request messages get a special component
  if (
    message.actionType === "csat_request" &&
    conversationId &&
    apiUrl &&
    clientKey
  ) {
    return (
      <CsatRequestMessage
        conversationId={conversationId}
        apiUrl={apiUrl}
        clientKey={clientKey}
      />
    );
  }

  const isUserMessage = message.direction === "inbound";
  const mediaUrl = message.mediaUrl || message.imageUrl;
  const inferredAudioByMime =
    typeof message.mimeType === "string" &&
    message.mimeType.startsWith("audio/");
  const inferredAudioByUrl =
    typeof mediaUrl === "string" &&
    /\.(webm|ogg|mp3|wav|m4a)(\?|$)/i.test(mediaUrl);
  const isAudioMessage =
    Boolean(mediaUrl) &&
    (message.mediaType === "audio" ||
      message.mediaType === "voice" ||
      inferredAudioByMime ||
      inferredAudioByUrl);
  const isImageMessage = Boolean(message.imageUrl) && !isAudioMessage;
  const relativeTime = message.timestamp
    ? getRelativeTime(message.timestamp)
    : "";
  const absoluteTime = message.timestamp
    ? getAbsoluteTime(message.timestamp)
    : "";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`message message-${isUserMessage ? "user" : "agent"} message-fade-in`}
      style={{ animationDelay: `${Math.min(index * 50, 200)}ms` }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {!isUserMessage && message.authorName && (
        <div className="message-author">{message.authorName}</div>
      )}
      <div className="message-bubble">
        {hasMarkdown(message.text) ? (
          <div className="message-text message-markdown">
            {renderMarkdownText(message.text)}
          </div>
        ) : (
          <div className="message-text">{message.text}</div>
        )}
        {relativeTime && (
          <div className="message-timestamp" title={absoluteTime}>
            {relativeTime}
          </div>
        )}
      </div>
      {isImageMessage && (
        <img
          src={message.imageUrl}
          alt="Attachment"
          className="message-image"
        />
      )}
      {isAudioMessage && mediaUrl && (
        <div className="message-audio-wrap">
          <audio
            className="message-audio"
            controls
            preload="metadata"
            src={mediaUrl}
          />
          {message.audioAnalysis ? (
            <div className="message-audio-analysis">
              {message.audioAnalysis}
            </div>
          ) : null}
        </div>
      )}

      {/* Hover actions (Notion-style) */}
      {isHovered && (
        <div className="message-actions">
          <button
            type="button"
            className="message-action-btn"
            onClick={handleCopy}
            title={copied ? "Copied!" : "Copy message"}
            aria-label={copied ? "Copied!" : "Copy message"}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      )}
    </div>
  );
};

export const MessageList = ({
  messages = EMPTY_MESSAGES,
  isLoading = false,
  error = null,
  welcomeMessage = "How can we assist you today?",
  onSuggestionSelect,
  onStartConversation,
  onDismissError,
  isAiriTyping = false,
  airiThinking = null,
  conversationId,
  apiUrl,
  clientKey,
}: MessageListProps) => {
  const isEmpty = messages.length === 0 && !isLoading;
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const isErrorDismissed = error != null && dismissedError === error;

  const handleDismissError = () => {
    setDismissedError(error);
    onDismissError?.();
  };

  return (
    <>
      {isEmpty ? (
        <ConversationEmptyState className="widget-empty-messages">
          <div className="widget-empty-messages-icon">
            <ChatIcon />
          </div>
          <h3 className="widget-empty-messages-title">No messages</h3>
          <p className="widget-empty-messages-text">
            Messages from the team will be displayed here
          </p>
          <button
            type="button"
            className="widget-empty-messages-button"
            onClick={onStartConversation}
          >
            <span>Send us a message</span>
            <span
              className="widget-empty-messages-button-icon"
              aria-hidden="true"
            >
              <ChevronRightIcon />
            </span>
          </button>
        </ConversationEmptyState>
      ) : (
        <ConversationContent className="widget-chat-content">
          {messages.map((message, index) => (
            <MessageItem
              key={message.id}
              message={message}
              index={index}
              conversationId={conversationId}
              apiUrl={apiUrl}
              clientKey={clientKey}
            />
          ))}
          {/* Airi thinking/reasoning panel */}
          {airiThinking && (
            <div className="message message-agent airi-thinking-panel">
              <div className="airi-thinking-content">
                <div className="airi-thinking-header">
                  <span className="airi-thinking-label">
                    Preparing a reply…
                  </span>
                </div>
                <div className="airi-thinking-reasoning">
                  {airiThinking.reasoning}
                </div>
              </div>
            </div>
          )}
          {/* Airi typing indicator */}
          {isAiriTyping && (
            <div className="message message-agent airi-typing-indicator">
              <div className="message-bubble">
                <div className="typing-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}
          {isLoading && (
            <div className="message message-agent message-fade-in">
              <div className="message-bubble">
                <div className="typing-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}
        </ConversationContent>
      )}
      {error && !isErrorDismissed && (
        <div className="widget-error">
          <span className="widget-error-text">{error}</span>
          <button
            className="widget-error-dismiss"
            onClick={handleDismissError}
            type="button"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};
