"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SCENARIO_BEHAVIOR_PRESETS,
  isScenarioBehaviorConfig,
  type ScenarioBehaviorConfig,
  type ScenarioBehaviorPreset,
  type PurchaseSegment,
} from "@icecore/scenario-contracts";
import { CustomerContactPolicyEditor } from "./customer-contact-policy-editor";
import type { ScenarioEditorValidationMode } from "../../view/node-enrichment/types";

export const BEHAVIOR_PRESET_DELAYS: Record<ScenarioBehaviorPreset, number> = {
  abandoned_cart: 60,
  abandoned_checkout: 60,
  purchase_completed: 0,
  replenishment: 30 * 1440,
  second_purchase: 14 * 1440,
  win_back: 90 * 1440,
  upcoming_renewal: 3 * 1440,
  overdue_service: 1440,
};
export function BehaviorTriggerEditor({
  value,
  onChange,
  workspaceId,
  validationMode = "runnable",
}: {
  value?: ScenarioBehaviorConfig;
  onChange: (value: ScenarioBehaviorConfig) => void;
  workspaceId?: string;
  validationMode?: ScenarioEditorValidationMode;
}) {
  const t = useTranslations("CustomerBehavior");
  const config = value || { preset: "purchase_completed", delayMinutes: 0 };
  const [unit, setUnit] = useState(config.delayMinutes >= 1440 ? 1440 : 60);
  const maxDelayMinutes =
    config.preset === "abandoned_cart" || config.preset === "abandoned_checkout"
      ? 30 * 1440
      : 730 * 1440;
  const segment = config.purchaseSegment || {};
  const patchSegment = (patch: Partial<PurchaseSegment>) =>
    onChange({ ...config, purchaseSegment: { ...segment, ...patch } });
  return (
    <div className="space-y-3 nodrag nopan">
      <Select
        value={config.preset}
        onValueChange={v => {
          const preset = v as ScenarioBehaviorPreset;
          const delayMinutes = BEHAVIOR_PRESET_DELAYS[preset];
          setUnit(delayMinutes >= 1440 ? 1440 : 60);
          onChange({ ...config, preset, delayMinutes });
        }}
      >
        <SelectTrigger aria-label={t("journey")} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCENARIO_BEHAVIOR_PRESETS.map(preset => (
            <SelectItem key={preset} value={preset}>
              {t(`presets.${preset}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {config.preset === "abandoned_cart" ||
      config.preset === "abandoned_checkout" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(`presetDescriptions.${config.preset}`)}
        </p>
      ) : null}
      {config.preset === "abandoned_cart" ||
      config.preset === "abandoned_checkout" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("recoveryTemplateHint")}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          {config.preset === "upcoming_renewal" ? t("beforeDue") : t("delay")}
          <Input
            aria-label={
              config.preset === "upcoming_renewal" ? t("beforeDue") : t("delay")
            }
            type="number"
            min={0}
            max={maxDelayMinutes / unit}
            step={1 / unit}
            value={config.delayMinutes / unit}
            onChange={e =>
              onChange({
                ...config,
                delayMinutes: Math.round(Number(e.target.value) * unit),
              })
            }
          />
        </label>
        <label className="text-xs">
          {t("unit")}
          <Select value={String(unit)} onValueChange={v => setUnit(Number(v))}>
            <SelectTrigger aria-label={t("unit")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t("minutes")}</SelectItem>
              <SelectItem value="60">{t("hours")}</SelectItem>
              <SelectItem value="1440">{t("days")}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      <details className="rounded-md border p-2 text-xs">
        <summary className="cursor-pointer font-medium">
          {t("segments")}
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(
            [
              "minPurchases",
              "maxPurchases",
              "minDaysSincePurchase",
              "maxDaysSincePurchase",
              "minNetSpend",
              "maxNetSpend",
            ] as const
          ).map(key => (
            <label key={key}>
              {t(key)}
              <Input
                aria-label={t(key)}
                type="number"
                min={0}
                step={key.includes("Spend") ? "0.01" : "1"}
                value={segment[key] ?? ""}
                onChange={e =>
                  patchSegment({
                    [key]:
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                  })
                }
              />
            </label>
          ))}
          <label className="col-span-2">
            {t("currency")}
            <Input
              aria-label={t("currency")}
              placeholder="KZT"
              maxLength={3}
              value={segment.currency || ""}
              onChange={e =>
                patchSegment({
                  currency: e.target.value.trim().toUpperCase() || undefined,
                })
              }
            />
          </label>
        </div>
      </details>
      {validationMode === "runnable" && !isScenarioBehaviorConfig(config) && (
        <p role="alert" className="text-xs text-destructive">
          {t("invalidConfig")}
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("triggerHint")}
      </p>
      {workspaceId && (
        <CustomerContactPolicyEditor
          key={workspaceId}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}
