"use client";
import {
  deleteTemplateAction,
  deleteUnifiedTemplateAction,
  switchUnifiedTemplateToCurrentWabaAction,
} from "@/features/panel/messengers/whatsapp-templates/actions";
import Masonry from "@/components/Masonry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  TEMPLATE_CATEGORY_METADATA,
  TEMPLATE_STATUS_METADATA,
  getStatusBadgeVariant,
} from "@icecore/shared/constants/whatsapp-templates";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";
import {
  AlertCircle,
  ArrowRightLeft,
  Copy,
  Eye,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  OtpTemplateBindingDrawer,
  type OtpTemplateBindingView,
} from "./otp-template-binding-drawer";

const TemplateEditorForm = dynamic(
  () =>
    import("./template-editor-form").then(module => module.TemplateEditorForm),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[320px] items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    ),
  }
);
import {
  TemplatePhonePreview,
  buildTemplatePhonePreviewModel,
  type TemplatePhonePreviewModel,
} from "./template-phone-preview";
import {
  buildWhatsAppTemplateCardModels,
  duplicateWhatsAppTemplateSelectionItem,
  getWhatsAppTemplateIdentity,
  getWhatsAppTemplateMapKey,
  type WhatsAppTemplateCardModel,
  type WhatsAppTemplateSelectionItem,
} from "@/lib/whatsapp/templates/selection-utils";
import { useTemplateFlowFacts } from "@/hooks/use-template-flow-facts";
import {
  collectTemplateFlowIds,
  evaluateTemplateFlowHealth,
  type TemplateFlowHealth,
} from "@/lib/whatsapp/flows/template-flow-health";
import { TemplateFlowHealthNotice } from "./template-flow-health-notice";

const NO_TEMPLATE_FLOW_HEALTH: TemplateFlowHealth = {
  state: "none",
  checks: [],
  issues: [],
};

/** Flows live in the WABA that owns the template; older-WABA cards can't be checked. */
function getCheckableTemplateFlowIds(
  template: WhatsAppTemplateSelectionItem
): string[] {
  if (template.canSwitchToCurrentWaba) return [];
  return collectTemplateFlowIds(template.components);
}

const otpBindingsLoadPromises = new Map<
  string,
  Promise<OtpTemplateBindingView[]>
>();

function loadOtpBindingsOnce(workspaceId: string) {
  const existing = otpBindingsLoadPromises.get(workspaceId);
  if (existing) return existing;

  const promise = (async () => {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/otp/whatsapp-bindings`
    );
    if (!response.ok) return [];
    const data = (await response.json()) as {
      bindings?: OtpTemplateBindingView[];
    };
    return Array.isArray(data.bindings) ? data.bindings : [];
  })();

  otpBindingsLoadPromises.set(workspaceId, promise);
  promise.then(
    () => {
      if (otpBindingsLoadPromises.get(workspaceId) === promise) {
        otpBindingsLoadPromises.delete(workspaceId);
      }
    },
    () => {
      if (otpBindingsLoadPromises.get(workspaceId) === promise) {
        otpBindingsLoadPromises.delete(workspaceId);
      }
    }
  );
  return promise;
}

interface TemplatesTableProps {
  templates: WhatsAppTemplateSelectionItem[];
  workspaceId: string;
  onRefresh: () => void;
  onDeleteOptimistic?: (template: WhatsAppTemplateSelectionItem) => void;
  initialEditTemplateName?: string | null;
  onConsumeInitialTemplateQuery?: () => void;
  createIntentToken?: number;
  canCreateTemplates?: boolean;
  createDisabledReason?: string;
}

type EditorState =
  | {
      mode: "selected";
      template: WhatsAppTemplateSelectionItem;
    }
  | {
      mode: "create";
      template?: WhatsAppTemplateSelectionItem;
    };

function getCategoryBadgeVariant(
  category: WhatsAppTemplate["category"]
): "default" | "secondary" | "outline" {
  return category === "MARKETING"
    ? "default"
    : category === "UTILITY"
      ? "secondary"
      : "outline";
}

function getTemplateChannel(template: WhatsAppTemplateSelectionItem) {
  return template.channel || "whatsapp";
}

type TemplateMasonryCardProps = {
  card: WhatsAppTemplateCardModel;
  previewModel: TemplatePhonePreviewModel;
  canDuplicate: boolean;
  otpBindingPurpose?: string | null;
  isSwitching: boolean;
  flowHealth: TemplateFlowHealth;
  isCheckingFlow: boolean;
  tTemplates: ReturnType<typeof useTranslations>;
  onCheckFlowAgain: (templateId: string) => void;
  onOpen: (templateId: string) => void;
  onSwitchToCurrentWaba: (templateId: string) => void;
  onDuplicate: (templateId: string) => void;
  onCopyId: (templateId: string) => void;
  onConnectOtp: (templateId: string) => void;
  onDelete: (templateId: string) => void;
};

const TemplateMasonryCard = memo(function TemplateMasonryCard({
  card,
  previewModel,
  canDuplicate,
  otpBindingPurpose,
  isSwitching,
  flowHealth,
  isCheckingFlow,
  tTemplates,
  onCheckFlowAgain,
  onOpen,
  onSwitchToCurrentWaba,
  onDuplicate,
  onCopyId,
  onConnectOtp,
  onDelete,
}: TemplateMasonryCardProps) {
  const template = card.template;
  const channel = getTemplateChannel(template);
  const canUseForOtp =
    (channel === "whatsapp" || channel === "both") &&
    template.category === "AUTHENTICATION" &&
    template.status === "APPROVED";
  const statusMeta = template.status
    ? TEMPLATE_STATUS_METADATA[template.status]
    : null;
  const categoryMeta = template.category
    ? TEMPLATE_CATEGORY_METADATA[template.category]
    : null;
  const canSwitchToCurrentWaba = Boolean(template.canSwitchToCurrentWaba);
  const primaryActionLabel = canSwitchToCurrentWaba
    ? tTemplates("table.switchToCurrentWaba")
    : tTemplates(card.isEditable ? "table.edit" : "table.preview");
  const runPrimaryAction = () => {
    if (canSwitchToCurrentWaba) {
      onSwitchToCurrentWaba(card.id);
      return;
    }
    onOpen(card.id);
  };

  return (
    <div
      role="button"
      tabIndex={isSwitching ? -1 : 0}
      aria-label={`${template.name} ${template.language || ""} ${primaryActionLabel}`}
      aria-busy={isSwitching}
      className="group flex w-full min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border bg-background shadow-sm transition-colors hover:border-primary/45 hover:bg-muted/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        if (isSwitching) return;
        runPrimaryAction();
      }}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (isSwitching) return;
          runPrimaryAction();
        }
      }}
    >
      <div className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{template.name}</p>
            <p className="text-xs text-muted-foreground">
              {template.language || "-"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {(channel === "whatsapp" || channel === "both") && (
              <Badge variant="outline" className="text-[10px]">
                {tTemplates("table.wa")}
              </Badge>
            )}
            {(channel === "telegram" || channel === "both") && (
              <Badge variant="secondary" className="text-[10px]">
                {tTemplates("table.tg")}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {categoryMeta ? (
            <Badge
              variant={getCategoryBadgeVariant(template.category)}
              className="text-[10px]"
            >
              {tTemplates(`categories.${template.category}`)}
            </Badge>
          ) : null}
          {statusMeta ? (
            <Badge
              variant={getStatusBadgeVariant(template.status)}
              className="text-[10px]"
            >
              {tTemplates(`statuses.${template.status.toLowerCase()}`)}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">
              {tTemplates("table.active")}
            </Badge>
          )}
          {canSwitchToCurrentWaba ? (
            <Badge
              variant="outline"
              className="max-w-full truncate font-mono text-[10px]"
            >
              {template.sourceWabaId
                ? tTemplates("table.previousWaba", {
                    id: template.sourceWabaId,
                  })
                : tTemplates("table.previousWabaUnknown")}
            </Badge>
          ) : null}
          {otpBindingPurpose ? (
            <Badge variant="outline" className="text-[10px]">
              OTP: {otpBindingPurpose}
            </Badge>
          ) : null}
          {flowHealth.state === "issue" ? (
            <Badge variant="destructive" className="text-[10px]">
              {tTemplates("flowHealth.badge")}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="px-3">
        <TemplatePhonePreview
          template={template}
          model={previewModel}
          mode="card"
        />
      </div>

      <TemplateFlowHealthNotice
        health={flowHealth}
        variant="card"
        className="mt-3"
        checking={isCheckingFlow}
        onCheckAgain={() => onCheckFlowAgain(card.id)}
      />

      <div className="mt-auto flex items-center justify-between gap-2 border-t bg-muted/20 px-3 py-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {card.variableCount > 0
            ? tTemplates("table.vars", {
                count: card.variableCount,
                s: card.variableCount > 1 ? "s" : "",
              })
            : tTemplates("table.none")}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {canSwitchToCurrentWaba ? (
            <Button
              type="button"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={isSwitching}
              aria-label={primaryActionLabel}
              onClick={event => {
                event.stopPropagation();
                if (isSwitching) return;
                onSwitchToCurrentWaba(card.id);
              }}
            >
              {isSwitching ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowRightLeft className="mr-1 h-3.5 w-3.5" />
              )}
              {isSwitching
                ? tTemplates("table.switchingToCurrentWaba")
                : tTemplates("table.switchToCurrentWaba")}
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              aria-label={primaryActionLabel}
              onClick={event => {
                event.stopPropagation();
                onOpen(card.id);
              }}
            >
              {card.isEditable ? (
                <Pencil className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                aria-label={tTemplates("table.openMenu")}
                onClick={event => event.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canSwitchToCurrentWaba ? (
                <DropdownMenuItem
                  onClick={event => {
                    event.stopPropagation();
                    onOpen(card.id);
                  }}
                >
                  <Eye className="mr-2 h-4 w-4" />
                  {tTemplates("table.preview")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                disabled={!canDuplicate}
                onClick={event => {
                  event.stopPropagation();
                  onDuplicate(card.id);
                }}
              >
                <Copy className="mr-2 h-4 w-4" />
                {tTemplates("table.duplicate")}
              </DropdownMenuItem>
              {card.copyId ? (
                <DropdownMenuItem
                  onClick={event => {
                    event.stopPropagation();
                    onCopyId(card.id);
                  }}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  {tTemplates("table.copyId")}
                </DropdownMenuItem>
              ) : null}
              {canUseForOtp ? (
                <DropdownMenuItem
                  onClick={event => {
                    event.stopPropagation();
                    onConnectOtp(card.id);
                  }}
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  {otpBindingPurpose ? "Edit OTP binding" : "Use for OTP"}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={event => {
                  event.stopPropagation();
                  onDelete(card.id);
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {tTemplates("table.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {card.missingReason ? (
        <p className="border-t px-3 py-2 text-xs text-destructive">
          {card.missingReason}
        </p>
      ) : null}
    </div>
  );
});

TemplateMasonryCard.displayName = "TemplateMasonryCard";

function TemplateEditorModal({
  editor,
  workspaceId,
  onOpenChange,
  onSuccess,
}: {
  editor: EditorState | null;
  workspaceId: string;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const tTemplates = useTranslations("templates");
  const open = Boolean(editor);
  const title =
    editor?.mode === "create"
      ? tTemplates("form.createNew")
      : tTemplates("form.edit");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Below md the Dialog is a full-width bottom sheet; size it only as a dialog.
        className="!h-[min(92vh,920px)] md:!w-[min(1180px,calc(100vw-2rem))] !max-w-none gap-0 overflow-hidden p-0"
        showCloseButton
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {editor?.mode === "create"
              ? tTemplates("form.create")
              : tTemplates("form.update")}
          </DialogDescription>
        </DialogHeader>
        {editor ? (
          <TemplateEditorForm
            key={editor.template?.dbId || editor.template?.name || "new"}
            template={editor.template}
            workspaceId={workspaceId}
            title={title}
            layout="modal"
            className="h-full min-h-0 rounded-none border-0"
            reopenSearchParams={
              editor.mode === "selected"
                ? { template: editor.template.name }
                : { create: "1" }
            }
            onCancel={() => onOpenChange(false)}
            onSuccess={onSuccess}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type TemplateMasonryItem = {
  card: WhatsAppTemplateCardModel;
  previewModel: TemplatePhonePreviewModel;
  flowHealth: TemplateFlowHealth;
};

const TEMPLATE_MASONRY_QUERIES = [
  "(min-width:1536px)",
  "(min-width:1024px)",
  "(min-width:640px)",
] as const;

const TEMPLATE_MASONRY_COLUMNS = [3, 2, 1] as const;

function estimateTemplateMasonryHeight(
  item: TemplateMasonryItem,
  columnWidth: number
) {
  const compactWidthAdjustment = columnWidth > 0 && columnWidth < 340 ? 28 : 0;
  const missingReasonHeight = item.card.missingReason ? 42 : 0;
  const previousWabaBadgeHeight = item.card.template.canSwitchToCurrentWaba
    ? 28
    : 0;
  // First-paint estimate only; the grid measures the rendered card.
  const flowNoticeHeight =
    item.flowHealth.state === "issue"
      ? 96
      : item.flowHealth.state === "unverified"
        ? 44
        : 0;
  return Math.min(
    900,
    Math.max(
      280,
      item.previewModel.height +
        154 +
        compactWidthAdjustment +
        missingReasonHeight +
        previousWabaBadgeHeight +
        flowNoticeHeight
    )
  );
}

export function TemplatesTable({
  templates,
  workspaceId,
  onRefresh,
  onDeleteOptimistic,
  initialEditTemplateName,
  onConsumeInitialTemplateQuery,
  createIntentToken = 0,
  canCreateTemplates = true,
  createDisabledReason,
}: TemplatesTableProps) {
  const tTemplates = useTranslations("templates");

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [otpBindings, setOtpBindings] = useState<OtpTemplateBindingView[]>([]);
  const [otpBindingTemplate, setOtpBindingTemplate] =
    useState<WhatsAppTemplateSelectionItem | null>(null);
  const [isOtpBindingOpen, setIsOtpBindingOpen] = useState(false);
  const [switchingTemplateId, setSwitchingTemplateId] = useState<string | null>(
    null
  );

  const templatesById = useMemo(
    () =>
      new Map(
        templates.map(template => [
          getWhatsAppTemplateIdentity(template),
          template,
        ])
      ),
    [templates]
  );

  const templateCards = useMemo<WhatsAppTemplateCardModel[]>(
    () =>
      buildWhatsAppTemplateCardModels(templates, {
        missingMetaId: tTemplates("form.editDisabledMissingMetaId"),
        missingDbId: tTemplates("form.editDisabledMissingDbId"),
      }),
    [templates, tTemplates]
  );

  const templatePreviewItems = useMemo(
    () =>
      templateCards.map(card => ({
        card,
        previewModel: buildTemplatePhonePreviewModel(card.template),
        flowIds: getCheckableTemplateFlowIds(card.template),
      })),
    [templateCards]
  );

  const templateFlowIds = useMemo(
    () => templatePreviewItems.flatMap(item => item.flowIds),
    [templatePreviewItems]
  );
  const templateFlowFacts = useTemplateFlowFacts({
    workspaceId,
    flowIds: templateFlowIds,
  });
  const { factsByFlowId: templateFlowFactsById } = templateFlowFacts;

  const templateItems = useMemo<TemplateMasonryItem[]>(
    () =>
      templatePreviewItems.map(({ card, previewModel, flowIds }) => ({
        card,
        previewModel,
        flowHealth:
          flowIds.length > 0
            ? evaluateTemplateFlowHealth(
                card.template.components,
                templateFlowFactsById
              )
            : NO_TEMPLATE_FLOW_HEALTH,
      })),
    [templateFlowFactsById, templatePreviewItems]
  );

  const flowIdsByCardId = useMemo(
    () =>
      new Map(templatePreviewItems.map(item => [item.card.id, item.flowIds])),
    [templatePreviewItems]
  );
  const { refresh: refreshTemplateFlowFacts } = templateFlowFacts;
  const handleCheckFlowAgainById = useCallback(
    (templateId: string) => {
      void refreshTemplateFlowFacts(flowIdsByCardId.get(templateId) ?? []);
    },
    [flowIdsByCardId, refreshTemplateFlowFacts]
  );

  const otpBindingsByTemplateKey = useMemo(() => {
    const map = new Map<string, OtpTemplateBindingView>();
    for (const binding of otpBindings) {
      map.set(
        getWhatsAppTemplateMapKey(binding.templateName, binding.languageCode),
        binding
      );
    }
    return map;
  }, [otpBindings]);

  const loadOtpBindings = useCallback(async () => {
    try {
      return await loadOtpBindingsOnce(workspaceId);
    } catch {
      return [];
    }
  }, [workspaceId]);

  const openCreateEditor = useCallback(
    (seedTemplate?: WhatsAppTemplateSelectionItem) => {
      if (!canCreateTemplates) {
        toast.error(
          createDisabledReason || tTemplates("connectRequiredCreateDisabled")
        );
        return;
      }
      setEditor({ mode: "create", template: seedTemplate });
    },
    [canCreateTemplates, createDisabledReason, tTemplates]
  );

  const openSelectedEditorById = useCallback(
    (templateId: string) => {
      const template = templatesById.get(templateId);
      if (!template) return;
      setEditor({ mode: "selected", template });
    },
    [templatesById]
  );

  const handleDuplicateById = useCallback(
    (templateId: string) => {
      const template = templatesById.get(templateId);
      if (!template) return;
      openCreateEditor(duplicateWhatsAppTemplateSelectionItem(template));
    },
    [openCreateEditor, templatesById]
  );

  const handleCopyIdById = useCallback(
    (templateId: string) => {
      const template = templatesById.get(templateId);
      if (!template) return;
      const idToCopy = template.dbId || template.metaId || template.id;
      if (!idToCopy) return;
      navigator.clipboard.writeText(idToCopy);
      toast.success(tTemplates("alerts.copied"));
    },
    [tTemplates, templatesById]
  );

  const handleConnectOtpById = useCallback(
    (templateId: string) => {
      const template = templatesById.get(templateId);
      if (!template) return;
      setOtpBindingTemplate(template);
      setIsOtpBindingOpen(true);
    },
    [templatesById]
  );

  const handleOtpBindingSaved = useCallback(
    (binding: OtpTemplateBindingView) => {
      setOtpBindings(current => {
        const withoutSamePurpose = current.filter(
          item => item.purpose !== binding.purpose
        );
        return [...withoutSamePurpose, binding];
      });
      void loadOtpBindings().then(setOtpBindings);
    },
    [loadOtpBindings]
  );

  const handleDeleteById = useCallback(
    async (templateId: string) => {
      const template = templatesById.get(templateId);
      if (!template) return;

      if (
        !confirm(
          tTemplates("alerts.deleteConfirmation", { name: template.name })
        )
      ) {
        return;
      }

      try {
        const dbId = template.dbId;
        const metaId = template.metaId;

        let result;
        if (dbId) {
          result = await deleteUnifiedTemplateAction({
            workspaceId,
            templateId: dbId,
            metaTemplateId: metaId,
            templateName: template.name,
            templateLanguage: template.language,
          });
        } else if (metaId) {
          result = await deleteTemplateAction({
            workspaceId,
            templateName: template.name,
            templateId: metaId,
            templateLanguage: template.language,
          });
        } else {
          toast.error(tTemplates("alerts.deleteIdNotFound"));
          return;
        }

        if (!result.success) {
          toast.error(result.error);
          return;
        }

        toast.success(tTemplates("alerts.deleteSuccess"));
        onDeleteOptimistic?.(template);
        if (!onDeleteOptimistic) {
          onRefresh();
        }
      } catch {
        toast.error(tTemplates("alerts.deleteFailed"));
      }
    },
    [onDeleteOptimistic, onRefresh, tTemplates, templatesById, workspaceId]
  );

  const handleSwitchToCurrentWabaById = useCallback(
    async (templateId: string) => {
      const template = templatesById.get(templateId);
      if (!template?.dbId || !template.canSwitchToCurrentWaba) return;
      if (switchingTemplateId) return;

      setSwitchingTemplateId(templateId);
      try {
        const result = await switchUnifiedTemplateToCurrentWabaAction({
          workspaceId,
          templateId: template.dbId,
        });
        if (!result.success) {
          toast.error(
            result.error || tTemplates("alerts.switchToCurrentWabaFailed")
          );
          return;
        }
        toast.success(
          tTemplates("alerts.switchToCurrentWabaSuccess", {
            name: template.name,
          })
        );
        onRefresh();
      } catch {
        toast.error(tTemplates("alerts.switchToCurrentWabaFailed"));
      } finally {
        setSwitchingTemplateId(current =>
          current === templateId ? null : current
        );
      }
    },
    [onRefresh, switchingTemplateId, tTemplates, templatesById, workspaceId]
  );

  useEffect(() => {
    if (initialEditTemplateName == null || templates.length === 0) return;
    const match = templates.find(
      template =>
        template.name.toLowerCase() === initialEditTemplateName.toLowerCase()
    );
    if (!match) return;

    const timeoutId = window.setTimeout(() => {
      openSelectedEditorById(getWhatsAppTemplateIdentity(match));
      onConsumeInitialTemplateQuery?.();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [
    initialEditTemplateName,
    onConsumeInitialTemplateQuery,
    openSelectedEditorById,
    templates,
  ]);

  useEffect(() => {
    if (createIntentToken <= 0 || !canCreateTemplates) return;
    const timeoutId = window.setTimeout(() => {
      openCreateEditor();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [canCreateTemplates, createIntentToken, openCreateEditor]);

  useEffect(() => {
    let cancelled = false;
    void loadOtpBindings().then(bindings => {
      if (!cancelled) {
        setOtpBindings(bindings);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadOtpBindings]);

  const handleEditorOpenChange = useCallback((open: boolean) => {
    if (!open) setEditor(null);
  }, []);

  const handleEditorSuccess = useCallback(() => {
    setEditor(null);
    onRefresh();
  }, [onRefresh]);

  if (templates.length === 0) {
    return (
      <>
        <div className="rounded-lg border border-dashed bg-muted/10 px-4 py-12 text-center text-muted-foreground">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 opacity-50" />
          <p className="text-lg font-medium">{tTemplates("noTemplates")}</p>
          <p className="mt-2 text-sm">{tTemplates("createFirst")}</p>
          <Button
            type="button"
            onClick={() => openCreateEditor()}
            className="mt-4"
            disabled={!canCreateTemplates}
          >
            <Plus className="mr-2 h-4 w-4" />
            {tTemplates("create")}
          </Button>
        </div>

        <TemplateEditorModal
          editor={editor}
          workspaceId={workspaceId}
          onOpenChange={handleEditorOpenChange}
          onSuccess={handleEditorSuccess}
        />
      </>
    );
  }

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {tTemplates("form.templateList")}
          </h3>
          <Badge variant="secondary">{templateItems.length}</Badge>
        </div>

        <Masonry
          items={templateItems}
          getKey={item => item.card.id}
          getHeight={estimateTemplateMasonryHeight}
          renderItem={item => (
            <TemplateMasonryCard
              card={item.card}
              previewModel={item.previewModel}
              canDuplicate={canCreateTemplates}
              otpBindingPurpose={
                otpBindingsByTemplateKey.get(
                  getWhatsAppTemplateMapKey(
                    item.card.template.name,
                    item.card.template.language
                  )
                )?.purpose ?? null
              }
              tTemplates={tTemplates}
              isSwitching={switchingTemplateId === item.card.id}
              flowHealth={item.flowHealth}
              isCheckingFlow={templateFlowFacts.isRefreshing(
                flowIdsByCardId.get(item.card.id) ?? []
              )}
              onCheckFlowAgain={handleCheckFlowAgainById}
              onOpen={openSelectedEditorById}
              onSwitchToCurrentWaba={handleSwitchToCurrentWabaById}
              onDuplicate={handleDuplicateById}
              onCopyId={handleCopyIdById}
              onConnectOtp={handleConnectOtpById}
              onDelete={handleDeleteById}
            />
          )}
          gap={16}
          minColumnWidth={320}
          queries={TEMPLATE_MASONRY_QUERIES}
          columnValues={TEMPLATE_MASONRY_COLUMNS}
          defaultColumns={1}
          animateFrom="bottom"
          duration={0.28}
          stagger={0.015}
          scaleOnHover={false}
          className={cn(
            "relative min-h-[520px]",
            templateItems.length === 0 && "min-h-0"
          )}
        />
      </div>

      <TemplateEditorModal
        editor={editor}
        workspaceId={workspaceId}
        onOpenChange={handleEditorOpenChange}
        onSuccess={handleEditorSuccess}
      />

      <OtpTemplateBindingDrawer
        open={isOtpBindingOpen}
        onOpenChange={setIsOtpBindingOpen}
        workspaceId={workspaceId}
        template={otpBindingTemplate}
        bindings={otpBindings}
        onSaved={handleOtpBindingSaved}
      />
    </>
  );
}
