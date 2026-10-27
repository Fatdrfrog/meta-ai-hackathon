"use client";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PopulatedMessage } from "@/types/models";
import { ChevronDown, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

const LONG_PRESS_MS = 550;

export type MessageTextUpdatedHandler = (
  messageId: string,
  text: string,
  editMeta?: PopulatedMessage["editMeta"]
) => void;

type OutboundWhatsAppMessageShellProps = {
  message: PopulatedMessage;
  conversationId: string;
  className: string;
  onTextUpdated: MessageTextUpdatedHandler;
  children: ReactNode;
};

/** Outbound WhatsApp bubble: menus + edit when enabled; plain div otherwise. */
export function OutboundWhatsAppMessageBubble({
  enabled,
  message,
  conversationId,
  onTextUpdated,
  className,
  children,
}: {
  enabled: boolean;
  message: PopulatedMessage;
  conversationId: string;
  onTextUpdated?: MessageTextUpdatedHandler;
  className: string;
  children: ReactNode;
}) {
  if (!enabled || !onTextUpdated) {
    return <div className={cn(className, "relative")}>{children}</div>;
  }
  return (
    <OutboundWhatsAppMessageShell
      message={message}
      conversationId={conversationId}
      className={className}
      onTextUpdated={onTextUpdated}
    >
      {children}
    </OutboundWhatsAppMessageShell>
  );
}

function OutboundWhatsAppMessageShell({
  message,
  conversationId,
  className,
  onTextUpdated,
  children,
}: OutboundWhatsAppMessageShellProps) {
  const t = useTranslations("ConversationDetailView");
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState(message.text || "");
  const [saving, setSaving] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearLongPress();
  }, [clearLongPress]);

  const openEditDialog = useCallback(() => {
    setDraft(message.text || "");
    setEditOpen(true);
  }, [message.text]);

  const longPressHandlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      longPressFiredRef.current = false;
      clearLongPress();
      longPressTimerRef.current = setTimeout(() => {
        longPressFiredRef.current = true;
        longPressTimerRef.current = null;
        openEditDialog();
      }, LONG_PRESS_MS);
    },
    onPointerUp: clearLongPress,
    onPointerCancel: clearLongPress,
    onPointerLeave: clearLongPress,
    onClick: (e: MouseEvent) => {
      if (longPressFiredRef.current) {
        e.preventDefault();
        e.stopPropagation();
        longPressFiredRef.current = false;
      }
    },
  };

  const handleSaveEdit = async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      toast.error(t("editWhatsAppMessageEmpty"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/whatsapp-edit-message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageId: message._id.toString(),
            text: trimmed,
          }),
        }
      );
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        text?: string;
        editMeta?: PopulatedMessage["editMeta"];
      };
      if (!res.ok) {
        throw new Error(payload.error || t("editWhatsAppMessageFailed"));
      }
      const nextText =
        typeof payload.text === "string" ? payload.text : trimmed;
      onTextUpdated(message._id.toString(), nextText, payload.editMeta);
      setEditOpen(false);
      toast.success(t("editWhatsAppMessageSuccess"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("editWhatsAppMessageFailed")
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(className, "relative touch-manipulation")}
            {...longPressHandlers}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "absolute top-1 right-1 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground/90 shadow-sm transition-opacity",
                    "opacity-80 hover:opacity-100",
                    "md:opacity-0 md:group-hover:opacity-100",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  )}
                  aria-label={t("messageActionsMenuAria")}
                  title={t("messageActionsMenuAria")}
                  onClick={e => e.stopPropagation()}
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[9rem]">
                <DropdownMenuItem onSelect={() => openEditDialog()}>
                  <Pencil className="h-4 w-4" />
                  {t("editMessage")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[9rem]">
          <ContextMenuItem onSelect={() => openEditDialog()}>
            <Pencil className="h-4 w-4" />
            {t("editMessage")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("editWhatsAppMessageTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("editWhatsAppMessageHint")}
          </p>
          <Textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={5}
            className="resize-y min-h-[120px]"
            disabled={saving}
          />
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={saving}
            >
              {t("cancelEdit")}
            </Button>
            <Button
              type="button"
              onClick={() => void handleSaveEdit()}
              disabled={saving}
            >
              {saving ? t("savingEdit") : t("saveEdit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
