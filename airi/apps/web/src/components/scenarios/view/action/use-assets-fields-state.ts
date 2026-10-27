"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useSyncedDraftValue } from "../../nodes/draft-state";
import { parseUrlLines } from "../scenario-template-utils";
import type { ScenarioCtaFlowOption } from "./assets-fields-utils";

/** The link being typed into the link list, before it is added. */
export function useScenarioActionLinkDraft({
  linkUrls,
  onAddLinkUrl,
}: {
  linkUrls: string[];
  onAddLinkUrl: (linkUrl: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const normalizedLinkUrl = useMemo(
    () => parseUrlLines(draft)[0] || "",
    [draft]
  );
  const hasDuplicate =
    normalizedLinkUrl.length > 0 && linkUrls.includes(normalizedLinkUrl);
  const canAdd = normalizedLinkUrl.length > 0 && !hasDuplicate;

  const add = () => {
    if (!canAdd) return;
    onAddLinkUrl(normalizedLinkUrl);
    setDraft("");
  };

  return { draft, setDraft, hasDuplicate, canAdd, add };
}

export type ScenarioActionLinkDraft = ReturnType<
  typeof useScenarioActionLinkDraft
>;

/** The link CTA's URL, edited inline and saved on blur or Enter. */
export function useScenarioActionPrimaryLinkDraft({
  linkUrls,
  onAddLinkUrl,
  onReplacePrimaryLinkUrl,
  onRemoveLinkUrl,
}: {
  linkUrls: string[];
  onAddLinkUrl: (linkUrl: string) => void;
  onReplacePrimaryLinkUrl?: (linkUrl: string) => void;
  onRemoveLinkUrl: (linkUrl: string) => void;
}) {
  const primaryLinkUrl = linkUrls[0] || "";
  const [draft, setDraft] = useSyncedDraftValue(primaryLinkUrl);
  const normalizedPrimaryLinkUrl = useMemo(
    () => parseUrlLines(draft)[0] || "",
    [draft]
  );
  const hasDuplicate =
    normalizedPrimaryLinkUrl.length > 0 &&
    linkUrls.slice(1).includes(normalizedPrimaryLinkUrl);

  const commit = () => {
    if (!normalizedPrimaryLinkUrl) {
      if (primaryLinkUrl) {
        if (onReplacePrimaryLinkUrl) {
          onReplacePrimaryLinkUrl("");
        } else {
          onRemoveLinkUrl(primaryLinkUrl);
        }
      }
      setDraft("");
      return;
    }

    if (normalizedPrimaryLinkUrl === primaryLinkUrl || hasDuplicate) {
      setDraft(normalizedPrimaryLinkUrl);
      return;
    }

    if (onReplacePrimaryLinkUrl) {
      onReplacePrimaryLinkUrl(normalizedPrimaryLinkUrl);
    } else if (!primaryLinkUrl) {
      onAddLinkUrl(normalizedPrimaryLinkUrl);
    }
    setDraft(normalizedPrimaryLinkUrl);
  };

  return { draft, setDraft, hasDuplicate, commit };
}

export type ScenarioActionPrimaryLinkDraft = ReturnType<
  typeof useScenarioActionPrimaryLinkDraft
>;

/**
 * Form choices for a flow CTA. A saved form that is missing from the loaded
 * list stays selectable under its saved name.
 */
export function useScenarioActionCtaFlowPicker({
  ctaFlowId,
  ctaFlowName,
  ctaFlowOptions,
  ctaFlowLoading,
  onCtaFlowOptionsOpen,
}: {
  ctaFlowId?: string;
  ctaFlowName?: string;
  ctaFlowOptions?: ScenarioCtaFlowOption[];
  ctaFlowLoading: boolean;
  onCtaFlowOptionsOpen?: (open: boolean) => void;
}) {
  const t = useTranslations("Scenarios");
  const [isSelectOpen, setIsSelectOpen] = useState(false);
  const options = useMemo(() => {
    const flowOptions = Array.isArray(ctaFlowOptions) ? ctaFlowOptions : [];
    const currentFlowId = (ctaFlowId || "").trim();
    if (!currentFlowId || flowOptions.some(flow => flow.id === currentFlowId)) {
      return flowOptions;
    }
    return [
      {
        id: currentFlowId,
        name: (ctaFlowName || "").trim() || t("untitledForm"),
        status: "UNKNOWN",
      },
      ...flowOptions,
    ];
  }, [ctaFlowId, ctaFlowName, ctaFlowOptions, t]);
  const showLoading =
    (isSelectOpen && ctaFlowLoading) ||
    (ctaFlowLoading && options.length === 0);

  const onOpenChange = (open: boolean) => {
    setIsSelectOpen(open);
    onCtaFlowOptionsOpen?.(open);
  };

  return { options, showLoading, onOpenChange };
}

export type ScenarioActionCtaFlowPicker = ReturnType<
  typeof useScenarioActionCtaFlowPicker
>;
