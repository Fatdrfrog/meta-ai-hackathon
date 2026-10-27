"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { TranslateFn } from "../types";
import { useScenarioGraphResources } from "../view/graph/resources-context";
import type { ScenarioContextEditorNodeData } from "../view/node-enrichment/types";
import { filterScenarioContextItems } from "./utils";

type ScenarioNodeContextSectionProps = {
  nodeData: ScenarioContextEditorNodeData;
  t: TranslateFn;
};

function AnswerSnippetCreateForm({
  t,
  disabled,
  onSubmit,
}: {
  t: TranslateFn;
  disabled: boolean;
  onSubmit: (question: string, answer: string) => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 w-full gap-1 text-[11px]"
        onClick={() => setOpen(prev => !prev)}
      >
        <Plus className="h-3 w-3" />
        {t("snippetCreateButton")}
      </Button>
      {open ? (
        <div className="space-y-1 rounded-md border bg-background p-2">
          <Input
            value={question}
            onChange={event => setQuestion(event.target.value)}
            placeholder={t("snippetQuestionPlaceholder")}
            className="nodrag h-8"
            onPointerDown={e => e.stopPropagation()}
          />
          <Textarea
            rows={3}
            value={answer}
            onChange={event => setAnswer(event.target.value)}
            placeholder={t("snippetAnswerPlaceholder")}
            className="nodrag"
            onPointerDown={e => e.stopPropagation()}
          />
          <Button
            type="button"
            size="sm"
            className="h-7 w-full text-[11px]"
            disabled={disabled || !question.trim() || !answer.trim()}
            onClick={() => {
              void onSubmit(question, answer).then(() => {
                setQuestion("");
                setAnswer("");
                setOpen(false);
              });
            }}
          >
            {disabled ? t("snippetCreating") : t("snippetCreateButton")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ScenarioNodeContextSection({
  nodeData,
  t,
}: ScenarioNodeContextSectionProps) {
  const { contextItemsLoading } = useScenarioGraphResources();
  const [contextSearch, setContextSearch] = useState("");
  const [contextSearchByOption, setContextSearchByOption] = useState<
    Record<string, string>
  >({});
  const [expandedSourceForSpecific, setExpandedSourceForSpecific] = useState<
    string | null
  >(null);

  const isUnifiedKnowledgeNode = Array.isArray(nodeData.contextSources);
  const contextItems = nodeData.uiContextItems || [];
  const contextItemIds = nodeData.contextItemIds || [];
  const contextSources = nodeData.contextSources || [];
  const contextOptionsFiltered = (nodeData.uiContextOptions || []).filter(
    opt =>
      !["connected_channels", "dynamic_business_tags"].includes(String(opt.id))
  );

  const filteredContextItems = useMemo(
    () => filterScenarioContextItems(contextItems, contextSearch),
    [contextItems, contextSearch]
  );

  const getSourceEntry = useCallback(
    (optionId: string) =>
      contextSources.find(entry => entry.optionId === optionId),
    [contextSources]
  );

  const getFilteredItemsForOption = useCallback(
    (optionId: string) => {
      const items =
        nodeData.uiContextItemsByOptionId?.[optionId] ||
        (optionId === nodeData.contextOptionId ? contextItems : []);
      return filterScenarioContextItems(
        items,
        contextSearchByOption[optionId] || ""
      );
    },
    [
      contextItems,
      contextSearchByOption,
      nodeData.contextOptionId,
      nodeData.uiContextItemsByOptionId,
    ]
  );

  if (isUnifiedKnowledgeNode) {
    return (
      <div className="space-y-1">
        {contextOptionsFiltered.map(option => {
          const sourceEntry = getSourceEntry(option.id);
          const enabled = Boolean(sourceEntry);
          const selectionMode = sourceEntry?.selectionMode ?? "all";
          const itemIds = sourceEntry?.itemIds || [];
          const expanded =
            expandedSourceForSpecific === option.id &&
            selectionMode === "specific";
          const items = getFilteredItemsForOption(option.id);
          const loading = contextItemsLoading;

          return (
            <div key={option.id} className="space-y-1">
              <label
                className={cn(
                  "nodrag flex cursor-pointer items-center justify-between gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-muted/40",
                  !option.available && "opacity-50"
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Checkbox
                    checked={enabled}
                    disabled={!option.available}
                    onCheckedChange={checked =>
                      nodeData.uiOnContextSourceToggle?.(
                        option.id,
                        Boolean(checked)
                      )
                    }
                  />
                  <span className="truncate">{option.title}</span>
                </div>
                <span className="shrink-0 text-muted-foreground">
                  ({option.count})
                </span>
              </label>
              {enabled ? (
                <div className="ml-5 space-y-1">
                  <div className="flex items-center gap-1">
                    <select
                      value={selectionMode}
                      onChange={event =>
                        nodeData.uiOnContextSourceSelectionModeChange?.(
                          option.id,
                          event.target.value as "all" | "specific"
                        )
                      }
                      className="nodrag h-6 rounded border bg-background px-2 text-[11px]"
                      onPointerDown={e => e.stopPropagation()}
                    >
                      <option value="all">{t("allItems")}</option>
                      <option value="specific">{t("specificItems")}</option>
                    </select>
                    {selectionMode === "specific" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[10px]"
                        onClick={() =>
                          setExpandedSourceForSpecific(
                            expanded ? null : option.id
                          )
                        }
                      >
                        {expanded ? "-" : "+"}
                      </Button>
                    ) : null}
                  </div>
                  {selectionMode === "specific" && expanded ? (
                    <div className="space-y-1 rounded border bg-muted/20 p-1.5">
                      <Input
                        value={contextSearchByOption[option.id] || ""}
                        onChange={event =>
                          setContextSearchByOption(current => ({
                            ...current,
                            [option.id]: event.target.value,
                          }))
                        }
                        placeholder={t("searchContextItems")}
                        className="nodrag h-7 text-[11px]"
                        onPointerDown={e => e.stopPropagation()}
                      />
                      <div className="nowheel max-h-32 space-y-0.5 overflow-y-auto rounded border bg-background p-1">
                        {loading ? (
                          <div className="px-1 py-1.5 text-[11px] text-muted-foreground">
                            {t("loadingItems")}
                          </div>
                        ) : items.length > 0 ? (
                          items.map(item => (
                            <label
                              key={item.id}
                              className="nodrag flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-muted/60"
                            >
                              <Checkbox
                                checked={itemIds.includes(item.id)}
                                onCheckedChange={() =>
                                  nodeData.uiOnContextSourceItemToggle?.(
                                    option.id,
                                    item.id
                                  )
                                }
                              />
                              <span className="truncate">{item.label}</span>
                            </label>
                          ))
                        ) : (
                          <div className="px-1 py-1.5 text-[11px] text-muted-foreground">
                            {t("noItemsFound")}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-1.5 text-[10px]"
                          onClick={() =>
                            nodeData.uiOnContextSourceSelectVisible?.(
                              option.id,
                              items.map(item => item.id)
                            )
                          }
                        >
                          {t("selectVisible")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[10px]"
                          onClick={() =>
                            nodeData.uiOnContextSourceClearSelection?.(
                              option.id
                            )
                          }
                        >
                          {t("clear")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[10px]"
                          onClick={() =>
                            nodeData.uiOnContextSourceRefresh?.(option.id)
                          }
                        >
                          {t("refresh")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {option.id === "answer_snippets" ? (
                    <AnswerSnippetCreateForm
                      t={t}
                      disabled={Boolean(nodeData.uiIsCreatingSnippet)}
                      onSubmit={async (question, answer) => {
                        if (!nodeData.uiOnContextCreateSnippet) return;
                        await nodeData.uiOnContextCreateSnippet(
                          question,
                          answer
                        );
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Select
        value={nodeData.contextOptionId || undefined}
        onValueChange={value => nodeData.uiOnContextOptionChange?.(value)}
      >
        <SelectTrigger className="nodrag h-8">
          <SelectValue placeholder={t("selectSource")} />
        </SelectTrigger>
        <SelectContent>
          {(nodeData.uiContextOptions || []).map(option => (
            <SelectItem
              key={option.id}
              value={option.id}
              disabled={!option.available}
            >
              {option.title} ({option.count})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={nodeData.contextSelectionMode || "all"}
        onValueChange={value =>
          nodeData.uiOnContextSelectionModeChange?.(value as "all" | "specific")
        }
      >
        <SelectTrigger className="nodrag h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="specific">{t("specificItems")}</SelectItem>
          <SelectItem value="all">{t("allItems")}</SelectItem>
        </SelectContent>
      </Select>
      {nodeData.contextSelectionMode === "specific" ? (
        <div className="space-y-1 rounded-md border bg-muted/20 p-2">
          <Input
            value={contextSearch}
            onChange={event => setContextSearch(event.target.value)}
            placeholder={t("searchContextItems")}
            className="nodrag h-8"
            onPointerDown={e => e.stopPropagation()}
          />
          <div className="nowheel max-h-40 space-y-1 overflow-y-auto rounded-md border bg-background p-2">
            {contextItemsLoading ? (
              <div className="px-1 py-2 text-[11px] text-muted-foreground">
                {t("loadingItems")}
              </div>
            ) : filteredContextItems.length > 0 ? (
              filteredContextItems.map(item => (
                <label
                  key={item.id}
                  className="nodrag flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-[11px] hover:bg-muted/60"
                >
                  <Checkbox
                    checked={contextItemIds.includes(item.id)}
                    onCheckedChange={() =>
                      nodeData.uiOnContextItemToggle?.(item.id)
                    }
                  />
                  <span className="truncate">{item.label}</span>
                </label>
              ))
            ) : (
              <div className="px-1 py-2 text-[11px] text-muted-foreground">
                {t("noItemsFound")}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() =>
                nodeData.uiOnContextSelectVisible?.(
                  filteredContextItems.map(item => item.id)
                )
              }
            >
              {t("selectVisible")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={nodeData.uiOnContextClearSelection}
            >
              {t("clear")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={nodeData.uiOnContextRefresh}
            >
              {t("refresh")}
            </Button>
          </div>
        </div>
      ) : null}
      {nodeData.contextOptionId === "answer_snippets" ? (
        <AnswerSnippetCreateForm
          t={t}
          disabled={Boolean(nodeData.uiIsCreatingSnippet)}
          onSubmit={async (question, answer) => {
            if (!nodeData.uiOnContextCreateSnippet) return;
            await nodeData.uiOnContextCreateSnippet(question, answer);
          }}
        />
      ) : null}
    </div>
  );
}
