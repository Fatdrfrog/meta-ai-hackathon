"use client";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ChatPanel } from "./chat-panel";

interface ConversationDetailDrawerProps {
  conversationId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string;
  initialHighlightedMessageId?: string;
}

export function ConversationDetailDrawer({
  conversationId,
  open,
  onOpenChange,
  workspaceId,
  initialHighlightedMessageId,
}: ConversationDetailDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex h-dvh w-full flex-col gap-0 overflow-hidden bg-background p-0 sm:max-w-[min(96vw,920px)] [&>button]:hidden"
        aria-describedby={undefined}
      >
        <SheetTitle className="sr-only">Conversation details</SheetTitle>
        <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
          <ChatPanel
            conversationId={conversationId}
            workspaceId={workspaceId}
            initialHighlightedMessageId={initialHighlightedMessageId}
            onBack={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
