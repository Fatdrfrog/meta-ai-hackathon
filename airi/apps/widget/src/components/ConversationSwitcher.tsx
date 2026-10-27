import { useState } from "preact/hooks";
import type { WidgetConversationSummary } from "@icecore/shared/types/widget-config";
import { formatUrl, formatRelativeTime } from "../lib/utils";
import { getUnreadCount } from "../lib/storage";
import { PageIcon } from "../assets/icons";

interface ConversationSwitcherProps {
  conversations: WidgetConversationSummary[];
  currentConversationId: string | null;
  currentPageUrl: string;
  onSwitch: (conversationId: string, pageUrl: string) => void;
}

export const ConversationSwitcher = ({
  conversations,
  currentConversationId,
  currentPageUrl,
  onSwitch,
}: ConversationSwitcherProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Don't show switcher if there's only one or no conversations
  if (conversations.length <= 1) {
    return null;
  }

  const currentConv = conversations.find((c) => c.id === currentConversationId);
  const otherConversations = conversations.filter(
    (c) => c.id !== currentConversationId,
  );

  return (
    <div className="conversation-switcher">
      <button
        className="switcher-toggle"
        onClick={() => setIsExpanded(!isExpanded)}
        type="button"
        aria-expanded={isExpanded}
        aria-haspopup="listbox"
      >
        <div className="switcher-current">
          <span className="switcher-icon">
            <PageIcon />
          </span>
          <div className="switcher-info">
            <div className="switcher-url">{formatUrl(currentPageUrl)}</div>
            {currentConv && (
              <div className="switcher-meta">
                {currentConv.messageCount} messages
                {currentConv.lastMessagePreview && (
                  <span className="switcher-preview">
                    {" "}
                    · {currentConv.lastMessagePreview}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <span className="switcher-arrow">{isExpanded ? "▲" : "▼"}</span>
      </button>

      {isExpanded && otherConversations.length > 0 && (
        <div className="switcher-dropdown">
          <div className="switcher-dropdown-header">Other pages</div>
          {otherConversations.map((conv) => {
            const unreadCount = getUnreadCount(conv.id, conv.messageCount);

            return (
              <button
                key={conv.id}
                className="switcher-item"
                onClick={() => {
                  onSwitch(conv.id, conv.pageUrl);
                  setIsExpanded(false);
                }}
                type="button"
                role="option"
                aria-selected={false}
              >
                <span className="switcher-icon">
                  <PageIcon />
                </span>
                <div className="switcher-info">
                  <div className="switcher-url">
                    {formatUrl(conv.pageUrl)}
                    {unreadCount > 0 && (
                      <span className="switcher-unread-badge">
                        {unreadCount}
                      </span>
                    )}
                  </div>
                  <div className="switcher-meta">
                    {conv.messageCount} messages ·{" "}
                    {formatRelativeTime(conv.lastMessageAt)}
                  </div>
                  {conv.lastMessagePreview && (
                    <div className="switcher-preview">
                      {conv.lastMessagePreview}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
