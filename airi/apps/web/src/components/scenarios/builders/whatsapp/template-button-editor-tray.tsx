"use client";

import { waActionButton } from "@/components/scenarios/builders/whatsapp/action-colors";
import { getFlowStatusBadgeKey } from "@/components/scenarios/builders/whatsapp/existing-flow-options";
import {
  EDITABLE_WHATSAPP_TEMPLATE_BUTTON_LIMITS,
  getTemplateButtonDisplayLabel,
  getTemplateButtonFieldErrors,
  listDuplicateEditableQuickReplyLabels,
  translateWhatsAppTemplateEditorError,
  type EditableWhatsAppTemplateButton,
  type EditableWhatsAppTemplateButtonType,
  type EditableWhatsAppTemplateEditorFormValues,
  type TemplateButtonFieldErrors,
} from "@/components/scenarios/builders/whatsapp/template-editor-utils";
import { WhatsAppTemplateFlowFirstScreenField } from "@/components/scenarios/builders/whatsapp/template-flow-first-screen-field";
import type { TemplateFlowScreenLookup } from "@/components/scenarios/builders/whatsapp/template-flow-screens";
import { WhatsAppDashedAddButton } from "@/components/scenarios/builders/whatsapp/whatsapp-dashed-add-button";
import { ScenarioInlineNotice } from "@/components/scenarios/scenario-inline-notice";
import {
  SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS,
  ScenarioSelectItemContent,
} from "@/components/scenarios/scenario-select-item-description";
import type { ScenarioWhatsAppFlowOption } from "@/components/scenarios/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { normalizeEditableTemplateFlowId } from "@/lib/scenarios/whatsapp-template-flow";
import { getWhatsAppFlowStatusVariant } from "@/lib/whatsapp/flows/client";
import { Eye, Loader2, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import {
  Controller,
  useFormContext,
  useWatch,
  type FieldPath,
} from "react-hook-form";

type WhatsAppTemplateButtonTypeOption = {
  value: EditableWhatsAppTemplateButtonType;
  label: string;
  /** One line under the label in the type menu. */
  description?: string;
};

/**
 * A saved route that Save removes, because its reply button left the draft
 * or the draft no longer has one form button.
 */
export type WhatsAppTemplateRouteRemoval = {
  /** `button:<id>` for a reply button, `form-submitted` for the form. */
  key: string;
  label: string;
  nextStepLabel: string;
};

type WhatsAppTemplateButtonEditorTrayProps = {
  buttonTypeOptions: WhatsAppTemplateButtonTypeOption[];
  existingFlows?: ScenarioWhatsAppFlowOption[];
  existingFlowsLoading?: boolean;
  /** The chosen forms' screens; without it the first screen is typed. */
  flowScreens?: TemplateFlowScreenLookup;
  pendingRouteRemovals?: readonly WhatsAppTemplateRouteRemoval[];
  onButtonChange: (
    buttonIndex: number,
    patch: {
      label?: string;
      type?: EditableWhatsAppTemplateButtonType;
      value?: string;
      flowId?: string;
      flowAction?: "navigate" | "data_exchange";
      navigateScreen?: string;
    }
  ) => void;
  onButtonRemove: (buttonIndex: number) => void;
  onAddButton: () => void;
  onExistingFlowPickerOpen?: () => void;
};

const CARD_CONTROL_CLASS = "nodrag nopan nokey";
const NO_ROUTE_REMOVALS: readonly WhatsAppTemplateRouteRemoval[] = [];

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

function IconButtonTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export type WhatsAppTemplateButtonRowActionsProps = {
  formIndex: number;
  branchHandle?: ReactNode;
  canEditTemplateFlow: boolean;
  inlineTemplateFlowId?: string | null;
  openingInlineTemplateFlowId?: string | null;
  openingLinkedFlowId?: string | null;
  onButtonChange: WhatsAppTemplateButtonEditorTrayProps["onButtonChange"];
  onButtonRemove: WhatsAppTemplateButtonEditorTrayProps["onButtonRemove"];
  onOpenInlineTemplateFlow: (flowId: string) => void | Promise<void>;
  onOpenLinkedFlowPreview?: (
    flowId: string,
    flowAction?: "navigate" | "data_exchange"
  ) => void | Promise<void>;
};

/**
 * Renders in the same row as the WhatsApp template CTA preview (right of a divider).
 * Expects a parent `FormProvider` for `EditableWhatsAppTemplateEditorFormValues` when flow controls need `setValue` for `flowAction`.
 */
export function WhatsAppTemplateButtonRowActions({
  formIndex,
  branchHandle,
  canEditTemplateFlow,
  inlineTemplateFlowId,
  openingInlineTemplateFlowId,
  openingLinkedFlowId,
  onButtonChange,
  onButtonRemove,
  onOpenInlineTemplateFlow,
  onOpenLinkedFlowPreview,
}: WhatsAppTemplateButtonRowActionsProps) {
  const t = useTranslations("Scenarios");
  const { setValue, control } =
    useFormContext<EditableWhatsAppTemplateEditorFormValues>();
  const buttonsField = useWatch({ control, name: "buttons" }) as
    | EditableWhatsAppTemplateButton[]
    | undefined;
  const button = buttonsField?.[formIndex];

  if (button == null) {
    return null;
  }

  const normalizedFlowId = normalizeEditableTemplateFlowId(button.flowId);
  const flowAction = button.flowAction || "navigate";
  const canOpenInlineFlow =
    button.type === "flow" &&
    normalizedFlowId.length > 0 &&
    canEditTemplateFlow &&
    inlineTemplateFlowId === normalizedFlowId;
  const isOpeningInlineFlow =
    canOpenInlineFlow && openingInlineTemplateFlowId === normalizedFlowId;
  const isOpeningPreviewFlow =
    normalizedFlowId.length > 0 && openingLinkedFlowId === normalizedFlowId;
  const openFlowLabel = canOpenInlineFlow
    ? t("whatsappTemplateOpenFlow")
    : t("whatsappTemplatePreviewForm");
  const OpenFlowIcon = canOpenInlineFlow ? Pencil : Eye;

  const handleOpenFlow =
    button.type === "flow" && normalizedFlowId
      ? canOpenInlineFlow
        ? () => {
            void onOpenInlineTemplateFlow(normalizedFlowId);
          }
        : onOpenLinkedFlowPreview
          ? () => void onOpenLinkedFlowPreview(normalizedFlowId, flowAction)
          : undefined
      : undefined;

  const patchButton = (
    patch: Parameters<
      WhatsAppTemplateButtonEditorTrayProps["onButtonChange"]
    >[1]
  ) => {
    onButtonChange(button.index, patch);
  };

  return (
    <TooltipProvider>
      <div className="inline-flex items-center gap-0.5">
        {button.type === "flow" ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    CARD_CONTROL_CLASS,
                    "h-8 w-8 shrink-0 hover:bg-zinc-100 dark:hover:bg-zinc-800/80",
                    waActionButton.textShadcnOverride,
                    !handleOpenFlow && "pointer-events-none opacity-40"
                  )}
                  disabled={
                    !handleOpenFlow ||
                    isOpeningInlineFlow ||
                    isOpeningPreviewFlow
                  }
                  onPointerDown={stopPropagation}
                  onClick={e => {
                    e.stopPropagation();
                    handleOpenFlow?.();
                  }}
                  aria-label={openFlowLabel}
                >
                  {isOpeningInlineFlow || isOpeningPreviewFlow ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <OpenFlowIcon className="h-3.5 w-3.5" aria-hidden />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{openFlowLabel}</TooltipContent>
            </Tooltip>

            <DropdownMenu>
              <IconButtonTooltip label={t("whatsappTemplateButtonEditType")}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      CARD_CONTROL_CLASS,
                      "h-8 w-8 shrink-0 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    )}
                    onPointerDown={stopPropagation}
                    aria-label={t("whatsappTemplateButtonEditType")}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
              </IconButtonTooltip>
              <DropdownMenuContent align="end" className="w-64 text-[11px]">
                <DropdownMenuRadioGroup
                  value={flowAction}
                  onValueChange={value => {
                    const nextAction = value as "navigate" | "data_exchange";
                    setValue(
                      `buttons.${formIndex}.flowAction` as FieldPath<EditableWhatsAppTemplateEditorFormValues>,
                      nextAction,
                      { shouldDirty: true, shouldValidate: true }
                    );
                    patchButton({ flowAction: nextAction });
                  }}
                >
                  <DropdownMenuRadioItem value="navigate">
                    {t("whatsappTemplateFlowActionNavigation")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="data_exchange">
                    {t("whatsappTemplateFlowActionDataCreate")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                CARD_CONTROL_CLASS,
                "h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              )}
              onPointerDown={stopPropagation}
              onClick={event => {
                event.stopPropagation();
                onButtonRemove(button.index);
              }}
              aria-label={t("whatsappTemplateRemoveButton", {
                label: getTemplateButtonDisplayLabel(button, t),
              })}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t("delete")}</TooltipContent>
        </Tooltip>

        {branchHandle}
      </div>
    </TooltipProvider>
  );
}

/**
 * Warns before Save removes routes, and about reply buttons that share a
 * text, which routes can't tell apart.
 */
function WhatsAppTemplateButtonTrayNotices({
  buttons,
  pendingRouteRemovals,
  className,
}: {
  buttons: EditableWhatsAppTemplateButton[];
  pendingRouteRemovals: readonly WhatsAppTemplateRouteRemoval[];
  className?: string;
}) {
  const t = useTranslations("Scenarios");
  const duplicateLabels = listDuplicateEditableQuickReplyLabels(buttons);
  if (pendingRouteRemovals.length === 0 && duplicateLabels.length === 0) {
    return null;
  }
  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-1.5", className)}>
      {pendingRouteRemovals.map(removal => (
        <ScenarioInlineNotice
          key={removal.key}
          live
          data-testid="whatsapp-template-save-removes-route"
        >
          {t("whatsappTemplateSaveRemovesRoute", {
            button: removal.label,
            step: removal.nextStepLabel,
          })}
        </ScenarioInlineNotice>
      ))}
      {duplicateLabels.map(label => (
        <ScenarioInlineNotice
          key={label}
          data-testid="whatsapp-template-duplicate-button-text"
        >
          {t("whatsappTemplateDuplicateButtonText", { label })}
        </ScenarioInlineNotice>
      ))}
    </div>
  );
}

export function WhatsAppTemplateButtonEditorTray({
  buttonTypeOptions,
  existingFlows,
  existingFlowsLoading = false,
  flowScreens,
  pendingRouteRemovals = NO_ROUTE_REMOVALS,
  onButtonChange,
  onAddButton,
  onExistingFlowPickerOpen,
}: WhatsAppTemplateButtonEditorTrayProps) {
  const t = useTranslations("Scenarios");
  const {
    control,
    formState: { errors, submitCount },
  } = useFormContext<EditableWhatsAppTemplateEditorFormValues>();
  const fieldId = useId();
  const counterId = `${fieldId}-count`;

  const watchedButtons = useWatch({ control, name: "buttons" }) as
    | EditableWhatsAppTemplateButton[]
    | undefined;

  const buttons = useMemo(() => watchedButtons ?? [], [watchedButtons]);
  const flowNameById = useMemo(() => {
    const map = new Map<string, string>();
    (existingFlows || []).forEach(flow => {
      const name = (flow.name || "").trim();
      if (name) map.set(String(flow.id), name);
    });
    return map;
  }, [existingFlows]);

  const knownFlowList = existingFlows || [];
  const requestedInitialFlowListRef = useRef(false);

  useEffect(() => {
    if (requestedInitialFlowListRef.current) return;
    const hasExistingTemplateFlow = buttons.some(
      button =>
        button.type === "flow" &&
        normalizeEditableTemplateFlowId(button.flowId).length > 0
    );
    if (!hasExistingTemplateFlow || knownFlowList.length > 0) return;
    requestedInitialFlowListRef.current = true;
    onExistingFlowPickerOpen?.();
  }, [buttons, knownFlowList.length, onExistingFlowPickerOpen]);

  const maxButtons = WHATSAPP_TEMPLATE_LIMITS.BUTTONS_MAX_COUNT;
  const atButtonLimit = buttons.length >= maxButtons;
  const addSection = (
    <div className="flex w-full min-w-0 items-center gap-2">
      <WhatsAppDashedAddButton
        className="min-w-0 flex-1"
        onClick={onAddButton}
        disabled={atButtonLimit}
        aria-describedby={atButtonLimit ? counterId : undefined}
      >
        {t("whatsappTemplateAddButton")}
      </WhatsAppDashedAddButton>
      <span
        id={counterId}
        data-testid="template-button-count"
        className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
      >
        {t("whatsappTemplateButtonCount", {
          count: buttons.length,
          max: maxButtons,
        })}
      </span>
    </div>
  );

  if (buttons.length === 0) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-1.5 px-2.5 py-1.5">
        <WhatsAppTemplateButtonTrayNotices
          buttons={buttons}
          pendingRouteRemovals={pendingRouteRemovals}
        />
        {addSection}
      </div>
    );
  }

  const typeLimitReached = (
    type: EditableWhatsAppTemplateButtonType,
    formIndex: number
  ): number | null => {
    const limit =
      type === "flow" || type === "phone" || type === "url"
        ? EDITABLE_WHATSAPP_TEMPLATE_BUTTON_LIMITS[type]
        : null;
    if (limit === null) return null;
    const others = buttons.filter(
      (item, index) => index !== formIndex && item.type === type
    ).length;
    return others >= limit ? limit : null;
  };

  return (
    <TooltipProvider>
      <div className="flex w-full min-w-0 flex-col">
        <WhatsAppTemplateButtonTrayNotices
          buttons={buttons}
          pendingRouteRemovals={pendingRouteRemovals}
          className="px-2.5 pb-1.5"
        />
        <div className="flex w-full min-w-0 flex-col space-y-1.5">
          {buttons.map((button, formIndex) => (
            <WhatsAppTemplateButtonTrayRow
              key={`template-button-${button.index}`}
              button={button}
              formIndex={formIndex}
              errors={getTemplateButtonFieldErrors(
                errors.buttons?.[formIndex],
                submitCount > 0
              )}
              errorId={`${fieldId}-${formIndex}-error`}
              buttonTypeOptions={buttonTypeOptions}
              typeLimitReached={typeLimitReached}
              existingFlows={knownFlowList}
              flowNameById={flowNameById}
              existingFlowsLoading={existingFlowsLoading}
              flowScreens={flowScreens}
              onButtonChange={onButtonChange}
              onExistingFlowPickerOpen={onExistingFlowPickerOpen}
            />
          ))}
        </div>

        <div
          className="w-full min-w-0 shrink-0 border-t border-[rgba(11,20,26,0.12)] px-2.5 py-1.5 dark:border-white/10"
          data-slot="template-button-add-section"
        >
          {addSection}
        </div>
      </div>
    </TooltipProvider>
  );
}

type WhatsAppTemplateButtonTrayRowProps = {
  button: EditableWhatsAppTemplateButton;
  formIndex: number;
  errors: TemplateButtonFieldErrors;
  /** Id of the row's error line. */
  errorId: string;
  buttonTypeOptions: WhatsAppTemplateButtonTypeOption[];
  typeLimitReached: (
    type: EditableWhatsAppTemplateButtonType,
    formIndex: number
  ) => number | null;
  existingFlows: ScenarioWhatsAppFlowOption[];
  flowNameById: ReadonlyMap<string, string>;
  existingFlowsLoading: boolean;
  flowScreens?: TemplateFlowScreenLookup;
  onButtonChange: WhatsAppTemplateButtonEditorTrayProps["onButtonChange"];
  onExistingFlowPickerOpen?: () => void;
};

/** One button's settings in the tray. */
function WhatsAppTemplateButtonTrayRow({
  button,
  formIndex,
  errors,
  errorId,
  buttonTypeOptions,
  typeLimitReached,
  existingFlows,
  flowNameById,
  existingFlowsLoading,
  flowScreens,
  onButtonChange: patchButton,
  onExistingFlowPickerOpen,
}: WhatsAppTemplateButtonTrayRowProps) {
  const t = useTranslations("Scenarios");
  const { control } =
    useFormContext<EditableWhatsAppTemplateEditorFormValues>();
  const showDedicatedLabelInput =
    button.type === "url" ||
    button.type === "phone" ||
    button.type === "copy_code";
  const fieldError = translateWhatsAppTemplateEditorError(errors.message, t);
  return (
    <div
      data-testid="template-button-tray-row"
      className="overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none"
    >
      <p className="truncate px-2.5 pb-1 pt-0.5 text-[10px] font-medium text-muted-foreground">
        {formIndex + 1} · {getTemplateButtonDisplayLabel(button, t)}
      </p>
      {showDedicatedLabelInput ? (
        <div className="px-2.5 pb-1.5 pt-0">
          <Controller
            control={control}
            name={`buttons.${formIndex}.label`}
            render={({ field }) => (
              <Input
                aria-label={t("buttonText")}
                aria-invalid={Boolean(errors.label)}
                aria-describedby={errors.label ? errorId : undefined}
                maxLength={WHATSAPP_TEMPLATE_LIMITS.BUTTON_TEXT_MAX_LENGTH}
                value={field.value}
                onChange={event => {
                  field.onChange(event.target.value);
                  patchButton(button.index, {
                    label: event.target.value,
                  });
                }}
                onKeyDown={event => {
                  event.stopPropagation();
                }}
                className="nodrag h-8 w-full min-w-0 border-zinc-300/80 bg-white text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950"
              />
            )}
          />
        </div>
      ) : null}

      <div className="w-full min-w-0 border-b border-[rgba(11,20,26,0.12)] dark:border-white/10">
        <div className="flex w-full min-w-0 flex-col gap-1.5 px-2.5 pb-1.5">
          <div className="flex h-8 min-w-0 w-full items-center">
            <Controller
              control={control}
              name={`buttons.${formIndex}.type`}
              render={({ field }) => (
                <Select
                  value={field.value}
                  disabled={button.type === "copy_code"}
                  onValueChange={value => {
                    const nextType =
                      value as EditableWhatsAppTemplateButtonType;
                    // The parent clears fields based on the previous type.
                    // Do not mutate the watched form value before that patch.
                    patchButton(button.index, {
                      type: nextType,
                    });
                  }}
                >
                  <SelectTrigger
                    aria-label={t("whatsappTemplateButtonTypeLabel")}
                    className={cn(
                      "nodrag h-8 w-full min-w-0 border-zinc-300/80 bg-white px-2 text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950",
                      SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS
                    )}
                    onKeyDown={event => {
                      event.stopPropagation();
                    }}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {button.type === "copy_code" ? (
                      <SelectItem value="copy_code">
                        {t("whatsappTemplateCopyCode")}
                      </SelectItem>
                    ) : null}
                    {buttonTypeOptions.map(option => {
                      const limit =
                        option.value === button.type
                          ? null
                          : typeLimitReached(option.value, formIndex);
                      const description =
                        limit === null
                          ? option.description
                          : limit === 1
                            ? t("whatsappTemplateTypeLimitOne")
                            : t("whatsappTemplateTypeLimitTwo");
                      return (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          textValue={option.label}
                          disabled={limit !== null}
                        >
                          {description ? (
                            <ScenarioSelectItemContent
                              label={option.label}
                              description={description}
                            />
                          ) : (
                            option.label
                          )}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          {button.type === "flow" ? (
            <>
              <WhatsAppTemplateFlowPicker
                button={button}
                formIndex={formIndex}
                error={errors.flowId}
                errorId={errorId}
                existingFlows={existingFlows}
                flowNameById={flowNameById}
                existingFlowsLoading={existingFlowsLoading}
                onButtonChange={patchButton}
                onExistingFlowPickerOpen={onExistingFlowPickerOpen}
              />
              <WhatsAppTemplateFlowFirstScreenField
                button={button}
                lookup={flowScreens}
                errorId={errors.navigateScreen ? errorId : undefined}
                onChange={navigateScreen =>
                  patchButton(button.index, { navigateScreen })
                }
              />
            </>
          ) : null}
        </div>
      </div>

      {fieldError ? (
        <p
          id={errorId}
          role="alert"
          className="px-2.5 pb-1.5 pt-0.5 text-[10px] leading-snug text-destructive"
        >
          {fieldError}
        </p>
      ) : null}

      {button.type === "url" ? (
        <div className="px-2.5 pb-1.5">
          <Controller
            control={control}
            name={`buttons.${formIndex}.value`}
            render={({ field }) => (
              <Input
                type="url"
                aria-label={t("whatsappTemplateUrlLabel")}
                aria-invalid={Boolean(errors.value)}
                aria-describedby={errors.value ? errorId : undefined}
                maxLength={WHATSAPP_TEMPLATE_LIMITS.BUTTON_URL_MAX_LENGTH}
                value={field.value || ""}
                onChange={event => {
                  field.onChange(event.target.value);
                  patchButton(button.index, {
                    value: event.target.value,
                  });
                }}
                onKeyDown={event => {
                  event.stopPropagation();
                }}
                placeholder={t("whatsappTemplateAttachLinkPlaceholder")}
                className="nodrag h-8 border-zinc-300/80 bg-white text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950"
              />
            )}
          />
        </div>
      ) : null}

      {button.type === "phone" ? (
        <div className="px-2.5 pb-1.5">
          <Controller
            control={control}
            name={`buttons.${formIndex}.value`}
            render={({ field }) => (
              <Input
                type="tel"
                aria-label={t("whatsappTemplatePhoneLabel")}
                aria-invalid={Boolean(errors.value)}
                aria-describedby={errors.value ? errorId : undefined}
                value={field.value || ""}
                onChange={event => {
                  field.onChange(event.target.value);
                  patchButton(button.index, {
                    value: event.target.value,
                  });
                }}
                onKeyDown={event => {
                  event.stopPropagation();
                }}
                placeholder={t("whatsappTemplateButtonValuePlaceholderPhone")}
                className="nodrag h-8 border-zinc-300/80 bg-white text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950"
              />
            )}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The form a form button opens. */
function WhatsAppTemplateFlowPicker({
  button,
  formIndex,
  error,
  errorId,
  existingFlows,
  flowNameById,
  existingFlowsLoading,
  onButtonChange: patchButton,
  onExistingFlowPickerOpen,
}: Pick<
  WhatsAppTemplateButtonTrayRowProps,
  | "button"
  | "formIndex"
  | "errorId"
  | "existingFlows"
  | "flowNameById"
  | "existingFlowsLoading"
  | "onButtonChange"
  | "onExistingFlowPickerOpen"
> & {
  /** Shown only after a save attempt. */
  error?: string;
}) {
  const t = useTranslations("Scenarios");
  const { control } =
    useFormContext<EditableWhatsAppTemplateEditorFormValues>();
  const hasOrphan = (v: string) =>
    Boolean(v) && !existingFlows.some(f => String(f.id) === String(v));
  return (
    <div className="flex h-8 w-full min-w-0 items-center">
      <Controller
        control={control}
        name={`buttons.${formIndex}.flowId`}
        render={({ field }) => {
          /** Template `flow_id` only; not defaulted to `existingFlows[0]`. */
          const v = normalizeEditableTemplateFlowId(field.value);
          const orphan = hasOrphan(v);
          return (
            <Select
              value={v}
              onValueChange={next => {
                const nextFlowId = normalizeEditableTemplateFlowId(next);
                if (!nextFlowId) return;
                patchButton(button.index, {
                  flowId: nextFlowId,
                });
              }}
              onOpenChange={open => {
                if (open) onExistingFlowPickerOpen?.();
              }}
            >
              <SelectTrigger
                aria-label={t("buttonFlow")}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                className="nodrag h-8 w-full min-w-0 border-zinc-300/80 bg-white px-2 text-left text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950"
                onKeyDown={event => {
                  event.stopPropagation();
                }}
              >
                <SelectValue
                  placeholder={t("whatsappTemplateButtonValuePlaceholderFlow")}
                />
              </SelectTrigger>
              <SelectContent
                className="max-w-[min(20rem,calc(100vw-2rem))]"
                position="popper"
              >
                {existingFlows.length === 0 ? (
                  existingFlowsLoading ? (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      {t("whatsappTemplateFormsLoading")}
                    </div>
                  ) : (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      {t("whatsappTemplateFormsEmpty")}
                    </div>
                  )
                ) : null}
                {existingFlows.map(flow => {
                  const id = String(flow.id);
                  // Customers can only open published forms.
                  const statusKey = getFlowStatusBadgeKey(flow.status);
                  return (
                    <SelectItem key={id} value={id} title={id}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">
                          {flowNameById.get(id) ?? t("untitledForm")}
                        </span>
                        {flow.status && statusKey ? (
                          <Badge
                            variant={getWhatsAppFlowStatusVariant(flow.status)}
                            className="shrink-0 text-[10px]"
                          >
                            {t(statusKey)}
                          </Badge>
                        ) : null}
                      </span>
                    </SelectItem>
                  );
                })}
                {orphan && v ? (
                  <SelectItem value={v} title={v}>
                    {t("untitledForm")}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          );
        }}
      />
    </div>
  );
}
