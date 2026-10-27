"use client";

import { LazyConversationDetailView } from "@/components/conversation/lazy-conversation-detail-view";
import type { FormattedRequest } from "@/features/panel/requests/formatting";
import { motion } from "framer-motion";
import { MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";

const PANEL_TRANSITION = { duration: 0.08, ease: "easeOut" } as const;

interface ChatPanelProps {
  conversationId: string | null;
  workspaceId?: string;
  initialHighlightedMessageId?: string;
  searchQuery?: string | null;
  onBack?: () => void;
  requestPreview?: FormattedRequest | null;
}
export function ChatPanel({
  conversationId,
  workspaceId,
  initialHighlightedMessageId,
  searchQuery = null,
  onBack,
  requestPreview = null,
}: ChatPanelProps) {
  const t = useTranslations("ChatPanel");

  return (
    <div className="flex min-h-0 min-w-0 flex-col h-full w-full overflow-hidden bg-background md:bg-background/50">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden relative flex flex-col">
        {conversationId ? (
          <div
            key={conversationId}
            className="min-h-0 min-w-0 flex-1 overflow-hidden flex flex-col"
          >
            <LazyConversationDetailView
              conversationId={conversationId}
              workspaceId={workspaceId}
              initialHighlightedMessageId={initialHighlightedMessageId}
              searchQuery={searchQuery}
              onBack={onBack}
              requestPreview={requestPreview}
            />
          </div>
        ) : (
          <motion.div
            key="empty-state"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={PANEL_TRANSITION}
            className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 md:p-8 text-center"
          >
            <motion.div
              className="mb-4 rounded-full bg-muted p-6"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1, duration: 0.3, ease: "easeOut" }}
            >
              <MessageCircle
                className="w-12 h-12 text-muted-foreground/50"
                aria-hidden="true"
              />
            </motion.div>
            <motion.h3
              className="text-lg md:text-xl font-semibold mb-2"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.2, ease: "easeOut" }}
            >
              {t("selectConversation")}
            </motion.h3>
            <motion.p
              className="max-w-sm mx-auto text-sm md:text-base"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.2, ease: "easeOut" }}
            >
              {t("chooseConversation")}
            </motion.p>
          </motion.div>
        )}
      </div>
    </div>
  );
}
