"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Textarea } from "@/components/ui/textarea";
import type { ScenarioTriggerConfig, TranslateFn } from "../../types";
import type { MessageTriggerEditorModel } from "./message-trigger-editor-model";
import { useState } from "react";
import { InfoIcon } from "lucide-react";

export function MessageMatchEditor({
  message,
  onChange,
  t,
}: {
  message: MessageTriggerEditorModel["message"];
  onChange: (delta: Partial<ScenarioTriggerConfig>) => void;
  t: TranslateFn;
}) {
  const [showKeywordMatchMode, setShowKeywordMatchMode] = useState(false);
  const showAdvanced =
    message.isContains &&
    (message.keywordMatchMode !== "contains" || showKeywordMatchMode);
  const patternLabel = message.isExact
    ? t("triggerExactMessage")
    : t("triggerKeywordPattern");
  const patternPlaceholder = message.isExact
    ? t("triggerExactMessagePlaceholder")
    : t("triggerKeywordPatternPlaceholder");

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2">
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <label className="text-[11px] font-medium text-muted-foreground">
            {t("triggerMessageMatchMode")}
          </label>
          {message.mode === "any" ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="nodrag size-6 text-muted-foreground"
                  aria-label={t("triggerMessageMatchHelp")}
                >
                  <InfoIcon className="size-3.5" aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="nodrag nowheel w-64 max-w-[calc(100vw-2rem)] text-xs"
                aria-label={t("triggerMessageMatchHelp")}
              >
                {t("triggerAnyMessageFilterHelp")}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
        <Select
          value={message.mode}
          onValueChange={value => {
            setShowKeywordMatchMode(false);
            onChange({
              messageMatchMode:
                value as ScenarioTriggerConfig["messageMatchMode"],
            });
          }}
        >
          <SelectTrigger className="nodrag h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("triggerMatchAny")}</SelectItem>
            <SelectItem value="exact">{t("triggerMatchExact")}</SelectItem>
            <SelectItem value="contains">
              {t("triggerMatchContains")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {message.usesPattern ? (
        <>
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {patternLabel}
            </label>
            {message.isExact ? (
              <Textarea
                value={message.pattern}
                onChange={event =>
                  onChange({ keywordPattern: event.target.value })
                }
                onKeyDown={event => event.stopPropagation()}
                placeholder={patternPlaceholder}
                className="nodrag min-h-[88px] resize-y font-semibold"
                rows={3}
              />
            ) : (
              <Input
                value={message.pattern}
                onChange={event =>
                  onChange({ keywordPattern: event.target.value })
                }
                onKeyDown={event => event.stopPropagation()}
                placeholder={patternPlaceholder}
                className="nodrag h-8 font-semibold"
              />
            )}
          </div>
          {showAdvanced ? (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {t("triggerKeywordMatchMode")}
              </label>
              <Select
                value={message.keywordMatchMode}
                onValueChange={value => {
                  if (value !== "contains") setShowKeywordMatchMode(true);
                  onChange({
                    keywordMatchMode: value as "contains" | "regex",
                  });
                }}
              >
                <SelectTrigger className="nodrag h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">
                    {t("triggerKeywordMatchContains")}
                  </SelectItem>
                  <SelectItem value="regex">
                    {t("triggerKeywordMatchRegex")}
                  </SelectItem>
                </SelectContent>
              </Select>
              {message.keywordMatchMode === "contains" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1 text-[11px]"
                  onClick={() => setShowKeywordMatchMode(false)}
                >
                  {t("inlineHideAdvanced")}
                </Button>
              ) : null}
            </div>
          ) : message.isContains ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1 text-[11px]"
              onClick={() => setShowKeywordMatchMode(true)}
            >
              {t("inlineShowAdvanced")}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
