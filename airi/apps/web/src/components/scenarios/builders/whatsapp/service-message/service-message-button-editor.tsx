"use client";

import {
  SERVICE_MESSAGE_EDITOR_ACTIONS,
  type ServiceMessageEditorAction,
} from "@/components/scenarios/builders/whatsapp/service-message/service-message-editor-model";
import { WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS } from "@/components/scenarios/builders/whatsapp/service-message/service-message-labels";
import { WhatsAppDashedAddButton } from "@/components/scenarios/builders/whatsapp/whatsapp-dashed-add-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  CalendarDays,
  ChevronDown,
  ContactRound,
  GalleryHorizontalEnd,
  Link2,
  Loader2,
  MapPin,
  MessageCircleMore,
  PanelsTopLeft,
  PhoneCall,
  Store,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, type ReactElement, type ReactNode } from "react";

type MenuItem = {
  action: ServiceMessageEditorAction;
  icon: typeof MessageCircleMore;
  labelKey: string;
};

const SERVICE_MESSAGE_ACTION_ICONS: Record<
  ServiceMessageEditorAction,
  typeof MessageCircleMore
> = {
  reply_buttons: MessageCircleMore,
  cta_url: Link2,
  flow: PanelsTopLeft,
  appointment: CalendarDays,
  voice_call: PhoneCall,
  media_carousel: GalleryHorizontalEnd,
  commerce: Store,
  contacts: ContactRound,
  request_contact_info: ContactRound,
  location: MapPin,
  location_request: MapPin,
};

/** Primary interactive / native actions in the shared add + switch menu. */
const SERVICE_MESSAGE_BUTTON_TYPE_ITEMS: MenuItem[] =
  SERVICE_MESSAGE_EDITOR_ACTIONS.filter(item => item.group === "button").map(
    item => ({
      action: item.action,
      icon: SERVICE_MESSAGE_ACTION_ICONS[item.action],
      labelKey: item.labelKey,
    })
  );

/** Locale key for the current action trigger (covers contact/location variants). */
function serviceMessageActionLabelKey(
  action: ServiceMessageEditorAction | "list" | null
): string {
  if (!action) return "whatsappServiceAddAction";
  if (action === "list") return WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.list;
  return SERVICE_MESSAGE_EDITOR_ACTIONS.find(item => item.action === action)!
    .labelKey;
}

function ServiceMessageActionMenuItems({
  available,
  loading,
  onSelectAction,
}: {
  available: Set<ServiceMessageEditorAction>;
  loading: Set<ServiceMessageEditorAction>;
  onSelectAction: (action: ServiceMessageEditorAction) => void;
}) {
  const t = useTranslations("Scenarios");
  const contactItems = SERVICE_MESSAGE_EDITOR_ACTIONS.filter(
    item => item.group === "contact" && available.has(item.action)
  );
  const locationItems = SERVICE_MESSAGE_EDITOR_ACTIONS.filter(
    item => item.group === "location" && available.has(item.action)
  );

  return (
    <>
      {SERVICE_MESSAGE_BUTTON_TYPE_ITEMS.map(
        ({ action, icon: Icon, labelKey }) =>
          available.has(action) ? (
            <DropdownMenuItem
              key={action}
              onSelect={() => onSelectAction(action)}
            >
              <Icon aria-hidden />
              {t(labelKey)}
            </DropdownMenuItem>
          ) : loading.has(action) ? (
            <DropdownMenuItem key={action} disabled>
              <Icon aria-hidden />
              {t(labelKey)}
              <Loader2 className="ms-auto animate-spin" aria-hidden />
              <span className="sr-only">{t("loadingItems")}</span>
            </DropdownMenuItem>
          ) : null
      )}
      {contactItems.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ContactRound aria-hidden />
            {t("whatsappServiceActionContact")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {contactItems.map(item => (
              <DropdownMenuItem
                key={item.action}
                onSelect={() => onSelectAction(item.action)}
              >
                {t(item.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {locationItems.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <MapPin aria-hidden />
            {t("whatsappServiceActionLocation")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {locationItems.map(item => (
              <DropdownMenuItem
                key={item.action}
                onSelect={() => onSelectAction(item.action)}
              >
                {t(item.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
    </>
  );
}

/**
 * Bubble-footer controls for service-message actions: dashed add (no action)
 * or the same full action menu (with Contact/Location submenus) to switch type,
 * plus optional choice add and remove.
 */
export function ServiceMessageButtonEditor({
  currentAction,
  availableActions,
  loadingActions = [],
  canAddChoice,
  actionFields,
  onSelectAction,
  onAddChoice,
  onRemoveAction,
}: {
  currentAction: ServiceMessageEditorAction | "list" | null;
  availableActions: ServiceMessageEditorAction[];
  /** Shown disabled with a spinner while their availability loads. */
  loadingActions?: ServiceMessageEditorAction[];
  canAddChoice: boolean;
  /** Extra fields for the current action (for example Website URL controls). */
  actionFields?: ReactNode;
  onSelectAction: (action: ServiceMessageEditorAction) => void;
  onAddChoice?: () => void;
  onRemoveAction?: () => void;
}): ReactElement {
  const t = useTranslations("Scenarios");
  const currentLabelId = useId();
  const available = new Set(availableActions);
  const loading = new Set(loadingActions);
  const currentLabel = t(serviceMessageActionLabelKey(currentAction));

  if (currentAction === null) {
    return (
      <div
        className="w-full min-w-0 px-2.5 py-1.5"
        data-testid="whatsapp-service-button-editor"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <WhatsAppDashedAddButton>
              {t("whatsappServiceAddAction")}
            </WhatsAppDashedAddButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" portalled={false}>
            <ServiceMessageActionMenuItems
              available={available}
              loading={loading}
              onSelectAction={onSelectAction}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  const removeLabel = t(
    currentAction === "media_carousel"
      ? "whatsappServiceRemoveCarousel"
      : "whatsappServiceRemoveAction"
  );

  return (
    <div
      className="w-full min-w-0 border-t border-[rgba(11,20,26,0.12)] dark:border-white/10"
      data-testid="whatsapp-service-button-editor"
    >
      <div className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className={cn(
                "nodrag h-8 min-w-0 flex-1 justify-between gap-1 border-zinc-300/80 bg-white px-2 text-[11px] font-normal shadow-none",
                "dark:border-zinc-700 dark:bg-zinc-950"
              )}
              aria-label={t("whatsappServiceChangeButtonType")}
              aria-describedby={currentLabelId}
            >
              <span id={currentLabelId} className="min-w-0 truncate">
                {currentLabel}
              </span>
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0 opacity-60"
                aria-hidden
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="min-w-[12rem]"
            portalled={false}
          >
            <ServiceMessageActionMenuItems
              available={available}
              loading={loading}
              onSelectAction={onSelectAction}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        {onRemoveAction ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="nodrag h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={removeLabel}
            title={removeLabel}
            onPointerDown={event => event.stopPropagation()}
            onClick={onRemoveAction}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
      {actionFields}
      {canAddChoice && onAddChoice ? (
        <div className="w-full min-w-0 px-2.5 pb-1.5">
          <WhatsAppDashedAddButton onClick={onAddChoice}>
            {t("whatsappServiceAddReplyButton")}
          </WhatsAppDashedAddButton>
        </div>
      ) : null}
    </div>
  );
}
