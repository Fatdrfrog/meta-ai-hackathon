"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldGroup } from "@/components/ui/field";
import { projectActiveClientMessageFilters } from "@/lib/scenarios/client-message-trigger-criteria";
import {
  FilterIcon,
  MessageSquareTextIcon,
  PlusIcon,
  TagsIcon,
  UserRoundCheckIcon,
  XIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import type {
  ScenarioAudienceOptions,
  ScenarioTriggerConfig,
  TranslateFn,
} from "../../types";
import { CampaignProductRouteEditor } from "./campaign-product-route-editor";
import { MessageMatchEditor } from "./message-match-editor";
import { MetaReferralFilterEditor } from "./meta-referral-filter-editor";
import { buildClientMessageTriggerPresentation } from "../../view/client-message-trigger-presentation";
import {
  metaReferralSelectionToConfigDelta,
  selectValueToMetaReferralSelection,
} from "./meta-referral-selection";
import { ChannelFilterEditor } from "./trigger-node-audience";
import {
  buildMessageTriggerEditorModel,
  createMessageTriggerEditorFormatters,
} from "./message-trigger-editor-model";

type OptionalFilter =
  | "message"
  | "customers"
  | "campaignRouting"
  | "specificAd";

const AD_FILTER_FIELDS = [
  "metaReferralCampaignIds",
  "metaReferralAdSetIds",
  "metaReferralSourceIds",
  "whatsappReferralSourceTypes",
  "whatsappReferralSourcePlatforms",
] as const;

export function MessageTriggerEditor({
  triggerConfig,
  audienceOptions,
  hasMetaAdsConnection,
  onChange,
}: {
  triggerConfig: ScenarioTriggerConfig;
  audienceOptions: ScenarioAudienceOptions;
  hasMetaAdsConnection: boolean;
  onChange: (delta: Partial<ScenarioTriggerConfig>) => void;
}) {
  const t = useTranslations("Scenarios") as TranslateFn;
  const locale = useLocale();
  const [revealed, setRevealed] = useState<ReadonlySet<OptionalFilter>>(
    () => new Set()
  );
  const filterElements = useRef<
    Partial<Record<OptionalFilter, HTMLElement | null>>
  >({});
  const pendingFocus = useRef<OptionalFilter | null>(null);
  const addFilterButton = useRef<HTMLButtonElement>(null);
  const formatters = useMemo(
    () => createMessageTriggerEditorFormatters(locale),
    [locale]
  );
  const model = useMemo(
    () =>
      buildMessageTriggerEditorModel({
        triggerConfig,
        audienceOptions,
        hasMetaAdsConnection,
        formatters,
        t,
      }),
    [triggerConfig, audienceOptions, hasMetaAdsConnection, formatters, t]
  );
  const savedAdSummary = useMemo(() => {
    const criteria = projectActiveClientMessageFilters(triggerConfig);
    const selection = selectValueToMetaReferralSelection(
      model.meta.selectValue
    );
    if (!selection) return [];
    const displayedFilter = metaReferralSelectionToConfigDelta(selection);
    const hasAdditionalCriteria = AD_FILTER_FIELDS.some(field => {
      const displayed = displayedFilter[field] ?? [];
      return (
        criteria[field].length !== displayed.length ||
        criteria[field].some(value => !displayed.includes(value))
      );
    });
    if (!hasAdditionalCriteria) return [];
    return buildClientMessageTriggerPresentation(criteria, t, audienceOptions)
      .summaryItems.filter(item =>
        [
          "referral-platforms",
          "referral-types",
          "ad",
          "campaign",
          "ad-set",
        ].includes(item.kind)
      )
      .map(item => item.text);
  }, [triggerConfig, model.meta.selectValue, audienceOptions, t]);
  const filters = [
    {
      id: "message" as const,
      label: t("triggerFilterMessage"),
      icon: MessageSquareTextIcon,
      configured: model.message.mode !== "any",
    },
    {
      id: "customers" as const,
      label: t("triggerFilterCustomers"),
      icon: UserRoundCheckIcon,
      configured: model.onlyNewCustomers,
    },
    {
      id: "campaignRouting" as const,
      label: t("triggerFilterCampaignRouting"),
      icon: TagsIcon,
      configured:
        Boolean(triggerConfig.metaCampaignAdAccountId) ||
        model.product.selectedLabelIds.length > 0 ||
        model.product.nameFallbacks.length > 0,
    },
    {
      id: "specificAd" as const,
      label: t("triggerFilterSpecificAd"),
      icon: FilterIcon,
      configured: AD_FILTER_FIELDS.some(field =>
        Boolean(triggerConfig[field]?.length)
      ),
    },
  ];
  const visibleFilters = filters.filter(
    filter => filter.configured || revealed.has(filter.id)
  );
  const availableFilters = filters.filter(
    filter => !filter.configured && !revealed.has(filter.id)
  );

  function revealFilter(id: OptionalFilter) {
    pendingFocus.current = id;
    if (id === "customers") {
      onChange({ onlyNewCustomers: true });
    } else {
      setRevealed(current => new Set([...current, id]));
    }
  }

  function removeFilter(id: OptionalFilter) {
    setRevealed(current => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    switch (id) {
      case "message":
        onChange({
          messageMatchMode: "any",
          keywordPattern: "",
          keywordMatchMode: "contains",
        });
        break;
      case "customers":
        onChange({ onlyNewCustomers: false });
        break;
      case "campaignRouting":
        onChange({
          metaCampaignAdAccountId: undefined,
          metaCampaignLabels: undefined,
          metaCampaignNameFallbacks: undefined,
        });
        break;
      case "specificAd":
        onChange(metaReferralSelectionToConfigDelta({ kind: "any_message" }));
        break;
    }
    requestAnimationFrame(() => addFilterButton.current?.focus());
  }

  return (
    <FieldGroup className="gap-4">
      <ChannelFilterEditor
        channels={model.channels}
        onChange={onChange}
        t={t}
      />
      {visibleFilters.map(filter => (
        <section
          key={filter.id}
          aria-label={filter.label}
          ref={element => {
            filterElements.current[filter.id] = element;
          }}
          className="flex min-w-0 items-start gap-1.5"
        >
          <div className="min-w-0 flex-1">
            {filter.id === "message" ? (
              <MessageMatchEditor
                message={model.message}
                onChange={onChange}
                t={t}
              />
            ) : filter.id === "customers" ? (
              <div className="flex min-h-9 items-center gap-2 rounded-md border bg-background px-3 py-2">
                <UserRoundCheckIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="text-sm">{filter.label}</span>
              </div>
            ) : filter.id === "campaignRouting" ? (
              <CampaignProductRouteEditor
                product={model.product}
                onChange={onChange}
                t={t}
              />
            ) : (
              <MetaReferralFilterEditor
                meta={model.meta}
                savedFilterSummary={savedAdSummary}
                catalogState={model.product.state}
                onChange={onChange}
                t={t}
              />
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="nodrag mt-0.5 shrink-0"
            aria-label={t("triggerRemoveFilter", { name: filter.label })}
            title={t("triggerRemoveFilter", { name: filter.label })}
            onClick={() => removeFilter(filter.id)}
          >
            <XIcon aria-hidden />
          </Button>
        </section>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={addFilterButton}
            type="button"
            variant="outline"
            size="sm"
            className="nodrag w-fit"
            disabled={availableFilters.length === 0}
          >
            <PlusIcon data-icon="inline-start" aria-hidden />
            {t("triggerAddFilter")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-w-[calc(100vw-2rem)]"
          onCloseAutoFocus={event => {
            const id = pendingFocus.current;
            if (!id) return;
            event.preventDefault();
            pendingFocus.current = null;
            requestAnimationFrame(() => {
              const section = filterElements.current[id];
              section?.scrollIntoView({ block: "nearest" });
              const control =
                section?.querySelector<HTMLElement>(
                  'input, textarea, [role="combobox"]'
                ) ?? section?.querySelector<HTMLElement>("button");
              control?.focus();
            });
          }}
        >
          <DropdownMenuGroup>
            {availableFilters.map(filter => (
              <DropdownMenuItem
                key={filter.id}
                onSelect={() => revealFilter(filter.id)}
              >
                <filter.icon aria-hidden />
                <span className="min-w-0 whitespace-normal">
                  {filter.label}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </FieldGroup>
  );
}
