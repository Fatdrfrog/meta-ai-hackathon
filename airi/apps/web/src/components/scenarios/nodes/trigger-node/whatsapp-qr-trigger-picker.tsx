"use client";

import Link from "next/link";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { normalizeWhatsAppQrManagerQuery } from "@/components/whatsapp-qr/use-whatsapp-qr-manager";
import type {
  WhatsAppQrManagerListItem,
  WhatsAppQrManagerPage,
  WhatsAppQrScenarioSummary,
} from "@/lib/whatsapp/qr-entry-points/client";

const SEARCH_DEBOUNCE_MS = 250;
const MAX_RETAINED_PAGES = 4;

export type WhatsAppQrPickerDisabledReason =
  | "save-scenario"
  | "wait-for-save"
  | "deactivate-target"
  | "summary-unavailable"
  | "selection-conflict";

export type WhatsAppQrTriggerPickerProps = {
  selected: WhatsAppQrScenarioSummary | null;
  selectedEntryPointId: string | null;
  selectionResolved: boolean;
  targetScenarioId: string | null;
  targetNodeId: string;
  targetScenarioName: string;
  managerHref: string;
  disabledReason?: WhatsAppQrPickerDisabledReason;
  sourceLabels: Readonly<Record<string, string>>;
  loading: boolean;
  error: string | null;
  busy: boolean;
  loadOptions(input: {
    query: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<WhatsAppQrManagerPage>;
  onAssign(option: WhatsAppQrManagerListItem): Promise<void>;
  onUnassign(): Promise<void>;
  onRefresh(): Promise<void>;
  onOpenScenario(scenarioId: string): void;
};

type RetainedPage = {
  cursor: string | null;
  page: WhatsAppQrManagerPage;
};

type PickerTranslate = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

function uniqueItems(pages: readonly RetainedPage[]) {
  const byId = new Map<string, WhatsAppQrManagerListItem>();
  for (const retained of pages) {
    for (const item of retained.page.items) {
      byId.set(item.entryPointId, item);
    }
  }
  return Array.from(byId.values());
}

function detailHref(managerHref: string, entryPointId: string) {
  return `${managerHref}/${encodeURIComponent(entryPointId)}`;
}

function scenarioHref(managerHref: string, scenarioId: string): string | null {
  const marker = "/messengers/whatsapp-qr";
  const markerIndex = managerHref.indexOf(marker);
  if (markerIndex < 0) return null;
  return `${managerHref.slice(0, markerIndex)}/scenarios?scenarioId=${encodeURIComponent(scenarioId)}`;
}

function shouldUseNativeLinkNavigation(
  event: ReactMouseEvent<HTMLAnchorElement>
): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

export function WhatsAppQrTriggerPicker({
  ...props
}: WhatsAppQrTriggerPickerProps) {
  const scopeKey = `${props.managerHref}\u0000${props.targetScenarioId ?? ""}\u0000${props.targetNodeId}\u0000${props.selectedEntryPointId ?? ""}`;
  return <WhatsAppQrTriggerPickerScope key={scopeKey} {...props} />;
}

function WhatsAppQrTriggerPickerScope({
  selected,
  selectedEntryPointId,
  selectionResolved,
  targetScenarioId,
  targetNodeId,
  targetScenarioName,
  managerHref,
  disabledReason,
  sourceLabels,
  loading,
  error,
  busy,
  loadOptions,
  onAssign,
  onUnassign,
  onRefresh,
  onOpenScenario,
}: WhatsAppQrTriggerPickerProps) {
  const t = useTranslations("Scenarios");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<RetainedPage[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [failedCursor, setFailedCursor] = useState<string | null | undefined>();
  const [pendingOption, setPendingOption] =
    useState<WhatsAppQrManagerListItem | null>(null);
  const requestSequenceRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const pickerId = useId();

  const sourceLabel = useCallback(
    (sourceId?: string) =>
      sourceId && sourceLabels[sourceId]
        ? sourceLabels[sourceId]
        : t("whatsappQrPickerSourceUnavailable"),
    [sourceLabels, t]
  );

  const requestPage = useCallback(
    async ({ cursor, replace }: { cursor?: string; replace: boolean }) => {
      const requestId = ++requestSequenceRef.current;
      requestAbortRef.current?.abort();
      const controller = new AbortController();
      requestAbortRef.current = controller;
      setOptionsLoading(true);
      setOptionsError(null);
      setFailedCursor(undefined);
      if (replace) setPages([]);
      try {
        const page = await loadOptions({
          query: query.trim(),
          ...(cursor ? { cursor } : {}),
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          requestSequenceRef.current !== requestId
        ) {
          return;
        }
        setPages(current => {
          const next = replace
            ? [{ cursor: cursor ?? null, page }]
            : [...current, { cursor: cursor ?? null, page }];
          return next.slice(-MAX_RETAINED_PAGES);
        });
      } catch (requestError) {
        if (
          controller.signal.aborted ||
          requestSequenceRef.current !== requestId
        ) {
          return;
        }
        setOptionsError(
          requestError instanceof Error && requestError.message.trim()
            ? requestError.message
            : t("whatsappQrPickerLoadError")
        );
        setFailedCursor(cursor ?? null);
      } finally {
        if (
          !controller.signal.aborted &&
          requestSequenceRef.current === requestId
        ) {
          setOptionsLoading(false);
        }
      }
    },
    [loadOptions, query, t]
  );

  useEffect(() => {
    if (!open) {
      requestAbortRef.current?.abort();
      return;
    }
    const timer = window.setTimeout(
      () => void requestPage({ replace: true }),
      query.trim() ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => {
      window.clearTimeout(timer);
      requestAbortRef.current?.abort();
    };
  }, [open, query, requestPage]);

  useEffect(
    () => () => {
      requestAbortRef.current?.abort();
    },
    []
  );

  const options = useMemo(() => uniqueItems(pages), [pages]);
  const nextCursor = pages.at(-1)?.page.nextCursor ?? null;
  const mutationDisabled = Boolean(disabledReason) || busy;
  const selectedMissing = Boolean(
    selectionResolved && selectedEntryPointId && !selected
  );
  const summaryUnavailable = !loading && !selectionResolved;

  const disabledReasonLabel = disabledReason
    ? t(`whatsappQrPickerDisabled.${disabledReason}`)
    : null;
  const globalDisabledReason = disabledReasonLabel
    ? disabledReasonLabel
    : busy
      ? t("whatsappQrPickerMutationBusy")
      : null;

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      const normalizedQuery = normalizeWhatsAppQrManagerQuery(nextQuery);
      if (normalizedQuery === query) return;
      requestSequenceRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      setPages([]);
      setOptionsLoading(false);
      setOptionsError(null);
      setFailedCursor(undefined);
      setQuery(normalizedQuery);
    },
    [query]
  );

  const retryOptions = useCallback(() => {
    if (failedCursor === undefined) return;
    void requestPage({
      ...(failedCursor ? { cursor: failedCursor } : {}),
      replace: failedCursor === null,
    });
  }, [failedCursor, requestPage]);

  const chooseOption = useCallback(
    (option: WhatsAppQrManagerListItem) => {
      const assignedHere = Boolean(
        targetScenarioId &&
          option.assignment?.scenarioId === targetScenarioId &&
          option.assignment.nodeId === targetNodeId &&
          option.entryPointId === selectedEntryPointId
      );
      if (assignedHere) {
        setOpen(false);
        return;
      }
      if (mutationDisabled || option.readiness !== "ready") return;
      if (option.assignment?.scenarioStatus === "active") return;

      const isMove = Boolean(option.assignment);
      const isReplacement = Boolean(
        selectedEntryPointId && selectedEntryPointId !== option.entryPointId
      );
      setOpen(false);
      if (isMove || isReplacement) {
        setPendingOption(option);
        return;
      }
      void onAssign(option);
    },
    [
      mutationDisabled,
      onAssign,
      selectedEntryPointId,
      targetNodeId,
      targetScenarioId,
    ]
  );

  const pendingIsMove = Boolean(pendingOption?.assignment);
  const pendingIsReplacement = Boolean(
    pendingOption &&
      selectedEntryPointId &&
      selectedEntryPointId !== pendingOption.entryPointId
  );
  const pendingTitle = pendingIsMove
    ? pendingIsReplacement
      ? t("whatsappQrPickerConfirmCombinedTitle")
      : t("whatsappQrPickerConfirmMoveTitle", {
          qrName:
            pendingOption?.placementName ?? t("whatsappQrPickerUnknownQr"),
        })
    : t("whatsappQrPickerConfirmReplacementTitle");
  const pendingDescription = pendingOption
    ? pendingIsMove
      ? pendingIsReplacement
        ? t("whatsappQrPickerConfirmCombinedDescription", {
            qrName: pendingOption.placementName,
            sourceScenario:
              pendingOption.assignment?.scenarioName ??
              t("whatsappQrPickerUnknownScenario"),
            targetScenario: targetScenarioName,
            currentQrName:
              selected?.placementName ?? t("whatsappQrPickerUnknownQr"),
          })
        : t("whatsappQrPickerConfirmMoveDescription", {
            qrName: pendingOption.placementName,
            sourceScenario:
              pendingOption.assignment?.scenarioName ??
              t("whatsappQrPickerUnknownScenario"),
            targetScenario: targetScenarioName,
          })
      : t("whatsappQrPickerConfirmReplacementDescription", {
          currentQrName:
            selected?.placementName ?? t("whatsappQrPickerUnknownQr"),
          replacementQrName: pendingOption.placementName,
          targetScenario: targetScenarioName,
        })
    : "";

  const pickerButtonLabel = selected
    ? t("whatsappQrPickerChange")
    : t("whatsappQrPickerChoose");
  const picker = (
    <PickerPopover
      open={open}
      onOpenChange={setOpen}
      triggerLabel={pickerButtonLabel}
      query={query}
      onQueryChange={handleQueryChange}
      options={options}
      optionsLoading={optionsLoading}
      optionsError={optionsError}
      nextCursor={nextCursor}
      mutationDisabled={mutationDisabled}
      globalDisabledReason={globalDisabledReason}
      selectedEntryPointId={selectedEntryPointId}
      targetScenarioId={targetScenarioId}
      targetNodeId={targetNodeId}
      managerHref={managerHref}
      sourceLabel={sourceLabel}
      onChoose={chooseOption}
      onRetry={retryOptions}
      onOpenScenario={onOpenScenario}
      onLoadNext={() => {
        if (nextCursor)
          void requestPage({ cursor: nextCursor, replace: false });
      }}
      t={t}
      pickerId={pickerId}
    />
  );

  return (
    <div className="nodrag nowheel flex min-w-0 flex-col gap-2">
      {summaryUnavailable ? (
        <Alert variant="destructive" className="py-2">
          <AlertCircleIcon aria-hidden />
          <AlertTitle className="text-xs">
            {t("whatsappQrPickerSummaryUnavailable")}
          </AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2 text-[11px]">
            <span>{t("whatsappQrPickerSummaryUnavailableDescription")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onRefresh()}
            >
              <RefreshCwIcon data-icon="inline-start" aria-hidden />
              {t("whatsappQrRetry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <div
          className="flex flex-col gap-2"
          role="status"
          aria-live="polite"
          aria-label={t("whatsappQrLoading")}
        >
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : selected ? (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <p
                className="truncate text-xs font-medium"
                title={selected.placementName}
              >
                {selected.placementName}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {sourceLabel(selected.sourceId)}
              </p>
            </div>
            <Badge
              variant={selected.readiness === "ready" ? "secondary" : "outline"}
            >
              {t(`whatsappQrPickerReadiness.${selected.readiness}`)}
            </Badge>
          </div>
          {selected.readiness !== "ready" ? (
            <Alert variant="destructive" className="py-2">
              <AlertCircleIcon aria-hidden />
              <AlertTitle className="text-xs">
                {t("whatsappQrPickerSelectedUnhealthy")}
              </AlertTitle>
              <AlertDescription className="text-[11px]">
                <Link
                  href={detailHref(managerHref, selected.entryPointId)}
                  className="underline underline-offset-2"
                >
                  {t("whatsappQrPickerFinishSetup")}
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {picker}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={
                mutationDisabled ||
                selected.readiness === "reconciling" ||
                selected.readiness === "detached"
              }
              onClick={() => void onUnassign()}
            >
              {t("whatsappQrPickerClear")}
            </Button>
            <Button type="button" variant="link" size="sm" asChild>
              <Link href={detailHref(managerHref, selected.entryPointId)}>
                {t("whatsappQrPickerManage")}
                <ExternalLinkIcon data-icon="inline-end" aria-hidden />
              </Link>
            </Button>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("whatsappQrPickerClearHelp")}
          </p>
        </div>
      ) : selectedMissing ? (
        <Alert variant="destructive" className="py-2">
          <AlertCircleIcon aria-hidden />
          <AlertTitle className="text-xs">
            {t("whatsappQrPickerSelectionMissing")}
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-2 text-[11px]">
            <span>{t("whatsappQrPickerSelectionMissingDescription")}</span>
            <Link
              href={detailHref(managerHref, selectedEntryPointId!)}
              className="underline underline-offset-2"
            >
              {t("whatsappQrPickerManage")}
            </Link>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("whatsappQrPickerHelper")}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {picker}
            <Button type="button" variant="link" size="sm" asChild>
              <Link href={managerHref}>
                {t("whatsappQrPickerManage")}
                <ExternalLinkIcon data-icon="inline-end" aria-hidden />
              </Link>
            </Button>
          </div>
        </div>
      )}

      {disabledReasonLabel ? (
        <p className="text-[11px] leading-snug text-destructive">
          {disabledReasonLabel}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[11px] leading-snug text-destructive">
          {error}
        </p>
      ) : null}

      <AlertDialog
        open={Boolean(pendingOption)}
        onOpenChange={nextOpen => {
          if (!nextOpen && !busy) setPendingOption(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="[overflow-wrap:anywhere]">
              {pendingTitle}
            </AlertDialogTitle>
            <AlertDialogDescription className="[overflow-wrap:anywhere]">
              {pendingDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutationDisabled}
              onClick={() => {
                const option = pendingOption;
                if (!option) return;
                void onAssign(option).finally(() => setPendingOption(null));
              }}
            >
              {busy ? (
                <Loader2Icon
                  data-icon="inline-start"
                  className="animate-spin"
                  aria-hidden
                />
              ) : null}
              {pendingIsMove
                ? t("whatsappQrPickerMoveHere")
                : t("whatsappQrPickerReplace")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type PickerPopoverProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  options: WhatsAppQrManagerListItem[];
  optionsLoading: boolean;
  optionsError: string | null;
  nextCursor: string | null;
  mutationDisabled: boolean;
  globalDisabledReason: string | null;
  selectedEntryPointId: string | null;
  targetScenarioId: string | null;
  targetNodeId: string;
  managerHref: string;
  sourceLabel: (sourceId?: string) => string;
  onChoose: (option: WhatsAppQrManagerListItem) => void;
  onRetry: () => void;
  onOpenScenario: (scenarioId: string) => void;
  onLoadNext: () => void;
  t: PickerTranslate;
  pickerId: string;
};

function PickerPopover({
  open,
  onOpenChange,
  triggerLabel,
  query,
  onQueryChange,
  options,
  optionsLoading,
  optionsError,
  nextCursor,
  mutationDisabled,
  globalDisabledReason,
  selectedEntryPointId,
  targetScenarioId,
  targetNodeId,
  managerHref,
  sourceLabel,
  onChoose,
  onRetry,
  onOpenScenario,
  onLoadNext,
  t,
  pickerId,
}: PickerPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-label={triggerLabel}
          aria-expanded={open}
          aria-controls={`${pickerId}-options`}
          className="min-w-0 max-w-full justify-between"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDownIcon data-icon="inline-end" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={`${pickerId}-options`}
        align="start"
        className="nodrag nowheel w-[min(22rem,calc(100vw-2rem))] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={onQueryChange}
            maxLength={512}
            placeholder={t("whatsappQrPickerSearch")}
            aria-label={t("whatsappQrPickerSearch")}
          />
          <CommandList>
            {optionsLoading && options.length === 0 ? (
              <div
                className="flex flex-col gap-2 p-3"
                role="status"
                aria-live="polite"
                aria-label={t("whatsappQrPickerLoadingOptions")}
              >
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : null}
            {optionsError && options.length === 0 ? (
              <div
                className="flex flex-col items-center gap-2 p-4 text-center text-sm"
                role="alert"
              >
                <AlertCircleIcon aria-hidden />
                <span>{t("whatsappQrPickerLoadError")}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRetry}
                >
                  <RefreshCwIcon data-icon="inline-start" aria-hidden />
                  {t("whatsappQrRetry")}
                </Button>
              </div>
            ) : null}
            {!optionsLoading && !optionsError && options.length === 0 ? (
              <CommandEmpty>{t("whatsappQrPickerNoResults")}</CommandEmpty>
            ) : null}
            {options.length > 0 ? (
              <CommandGroup heading={t("whatsappQrPickerAvailableCodes")}>
                {options.map(option => {
                  const assignedHere = Boolean(
                    targetScenarioId &&
                      option.assignment?.scenarioId === targetScenarioId &&
                      option.assignment.nodeId === targetNodeId &&
                      option.entryPointId === selectedEntryPointId
                  );
                  const setupRequired = option.readiness !== "ready";
                  const activeSource =
                    option.assignment?.scenarioStatus === "active";
                  const disabled =
                    mutationDisabled || setupRequired || activeSource;
                  const reasonId = `${pickerId}-option-reason-${option.entryPointId}`;
                  const sourceScenarioId = option.assignment?.scenarioId;
                  const sourceLink = sourceScenarioId
                    ? scenarioHref(managerHref, sourceScenarioId)
                    : null;
                  return (
                    <div
                      key={option.entryPointId}
                      className="flex flex-col gap-1 py-0.5"
                    >
                      <CommandItem
                        value={option.entryPointId}
                        disabled={disabled}
                        aria-describedby={
                          disabled || assignedHere ? reasonId : undefined
                        }
                        onSelect={() => onChoose(option)}
                        className="items-start"
                      >
                        <div className="min-w-0 flex-1">
                          <p
                            className="truncate font-medium"
                            title={option.placementName}
                          >
                            {option.placementName}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {sourceLabel(option.sourceId)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Badge variant="outline">
                            {t(`whatsappQrPickerReadiness.${option.readiness}`)}
                          </Badge>
                          {assignedHere ? <CheckIcon aria-hidden /> : null}
                        </div>
                      </CommandItem>
                      <div
                        id={reasonId}
                        className="flex min-w-0 items-center justify-between gap-2 px-2 text-[11px] text-muted-foreground"
                      >
                        <span className="min-w-0 truncate">
                          {globalDisabledReason
                            ? globalDisabledReason
                            : assignedHere
                              ? t("whatsappQrPickerAssignedHere")
                              : activeSource
                                ? t("whatsappQrPickerDeactivateSource", {
                                    scenario:
                                      option.assignment?.scenarioName ??
                                      t("whatsappQrPickerUnknownScenario"),
                                  })
                                : option.assignment
                                  ? t("whatsappQrPickerAssignedTo", {
                                      scenario: option.assignment.scenarioName,
                                    })
                                  : setupRequired
                                    ? t("whatsappQrPickerSetupRequired")
                                    : t("whatsappQrPickerReadyToAssign")}
                        </span>
                        {activeSource && sourceLink && sourceScenarioId ? (
                          <Link
                            href={sourceLink}
                            className="shrink-0 underline underline-offset-2"
                            onClick={event => {
                              if (shouldUseNativeLinkNavigation(event)) return;
                              event.preventDefault();
                              onOpenScenario(sourceScenarioId);
                            }}
                          >
                            {t("whatsappQrPickerOpenScenario")}
                          </Link>
                        ) : setupRequired ? (
                          <Link
                            href={detailHref(managerHref, option.entryPointId)}
                            className="shrink-0 underline underline-offset-2"
                          >
                            {t("whatsappQrPickerFinishSetup")}
                          </Link>
                        ) : option.assignment && !assignedHere ? (
                          <span className="shrink-0 font-medium text-foreground">
                            {t("whatsappQrPickerMoveHere")}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </CommandGroup>
            ) : null}
            {optionsError && options.length > 0 ? (
              <div
                role="alert"
                className="flex items-center justify-between gap-2 border-t p-2 text-xs text-destructive"
              >
                <span>{t("whatsappQrPickerLoadMoreError")}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRetry}
                >
                  <RefreshCwIcon data-icon="inline-start" aria-hidden />
                  {t("whatsappQrRetry")}
                </Button>
              </div>
            ) : null}
            {nextCursor ? (
              <div className="border-t p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={optionsLoading}
                  onClick={onLoadNext}
                >
                  {optionsLoading ? (
                    <Loader2Icon
                      data-icon="inline-start"
                      className="animate-spin"
                      aria-hidden
                    />
                  ) : null}
                  {t("whatsappQrPickerLoadMore")}
                </Button>
              </div>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
