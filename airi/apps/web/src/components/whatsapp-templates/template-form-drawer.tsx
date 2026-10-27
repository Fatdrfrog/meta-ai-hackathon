"use client";

import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import { useTranslations } from "next-intl";
import type {
  TelegramTemplateData,
  TemplateChannel,
} from "@icecore/shared/types/templates";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";
import { TemplateEditorForm } from "./template-editor-form";

interface TemplateFormDrawerProps {
  template?: WhatsAppTemplate & {
    metaId?: string;
    dbId?: string;
    channel?: TemplateChannel;
    telegramData?: TelegramTemplateData;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onSuccess: () => void;
}

export function TemplateFormDrawer({
  template,
  open,
  onOpenChange,
  workspaceId,
  onSuccess,
}: TemplateFormDrawerProps) {
  const t = useTranslations("templates");
  const formVisit = useTransitionOwnerKey(
    JSON.stringify([
      open,
      workspaceId,
      template?.dbId,
      template?.metaId || template?.id,
      template?.name,
      template?.language,
    ])
  );
  return (
    <Drawer direction="right" open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        aria-describedby={undefined}
        className="!w-[92vw] md:!w-[75vw] lg:!w-[60vw] xl:!w-[55vw] !min-w-[320px] !max-w-[960px] !h-[calc(100vh-2rem)] !inset-y-auto !top-4 !bottom-4 !right-4 rounded-xl border shadow-xl"
      >
        <DrawerTitle className="sr-only">
          {t(template ? "form.edit" : "form.createNew")}
        </DrawerTitle>
        <TemplateEditorForm
          key={formVisit}
          template={template}
          workspaceId={workspaceId}
          onCancel={() => onOpenChange(false)}
          onSuccess={() => {
            onOpenChange(false);
            onSuccess();
          }}
          className="h-full border-0 rounded-none"
        />
      </DrawerContent>
    </Drawer>
  );
}
