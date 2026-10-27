"use client";

import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldType,
  WhatsAppFlowScreenConfig,
} from "@/components/scenarios/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  resolveWhatsAppFlowLayoutContent,
  type WhatsAppFlowLayoutContentItem,
  type WhatsAppFlowTextType,
} from "@icecore/scenario-contracts";
import { renameWhatsAppFlowScreen } from "@/lib/scenarios/whatsapp-flow-config";
import { cn } from "@/lib/utils";
import { extractFlowBranchOptions } from "@/lib/scenarios/whatsapp-flow-branches";
import { FlowBranchPreview } from "../../nodes/action-node/action-node-flow-branch-preview";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { FlowBranchOptionHandleRenderParams } from "./field-editor";
import { MAX_FLOW_SCREENS } from "./flow-validation";
import { convertWhatsAppFlowToStaticGraph } from "./flow-json-generator";
import {
  FLOW_AUTHORING_CONTROL,
  FlowAuthoringInput,
  FlowAuthoringLabel,
  FlowScreenActionEditor,
  useFlowAuthoringDraft,
} from "./flow-screen-action-editor";
import { FlowScreenDataEditor } from "./flow-screen-data-editor";

type Props = {
  flowConfig: WhatsAppFlowConfig;
  activeScreenIndex: number;
  onChange: (config: WhatsAppFlowConfig) => void;
  onSelectScreen: (index: number) => void;
  onAddScreen: () => void;
  onRemoveScreen: () => void;
  onAddField: (type: WhatsAppFlowFieldType) => void;
  onViewportChange?: () => void;
  fieldTypes: { value: WhatsAppFlowFieldType; label: string }[];
  renderFieldProperties: (fieldIndex: number) => ReactNode;
  renderPreview?: (screenId: string) => ReactNode;
  fillAvailableHeight?: boolean;
  connectedBranchIds?: readonly string[];
  routingEditor?: ReactNode;
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
};

const TEXT_COMPONENT_TYPES: { value: WhatsAppFlowTextType; key: string }[] = [
  { value: "TextHeading", key: "textHeading" },
  { value: "TextSubheading", key: "textSubheading" },
  { value: "TextBody", key: "textBody" },
  { value: "TextCaption", key: "textCaption" },
];

function TextProperties({
  content,
  onChange,
}: {
  content: Extract<WhatsAppFlowLayoutContentItem, { kind: "text" }>;
  onChange: (
    content: Extract<WhatsAppFlowLayoutContentItem, { kind: "text" }>
  ) => void;
}) {
  const t = useTranslations("Scenarios");
  return (
    <div className="space-y-3">
      <FlowAuthoringLabel label={t("flowAuthoring.textType")}>
        <select
          aria-label={t("flowAuthoring.textType")}
          className={FLOW_AUTHORING_CONTROL}
          value={content.type}
          onChange={event =>
            onChange({
              ...content,
              type: event.target.value as WhatsAppFlowTextType,
            })
          }
        >
          {TEXT_COMPONENT_TYPES.map(type => (
            <option key={type.value} value={type.value}>
              {t(`flowAuthoring.${type.key}`)}
            </option>
          ))}
        </select>
      </FlowAuthoringLabel>
      <FlowAuthoringLabel label={t("flowAuthoring.text")}>
        <Textarea
          aria-label={t("flowAuthoring.text")}
          value={content.text}
          rows={5}
          className="nodrag nowheel max-h-64 min-h-28 resize-y border-input/60 text-xs shadow-none [overflow-wrap:anywhere]"
          onChange={event => onChange({ ...content, text: event.target.value })}
        />
      </FlowAuthoringLabel>
    </div>
  );
}

function ScreenProperties({
  flowConfig,
  index,
  onChange,
  connectedBranchIds,
}: {
  flowConfig: WhatsAppFlowConfig;
  index: number;
  onChange: Props["onChange"];
  connectedBranchIds?: readonly string[];
}) {
  const t = useTranslations("Scenarios");
  const screen = flowConfig.screens[index];
  const graph = flowConfig.flowNavigationMode === "static_graph";
  const idDraft = useFlowAuthoringDraft(screen.id);
  const update = (patch: Partial<WhatsAppFlowScreenConfig>) =>
    onChange({
      ...flowConfig,
      screens: flowConfig.screens.map((candidate, i) =>
        i === index ? { ...candidate, ...patch } : candidate
      ),
    });
  return (
    <div className="space-y-4">
      <FlowAuthoringInput
        label={t("flowAuthoring.screenTitle")}
        value={screen.title}
        onChange={title => update({ title })}
      />
      {graph ? (
        <>
          <label className="flex min-h-8 items-center gap-2 text-xs">
            <Checkbox
              aria-label={t("flowAuthoring.terminal")}
              checked={screen.terminal === true}
              onCheckedChange={checked =>
                update({ terminal: checked === true })
              }
            />
            {t("flowAuthoring.terminal")}
          </label>
          <FlowAuthoringLabel label={t("flowAuthoring.footer")}>
            <select
              aria-label={t("flowAuthoring.footer")}
              className={FLOW_AUTHORING_CONTROL}
              value={screen.footer ? "on" : "off"}
              onChange={event =>
                update({
                  footer:
                    event.target.value === "off"
                      ? undefined
                      : {
                          label: "",
                          action: screen.terminal
                            ? { name: "complete" }
                            : {
                                name: "navigate",
                                nextScreenId:
                                  flowConfig.screens.find(
                                    candidate => candidate.id !== screen.id
                                  )?.id ?? "",
                              },
                        },
                })
              }
            >
              <option value="off">{t("flowAuthoring.noFooter")}</option>
              <option value="on">{t("flowAuthoring.footer")}</option>
            </select>
          </FlowAuthoringLabel>
          {screen.footer ? (
            <>
              <FlowAuthoringInput
                label={t("flowAuthoring.footerLabel")}
                value={screen.footer.label}
                onChange={label =>
                  update({ footer: { ...screen.footer!, label } })
                }
              />
              <FlowScreenActionEditor
                action={screen.footer.action}
                screen={screen}
                screens={flowConfig.screens}
                connectedBranchIds={connectedBranchIds}
                onChange={action =>
                  update({ footer: { ...screen.footer!, action } })
                }
              />
            </>
          ) : null}
        </>
      ) : (
        <FlowAuthoringInput
          label={t("flowAuthoring.footerLabel")}
          value={flowConfig.flowSubmitLabel ?? ""}
          onChange={flowSubmitLabel =>
            onChange({ ...flowConfig, flowSubmitLabel })
          }
        />
      )}
      <details
        data-testid="flow-screen-advanced"
        className="space-y-3 border-t border-border/40 pt-3"
      >
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t("flowAuthoring.advanced")}
        </summary>
        <div className="space-y-3 pt-2">
          <FlowAuthoringInput
            label={t("flowAuthoring.screenId")}
            value={idDraft.value}
            onChange={idDraft.change}
            onBlur={() => {
              const next = renameWhatsAppFlowScreen(
                flowConfig,
                index,
                idDraft.value
              );
              idDraft.change(next.screens[index].id);
              if (next.screens[index].id !== screen.id) onChange(next);
            }}
          />
          {graph ? (
            <>
              <FlowAuthoringLabel label={t("flowAuthoring.success")}>
                <select
                  aria-label={t("flowAuthoring.success")}
                  className={FLOW_AUTHORING_CONTROL}
                  value={
                    screen.success === undefined
                      ? "default"
                      : String(screen.success)
                  }
                  onChange={event =>
                    update({
                      success:
                        event.target.value === "default"
                          ? undefined
                          : event.target.value === "true",
                    })
                  }
                >
                  <option value="default">
                    {t("flowAuthoring.successDefault")}
                  </option>
                  <option value="true">{t("flowAuthoring.successTrue")}</option>
                  <option value="false">
                    {t("flowAuthoring.successFalse")}
                  </option>
                </select>
              </FlowAuthoringLabel>
              <FlowAuthoringLabel label={t("flowAuthoring.formLayout")}>
                <select
                  aria-label={t("flowAuthoring.formLayout")}
                  className={FLOW_AUTHORING_CONTROL}
                  value={screen.layoutForm ? "form" : "direct"}
                  onChange={event =>
                    update({
                      layoutForm:
                        event.target.value === "form"
                          ? { name: "form" }
                          : undefined,
                    })
                  }
                >
                  <option value="direct">
                    {t("flowAuthoring.directLayout")}
                  </option>
                  <option value="form">{t("flowAuthoring.formLayout")}</option>
                </select>
              </FlowAuthoringLabel>
              {screen.layoutForm ? (
                <FlowAuthoringInput
                  label={t("flowAuthoring.formName")}
                  value={screen.layoutForm.name}
                  onChange={name => update({ layoutForm: { name } })}
                />
              ) : null}
              <FlowScreenDataEditor
                data={screen.data}
                onChange={data => update({ data })}
              />
            </>
          ) : null}
        </div>
      </details>
    </div>
  );
}

/** One shared workspace: selection controls the real preview and one focused inspector. */
export function FlowAuthoringWorkspace({
  flowConfig,
  activeScreenIndex,
  onChange,
  onSelectScreen,
  onAddScreen,
  onRemoveScreen,
  onAddField,
  onViewportChange,
  fieldTypes,
  renderFieldProperties,
  renderPreview,
  fillAvailableHeight = false,
  connectedBranchIds,
  routingEditor,
  renderFlowBranchHandle,
}: Props) {
  const t = useTranslations("Scenarios");
  const screen = flowConfig.screens[activeScreenIndex];
  const [contentIndex, setContentIndex] = useState(0);
  const [inspector, setInspector] = useState<"screen" | "field">("field");
  const [pane, setPane] = useState<"outline" | "edit" | "preview">("edit");
  const outlineRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const outlineFocusRef = useRef<Element | null>(null);
  const openEditor = () => {
    const focused = document.activeElement;
    outlineFocusRef.current = outlineRef.current?.contains(focused)
      ? focused
      : null;
    setPane("edit");
  };
  useLayoutEffect(() => {
    const focused = outlineFocusRef.current;
    outlineFocusRef.current = null;
    if (
      pane === "edit" &&
      focused &&
      outlineRef.current?.contains(focused) &&
      window.getComputedStyle(outlineRef.current).display === "none" &&
      (document.activeElement === focused ||
        document.activeElement === document.body)
    ) {
      editorRef.current?.focus({ preventScroll: true });
    }
  }, [pane]);
  const [newComponentType, setNewComponentType] = useState<
    WhatsAppFlowFieldType | WhatsAppFlowTextType
  >("TextInput");
  const content = screen ? resolveWhatsAppFlowLayoutContent(screen) : [];
  const selectedIndex = Math.min(contentIndex, Math.max(0, content.length - 1));
  const selectedContent = content[selectedIndex];
  const selectedField =
    selectedContent?.kind === "field"
      ? screen?.fields.find(field => field.id === selectedContent.fieldId)
      : undefined;
  const graph = flowConfig.flowNavigationMode === "static_graph";
  const endpoint = flowConfig.flowNavigationMode === "data_endpoint";
  const branchOptions = renderFlowBranchHandle
    ? extractFlowBranchOptions(flowConfig)
    : [];
  const selectScreen = (index: number) => {
    openEditor();
    onSelectScreen(index);
    setContentIndex(0);
    setInspector(
      resolveWhatsAppFlowLayoutContent(flowConfig.screens[index]).length
        ? "field"
        : "screen"
    );
  };
  const moveScreen = (offset: number) => {
    const screens = [...flowConfig.screens];
    [screens[activeScreenIndex], screens[activeScreenIndex + offset]] = [
      screens[activeScreenIndex + offset],
      screens[activeScreenIndex],
    ];
    onChange({ ...flowConfig, screens });
    onSelectScreen(activeScreenIndex + offset);
  };
  const updateContent = (layoutContent: WhatsAppFlowLayoutContentItem[]) => {
    if (!screen) return;
    onChange({
      ...flowConfig,
      screens: flowConfig.screens.map((candidate, i) =>
        i === activeScreenIndex ? { ...candidate, layoutContent } : candidate
      ),
    });
  };
  const moveContent = (offset: number) => {
    if (!screen || !selectedContent) return;
    if (screen.layoutContent) {
      const next = [...content];
      [next[selectedIndex], next[selectedIndex + offset]] = [
        next[selectedIndex + offset],
        next[selectedIndex],
      ];
      updateContent(next);
    } else {
      const fields = [...screen.fields];
      [fields[selectedIndex], fields[selectedIndex + offset]] = [
        fields[selectedIndex + offset],
        fields[selectedIndex],
      ];
      onChange({
        ...flowConfig,
        screens: flowConfig.screens.map((candidate, i) =>
          i === activeScreenIndex ? { ...candidate, fields } : candidate
        ),
      });
    }
    setContentIndex(selectedIndex + offset);
    onViewportChange?.();
  };
  const addComponent = () => {
    if (!screen) return;
    openEditor();
    if (TEXT_COMPONENT_TYPES.some(type => type.value === newComponentType)) {
      const base = convertWhatsAppFlowToStaticGraph(flowConfig);
      const candidate = base?.screens[activeScreenIndex];
      if (!base || !candidate) return;
      const previous = resolveWhatsAppFlowLayoutContent(candidate);
      let suffix = 1;
      while (
        previous.some(
          item => item.kind === "text" && item.id === `text_${suffix}`
        )
      )
        suffix++;
      onChange({
        ...base,
        screens: base.screens.map((entry, index) =>
          index === activeScreenIndex
            ? {
                ...entry,
                layoutContent: [
                  ...previous,
                  {
                    kind: "text",
                    id: `text_${suffix}`,
                    type: newComponentType as WhatsAppFlowTextType,
                    text: "",
                  },
                ],
              }
            : entry
        ),
      });
    } else onAddField(newComponentType as WhatsAppFlowFieldType);
    setContentIndex(content.length);
    setInspector("field");
  };
  const paneClass = (name: typeof pane) =>
    cn(
      "min-w-0",
      pane === name ? "block" : "hidden",
      "@min-[56rem]/flow-authoring:block",
      fillAvailableHeight && "min-h-0 overflow-y-auto overscroll-contain"
    );
  return (
    <div
      className={cn(
        "@container/flow-authoring min-w-0",
        fillAvailableHeight
          ? "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
          : "space-y-4"
      )}
      data-testid="flow-authoring-workspace"
    >
      <div
        className="flex shrink-0 gap-1 rounded-lg bg-muted/40 p-1 @min-[56rem]/flow-authoring:hidden"
        aria-label={t("flowAuthoring.edit")}
        data-testid="flow-authoring-pane-switcher"
      >
        {(
          [
            "outline",
            "edit",
            ...(renderPreview ? ["preview" as const] : []),
          ] as const
        ).map(name => (
          <Button
            key={name}
            type="button"
            variant={pane === name ? "secondary" : "ghost"}
            size="sm"
            className="h-auto min-h-8 min-w-0 flex-1 whitespace-normal px-2 text-xs leading-snug shadow-none"
            aria-pressed={pane === name}
            onClick={() => {
              setPane(name);
              onViewportChange?.();
            }}
          >
            {t(`flowAuthoring.${name}`)}
          </Button>
        ))}
      </div>
      <div
        className={cn(
          "grid min-w-0 gap-5",
          fillAvailableHeight && "min-h-0 flex-1",
          renderPreview
            ? "@min-[56rem]/flow-authoring:grid-cols-[minmax(140px,180px)_minmax(0,1fr)_minmax(280px,340px)]"
            : "@min-[56rem]/flow-authoring:grid-cols-[minmax(140px,180px)_minmax(0,1fr)]"
        )}
      >
        <nav
          ref={outlineRef}
          className={paneClass("outline")}
          aria-label={t("flowAuthoring.outline")}
          data-testid="flow-authoring-outline"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold">
              {t("flowAuthoring.screens")}
            </h3>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {flowConfig.screens.length}/{MAX_FLOW_SCREENS}
            </span>
          </div>
          <div className="space-y-1">
            {flowConfig.screens.map((candidate, index) => (
              <Button
                key={index}
                type="button"
                variant="ghost"
                className={cn(
                  "h-auto min-h-10 w-full justify-start whitespace-normal px-2 py-2 text-left",
                  index === activeScreenIndex && "bg-accent"
                )}
                aria-label={`${candidate.id} ${candidate.title}`.trim()}
                aria-pressed={index === activeScreenIndex}
                title={candidate.id}
                onClick={() => selectScreen(index)}
              >
                <span className="min-w-0 truncate text-xs">
                  {candidate.title || candidate.id || t("flowAuthoring.screen")}
                </span>
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 h-8 w-full justify-start px-2 text-xs text-muted-foreground"
            disabled={flowConfig.screens.length >= MAX_FLOW_SCREENS}
            onClick={() => {
              openEditor();
              onAddScreen();
              setInspector("screen");
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("flowAddScreen")}
          </Button>
          {!endpoint ? (
            <details className="mt-4 space-y-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("flowAuthoring.advanced")}
              </summary>
              <div className="space-y-3 pt-2">
                <FlowAuthoringLabel label={t("flowAuthoring.navigationMode")}>
                  <select
                    aria-label={t("flowAuthoring.navigationMode")}
                    className={FLOW_AUTHORING_CONTROL}
                    value={graph ? "static_graph" : "linear"}
                    onChange={() => {
                      const next = convertWhatsAppFlowToStaticGraph(flowConfig);
                      if (next) onChange(next);
                      onViewportChange?.();
                    }}
                  >
                    {!graph ? (
                      <option value="linear">
                        {t("flowAuthoring.linearMode")}
                      </option>
                    ) : null}
                    <option value="static_graph">
                      {t("flowAuthoring.graphMode")}
                    </option>
                  </select>
                </FlowAuthoringLabel>
                {graph ? (
                  <FlowAuthoringLabel label={t("flowAuthoring.version")}>
                    <select
                      aria-label={t("flowAuthoring.version")}
                      className={FLOW_AUTHORING_CONTROL}
                      value={flowConfig.flowJsonVersion ?? "7.3"}
                      onChange={event =>
                        onChange({
                          ...flowConfig,
                          flowJsonVersion: event.target.value as "6.3" | "7.3",
                        })
                      }
                    >
                      <option value="6.3">6.3</option>
                      <option value="7.3">7.3</option>
                    </select>
                  </FlowAuthoringLabel>
                ) : null}
              </div>
            </details>
          ) : null}
          {screen ? (
            <div className="mt-5 space-y-2">
              <h3 className="text-xs font-semibold">
                {t(graph ? "flowAuthoring.content" : "flowAuthoring.fields")}
              </h3>
              {content.map((item, index) => {
                const field =
                  item.kind === "field"
                    ? screen.fields.find(
                        candidate => candidate.id === item.fieldId
                      )
                    : undefined;
                const label =
                  item.kind === "text"
                    ? item.text ||
                      t(
                        `flowAuthoring.${TEXT_COMPONENT_TYPES.find(type => type.value === item.type)?.key ?? "text"}`
                      )
                    : field?.label || item.fieldId;
                return (
                  <div key={index} className="relative min-w-0">
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(
                        "h-auto min-h-8 w-full justify-start whitespace-normal px-2 py-1.5 text-left text-xs",
                        inspector === "field" &&
                          selectedIndex === index &&
                          "bg-accent"
                      )}
                      aria-pressed={
                        inspector === "field" && selectedIndex === index
                      }
                      onClick={() => {
                        openEditor();
                        setContentIndex(index);
                        setInspector("field");
                        onViewportChange?.();
                      }}
                    >
                      <span className="truncate">{label}</span>
                    </Button>
                  </div>
                );
              })}
              {!content.length ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("flowAuthoring.emptyFields")}
                </p>
              ) : null}
              <select
                aria-label={t("flowAddField")}
                className={FLOW_AUTHORING_CONTROL}
                value={newComponentType}
                onChange={event =>
                  setNewComponentType(
                    event.target.value as
                      | WhatsAppFlowFieldType
                      | WhatsAppFlowTextType
                  )
                }
              >
                {fieldTypes
                  .filter(type => graph || type.value !== "NavigationList")
                  .map(type => (
                    <option key={type.value} value={type.value}>
                      {type.value === "NavigationList"
                        ? t("flowAuthoring.navigationList")
                        : type.label}
                    </option>
                  ))}
                {!endpoint
                  ? TEXT_COMPONENT_TYPES.map(type => (
                      <option key={type.value} value={type.value}>
                        {t(`flowAuthoring.${type.key}`)}
                      </option>
                    ))
                  : null}
              </select>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 w-full text-xs"
                onClick={addComponent}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t("flowAddField")}
              </Button>
            </div>
          ) : null}
        </nav>
        <section
          ref={editorRef}
          tabIndex={-1}
          aria-label={t("flowAuthoring.edit")}
          data-testid="flow-authoring-editor"
          className={cn(
            paneClass("edit"),
            "space-y-4 @min-[56rem]/flow-authoring:pr-1"
          )}
        >
          {screen ? (
            <>
              <div className="flex gap-1 rounded-lg bg-muted/40 p-1">
                <Button
                  type="button"
                  variant={inspector === "screen" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 min-w-0 flex-1 text-xs shadow-none"
                  aria-pressed={inspector === "screen"}
                  onClick={() => setInspector("screen")}
                >
                  {t("flowAuthoring.screen")}
                </Button>
                <Button
                  type="button"
                  variant={inspector === "field" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 min-w-0 flex-1 text-xs shadow-none"
                  disabled={!selectedContent}
                  aria-pressed={inspector === "field"}
                  onClick={() => setInspector("field")}
                >
                  {t(graph ? "flowAuthoring.content" : "flowAuthoring.fields")}
                </Button>
              </div>
              {inspector === "screen" || !selectedContent ? (
                <>
                  <h3 className="text-sm font-semibold">
                    {t("flowAuthoring.editScreen")}
                  </h3>
                  <ScreenProperties
                    key={activeScreenIndex}
                    flowConfig={flowConfig}
                    index={activeScreenIndex}
                    onChange={onChange}
                    connectedBranchIds={connectedBranchIds}
                  />
                  <div className="flex flex-wrap items-center gap-1 pt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={activeScreenIndex === 0}
                      aria-label={t("flowAuthoring.moveUp")}
                      onClick={() => moveScreen(-1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={
                        activeScreenIndex >= flowConfig.screens.length - 1
                      }
                      aria-label={t("flowAuthoring.moveDown")}
                      onClick={() => moveScreen(1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs text-destructive"
                      disabled={flowConfig.screens.length <= 1}
                      onClick={onRemoveScreen}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {t("flowRemoveScreen")}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="min-w-0 truncate text-xs font-semibold">
                      {t("flowAuthoring.editComponent")}
                    </h3>
                    <div className="flex gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={selectedIndex === 0}
                        aria-label={t("flowAuthoring.moveUp")}
                        onClick={() => moveContent(-1)}
                      >
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={selectedIndex >= content.length - 1}
                        aria-label={t("flowAuthoring.moveDown")}
                        onClick={() => moveContent(1)}
                      >
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      {selectedContent.kind === "text" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          aria-label={t("delete")}
                          onClick={() => {
                            updateContent(
                              content.filter(
                                (_, index) => index !== selectedIndex
                              )
                            );
                            onViewportChange?.();
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {selectedContent.kind === "text" ? (
                    <TextProperties
                      content={selectedContent}
                      onChange={next =>
                        updateContent(
                          content.map((item, index) =>
                            index === selectedIndex ? next : item
                          )
                        )
                      }
                    />
                  ) : selectedField ? (
                    renderFieldProperties(screen.fields.indexOf(selectedField))
                  ) : null}
                </>
              )}
              {routingEditor ? (
                <details className="border-t border-border/40 pt-3">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {t("flowAuthoring.advanced")}
                  </summary>
                  <div className="pt-3">{routingEditor}</div>
                </details>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("flowAuthoring.selectField")}
            </p>
          )}
        </section>
        {renderPreview && screen ? (
          <aside
            aria-label={t("flowAuthoring.preview")}
            data-testid="flow-authoring-preview"
            className={cn(
              paneClass("preview"),
              "rounded-2xl bg-muted/25 p-3 @min-[56rem]/flow-authoring:p-4"
            )}
          >
            <h3 className="mb-3 text-sm font-semibold">
              {t("flowAuthoring.preview")}
            </h3>
            <div className="flex min-w-0 justify-center">
              {renderPreview(screen.id)}
            </div>
          </aside>
        ) : null}
      </div>
      {branchOptions.length > 0 ? (
        <div className="shrink-0">
          <FlowBranchPreview
            options={branchOptions}
            connectedBranchIds={connectedBranchIds}
            renderFlowBranchHandle={renderFlowBranchHandle}
          />
        </div>
      ) : null}
    </div>
  );
}
