"use client";

import { Button } from "@/components/ui/button";
import { CRAWL_INDEX_LIMITS } from "@/lib/crawler/crawl-limits";
import { normalizeRootUrl } from "@/lib/crawler/crawl-html-utils";
import { Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { ProductConnectedSources } from "./product-connected-sources";
import {
  deriveProductContextReadiness,
  type ProductTrainingHandoffState,
} from "./product-context-state";
import { ProductTestAiri } from "./product-test-airi";
import { ProductTrainingStatus } from "./product-training-status";
import {
  ProductWebsiteFields,
  useProductWebsiteRows,
} from "./product-website-fields";
import { useProductContextController } from "./use-product-context-controller";

const MAX_WEBSITES = CRAWL_INDEX_LIMITS.maxWebsitesPerRequest;

export type ProductContextStepProps = {
  workspaceId: string;
  onHandoffStateChange?: (state: ProductTrainingHandoffState) => void;
};

export function ProductContextStep(props: ProductContextStepProps) {
  return <ProductContextStepWorkspace key={props.workspaceId} {...props} />;
}

function ProductContextStepWorkspace({
  workspaceId,
  onHandoffStateChange,
}: ProductContextStepProps) {
  const t = useTranslations("OnboardingProductStep");
  const { state, startTraining, checkAgain } = useProductContextController({
    workspaceId,
    onHandoffStateChange,
  });
  const { rows, updateRow, addRow, removeRow, focusRequest } =
    useProductWebsiteRows(MAX_WEBSITES);
  const [instagramSelection, setInstagramSelection] = useState<boolean | null>(
    null
  );
  const [whatsappSelection, setWhatsappSelection] = useState<boolean | null>(
    null
  );
  const includeInstagram = instagramSelection ?? state.connected.instagram;
  const includeWhatsapp = whatsappSelection ?? state.connected.whatsapp;

  const websiteErrors = useMemo(() => {
    const errors = new Map<string, string>();
    for (const row of rows) {
      if (row.value.trim() && !normalizeRootUrl(row.value)) {
        errors.set(row.id, t("websiteInvalid"));
      }
    }
    return errors;
  }, [rows, t]);

  const normalizedWebsiteSeeds = useMemo(
    () =>
      rows
        .map(row => normalizeRootUrl(row.value))
        .filter((url): url is URL => Boolean(url))
        .map(url => url.toString()),
    [rows]
  );
  const existingWebsiteSeeds = useMemo(
    () =>
      Array.from(
        new Set(
          state.sources
            .map(source => normalizeRootUrl(source.url))
            .filter((url): url is URL => Boolean(url))
            .map(url => url.toString())
        )
      ),
    [state.sources]
  );
  const websiteSeedsForTraining =
    normalizedWebsiteSeeds.length > 0
      ? normalizedWebsiteSeeds
      : existingWebsiteSeeds;
  const hasSelectedConnectedSource =
    (includeInstagram && state.connected.instagram) ||
    (includeWhatsapp && state.connected.whatsapp);
  const hasTrainingSource =
    websiteSeedsForTraining.length > 0 || hasSelectedConnectedSource;
  const hasValidationError = websiteErrors.size > 0;
  const trainingStarted =
    state.acceptedRun ||
    state.counts.total > 0 ||
    state.whatsappHistoryRequested;
  const canStartTraining =
    hasTrainingSource && !hasValidationError && state.phase !== "starting";
  const readiness = deriveProductContextReadiness(state);

  const normalizeWebsite = useCallback(
    (rowId: string) => {
      const row = rows.find(candidate => candidate.id === rowId);
      const normalized = normalizeRootUrl(row?.value ?? "");
      if (normalized) updateRow(rowId, normalized.toString());
    },
    [rows, updateRow]
  );

  const handleStartTraining = useCallback(async () => {
    if (!canStartTraining) return;
    await startTraining({
      websites: websiteSeedsForTraining,
      includeInstagram,
      includeWhatsapp,
    });
  }, [
    canStartTraining,
    includeInstagram,
    includeWhatsapp,
    startTraining,
    websiteSeedsForTraining,
  ]);

  const trainingMetadata = useMemo(
    () => ({
      website_count: websiteSeedsForTraining.length,
      has_website: websiteSeedsForTraining.length > 0,
      include_instagram: includeInstagram && state.connected.instagram,
      include_whatsapp: includeWhatsapp && state.connected.whatsapp,
      connected_instagram: state.connected.instagram,
      connected_whatsapp: state.connected.whatsapp,
      whatsapp_history_eligible: state.whatsappHistoryEligible,
      whatsapp_history_requested: state.whatsappHistoryRequested,
      ready_context_source: readiness.source,
    }),
    [
      includeInstagram,
      includeWhatsapp,
      readiness.source,
      state.connected.instagram,
      state.connected.whatsapp,
      state.whatsappHistoryEligible,
      state.whatsappHistoryRequested,
      websiteSeedsForTraining.length,
    ]
  );

  return (
    <div
      data-testid="training-region"
      aria-busy={state.phase === "starting" || state.phase === "polling"}
      className="min-w-0 space-y-6"
    >
      <ProductWebsiteFields
        rows={rows}
        errors={websiteErrors}
        maxRows={MAX_WEBSITES}
        focusRequest={focusRequest}
        onChange={updateRow}
        onBlur={normalizeWebsite}
        onAdd={addRow}
        onRemove={removeRow}
      />

      <ProductConnectedSources
        connected={state.connected}
        includeInstagram={includeInstagram}
        includeWhatsapp={includeWhatsapp}
        whatsappHistoryEligible={state.whatsappHistoryEligible}
        whatsappHistoryRequested={state.whatsappHistoryRequested}
        whatsappHistorySync={state.whatsappHistorySync}
        onIncludeInstagramChange={setInstagramSelection}
        onIncludeWhatsappChange={setWhatsappSelection}
      />

      <section className="space-y-3" aria-label={t("trainingProgressTitle")}>
        <Button
          type="button"
          onClick={() => void handleStartTraining()}
          disabled={!canStartTraining}
          size="sm"
          className="w-full max-w-full gap-2 text-center sm:w-auto sm:min-w-40 [&_.btn-push-front]:min-w-0 [&_.btn-push-front]:break-words [&_.btn-push-front]:px-4 [&_.btn-push-front]:text-center [&_.btn-push-front]:whitespace-normal"
        >
          {state.phase === "starting" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {trainingStarted ? t("trainingRestart") : t("trainingStart")}
        </Button>

        {!hasTrainingSource && !hasValidationError ? (
          <p className="break-words text-xs font-semibold leading-5 text-muted-foreground">
            {t("trainingNeedsSource")}
          </p>
        ) : null}
        <p className="break-words text-xs leading-5 text-muted-foreground">
          {t("trainingOptional")}
        </p>

        <ProductTrainingStatus
          state={state}
          onCheckAgain={() => void checkAgain()}
          onRetrySource={() => void handleStartTraining()}
        />
      </section>

      <ProductTestAiri
        workspaceId={workspaceId}
        enabled={readiness.ready}
        metadata={trainingMetadata}
      />
    </div>
  );
}
