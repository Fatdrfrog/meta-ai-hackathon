"use client";

import type {
  WhatsAppFlowNavigationItem,
  WhatsAppFlowPayloadValue,
  WhatsAppFlowScreenAction,
  WhatsAppFlowScreenConfig,
} from "@/components/scenarios/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { parseFlowBranchOptionKey } from "@icecore/scenario-contracts";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ComponentProps, type ReactNode } from "react";

export const FLOW_AUTHORING_CONTROL =
  "nodrag nowheel h-8 min-w-0 w-full rounded-md border border-input/60 bg-background px-2 text-xs shadow-none focus-visible:ring-1";

/** Local, explicitly committed drafts follow a new source without an effect or a remount. */
export function useFlowAuthoringDraft(source: string) {
  const [state, setState] = useState({ source, value: source, invalid: false });
  const current =
    state.source === source ? state : { source, value: source, invalid: false };
  return {
    value: current.value,
    invalid: current.invalid,
    change: (value: string) => setState({ source, value, invalid: false }),
    markInvalid: (invalid: boolean) => setState({ ...current, invalid }),
  };
}

export function FlowAuthoringLabel({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function FlowAuthoringInput({
  label,
  value,
  onChange,
  ...props
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<ComponentProps<typeof Input>, "value" | "onChange">) {
  return (
    <FlowAuthoringLabel label={label}>
      <Input
        {...props}
        aria-label={label}
        className={FLOW_AUTHORING_CONTROL}
        value={value}
        onChange={event => {
          if (!props.readOnly) onChange(event.target.value);
        }}
      />
    </FlowAuthoringLabel>
  );
}

/** Advanced values are applied explicitly; malformed JSON never overwrites a saved mapping. */
export function FlowJsonObjectEditor({
  label,
  value,
  onApply,
  readOnly = false,
  invalidMessage,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
  onApply: (value: Record<string, WhatsAppFlowPayloadValue>) => void;
  readOnly?: boolean;
  invalidMessage?: string;
}) {
  const t = useTranslations("Scenarios");
  const source = JSON.stringify(value ?? {}, null, 2);
  const draft = useFlowAuthoringDraft(source);
  return (
    <div className="space-y-2">
      <FlowAuthoringLabel label={label}>
        <Textarea
          aria-label={label}
          value={draft.value}
          readOnly={readOnly}
          maxLength={256 * 1024}
          rows={4}
          spellCheck={false}
          aria-invalid={draft.invalid}
          className="nodrag nowheel max-h-64 min-h-24 resize-y border-input/60 font-mono text-[11px] shadow-none [overflow-wrap:anywhere]"
          onChange={event => {
            if (!readOnly) draft.change(event.target.value);
          }}
        />
      </FlowAuthoringLabel>
      {draft.invalid ? (
        <p role="alert" className="text-xs text-destructive">
          {invalidMessage ?? t("flowAuthoring.invalidObject")}
        </p>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-8 text-xs"
        disabled={readOnly || draft.value === source}
        onClick={() => {
          try {
            const parsed: unknown = JSON.parse(draft.value);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw new Error("object");
            onApply(parsed as Record<string, WhatsAppFlowPayloadValue>);
            draft.markInvalid(false);
          } catch {
            draft.markInvalid(true);
          }
        }}
      >
        {t("flowAuthoring.applyJson")}
      </Button>
    </div>
  );
}

type Payload = Record<string, WhatsAppFlowPayloadValue>;
type PayloadSource = "constant" | "form" | "data" | "json";

function payloadSource(value: WhatsAppFlowPayloadValue): PayloadSource {
  if (typeof value !== "string") return "json";
  if (/^\$\{form\.[^}]+\}$/.test(value)) return "form";
  if (/^\$\{data\.[^}]+\}$/.test(value)) return "data";
  return "constant";
}

function PayloadRow({
  entryKey,
  value,
  fields,
  dataKeys,
  onRename,
  onChange,
  onRemove,
  readOnly = false,
}: {
  entryKey: string;
  value: WhatsAppFlowPayloadValue;
  fields: string[];
  dataKeys: string[];
  onRename: (key: string) => boolean;
  onChange: (value: WhatsAppFlowPayloadValue) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  const t = useTranslations("Scenarios");
  const source = payloadSource(value);
  const keyDraft = useFlowAuthoringDraft(entryKey);
  const jsonDraft = useFlowAuthoringDraft(JSON.stringify(value));
  const refs = source === "data" ? dataKeys : fields;
  const reference =
    typeof value === "string" ? value.slice(source.length + 3, -1) : "";
  return (
    <div role="group" aria-label={entryKey} className="space-y-2 py-2">
      <div className="flex items-end gap-1">
        <FlowAuthoringInput
          label={t("flowAuthoring.payloadKey")}
          value={keyDraft.value}
          readOnly={readOnly}
          aria-invalid={keyDraft.invalid}
          onChange={keyDraft.change}
          onBlur={() => {
            if (!readOnly) keyDraft.markInvalid(!onRename(keyDraft.value));
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t("delete")}
          disabled={readOnly}
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      {keyDraft.invalid ? (
        <p role="alert" className="text-xs text-destructive">
          {t("flowAuthoring.invalidPayloadKey")}
        </p>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <FlowAuthoringLabel label={t("flowAuthoring.valueSource")}>
          <select
            aria-label={t("flowAuthoring.valueSource")}
            className={FLOW_AUTHORING_CONTROL}
            value={source}
            disabled={readOnly}
            onChange={event => {
              const next = event.target.value as PayloadSource;
              if (next === "form" || next === "data") {
                const key = (next === "form" ? fields : dataKeys)[0] ?? "";
                onChange(`\${${next}.${key}}`);
              } else onChange(next === "json" ? null : "");
            }}
          >
            <option value="constant">{t("flowAuthoring.constant")}</option>
            <option value="form">{t("flowAuthoring.formValue")}</option>
            <option value="data">{t("flowAuthoring.dataValue")}</option>
            <option value="json">{t("flowAuthoring.jsonValue")}</option>
          </select>
        </FlowAuthoringLabel>
        {source === "constant" ? (
          <FlowAuthoringInput
            label={t("flowAuthoring.value")}
            value={String(value)}
            readOnly={readOnly}
            onChange={onChange}
          />
        ) : source === "json" ? (
          <FlowAuthoringInput
            label={t("flowAuthoring.value")}
            value={jsonDraft.value}
            readOnly={readOnly}
            aria-invalid={jsonDraft.invalid}
            onChange={jsonDraft.change}
            onBlur={() => {
              try {
                if (!readOnly)
                  onChange(
                    JSON.parse(jsonDraft.value) as WhatsAppFlowPayloadValue
                  );
                jsonDraft.markInvalid(false);
              } catch {
                jsonDraft.markInvalid(true);
              }
            }}
          />
        ) : (
          <FlowAuthoringLabel label={t("flowAuthoring.value")}>
            <select
              aria-label={t("flowAuthoring.value")}
              className={FLOW_AUTHORING_CONTROL}
              value={reference}
              disabled={readOnly}
              onChange={event =>
                onChange(`\${${source}.${event.target.value}}`)
              }
            >
              {!refs.includes(reference) ? (
                <option value={reference}>{reference || "—"}</option>
              ) : null}
              {refs.map(key => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </FlowAuthoringLabel>
        )}
      </div>
      {jsonDraft.invalid ? (
        <p role="alert" className="text-xs text-destructive">
          {t("flowAuthoring.invalidValue")}
        </p>
      ) : null}
    </div>
  );
}

function FlowPayloadEditor({
  payload,
  screen,
  onChange,
  connectedBranchIds,
}: {
  payload?: Payload;
  screen: WhatsAppFlowScreenConfig;
  onChange: (payload: Payload) => void;
  connectedBranchIds?: readonly string[];
}) {
  const t = useTranslations("Scenarios");
  const entries = Object.entries(payload ?? {});
  const connectedKeys = new Set(
    connectedBranchIds
      ?.map(id => parseFlowBranchOptionKey(id)?.fieldId)
      .filter(Boolean)
  );
  return (
    <div
      role="group"
      aria-label={t("flowAuthoring.payload")}
      className="min-w-0 space-y-1"
    >
      <p className="text-[11px] font-medium text-foreground">
        {t("flowAuthoring.payload")}
      </p>
      {entries.some(([key]) => connectedKeys.has(key)) ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("flowAuthoring.connectedIdentifier")}
        </p>
      ) : null}
      {entries.map(([key, value], index) => (
        <PayloadRow
          key={index}
          entryKey={key}
          readOnly={connectedKeys.has(key)}
          value={value}
          fields={screen.fields
            .filter(field => field.fieldType !== "NavigationList")
            .map(field => field.id)}
          dataKeys={Object.keys(screen.data ?? {})}
          onChange={next =>
            onChange(
              Object.fromEntries(
                entries.map(([entryKey, entryValue], i) => [
                  entryKey,
                  i === index ? next : entryValue,
                ])
              )
            )
          }
          onRename={nextKey => {
            if (
              !nextKey.trim() ||
              entries.some(([other], i) => i !== index && other === nextKey)
            )
              return false;
            if (nextKey !== key)
              onChange(
                Object.fromEntries(
                  entries.map(([entryKey, entryValue], i) => [
                    i === index ? nextKey : entryKey,
                    entryValue,
                  ])
                )
              );
            return true;
          }}
          onRemove={() =>
            onChange(Object.fromEntries(entries.filter((_, i) => i !== index)))
          }
        />
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs"
        onClick={() => {
          let index = 1;
          while (Object.hasOwn(payload ?? {}, `answer_${index}`)) index++;
          onChange({ ...payload, [`answer_${index}`]: "" });
        }}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t("flowAuthoring.addPayload")}
      </Button>
      <details className="pt-1">
        <summary className="cursor-pointer text-[11px] text-muted-foreground">
          {t("flowAuthoring.payloadJson")}
        </summary>
        <div className="pt-2">
          <FlowJsonObjectEditor
            label={t("flowAuthoring.payloadJson")}
            value={payload}
            onApply={onChange}
            readOnly={entries.some(([key]) => connectedKeys.has(key))}
          />
        </div>
      </details>
    </div>
  );
}

export function FlowScreenActionEditor({
  action,
  screen,
  screens,
  onChange,
  navigationOnly = false,
  connectedBranchIds,
  advancedContent,
  advancedTestId = "flow-action-advanced",
}: {
  action: WhatsAppFlowScreenAction;
  screen: WhatsAppFlowScreenConfig;
  screens: WhatsAppFlowScreenConfig[];
  onChange: (action: WhatsAppFlowScreenAction) => void;
  navigationOnly?: boolean;
  connectedBranchIds?: readonly string[];
  advancedContent?: ReactNode;
  advancedTestId?: string;
}) {
  const t = useTranslations("Scenarios");
  return (
    <div className="min-w-0 space-y-3">
      {!navigationOnly ? (
        <FlowAuthoringLabel label={t("flowAuthoring.action")}>
          <select
            aria-label={t("flowAuthoring.action")}
            className={FLOW_AUTHORING_CONTROL}
            value={action.name}
            onChange={event => {
              const name = event.target
                .value as WhatsAppFlowScreenAction["name"];
              onChange(
                name === "navigate"
                  ? {
                      name,
                      nextScreenId:
                        screens.find(candidate => candidate.id !== screen.id)
                          ?.id ?? "",
                      ...(action.payload ? { payload: action.payload } : {}),
                    }
                  : {
                      name,
                      ...(action.payload ? { payload: action.payload } : {}),
                    }
              );
            }}
          >
            <option value="navigate">{t("flowAuthoring.navigate")}</option>
            <option value="complete">{t("flowAuthoring.complete")}</option>
            {action.name === "data_exchange" ? (
              <option value="data_exchange">
                {t("flowAuthoring.dataExchange")}
              </option>
            ) : null}
          </select>
        </FlowAuthoringLabel>
      ) : null}
      {action.name === "navigate" ? (
        <FlowAuthoringLabel label={t("flowAuthoring.destination")}>
          <select
            aria-label={t("flowAuthoring.destination")}
            className={FLOW_AUTHORING_CONTROL}
            value={action.nextScreenId}
            onChange={event =>
              onChange({ ...action, nextScreenId: event.target.value })
            }
          >
            {!screens.some(
              candidate =>
                candidate.id === action.nextScreenId &&
                candidate.id !== screen.id
            ) ? (
              <option value={action.nextScreenId}>
                {action.nextScreenId || "—"}
              </option>
            ) : null}
            {screens
              .filter(candidate => candidate.id !== screen.id)
              .map(candidate => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id} · {candidate.title}
                </option>
              ))}
          </select>
        </FlowAuthoringLabel>
      ) : null}
      <details data-testid={advancedTestId} className="space-y-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t("flowAuthoring.advanced")}
        </summary>
        <div className="space-y-3 pt-2">
          {advancedContent}
          <FlowPayloadEditor
            payload={action.payload}
            screen={screen}
            onChange={payload => onChange({ ...action, payload })}
            connectedBranchIds={
              action.name === "complete" ? connectedBranchIds : undefined
            }
          />
        </div>
      </details>
    </div>
  );
}

export function FlowNavigationItemsEditor({
  items,
  screen,
  screens,
  onChange,
}: {
  items: WhatsAppFlowNavigationItem[];
  screen: WhatsAppFlowScreenConfig;
  screens: WhatsAppFlowScreenConfig[];
  onChange: (items: WhatsAppFlowNavigationItem[]) => void;
}) {
  const t = useTranslations("Scenarios");
  const update = (index: number, patch: Partial<WhatsAppFlowNavigationItem>) =>
    onChange(
      items.map((item, i) => (i === index ? { ...item, ...patch } : item))
    );
  const move = (index: number, offset: number) => {
    const next = [...items];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  };
  return (
    <div className="space-y-4">
      {items.map((item, index) => (
        <section
          role="group"
          aria-label={`${t("flowAuthoring.navigationItems")} ${index + 1}`}
          key={index}
          className="space-y-3 border-t border-border/40 pt-3 first:border-t-0 first:pt-0"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs font-medium">
              {index + 1}. {item.title || item.id}
            </span>
            <div className="flex shrink-0 gap-0.5">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                disabled={index === 0}
                aria-label={t("flowAuthoring.moveUp")}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                disabled={index === items.length - 1}
                aria-label={t("flowAuthoring.moveDown")}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                aria-label={t("flowAuthoring.deleteItem")}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          </div>
          <FlowAuthoringInput
            label={t("flowAuthoring.optionTitle")}
            value={item.title}
            onChange={title => update(index, { title })}
          />
          <FlowAuthoringInput
            label={t("flowAuthoring.optionDescription")}
            value={item.description ?? ""}
            onChange={description =>
              update(index, { description: description || undefined })
            }
          />
          <FlowScreenActionEditor
            navigationOnly
            advancedTestId="flow-navigation-item-advanced"
            advancedContent={
              <FlowAuthoringInput
                label={t("flowAuthoring.itemId")}
                value={item.id}
                onChange={id => update(index, { id })}
              />
            }
            action={item.action}
            screen={screen}
            screens={screens}
            onChange={action => update(index, { action })}
          />
        </section>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-8 w-full text-xs"
        onClick={() => {
          let index = 1;
          while (items.some(item => item.id === `item_${index}`)) index++;
          onChange([
            ...items,
            {
              id: `item_${index}`,
              title: "",
              action: {
                name: "navigate",
                nextScreenId:
                  screens.find(candidate => candidate.id !== screen.id)?.id ??
                  "",
              },
            },
          ]);
        }}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t("flowAuthoring.addItem")}
      </Button>
    </div>
  );
}
