"use client";

import { useTranslations } from "next-intl";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { TranslateFn } from "../../types";
import type { ScenarioTriggerEditorNodeData } from "../../view/node-enrichment/types";
import { BehaviorTriggerEditor } from "./behavior-trigger-editor";
import { BusinessEventTriggerEditor } from "./business-event-trigger-editor";
import {
  EMPTY_BUSINESS_EVENT_CATALOG,
  type BusinessEventTriggerCatalog,
} from "./business-event-trigger-model";
import { MessageTriggerEditor } from "./message-trigger-editor";

/**
 * Trigger settings body: the entry type and its editor. The settings panel
 * and the legacy trigger sheet host it; neither renders canvas handles.
 */
export function TriggerNodeSettings({
  nodeId,
  data,
  businessEventCatalog = EMPTY_BUSINESS_EVENT_CATALOG,
  onRefreshBusinessEventCatalog,
  className,
}: {
  nodeId: string;
  data: ScenarioTriggerEditorNodeData;
  businessEventCatalog?: BusinessEventTriggerCatalog;
  onRefreshBusinessEventCatalog?: () => void;
  className?: string;
}) {
  const t = useTranslations("Scenarios") as TranslateFn;
  const config = data.uiTriggerConfig;
  const onConfigChange = data.uiOnTriggerConfigChange;
  const isBehavior = config.entryPointType === "customer_behavior";
  const isBusinessEvent = config.entryPointType === "business_event";

  return (
    <FieldGroup className={cn("gap-5", className)}>
      <Field className="gap-2">
        <FieldLabel htmlFor={`trigger-entry-${nodeId}`}>
          {t("triggerEditorEntryLabel")}
        </FieldLabel>
        <Select
          value={
            isBusinessEvent
              ? "business_event"
              : isBehavior
                ? "customer_behavior"
                : "message"
          }
          onValueChange={value =>
            onConfigChange({
              entryPointType: value as
                | "message"
                | "customer_behavior"
                | "business_event",
              ...(value === "customer_behavior"
                ? {
                    behavior: config.behavior || {
                      preset: "purchase_completed",
                      delayMinutes: 0,
                    },
                  }
                : {}),
            })
          }
        >
          <SelectTrigger id={`trigger-entry-${nodeId}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="message">
                {t("presetTriggerIncoming")}
              </SelectItem>
              <SelectItem value="customer_behavior">
                {t("presetTriggerCustomerBehavior")}
              </SelectItem>
              <SelectItem value="business_event">
                {t("presetTriggerBusinessEvent")}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {isBusinessEvent ? (
        <BusinessEventTriggerEditor
          value={config.businessEvent}
          onChange={businessEvent => onConfigChange({ businessEvent })}
          catalog={businessEventCatalog}
          onRetry={onRefreshBusinessEventCatalog}
          integrationsHref={
            data.uiWorkspaceId
              ? `/panel/w/${encodeURIComponent(data.uiWorkspaceId)}/settings/integrations`
              : undefined
          }
        />
      ) : isBehavior ? (
        <BehaviorTriggerEditor
          validationMode={data.uiValidationMode}
          key={data.uiWorkspaceId}
          workspaceId={data.uiWorkspaceId}
          value={config.behavior}
          onChange={behavior => onConfigChange({ behavior })}
        />
      ) : (
        <MessageTriggerEditor
          triggerConfig={config}
          audienceOptions={data.uiAudienceOptions}
          hasMetaAdsConnection={data.uiHasMetaAdsConnection}
          onChange={onConfigChange}
        />
      )}
    </FieldGroup>
  );
}
