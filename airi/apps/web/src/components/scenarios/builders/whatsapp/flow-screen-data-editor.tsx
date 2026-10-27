"use client";

import type { WhatsAppFlowDataSchema } from "@/components/scenarios/types";
import { Button } from "@/components/ui/button";
import { parseWhatsAppFlowDataSchema } from "@icecore/scenario-contracts";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  FLOW_AUTHORING_CONTROL,
  FlowAuthoringInput,
  FlowAuthoringLabel,
  FlowJsonObjectEditor,
  useFlowAuthoringDraft,
} from "./flow-screen-action-editor";

type Data = Record<string, WhatsAppFlowDataSchema>;

function FlowDataRow({
  dataKey,
  schema,
  onRename,
  onChange,
  onRemove,
}: {
  dataKey: string;
  schema: WhatsAppFlowDataSchema;
  onRename: (key: string) => boolean;
  onChange: (schema: WhatsAppFlowDataSchema) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("Scenarios");
  const draft = useFlowAuthoringDraft(dataKey);
  return (
    <div role="group" aria-label={dataKey} className="space-y-2 py-2">
      <div className="flex items-end gap-1">
        <FlowAuthoringInput
          label={t("flowAuthoring.dataKey")}
          value={draft.value}
          aria-invalid={draft.invalid}
          onChange={draft.change}
          onBlur={() => draft.markInvalid(!onRename(draft.value))}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t("delete")}
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      {draft.invalid ? (
        <p role="alert" className="text-xs text-destructive">
          {t("flowAuthoring.invalidDataKey")}
        </p>
      ) : null}
      <FlowAuthoringLabel label={t("flowAuthoring.dataType")}>
        <select
          aria-label={t("flowAuthoring.dataType")}
          className={FLOW_AUTHORING_CONTROL}
          value={schema.type}
          onChange={event => {
            const type = event.target.value as WhatsAppFlowDataSchema["type"];
            onChange(
              type === schema.type
                ? schema
                : type === "array"
                  ? { type, items: { type: "string" } }
                  : type === "object"
                    ? { type, properties: {} }
                    : { type }
            );
          }}
        >
          <option value="string">{t("flowAuthoring.dataString")}</option>
          <option value="number">{t("flowAuthoring.dataNumber")}</option>
          <option value="boolean">{t("flowAuthoring.dataBoolean")}</option>
          <option value="array">{t("flowAuthoring.dataArray")}</option>
          <option value="object">{t("flowAuthoring.dataObject")}</option>
        </select>
      </FlowAuthoringLabel>
      {schema.type === "string" ? (
        <FlowAuthoringInput
          label={t("flowAuthoring.example")}
          value={
            typeof schema.__example__ === "string" ? schema.__example__ : ""
          }
          onChange={value => onChange({ ...schema, __example__: value })}
        />
      ) : schema.type === "number" ? (
        <FlowAuthoringInput
          type="number"
          label={t("flowAuthoring.example")}
          value={
            typeof schema.__example__ === "number"
              ? String(schema.__example__)
              : ""
          }
          onChange={value => {
            const number = Number(value);
            if (value === "" || Number.isFinite(number))
              onChange({
                ...schema,
                __example__: value === "" ? undefined : number,
              });
          }}
        />
      ) : schema.type === "boolean" ? (
        <FlowAuthoringLabel label={t("flowAuthoring.example")}>
          <select
            aria-label={t("flowAuthoring.example")}
            className={FLOW_AUTHORING_CONTROL}
            value={
              typeof schema.__example__ === "boolean"
                ? String(schema.__example__)
                : ""
            }
            onChange={event =>
              onChange({
                ...schema,
                __example__:
                  event.target.value === ""
                    ? undefined
                    : event.target.value === "true",
              })
            }
          >
            <option value="">{t("flowAuthoring.noExample")}</option>
            <option value="true">{t("flowAuthoring.yes")}</option>
            <option value="false">{t("flowAuthoring.no")}</option>
          </select>
        </FlowAuthoringLabel>
      ) : null}
    </div>
  );
}

export function FlowScreenDataEditor({
  data,
  onChange,
}: {
  data?: Data;
  onChange: (data: Data) => void;
}) {
  const t = useTranslations("Scenarios");
  const entries = Object.entries(data ?? {});
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium">{t("flowAuthoring.dataSchema")}</p>
      {entries.map(([key, schema], index) => (
        <FlowDataRow
          key={index}
          dataKey={key}
          schema={schema}
          onRename={next => {
            if (
              !next.trim() ||
              entries.some(([other], i) => i !== index && other === next)
            )
              return false;
            if (next !== key)
              onChange(
                Object.fromEntries(
                  entries.map(([name, value], i) => [
                    i === index ? next : name,
                    value,
                  ])
                )
              );
            return true;
          }}
          onChange={next =>
            onChange(
              Object.fromEntries(
                entries.map(([name, value], i) => [
                  name,
                  i === index ? next : value,
                ])
              )
            )
          }
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
          while (Object.hasOwn(data ?? {}, `data_${index}`)) index++;
          onChange({ ...data, [`data_${index}`]: { type: "string" } });
        }}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t("flowAuthoring.addData")}
      </Button>
      <details className="pt-1">
        <summary className="cursor-pointer text-[11px] text-muted-foreground">
          {t("flowAuthoring.advanced")}
        </summary>
        <div className="pt-2">
          <FlowJsonObjectEditor
            label={t("flowAuthoring.dataSchema")}
            value={data}
            invalidMessage={t("flowAuthoring.invalidDataSchema")}
            onApply={next => {
              const parsed = Object.fromEntries(
                Object.entries(next).map(([key, value]) => {
                  const schema = parseWhatsAppFlowDataSchema(value);
                  if (!schema) throw new Error("Invalid data schema");
                  return [key, schema];
                })
              );
              onChange(parsed);
            }}
          />
        </div>
      </details>
    </div>
  );
}
