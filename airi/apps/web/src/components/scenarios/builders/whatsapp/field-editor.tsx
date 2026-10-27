"use client";

import type { ScenarioEditorValidationMode } from "../../view/node-enrichment/types";

import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldConfig,
  WhatsAppFlowFieldType,
  WhatsAppFlowScreenConfig,
} from "@/components/scenarios/types";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createWhatsAppFlowScreenId,
  sanitizeWhatsAppFlowConfig,
} from "@/lib/scenarios/whatsapp-flow-config";
import {
  WHATSAPP_FLOW_SUBMIT_MAX_LENGTH,
  WHATSAPP_FLOW_UI_LOCALE_IDS,
  type WhatsAppFlowUiLocaleId,
  defaultSubmitLabelForFlowLocale,
} from "@/lib/scenarios/whatsapp-flow-ui-locale";
import { cn } from "@/lib/utils";
import { extractFlowBranchOptions } from "@/lib/scenarios/whatsapp-flow-branches";
import {
  buildFlowBranchOptionKey,
  buildFlowBranchSourceHandleId,
  isScenarioPromptInputKey,
  syncWhatsAppFlowLayoutContent,
  WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES,
} from "@icecore/scenario-contracts";
import {
  Calendar,
  ChevronDown,
  GitBranch,
  Languages,
  List,
  Plus,
  RotateCcw,
  Route,
  ToggleLeft,
  Trash2,
  Type,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  type WheelEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import { WhatsAppActionRenderer } from "./action-renderer";
import {
  useFlowFieldAnswerToken,
  useFlowFieldAnswerTokens,
} from "./flow-field-answer-tokens";
import { type FlowFieldErrors, computeFieldErrors } from "./flow-field-schema";
import { MAX_FLOW_SCREENS } from "./flow-validation";
import { LazyWhatsAppInlineEditor as WhatsAppInlineEditor } from "./lazy-inline-editor";
import { FlowAuthoringWorkspace } from "./flow-authoring-workspace";
import {
  FlowAuthoringInput,
  FlowNavigationItemsEditor,
} from "./flow-screen-action-editor";
import { convertWhatsAppFlowToStaticGraph } from "./flow-json-generator";
import {
  FlowFieldChoiceMarker,
  FlowFieldInputSample,
} from "./flow-field-preview";

const FIELD_TYPES: Array<{
  value: WhatsAppFlowFieldType;
  label: string;
  icon: typeof Type;
}> = [
  { value: "TextInput", label: "Text", icon: Type },
  { value: "TextArea", label: "Text Area", icon: Type },
  { value: "Dropdown", label: "Dropdown", icon: ChevronDown },
  { value: "DatePicker", label: "Date Picker", icon: Calendar },
  { value: "RadioButtonsGroup", label: "Radio Buttons", icon: ToggleLeft },
  { value: "CheckboxGroup", label: "Checkboxes", icon: List },
  { value: "NavigationList", label: "Navigation list", icon: Route },
];

const HAS_OPTIONS: Set<WhatsAppFlowFieldType> = new Set([
  "Dropdown",
  "RadioButtonsGroup",
  "CheckboxGroup",
]);

function stopFlowEditorWheelPropagation(event: WheelEvent<HTMLElement>) {
  event.stopPropagation();
}

export type FlowBranchOptionHandleRenderParams = {
  fieldId: string;
  optionId: string;
  optionTitle: string;
  branchId: string;
  handleId: string;
};

function defaultOptionsForType(fieldType: WhatsAppFlowFieldType) {
  if (!HAS_OPTIONS.has(fieldType)) return undefined;
  return [
    { id: "opt_1", title: "Option 1" },
    { id: "opt_2", title: "Option 2" },
  ];
}

function EditableOptionRow({
  option,
  optionIndex,
  marker,
  branchHandleSlot,
  canDelete,
  onUpdateOption,
  onRemoveOption,
  canEditOptionIds,
  isOptionIdLocked,
  error,
  collapseIdentifier = false,
}: {
  option: NonNullable<WhatsAppFlowFieldConfig["options"]>[number];
  optionIndex: number;
  marker?: ReactNode;
  branchHandleSlot?: ReactNode;
  canDelete: boolean;
  onUpdateOption: (
    optIndex: number,
    patch: Partial<NonNullable<WhatsAppFlowFieldConfig["options"]>[number]>
  ) => void;
  onRemoveOption: (optIndex: number) => void;
  canEditOptionIds?: boolean;
  isOptionIdLocked?: (id: string) => boolean;
  error?: string;
  collapseIdentifier?: boolean;
}) {
  const t = useTranslations("Scenarios");

  return (
    <div className="group/opt relative space-y-2 overflow-visible">
      <div className="flex items-center gap-1.5">
        {marker}
        <WhatsAppInlineEditor
          value={option.title}
          onChange={title => onUpdateOption(optionIndex, { title })}
          placeholder={`Option ${optionIndex + 1}`}
          outputFormat="plain_text"
          className="min-h-8 min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-[11px] text-gray-700 shadow-sm transition-colors focus-visible:border-emerald-400 focus-visible:ring-1 focus-visible:ring-emerald-200 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:focus-visible:border-emerald-500 dark:focus-visible:ring-emerald-900/30"
          error={error}
        />
        {canDelete ? (
          <button
            type="button"
            onClick={() => onRemoveOption(optionIndex)}
            title={t("delete")}
            aria-label={t("delete")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-transparent p-0 text-red-600 transition-colors hover:bg-red-600 hover:text-white dark:text-red-300 dark:hover:bg-red-700 dark:hover:text-white"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {branchHandleSlot}
      </div>
      {collapseIdentifier ? (
        <details className="space-y-2">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {t("flowAuthoring.advanced")}
          </summary>
          <div className="pt-2">
            <FlowAuthoringInput
              label={`${t("flowAuthoring.optionId")} ${optionIndex + 1}`}
              value={option.id}
              readOnly={!canEditOptionIds || isOptionIdLocked?.(option.id)}
              onChange={id => onUpdateOption(optionIndex, { id })}
            />
          </div>
        </details>
      ) : (
        <FlowAuthoringInput
          label={`${t("flowAuthoring.optionId")} ${optionIndex + 1}`}
          value={option.id}
          readOnly={!canEditOptionIds || isOptionIdLocked?.(option.id)}
          onChange={id => onUpdateOption(optionIndex, { id })}
        />
      )}
      <FlowAuthoringInput
        label={`${t("flowAuthoring.optionDescription")} ${optionIndex + 1}`}
        value={option.description ?? ""}
        onChange={description =>
          onUpdateOption(optionIndex, { description: description || undefined })
        }
      />
    </div>
  );
}

function FieldPreviewHeader({
  previewLabel,
  previewRequiredSuffix,
  isRequired,
  canDelete,
  onRequiredChange,
  onRemove,
}: {
  previewLabel: ReactNode;
  previewRequiredSuffix: ReactNode;
  isRequired: boolean;
  canDelete: boolean;
  onRequiredChange: (required: boolean) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("Scenarios");

  return (
    <div className="flex items-center gap-4 text-[10px] font-medium text-gray-500 dark:text-gray-400">
      {previewLabel}
      {previewRequiredSuffix}

      <div className="flex items-center gap-1">
        <Checkbox
          checked={isRequired}
          aria-label={t("flowFieldRequired")}
          onCheckedChange={checked => onRequiredChange(checked === true)}
          className="h-3.5 w-3.5 rounded-[4px] border-gray-300 data-[state=checked]:border-emerald-600 data-[state=checked]:bg-emerald-600"
        />
        <label className="text-[10px] font-medium text-gray-500 dark:text-gray-400">
          {t("flowFieldRequired")}
        </label>
      </div>

      {canDelete ? (
        <button
          type="button"
          onClick={onRemove}
          title={t("delete")}
          aria-label={t("delete")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white p-0 text-red-600 transition-colors hover:border-red-600 hover:bg-red-600 hover:text-white dark:border-gray-600 dark:bg-gray-900 dark:text-red-300 dark:hover:border-red-700 dark:hover:bg-red-700 dark:hover:text-white"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

const TEXT_FIELD_TYPES: ReadonlySet<WhatsAppFlowFieldType> = new Set([
  "TextInput",
  "TextArea",
]);

/** Fields whose card shows a sample of the input the customer fills. */
const INPUT_PREVIEW_FIELD_TYPES: ReadonlySet<WhatsAppFlowFieldType> = new Set([
  "TextInput",
  "TextArea",
  "Dropdown",
  "DatePicker",
]);

const CHOICE_FIELD_TYPES: ReadonlySet<WhatsAppFlowFieldType> = new Set([
  "RadioButtonsGroup",
  "CheckboxGroup",
]);

/** Says where a form's answers go, once its fields have variables. */
function FlowAnswerTokensHint({
  fields,
}: {
  fields: readonly WhatsAppFlowFieldConfig[];
}) {
  const t = useTranslations("Scenarios");
  const answerTokens = useFlowFieldAnswerTokens();
  if (!fields.some(field => answerTokens.has(field.id.trim()))) return null;
  return (
    <p className="mb-2 text-[10px] leading-snug text-muted-foreground">
      {t("flowPromptInputHint")}
    </p>
  );
}

/** The variable an answer fills in AI steps after the form. */
function FlowFieldAnswerToken({ token }: { token: string }) {
  return (
    <span
      className="break-all font-mono text-[10px] text-muted-foreground"
      data-testid="flow-field-answer-token"
    >
      {token}
    </span>
  );
}

/**
 * A text field's variable name, and for every field the variable its answer
 * fills in AI steps. In a scenario, only text fields rename their key: a
 * choice's key also names its routes. Standalone authoring can rename any key.
 */
function FlowFieldAnswerKey({
  field,
  authoringContext = "scenario",
  fieldKeyLabel,
  answerToken,
  onIdChange,
  exactResponseKeys = false,
  readOnly = false,
}: {
  field: WhatsAppFlowFieldConfig;
  authoringContext?: "scenario" | "manager";
  fieldKeyLabel?: string;
  answerToken: string | undefined;
  onIdChange: (id: string) => void;
  exactResponseKeys?: boolean;
  readOnly?: boolean;
}) {
  const t = useTranslations("Scenarios");
  if (
    !exactResponseKeys &&
    authoringContext === "scenario" &&
    !TEXT_FIELD_TYPES.has(field.fieldType)
  ) {
    return answerToken ? <FlowFieldAnswerToken token={answerToken} /> : null;
  }
  const keyLabel =
    fieldKeyLabel ||
    t(
      exactResponseKeys
        ? "flowAuthoring.fieldKey"
        : "whatsappServicePromptInputsKey"
    );
  const keyValid =
    exactResponseKeys ||
    authoringContext === "manager" ||
    isScenarioPromptInputKey(field.id.trim());
  return (
    <label className="grid gap-1 text-[11px]">
      <span>{keyLabel}</span>
      <input
        value={field.id}
        readOnly={readOnly}
        aria-label={`${keyLabel} ${field.label || field.id}`}
        data-testid="flow-prompt-input-key"
        className="nodrag h-8 rounded-md border border-gray-200 bg-white px-2 font-mono text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
        onChange={event => {
          if (!readOnly) onIdChange(event.target.value);
        }}
      />
      {!keyValid ? (
        <span className="text-[10px] text-destructive">
          {t("whatsappServiceValidationPromptInputKey")}
        </span>
      ) : authoringContext === "scenario" && answerToken ? (
        <FlowFieldAnswerToken token={answerToken} />
      ) : null}
    </label>
  );
}

type FlowFieldOptionHandlers = {
  onAddOption: () => void;
  onRemoveOption: (optIndex: number) => void;
  onUpdateOption: (
    optIndex: number,
    patch: Partial<NonNullable<WhatsAppFlowFieldConfig["options"]>[number]>
  ) => void;
  canEditOptionIds?: boolean;
  isOptionIdLocked?: (id: string) => boolean;
  collapseIdentifiers?: boolean;
};

/** Radio or checkbox options; a radio option can lead to its own route. */
function FlowFieldChoiceOptions({
  field,
  header,
  renderFlowBranchHandle,
  fieldErrors,
  onAddOption,
  onRemoveOption,
  onUpdateOption,
  canEditOptionIds,
  isOptionIdLocked,
  collapseIdentifiers,
}: FlowFieldOptionHandlers & {
  field: WhatsAppFlowFieldConfig;
  header: ReactNode;
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
  fieldErrors?: FlowFieldErrors;
}) {
  const t = useTranslations("Scenarios");
  const options = field.options ?? [];
  const isRadio = field.fieldType === "RadioButtonsGroup";
  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-emerald-100/70 bg-white/75 p-2 transition-colors hover:bg-green-50/45 dark:border-emerald-900/45 dark:bg-gray-900/70 dark:hover:bg-green-950/20">
      {header}
      {options.map((opt, optIndex) => (
        <EditableOptionRow
          key={optIndex}
          option={opt}
          optionIndex={optIndex}
          marker={<FlowFieldChoiceMarker radio={isRadio} />}
          branchHandleSlot={
            isRadio && renderFlowBranchHandle
              ? renderFlowBranchHandle({
                  fieldId: field.id,
                  optionId: opt.id,
                  optionTitle: opt.title,
                  branchId: buildFlowBranchOptionKey(field.id, opt.id),
                  handleId: buildFlowBranchSourceHandleId(field.id, opt.id),
                })
              : undefined
          }
          canDelete={options.length > 1}
          onUpdateOption={onUpdateOption}
          canEditOptionIds={canEditOptionIds}
          isOptionIdLocked={isOptionIdLocked}
          collapseIdentifier={collapseIdentifiers}
          onRemoveOption={onRemoveOption}
          error={fieldErrors?.[`options.${optIndex}.title`]}
        />
      ))}
      <button
        type="button"
        onClick={onAddOption}
        className="mt-0.5 flex h-8 items-center gap-1 rounded-md border border-dashed border-emerald-100/80 px-2 text-[10px] font-medium text-gray-500 transition-colors hover:border-green-300/70 hover:bg-green-50 hover:text-green-600 dark:border-emerald-900/45 dark:text-gray-300 dark:hover:border-green-700/60 dark:hover:bg-green-900/30 dark:hover:text-green-400"
      >
        <Plus className="h-2.5 w-2.5" />
        {t("flowAddOption")}
      </button>
    </div>
  );
}

/** A dropdown's options. */
function FlowFieldDropdownOptions({
  options,
  fieldErrors,
  onAddOption,
  onRemoveOption,
  onUpdateOption,
  canEditOptionIds,
  isOptionIdLocked,
  collapseIdentifiers,
}: FlowFieldOptionHandlers & {
  options: NonNullable<WhatsAppFlowFieldConfig["options"]>;
  fieldErrors?: FlowFieldErrors;
}) {
  const t = useTranslations("Scenarios");
  return (
    <div className="mt-2 space-y-1.5 rounded border border-dashed border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
      <div className="text-[10px] font-medium text-gray-500 dark:text-gray-400">
        {t("flowFieldOptions")}
      </div>
      {options.map((opt, optIndex) => (
        <EditableOptionRow
          key={optIndex}
          option={opt}
          optionIndex={optIndex}
          canDelete={options.length > 1}
          onUpdateOption={onUpdateOption}
          canEditOptionIds={canEditOptionIds}
          isOptionIdLocked={isOptionIdLocked}
          collapseIdentifier={collapseIdentifiers}
          onRemoveOption={onRemoveOption}
          error={fieldErrors?.[`options.${optIndex}.title`]}
        />
      ))}
      <button
        type="button"
        onClick={onAddOption}
        className="mt-0.5 flex h-8 items-center gap-1 rounded-md border border-dashed border-gray-300 px-2 text-[10px] font-medium text-gray-500 transition-colors hover:border-green-400 hover:text-green-600 dark:border-gray-600 dark:text-gray-300 dark:hover:border-green-500 dark:hover:text-green-400"
      >
        <Plus className="h-2.5 w-2.5" />
        {t("flowAddOption")}
      </button>
    </div>
  );
}

function EditablePhoneField({
  field,
  authoringContext = "scenario",
  fieldKeyLabel,
  canDelete,
  renderFlowBranchHandle,
  onUpdate,
  onRemove,
  onAddOption,
  onRemoveOption,
  onUpdateOption,
  fieldErrors,
  inspector = false,
  exactResponseKeys = false,
  screen,
  screens,
  canEditOptionIds,
  isOptionIdLocked,
  fieldIdReadOnly = false,
}: FlowFieldOptionHandlers & {
  field: WhatsAppFlowFieldConfig;
  authoringContext?: "scenario" | "manager";
  fieldKeyLabel?: string;
  canDelete: boolean;
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
  onUpdate: (patch: Partial<WhatsAppFlowFieldConfig>) => void;
  onRemove: () => void;
  fieldErrors?: FlowFieldErrors;
  inspector?: boolean;
  exactResponseKeys?: boolean;
  screen?: WhatsAppFlowScreenConfig;
  screens?: WhatsAppFlowScreenConfig[];
  fieldIdReadOnly?: boolean;
}) {
  const t = useTranslations("Scenarios");
  const answerToken = useFlowFieldAnswerToken(field.id);
  const isRequired = field.required === true;
  const fieldTypeLabel =
    FIELD_TYPES.find(ft => ft.value === field.fieldType)?.label ?? "Text";
  const optionHandlers = {
    onAddOption,
    onRemoveOption,
    onUpdateOption,
    canEditOptionIds,
    isOptionIdLocked,
    collapseIdentifiers: inspector,
  };

  const answerKey = (
    <FlowFieldAnswerKey
      field={field}
      authoringContext={authoringContext}
      fieldKeyLabel={fieldKeyLabel}
      answerToken={answerToken}
      onIdChange={id => onUpdate({ id })}
      exactResponseKeys={exactResponseKeys}
      readOnly={fieldIdReadOnly}
    />
  );

  const handleFieldTypeChange = (value: WhatsAppFlowFieldType) => {
    const patch: Partial<WhatsAppFlowFieldConfig> = { fieldType: value };
    if (
      HAS_OPTIONS.has(value) &&
      (!field.options || field.options.length === 0)
    ) {
      patch.options = defaultOptionsForType(value);
    }
    if (!HAS_OPTIONS.has(value)) {
      patch.options = undefined;
    }
    if (value !== "NavigationList") patch.navigationItems = undefined;
    if (value === "NavigationList" && !field.navigationItems?.length) {
      patch.navigationItems = [
        {
          id: "item_1",
          title: "",
          action: {
            name: "navigate",
            nextScreenId:
              screens?.find(candidate => candidate.id !== screen?.id)?.id ?? "",
          },
        },
      ];
      patch.required = undefined;
      patch.helperText = undefined;
    }
    onUpdate(patch);
  };

  const previewHeader = (
    <FieldPreviewHeader
      previewLabel={field.label.trim() || t("flowFieldLabelPlaceholder")}
      previewRequiredSuffix={isRequired ? " *" : ""}
      isRequired={isRequired}
      canDelete={canDelete}
      onRequiredChange={required => onUpdate({ required })}
      onRemove={onRemove}
    />
  );

  return (
    <div
      className={cn(
        "group/field relative min-w-0",
        inspector
          ? "space-y-3"
          : "rounded-md border bg-gray-50/50 p-2.5 transition-colors dark:bg-gray-800/50",
        !inspector && fieldErrors?.label
          ? "border-destructive/60 hover:border-destructive"
          : "border-gray-200 hover:border-green-400/60 dark:border-gray-700"
      )}
    >
      <div className="space-y-2">
        {field.fieldType !== "NavigationList" ? (
          <div className="min-w-0">
            <WhatsAppInlineEditor
              value={field.label}
              onChange={v => onUpdate({ label: v })}
              placeholder={t("flowFieldLabelPlaceholder")}
              outputFormat="plain_text"
              className="min-h-8 rounded-md border border-input/60 bg-background px-2 py-1.5 text-xs font-medium text-foreground shadow-none"
              error={fieldErrors?.label}
            />
          </div>
        ) : null}

        {!inspector ? answerKey : null}

        <div className="flex items-center gap-2">
          <Select value={field.fieldType} onValueChange={handleFieldTypeChange}>
            <SelectTrigger
              aria-label={t("flowAuthoring.fieldType")}
              className="h-8 min-w-0 flex-1 border-input/60 bg-background px-2 text-[11px] shadow-none"
            >
              <SelectValue>{fieldTypeLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.filter(
                ft => exactResponseKeys || ft.value !== "NavigationList"
              ).map(ft => (
                <SelectItem key={ft.value} value={ft.value}>
                  {ft.value === "NavigationList"
                    ? t("flowAuthoring.navigationList")
                    : ft.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {TEXT_FIELD_TYPES.has(field.fieldType) ? (
          <FlowAuthoringInput
            label={t("flowAuthoring.helperText")}
            value={field.helperText ?? ""}
            onChange={helperText =>
              onUpdate({ helperText: helperText || undefined })
            }
          />
        ) : null}
        {inspector && field.fieldType !== "NavigationList"
          ? previewHeader
          : null}
        {inspector && field.fieldType === "NavigationList" && canDelete ? (
          <button
            type="button"
            className="min-h-8 text-xs text-destructive"
            aria-label={t("delete")}
            onClick={onRemove}
          >
            {t("delete")}
          </button>
        ) : null}
      </div>

      {!inspector && INPUT_PREVIEW_FIELD_TYPES.has(field.fieldType) ? (
        <div className="mt-2 rounded-md border border-gray-200 bg-white p-2 dark:border-gray-600 dark:bg-gray-900">
          {previewHeader}
          <FlowFieldInputSample fieldType={field.fieldType} />
        </div>
      ) : null}

      {CHOICE_FIELD_TYPES.has(field.fieldType) ? (
        <FlowFieldChoiceOptions
          field={field}
          header={inspector ? null : previewHeader}
          renderFlowBranchHandle={renderFlowBranchHandle}
          fieldErrors={fieldErrors}
          {...optionHandlers}
        />
      ) : null}
      {field.fieldType === "NavigationList" && screen && screens ? (
        <FlowNavigationItemsEditor
          items={field.navigationItems ?? []}
          screen={screen}
          screens={screens}
          onChange={navigationItems => onUpdate({ navigationItems })}
        />
      ) : null}

      {field.fieldType === "Dropdown" && field.options?.length ? (
        <FlowFieldDropdownOptions
          options={field.options}
          fieldErrors={fieldErrors}
          {...optionHandlers}
        />
      ) : null}
      {inspector ? (
        <details
          data-testid="flow-field-advanced"
          className="border-t border-border/40 pt-3"
        >
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t("flowAuthoring.advanced")}
          </summary>
          <div className="pt-2">{answerKey}</div>
        </details>
      ) : null}
    </div>
  );
}

type FlowFormEditorContentProps = {
  authoringContext?: "scenario" | "manager";
  fieldKeyLabel?: string;
  validationMode?: ScenarioEditorValidationMode;
  flowConfig: WhatsAppFlowConfig;
  className?: string;
  onChange: (config: WhatsAppFlowConfig) => void;
  onViewportChange?: () => void;
  renderPreview?: (screenId: string) => ReactNode;
  fillAvailableHeight?: boolean;
  connectedBranchIds?: readonly string[];
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
};

function resolveEndpointRoutes(
  flowConfig: WhatsAppFlowConfig,
  screenIndex: number
): string[] {
  const screen = flowConfig.screens[screenIndex];
  if (!screen || screenIndex >= flowConfig.screens.length - 1) return [];
  const configured = flowConfig.screenRoutes?.[screen.id];
  if (configured && configured.length > 0) return configured;
  const nextScreenId = flowConfig.screens[screenIndex + 1]?.id;
  return nextScreenId ? [nextScreenId] : [];
}

function cloneEndpointBranchRules(
  rules: WhatsAppFlowConfig["flowBranchRules"]
): NonNullable<WhatsAppFlowConfig["flowBranchRules"]> {
  return Object.fromEntries(
    Object.entries(rules ?? {}).map(([screenId, fields]) => [
      screenId,
      Object.fromEntries(
        Object.entries(fields).map(([fieldId, options]) => [
          fieldId,
          { ...options },
        ])
      ),
    ])
  );
}

function updateEndpointBranchRules(
  flowConfig: WhatsAppFlowConfig,
  sourceScreenId: string,
  fieldId: string,
  optionId: string,
  targetScreenId: string
): WhatsAppFlowConfig {
  const nextRules = cloneEndpointBranchRules(flowConfig.flowBranchRules);
  const screenRules = (nextRules[sourceScreenId] ??= {});
  const fieldRules = (screenRules[fieldId] ??= {});

  if (targetScreenId) {
    fieldRules[optionId] = targetScreenId;
  } else {
    delete fieldRules[optionId];
  }

  if (Object.keys(fieldRules).length === 0) delete screenRules[fieldId];
  if (Object.keys(screenRules).length === 0) delete nextRules[sourceScreenId];

  return {
    ...flowConfig,
    ...(Object.keys(nextRules).length > 0
      ? { flowBranchRules: nextRules }
      : { flowBranchRules: undefined }),
  };
}

function FlowEndpointRoutingEditor({
  flowConfig,
  onChange,
  onViewportChange,
}: {
  flowConfig: WhatsAppFlowConfig;
  onChange: (config: WhatsAppFlowConfig) => void;
  onViewportChange?: () => void;
}) {
  const t = useTranslations("Scenarios");
  const endpointEnabled = flowConfig.flowNavigationMode === "data_endpoint";
  const screenIds = flowConfig.screens.map(screen => screen.id);
  const screenById = new Map(
    flowConfig.screens.map(screen => [screen.id, screen] as const)
  );
  const screenLabel = (screenId: string) =>
    screenById.get(screenId)?.title?.trim() || screenId;
  const routeCount = endpointEnabled
    ? flowConfig.screens
        .slice(0, -1)
        .reduce(
          (count, _screen, screenIndex) =>
            count + resolveEndpointRoutes(flowConfig, screenIndex).length,
          0
        )
    : 0;

  const commit = (next: WhatsAppFlowConfig) => {
    onChange(sanitizeWhatsAppFlowConfig(next) ?? next);
    onViewportChange?.();
  };

  const updateMode = (value: string) => {
    const next = {
      ...flowConfig,
      ...(value === "data_endpoint"
        ? { flowNavigationMode: "data_endpoint" as const }
        : { flowNavigationMode: undefined }),
    };
    commit(next);
  };

  const updateRoutes = (screenIndex: number, targetId: string) => {
    const source = flowConfig.screens[screenIndex];
    if (!source || screenIndex >= flowConfig.screens.length - 1) return;
    const current = resolveEndpointRoutes(flowConfig, screenIndex);
    const isSelected = current.includes(targetId);
    const replaceSoleRoute =
      !isSelected &&
      current.length === 1 &&
      routeCount >= WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES;
    const targets = isSelected
      ? current.filter(id => id !== targetId)
      : replaceSoleRoute
        ? [targetId]
        : [...current, targetId];
    if (targets.length === 0) return;

    const nextRoutes = { ...(flowConfig.screenRoutes ?? {}) };
    nextRoutes[source.id] = targets;
    const nextBranches = cloneEndpointBranchRules(flowConfig.flowBranchRules);
    const allowedTargets = new Set(targets);
    const screenBranches = nextBranches[source.id];
    if (screenBranches) {
      for (const [fieldId, options] of Object.entries(screenBranches)) {
        for (const [optionId, target] of Object.entries(options)) {
          if (!allowedTargets.has(target)) delete options[optionId];
        }
        if (Object.keys(options).length === 0) delete screenBranches[fieldId];
      }
      if (Object.keys(screenBranches).length === 0)
        delete nextBranches[source.id];
    }

    const next = {
      ...flowConfig,
      screenRoutes: nextRoutes,
      ...(Object.keys(nextBranches).length > 0
        ? { flowBranchRules: nextBranches }
        : { flowBranchRules: undefined }),
    };
    commit(next);
  };

  const resetRouting = () => {
    commit({
      ...flowConfig,
      screenRoutes: undefined,
      flowBranchRules: undefined,
    });
  };

  return (
    <section className="nodrag nowheel mb-3 w-full rounded-md border border-emerald-200/70 bg-emerald-50/40 p-2 dark:border-emerald-900/60 dark:bg-emerald-950/20">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <Route
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-300"
            aria-hidden
          />
          <div className="min-w-0">
            <div className="text-[10px] font-semibold text-emerald-950 dark:text-emerald-50">
              {t("flowNavigationLabel")}
            </div>
            <p className="mt-0.5 max-w-[22rem] text-[10px] leading-snug text-muted-foreground">
              {endpointEnabled
                ? t("flowEndpointDescription")
                : t("flowLinearDescription")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {endpointEnabled ? (
            <span
              className="rounded-full border border-emerald-300/70 bg-background px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-emerald-800 dark:text-emerald-200"
              aria-label={t("flowEndpointRouteCount", {
                count: routeCount,
                max: WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES,
              })}
            >
              {routeCount}/{WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES}
            </span>
          ) : null}
          <Select
            value={endpointEnabled ? "data_endpoint" : "linear"}
            onValueChange={updateMode}
          >
            <SelectTrigger
              aria-label={t("flowNavigationLabel")}
              className="nodrag h-7 w-[9.75rem] border-emerald-300/60 bg-background text-[10px] shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="linear" className="text-xs">
                {t("flowNavigationLinear")}
              </SelectItem>
              <SelectItem value="data_endpoint" className="text-xs">
                {t("flowNavigationEndpoint")}
              </SelectItem>
            </SelectContent>
          </Select>
          {endpointEnabled ? (
            <button
              type="button"
              className="nodrag flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              onClick={resetRouting}
              disabled={!flowConfig.screenRoutes && !flowConfig.flowBranchRules}
              title={t("flowEndpointReset")}
              aria-label={t("flowEndpointReset")}
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      {endpointEnabled ? (
        <div className="mt-2 space-y-2 border-t border-emerald-200/60 pt-2 dark:border-emerald-900/60">
          {flowConfig.screens.length < 2 ? (
            <p className="rounded border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-[10px] font-medium text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-200">
              {t("flowEndpointRequiresTwoScreens")}
            </p>
          ) : null}
          {routeCount >= WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES ? (
            <p className="text-[10px] text-amber-700 dark:text-amber-300">
              {t("flowEndpointRouteLimit", {
                max: WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES,
              })}
            </p>
          ) : null}
          {flowConfig.screens.slice(0, -1).map((screen, screenIndex) => {
            const routes = resolveEndpointRoutes(flowConfig, screenIndex);
            const routeSet = new Set(routes);
            const radioFields = screen.fields.filter(
              field =>
                field.fieldType === "RadioButtonsGroup" && field.options?.length
            );
            return (
              <div
                key={screen.id}
                className="rounded border border-border/60 bg-background/70 p-2"
              >
                <div className="flex items-center gap-1 text-[10px] font-semibold text-foreground">
                  <GitBranch
                    className="h-3 w-3 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {t("flowEndpointRoutesFor", {
                      screen: screen.title || screen.id,
                    })}
                  </span>
                  <span className="shrink-0 font-normal tabular-nums text-muted-foreground">
                    {t("flowEndpointRouteTargets", { count: routes.length })}
                  </span>
                </div>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  {screenIds.map(targetId => {
                    if (targetId === screen.id) return null;

                    const checked = routeSet.has(targetId);
                    const limitReached =
                      !checked &&
                      routeCount >= WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES &&
                      routes.length !== 1;
                    return (
                      <label
                        key={targetId}
                        className="nodrag flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-emerald-500"
                      >
                        <Checkbox
                          checked={checked}
                          disabled={limitReached}
                          aria-label={t("flowEndpointRouteToggle", {
                            from: screen.title || screen.id,
                            to: screenLabel(targetId),
                          })}
                          onCheckedChange={() =>
                            updateRoutes(screenIndex, targetId)
                          }
                          className="h-3.5 w-3.5 rounded-[3px]"
                        />
                        <span className="truncate" title={targetId}>
                          {screenLabel(targetId)}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {radioFields.length > 0 ? (
                  <div className="mt-2 space-y-1 border-t border-border/50 pt-1.5">
                    <div className="text-[10px] font-medium text-muted-foreground">
                      {t("flowEndpointBranchRules")}
                    </div>
                    {radioFields.flatMap(field =>
                      (field.options ?? []).map(option => {
                        const target =
                          flowConfig.flowBranchRules?.[screen.id]?.[field.id]?.[
                            option.id
                          ] ?? "";
                        return (
                          <div
                            key={`${field.id}:${option.id}`}
                            className="flex items-center gap-1.5"
                          >
                            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                              {field.label}: {option.title}
                            </span>
                            <select
                              aria-label={`${t("flowEndpointBranchRules")}: ${field.label}: ${option.title}`}
                              className="nodrag h-6 max-w-[9rem] rounded border bg-background px-1 text-[10px]"
                              value={target}
                              onChange={event =>
                                commit(
                                  updateEndpointBranchRules(
                                    flowConfig,
                                    screen.id,
                                    field.id,
                                    option.id,
                                    event.target.value
                                  )
                                )
                              }
                            >
                              <option value="">
                                {t("flowEndpointBranchDefault")}
                              </option>
                              {routes.map(routeId => (
                                <option key={routeId} value={routeId}>
                                  {screenLabel(routeId)}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

export function FlowFormEditorContent({
  authoringContext = "scenario",
  fieldKeyLabel,
  validationMode = "runnable",
  className,
  flowConfig,
  onChange: onConfigChange,
  onViewportChange,
  renderFlowBranchHandle,
  renderPreview,
  fillAvailableHeight = false,
  connectedBranchIds,
}: FlowFormEditorContentProps) {
  const t = useTranslations("Scenarios");
  const [activeScreenIndex, setActiveScreenIndex] = useState(0);
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [connectedMutationBlocked, setConnectedMutationBlocked] =
    useState(false);
  const resolvedActiveScreenIndex =
    flowConfig.screens.length === 0
      ? 0
      : Math.min(activeScreenIndex, flowConfig.screens.length - 1);
  const activeScreen = flowConfig.screens[resolvedActiveScreenIndex];
  const graph = flowConfig.flowNavigationMode === "static_graph";
  const workspace = graph || Boolean(renderPreview);
  const protectedBranchIds =
    authoringContext === "scenario" && graph ? connectedBranchIds : undefined;
  const protectedBranches = new Set(protectedBranchIds);
  const onChange = useCallback(
    (next: WhatsAppFlowConfig) => {
      if (protectedBranchIds?.length) {
        const branchIds = (config: WhatsAppFlowConfig) =>
          new Set(
            extractFlowBranchOptions(config).map(option =>
              buildFlowBranchOptionKey(option.fieldId, option.optionId)
            )
          );
        const before = branchIds(flowConfig);
        const after = branchIds(next);
        if (protectedBranchIds.some(id => before.has(id) && !after.has(id))) {
          setConnectedMutationBlocked(true);
          return;
        }
      }
      setConnectedMutationBlocked(false);
      onConfigChange(next);
    },
    [flowConfig, onConfigChange, protectedBranchIds]
  );

  const selectActiveScreen = useCallback(
    (screenIndex: number) => {
      setActiveScreenIndex(screenIndex);
      onViewportChange?.();
    },
    [onViewportChange]
  );

  const fieldErrors = useMemo(
    () => (validationMode === "runnable" ? computeFieldErrors(flowConfig) : {}),
    [flowConfig, validationMode]
  );

  const updateScreen = useCallback(
    (screenIndex: number, patch: Partial<WhatsAppFlowScreenConfig>) => {
      const nextScreens = flowConfig.screens.map((screen, i) =>
        i === screenIndex ? { ...screen, ...patch } : screen
      );
      onChange({ ...flowConfig, screens: nextScreens });
    },
    [flowConfig, onChange]
  );

  const updateField = useCallback(
    (
      screenIndex: number,
      fieldIndex: number,
      patch: Partial<WhatsAppFlowFieldConfig>
    ) => {
      const screen = flowConfig.screens[screenIndex];
      if (!screen) return;
      const nextFields = screen.fields.map((field, i) =>
        i === fieldIndex ? { ...field, ...patch } : field
      );
      updateScreen(
        screenIndex,
        syncWhatsAppFlowLayoutContent(
          { ...screen, fields: nextFields },
          patch.id !== undefined
            ? { from: screen.fields[fieldIndex].id, to: patch.id }
            : undefined
        )
      );
    },
    [flowConfig.screens, updateScreen]
  );

  const addField = useCallback(
    (screenIndex: number, fieldType: WhatsAppFlowFieldType = "TextInput") => {
      const base =
        fieldType === "NavigationList"
          ? convertWhatsAppFlowToStaticGraph(flowConfig)
          : flowConfig;
      const screen = base?.screens[screenIndex];
      if (!screen) return;
      const used = new Set(
        base!.screens.flatMap(candidate =>
          candidate.fields.map(field => field.id)
        )
      );
      let suffix = 1;
      while (used.has(`field_${suffix}`)) suffix++;
      const newField: WhatsAppFlowFieldConfig = {
        id: `field_${suffix}`,
        label: "",
        fieldType,
        required: false,
        options: defaultOptionsForType(fieldType),
        ...(fieldType === "NavigationList"
          ? {
              required: undefined,
              navigationItems: [
                {
                  id: "item_1",
                  title: "",
                  action: {
                    name: "navigate" as const,
                    nextScreenId:
                      base!.screens.find(
                        candidate => candidate.id !== screen.id
                      )?.id ?? "",
                  },
                },
              ],
            }
          : {}),
      };
      onChange({
        ...base!,
        screens: base!.screens.map((candidate, i) =>
          i === screenIndex
            ? syncWhatsAppFlowLayoutContent({
                ...candidate,
                fields: [...screen.fields, newField],
              })
            : candidate
        ),
      });
    },
    [flowConfig, onChange]
  );

  const removeField = useCallback(
    (screenIndex: number, fieldIndex: number) => {
      const screen = flowConfig.screens[screenIndex];
      if (!screen || (!graph && screen.fields.length <= 1)) return;
      updateScreen(
        screenIndex,
        syncWhatsAppFlowLayoutContent({
          ...screen,
          fields: screen.fields.filter((_, i) => i !== fieldIndex),
        })
      );
    },
    [flowConfig.screens, graph, updateScreen]
  );

  const addOption = useCallback(
    (screenIndex: number, fieldIndex: number) => {
      const field = flowConfig.screens[screenIndex]?.fields[fieldIndex];
      if (!field) return;
      const newOption = {
        id: `opt_${Date.now()}`,
        title: "",
      };
      updateField(screenIndex, fieldIndex, {
        options: [...(field.options ?? []), newOption],
      });
    },
    [flowConfig.screens, updateField]
  );

  const removeOption = useCallback(
    (screenIndex: number, fieldIndex: number, optionIndex: number) => {
      const field = flowConfig.screens[screenIndex]?.fields[fieldIndex];
      if (!field?.options || field.options.length <= 1) return;
      updateField(screenIndex, fieldIndex, {
        options: field.options.filter((_, i) => i !== optionIndex),
      });
    },
    [flowConfig.screens, updateField]
  );

  const updateOption = useCallback(
    (
      screenIndex: number,
      fieldIndex: number,
      optionIndex: number,
      patch: Partial<NonNullable<WhatsAppFlowFieldConfig["options"]>[number]>
    ) => {
      const field = flowConfig.screens[screenIndex]?.fields[fieldIndex];
      if (!field?.options) return;
      updateField(screenIndex, fieldIndex, {
        options: field.options.map((opt, i) =>
          i === optionIndex ? { ...opt, ...patch } : opt
        ),
      });
      if (patch.id !== undefined) onViewportChange?.();
    },
    [flowConfig.screens, onViewportChange, updateField]
  );

  const addScreen = useCallback(() => {
    if (flowConfig.screens.length >= MAX_FLOW_SCREENS) {
      return;
    }
    const used = new Set(
      flowConfig.screens.map(s => s.id.trim()).filter(id => id.length > 0)
    );
    const newId = createWhatsAppFlowScreenId(
      `screen_${flowConfig.screens.length + 1}`,
      flowConfig.screens.length,
      used
    );
    const fieldId = `field_${Date.now()}`;
    const newField: WhatsAppFlowFieldConfig = {
      id: fieldId,
      label: "",
      fieldType: "TextInput",
      required: false,
    };
    const newScreen: WhatsAppFlowScreenConfig = {
      id: newId,
      title: "",
      fields: graph ? [] : [newField],
    };
    const next: WhatsAppFlowConfig = {
      ...flowConfig,
      screens: [...flowConfig.screens, newScreen],
    };
    onChange(sanitizeWhatsAppFlowConfig(next) ?? next);
    setActiveScreenIndex(flowConfig.screens.length);
  }, [flowConfig, graph, onChange]);

  const removeActiveScreen = useCallback(() => {
    if (flowConfig.screens.length <= 1) {
      return;
    }
    const removeIdx = resolvedActiveScreenIndex;
    const nextScreens = flowConfig.screens.filter((_, i) => i !== removeIdx);
    const next: WhatsAppFlowConfig = { ...flowConfig, screens: nextScreens };
    onChange(sanitizeWhatsAppFlowConfig(next) ?? next);
    setActiveScreenIndex(prev => {
      const n = nextScreens.length;
      if (n === 0) {
        return 0;
      }
      if (removeIdx < prev) {
        return prev - 1;
      }
      return Math.min(prev, n - 1);
    });
  }, [flowConfig, onChange, resolvedActiveScreenIndex]);

  if (workspace) {
    return (
      <div
        className={cn(
          "nowheel w-full min-w-0 overscroll-contain p-3",
          fillAvailableHeight && "flex h-full min-h-0 flex-col overflow-hidden",
          className
        )}
        onScroll={onViewportChange}
        onWheel={stopFlowEditorWheelPropagation}
      >
        {connectedMutationBlocked ? (
          <p
            role="alert"
            className="mb-3 shrink-0 text-xs leading-relaxed text-destructive"
          >
            {t("flowAuthoring.connectedIdentifier")}
          </p>
        ) : null}
        <FlowAuthoringWorkspace
          flowConfig={flowConfig}
          activeScreenIndex={resolvedActiveScreenIndex}
          onChange={onChange}
          onSelectScreen={selectActiveScreen}
          onAddScreen={addScreen}
          onRemoveScreen={removeActiveScreen}
          onAddField={type => addField(resolvedActiveScreenIndex, type)}
          onViewportChange={onViewportChange}
          fieldTypes={FIELD_TYPES}
          renderPreview={renderPreview}
          fillAvailableHeight={fillAvailableHeight}
          renderFlowBranchHandle={renderFlowBranchHandle}
          connectedBranchIds={protectedBranchIds}
          routingEditor={
            authoringContext === "scenario" && !graph ? (
              <FlowEndpointRoutingEditor
                flowConfig={flowConfig}
                onChange={onChange}
                onViewportChange={onViewportChange}
              />
            ) : undefined
          }
          renderFieldProperties={fieldIndex => {
            const field = activeScreen?.fields[fieldIndex];
            if (!field || !activeScreen) return null;
            const prefix = `screens.${resolvedActiveScreenIndex}.fields.${fieldIndex}.`;
            const errorsForField = Object.fromEntries(
              Object.entries(fieldErrors)
                .filter(([key, message]) => key.startsWith(prefix) && message)
                .map(([key, message]) => [key.slice(prefix.length), message])
            );
            const aliases =
              activeScreen.terminal &&
              activeScreen.footer?.action.name === "complete"
                ? Object.entries(activeScreen.footer.action.payload ?? {})
                    .filter(([, value]) => value === `\${form.${field.id}}`)
                    .map(([key]) => key)
                : [];
            const isOptionIdLocked = (optionId: string) =>
              aliases.some(alias =>
                protectedBranches.has(buildFlowBranchOptionKey(alias, optionId))
              );
            const fieldIdReadOnly =
              field.fieldType === "RadioButtonsGroup" &&
              (field.options ?? []).some(option => isOptionIdLocked(option.id));
            return (
              <EditablePhoneField
                key={`${resolvedActiveScreenIndex}-${fieldIndex}`}
                inspector
                exactResponseKeys={graph}
                screen={activeScreen}
                screens={flowConfig.screens}
                field={field}
                authoringContext={authoringContext}
                fieldKeyLabel={fieldKeyLabel}
                canDelete={graph || activeScreen.fields.length > 1}
                canEditOptionIds={authoringContext === "manager" || graph}
                isOptionIdLocked={isOptionIdLocked}
                fieldIdReadOnly={fieldIdReadOnly}
                fieldErrors={errorsForField}
                onUpdate={patch => {
                  updateField(resolvedActiveScreenIndex, fieldIndex, patch);
                  if (patch.id !== undefined) onViewportChange?.();
                }}
                onRemove={() =>
                  removeField(resolvedActiveScreenIndex, fieldIndex)
                }
                onAddOption={() =>
                  addOption(resolvedActiveScreenIndex, fieldIndex)
                }
                onRemoveOption={optionIndex =>
                  removeOption(
                    resolvedActiveScreenIndex,
                    fieldIndex,
                    optionIndex
                  )
                }
                onUpdateOption={(optionIndex, patch) =>
                  updateOption(
                    resolvedActiveScreenIndex,
                    fieldIndex,
                    optionIndex,
                    patch
                  )
                }
              />
            );
          }}
        />
      </div>
    );
  }

  if (!activeScreen) return null;

  const defaultSubmitPlaceholder = defaultSubmitLabelForFlowLocale(
    flowConfig.flowUiLocale ?? "en"
  );

  return (
    <div
      className={cn("nowheel w-full overscroll-contain p-3", className)}
      onScroll={onViewportChange}
      onWheel={stopFlowEditorWheelPropagation}
    >
      {authoringContext === "scenario" ? (
        <FlowEndpointRoutingEditor
          flowConfig={flowConfig}
          onChange={onChange}
          onViewportChange={onViewportChange}
        />
      ) : null}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {flowConfig.screens.length > 1 && (
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {flowConfig.screens.map((scr, idx) => (
              <button
                key={scr.id || `screen-${idx}`}
                type="button"
                onClick={() => selectActiveScreen(idx)}
                className={cn(
                  "max-w-[140px] truncate rounded-md px-2 py-1 text-[10px] font-medium transition-colors",
                  idx === resolvedActiveScreenIndex
                    ? "bg-[#075e54] text-white"
                    : "bg-muted/70 text-muted-foreground hover:bg-muted"
                )}
                title={(scr.title || scr.id || "").trim()}
              >
                {(scr.title || "").trim() ||
                  t("flowScreenTabFallback", { n: idx + 1 })}
              </button>
            ))}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          {flowConfig.screens.length > 1 ? (
            <button
              type="button"
              onClick={removeActiveScreen}
              className="whitespace-nowrap rounded-md border border-border/60 bg-background px-2 py-1 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              {t("flowRemoveScreen")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={addScreen}
            disabled={flowConfig.screens.length >= MAX_FLOW_SCREENS}
            title={t("flowAddScreenTitle")}
            className="whitespace-nowrap rounded-md border border-dashed border-green-600/50 bg-background px-2 py-1 text-[10px] font-medium text-green-800 transition-colors hover:border-green-600 hover:bg-green-50 disabled:pointer-events-none disabled:opacity-40 dark:text-green-300 dark:hover:bg-green-950/40"
          >
            <span className="inline-flex items-center gap-0.5">
              <Plus className="h-2.5 w-2.5" />
              {t("flowAddScreen")}
            </span>
          </button>
        </div>
      </div>

      <div className="mb-2 text-center">
        <WhatsAppInlineEditor
          value={activeScreen.title}
          onChange={v => updateScreen(resolvedActiveScreenIndex, { title: v })}
          placeholder={t("flowScreenTitlePlaceholder")}
          outputFormat="plain_text"
          className="text-center text-[13px] font-semibold text-gray-800 dark:text-gray-200"
        />
      </div>

      {authoringContext === "scenario" ? (
        <FlowAnswerTokensHint fields={activeScreen.fields} />
      ) : null}

      <div className="space-y-2">
        {activeScreen.fields.map((field, fieldIndex) => {
          const prefix = `screens.${resolvedActiveScreenIndex}.fields.${fieldIndex}.`;
          const errorsForField: FlowFieldErrors = {};
          for (const [key, msg] of Object.entries(fieldErrors)) {
            if (key.startsWith(prefix) && msg) {
              errorsForField[key.slice(prefix.length)] = msg;
            }
          }
          return (
            <EditablePhoneField
              key={`${resolvedActiveScreenIndex}-${fieldIndex}`}
              field={field}
              authoringContext={authoringContext}
              canEditOptionIds={authoringContext === "manager"}
              fieldKeyLabel={fieldKeyLabel}
              canDelete={activeScreen.fields.length > 1}
              renderFlowBranchHandle={renderFlowBranchHandle}
              onUpdate={patch =>
                updateField(resolvedActiveScreenIndex, fieldIndex, patch)
              }
              onRemove={() =>
                removeField(resolvedActiveScreenIndex, fieldIndex)
              }
              onAddOption={() =>
                addOption(resolvedActiveScreenIndex, fieldIndex)
              }
              onRemoveOption={optIndex =>
                removeOption(resolvedActiveScreenIndex, fieldIndex, optIndex)
              }
              onUpdateOption={(optIndex, patch) =>
                updateOption(
                  resolvedActiveScreenIndex,
                  fieldIndex,
                  optIndex,
                  patch
                )
              }
              fieldErrors={errorsForField}
            />
          );
        })}
      </div>

      <Popover open={addFieldOpen} onOpenChange={setAddFieldOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="mt-2.5 flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-gray-300 px-2 text-[11px] text-gray-500 transition-colors hover:border-green-400 hover:text-green-600 dark:border-gray-600 dark:text-gray-300 dark:hover:border-green-500 dark:hover:text-green-400"
          >
            <Plus className="h-3 w-3" />
            {t("flowAddField")}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1" side="top" align="center">
          {FIELD_TYPES.filter(
            ft =>
              flowConfig.flowNavigationMode !== "data_endpoint" ||
              ft.value !== "NavigationList"
          ).map(ft => {
            const Icon = ft.icon;
            return (
              <button
                key={ft.value}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted"
                onClick={() => {
                  addField(resolvedActiveScreenIndex, ft.value);
                  setAddFieldOpen(false);
                }}
              >
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                {ft.value === "NavigationList"
                  ? t("flowAuthoring.navigationList")
                  : ft.label}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

      <div className="mt-2.5 rounded bg-[#25d366] px-2 py-1.5">
        <WhatsAppInlineEditor
          value={flowConfig.flowSubmitLabel ?? ""}
          onChange={v => {
            let next = v;
            if (next.length > WHATSAPP_FLOW_SUBMIT_MAX_LENGTH) {
              next = next.slice(0, WHATSAPP_FLOW_SUBMIT_MAX_LENGTH);
            }
            onChange({
              ...flowConfig,
              flowSubmitLabel: next.trim() === "" ? undefined : next,
            });
          }}
          placeholder={defaultSubmitPlaceholder}
          outputFormat="plain_text"
          className="text-center text-xs font-medium text-white [&_.ProseMirror]:text-center"
          multiline={false}
        />
      </div>
    </div>
  );
}

type FieldEditorProps = {
  validationMode?: ScenarioEditorValidationMode;
  flowConfig: WhatsAppFlowConfig;
  onChange: (config: WhatsAppFlowConfig) => void;
  hideFlowUiLocaleSelect?: boolean;
  onViewportChange?: () => void;
  renderPreview?: (screenId: string) => ReactNode;
  connectedBranchIds?: readonly string[];
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
};

export function FieldEditor({
  validationMode,
  flowConfig,
  onChange,
  hideFlowUiLocaleSelect = false,
  onViewportChange,
  renderFlowBranchHandle,
  renderPreview,
  connectedBranchIds,
}: FieldEditorProps) {
  const t = useTranslations("Scenarios");
  const formEditor = (
    <FlowFormEditorContent
      validationMode={validationMode}
      flowConfig={flowConfig}
      onChange={onChange}
      onViewportChange={onViewportChange}
      renderFlowBranchHandle={renderFlowBranchHandle}
      renderPreview={renderPreview}
      connectedBranchIds={connectedBranchIds}
    />
  );
  const messageEditor = (
    <WhatsAppActionRenderer
      surface={renderPreview ? "message" : "phone"}
      bodyText={flowConfig.bodyText ?? ""}
      onBodyTextChange={value => onChange({ ...flowConfig, bodyText: value })}
      bodyPlaceholder={t("flowBodyTextPlaceholder")}
      footerText={flowConfig.footerText ?? ""}
      onFooterTextChange={value =>
        onChange({ ...flowConfig, footerText: value })
      }
      footerPlaceholder={t("flowFooterTextPlaceholder")}
      ctaText={flowConfig.ctaText}
      onCtaTextChange={value => onChange({ ...flowConfig, ctaText: value })}
      editorTray={renderPreview ? undefined : formEditor}
    />
  );

  return (
    <div
      className={cn(
        "nowheel flex h-full min-h-0 min-w-0 flex-col overflow-auto overscroll-contain p-3",
        renderPreview ? "w-full items-stretch" : "items-center"
      )}
      onScroll={onViewportChange}
      onWheel={stopFlowEditorWheelPropagation}
    >
      {!hideFlowUiLocaleSelect ? (
        <div className="mb-2 flex w-full max-w-[360px] items-center justify-end gap-1">
          <Languages
            className="h-3 w-3 shrink-0 text-muted-foreground/80"
            aria-hidden
          />
          <Select
            value={flowConfig.flowUiLocale ?? "en"}
            onValueChange={value =>
              onChange({
                ...flowConfig,
                flowUiLocale: value as WhatsAppFlowUiLocaleId,
              })
            }
          >
            <SelectTrigger
              title={t("flowUiLocaleLabel")}
              aria-label={t("flowUiLocaleLabel")}
              className="nodrag h-7 w-[6.75rem] shrink-0 border-border/40 bg-muted/25 text-[10px] shadow-none hover:bg-muted/45 focus:ring-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WHATSAPP_FLOW_UI_LOCALE_IDS.map(id => (
                <SelectItem key={id} value={id} className="text-xs">
                  {t(`flowUiLocaleOption.${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {renderPreview ? (
        <>
          <details className="mb-3 w-full">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t("flowAuthoring.launchMessage")}
            </summary>
            <div className="pt-3">{messageEditor}</div>
          </details>
          {formEditor}
        </>
      ) : (
        messageEditor
      )}
    </div>
  );
}
