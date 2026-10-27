"use client";

import type {
  ScenarioRecipientColumnSplitConfig,
  ScenarioRecipientColumnSplitOp,
  ScenarioRecipientColumnSplitPath,
  ScenarioRecipientColumnSplitRule,
  TranslateFn,
} from "@/components/scenarios/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
  RECIPIENT_COLUMN_SPLIT_NUMBER_OPS,
  RECIPIENT_COLUMN_SPLIT_STRING_OPS,
  buildRecipientColumnSplitPathHandleId,
  createDefaultRecipientColumnSplitPath,
  getRecipientColumnSplitConfig,
  parseRecipientColumnSplitInValues,
} from "@/lib/scenarios/recipient-column-split";
import { Plus, Trash2 } from "lucide-react";
import { ScenarioRouteHandle, bindSourceHandleCreate } from "../scenario-route";
import type { ScenarioNodeData } from "../types";
import type { ScenarioLogicEditorNodeData } from "../view/node-enrichment/types";

type RecipientColumnSplitEditorProps = {
  nodeData: ScenarioLogicEditorNodeData;
  t: TranslateFn;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
};

function opLabelKey(op: ScenarioRecipientColumnSplitOp): string {
  return `columnSplitOp_${op}`;
}

function ruleNeedsValue(op: ScenarioRecipientColumnSplitOp): boolean {
  return op !== "is_empty" && op !== "is_not_empty";
}

function ruleNeedsSecondValue(op: ScenarioRecipientColumnSplitOp): boolean {
  return op === "between";
}

function updateConfig(
  config: ScenarioRecipientColumnSplitConfig,
  patchNode: (patch: Partial<ScenarioNodeData>) => void
) {
  patchNode({ recipientColumnSplit: config });
}

function PathConnectHandle(params: {
  handleId: string;
  title: string;
  nodeData: ScenarioLogicEditorNodeData;
}) {
  return (
    <ScenarioRouteHandle
      id={params.handleId}
      local
      title={params.title}
      onCreateNode={bindSourceHandleCreate(
        params.nodeData.uiOnCreateNodeFromSourceHandle,
        params.handleId
      )}
    />
  );
}

export function RecipientColumnSplitEditor({
  nodeData,
  t,
  patchNode,
}: RecipientColumnSplitEditorProps) {
  const config = getRecipientColumnSplitConfig(nodeData);
  const columnOptions = nodeData.uiRecipientColumnOptions ?? [];
  const valueSuggestions = nodeData.uiRecipientColumnValueSuggestions ?? {};
  const disabledReason = nodeData.uiRecipientColumnSplitDisabledReason;
  const routePreview = nodeData.uiBulkColumnSplitPreview;

  const patchPath = (
    pathId: string,
    updater: (
      path: ScenarioRecipientColumnSplitPath
    ) => ScenarioRecipientColumnSplitPath
  ) => {
    updateConfig(
      {
        ...config,
        paths: config.paths.map(path =>
          path.id === pathId ? updater(path) : path
        ),
      },
      patchNode
    );
  };

  const patchRule = (
    pathId: string,
    ruleId: string,
    patch: Partial<ScenarioRecipientColumnSplitRule>
  ) => {
    patchPath(pathId, path => ({
      ...path,
      rules: path.rules.map(rule =>
        rule.id === ruleId ? { ...rule, ...patch } : rule
      ),
    }));
  };

  const addPath = () => {
    updateConfig(
      {
        ...config,
        paths: [
          ...config.paths,
          createDefaultRecipientColumnSplitPath(
            config.paths.length,
            config.paths.map(path => path.id)
          ),
        ],
      },
      patchNode
    );
  };

  const removePath = (pathId: string) => {
    updateConfig(
      {
        ...config,
        paths: config.paths.filter(path => path.id !== pathId),
      },
      patchNode
    );
  };

  const addRule = (pathId: string) => {
    patchPath(pathId, path => ({
      ...path,
      rules: [
        ...path.rules,
        {
          id: `rule_${path.rules.length + 1}`,
          column: columnOptions[0] ?? "",
          op: "equals",
          value: "",
        },
      ],
    }));
  };

  const removeRule = (pathId: string, ruleId: string) => {
    patchPath(pathId, path => ({
      ...path,
      rules: path.rules.filter(rule => rule.id !== ruleId),
    }));
  };

  if (disabledReason) {
    return (
      <div className="rounded-md border border-dashed bg-muted/20 p-2 text-[11px] text-muted-foreground">
        {disabledReason}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-[10px] leading-snug text-muted-foreground">
        {t("columnSplitEditorHint")}
      </p>

      {config.paths.map((path, pathIndex) => {
        const handleId = buildRecipientColumnSplitPathHandleId(path.id);
        const previewRoute = routePreview?.routes?.find(
          route => !route.isElse && route.pathId === path.id
        );

        return (
          <div
            key={path.id}
            className="rounded-md border bg-background/80 p-2 shadow-sm"
          >
            <div className="relative -mx-2 mb-2 flex items-center gap-2 overflow-visible px-2">
              <Input
                value={path.label ?? ""}
                placeholder={t("columnSplitPathLabelPlaceholder", {
                  index: pathIndex + 1,
                })}
                onChange={event =>
                  patchPath(path.id, current => ({
                    ...current,
                    label: event.target.value,
                  }))
                }
                className="nodrag h-7 min-w-0 flex-1 text-[11px] font-medium"
                onPointerDown={event => event.stopPropagation()}
              />
              {typeof previewRoute?.recipientCount === "number" ? (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {t("columnSplitPathRecipientCount", {
                    count: previewRoute.recipientCount,
                  })}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => removePath(path.id)}
                aria-label={t("columnSplitRemovePath")}
                disabled={config.paths.length <= 1}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <PathConnectHandle
                handleId={handleId}
                title={t("sourceHandleColumnSplitPathTooltip")}
                nodeData={nodeData}
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("columnSplitWhenAllMatch")}
              </p>
              {path.rules.map(rule => {
                const suggestions = valueSuggestions[rule.column] ?? [];
                const showValue = ruleNeedsValue(rule.op);
                const showSecondValue = ruleNeedsSecondValue(rule.op);

                return (
                  <div
                    key={rule.id}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-1"
                  >
                    <Select
                      value={rule.column || undefined}
                      onValueChange={value =>
                        patchRule(path.id, rule.id, { column: value })
                      }
                    >
                      <SelectTrigger className="nodrag h-7 text-[11px]">
                        <SelectValue
                          placeholder={t("columnSplitColumnPlaceholder")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {columnOptions.map(column => (
                          <SelectItem key={column} value={column}>
                            {column}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Select
                      value={rule.op}
                      onValueChange={value =>
                        patchRule(path.id, rule.id, {
                          op: value as ScenarioRecipientColumnSplitOp,
                        })
                      }
                    >
                      <SelectTrigger className="nodrag h-7 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[
                          ...RECIPIENT_COLUMN_SPLIT_STRING_OPS,
                          ...RECIPIENT_COLUMN_SPLIT_NUMBER_OPS,
                        ].map(op => (
                          <SelectItem key={op} value={op}>
                            {t(opLabelKey(op))}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {showValue ? (
                      showSecondValue ? (
                        <div className="flex min-w-0 items-center gap-1">
                          <Input
                            value={rule.value ?? ""}
                            placeholder={t("columnSplitValuePlaceholder")}
                            onChange={event =>
                              patchRule(path.id, rule.id, {
                                value: event.target.value,
                              })
                            }
                            className="nodrag h-7 min-w-0 flex-1 text-[11px]"
                            onPointerDown={event => event.stopPropagation()}
                          />
                          <span className="text-[10px] text-muted-foreground">
                            –
                          </span>
                          <Input
                            value={rule.valueTo ?? ""}
                            placeholder={t("columnSplitValueToPlaceholder")}
                            onChange={event =>
                              patchRule(path.id, rule.id, {
                                valueTo: event.target.value,
                              })
                            }
                            className="nodrag h-7 min-w-0 flex-1 text-[11px]"
                            onPointerDown={event => event.stopPropagation()}
                          />
                        </div>
                      ) : (
                        <Input
                          value={
                            rule.op === "in"
                              ? (rule.value ?? rule.values?.join(", ") ?? "")
                              : (rule.value ?? "")
                          }
                          list={
                            suggestions.length > 0
                              ? `column-split-${path.id}-${rule.id}`
                              : undefined
                          }
                          placeholder={
                            rule.op === "in"
                              ? t("columnSplitInValuesPlaceholder")
                              : t("columnSplitValuePlaceholder")
                          }
                          onChange={event => {
                            if (rule.op === "in") {
                              const nextValue = event.target.value;
                              patchRule(path.id, rule.id, {
                                value: nextValue,
                                values:
                                  parseRecipientColumnSplitInValues(nextValue),
                              });
                              return;
                            }
                            patchRule(path.id, rule.id, {
                              value: event.target.value,
                              values: undefined,
                            });
                          }}
                          className="nodrag h-7 text-[11px]"
                          onPointerDown={event => event.stopPropagation()}
                        />
                      )
                    ) : (
                      <div className="h-7 rounded-md border border-dashed bg-muted/20" />
                    )}

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => removeRule(path.id, rule.id)}
                      aria-label={t("columnSplitRemoveRule")}
                      disabled={path.rules.length <= 1}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>

                    {suggestions.length > 0 ? (
                      <datalist id={`column-split-${path.id}-${rule.id}`}>
                        {suggestions.map(value => (
                          <option key={value} value={value} />
                        ))}
                      </datalist>
                    ) : null}
                  </div>
                );
              })}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="nodrag h-7 w-full justify-start px-1 text-[11px] text-muted-foreground"
                onClick={() => addRule(path.id)}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t("columnSplitAddRule")}
              </Button>
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="nodrag h-8 w-full text-[11px]"
        onClick={addPath}
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {t("columnSplitAddPath")}
      </Button>

      <div className="relative flex items-start justify-between gap-2 overflow-visible rounded-md border border-dashed bg-muted/15 p-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-[11px] font-medium">{t("columnSplitElsePath")}</p>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {t("columnSplitElseHint")}
          </p>
          {typeof routePreview?.elseCount === "number" ? (
            <p className="text-[10px] tabular-nums text-muted-foreground">
              {t("columnSplitPathRecipientCount", {
                count: routePreview.elseCount,
              })}
            </p>
          ) : null}
        </div>
        <PathConnectHandle
          handleId={RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID}
          title={t("sourceHandleColumnSplitElseTooltip")}
          nodeData={nodeData}
        />
      </div>
    </div>
  );
}
