"use client";

import {
  ActiveFilters,
  type DashboardFilterDimension,
  type DashboardFilterSelection,
} from "@/components/dashboard/active-filters";
import { formatDashboardCategory } from "@/components/dashboard/dashboard-localization";
import { DashboardPeriodRanges } from "@/components/dashboard/dashboard-period-ranges";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DateRangeControl,
  type DateRange,
} from "@/components/ui/date-range-control";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  DashboardComparisonPeriod,
  DashboardManagerOption,
} from "@/types/dashboard";
import { useTranslations } from "next-intl";
import * as React from "react";

export interface DashboardFilterOptions {
  channels: string[];
  categories: string[];
  internalLabels: string[];
  managers: DashboardManagerOption[];
}

export interface DashboardToolbarPreset extends DashboardFilterSelection {
  name: string;
}

export interface DashboardToolbarProps {
  dateRange: DateRange;
  filters: DashboardFilterSelection;
  options: DashboardFilterOptions;
  presets: DashboardToolbarPreset[];
  comparisonEnabled: boolean;
  comparisonAvailable: boolean;
  comparisonPeriod: DashboardComparisonPeriod | null;
  exportDisabled: boolean;
  onDateRangeChange: (value: DateRange) => void;
  onComparisonChange: (enabled: boolean) => void;
  onFiltersChange: (filters: DashboardFilterSelection) => void;
  onSavePreset: (name: string) => void;
  onApplyPreset: (preset: DashboardToolbarPreset) => void;
  onDeletePreset: (name: string) => void;
  onExport: () => void;
}

interface FilterOption {
  value: string;
  label: string;
}

interface DashboardFilterGroupProps {
  legend: string;
  emptyLabel: string;
  options: FilterOption[];
  selected: string[];
  onToggle: (value: string) => void;
}

function DashboardFilterGroup({
  legend,
  emptyLabel,
  options,
  selected,
  onToggle,
}: DashboardFilterGroupProps) {
  const idPrefix = React.useId();

  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <FieldGroup data-slot="checkbox-group" className="gap-3">
          {options.map((option, index) => {
            const id = `${idPrefix}-${index}`;
            return (
              <Field key={option.value} orientation="horizontal">
                <Checkbox
                  iconFree
                  id={id}
                  checked={selected.includes(option.value)}
                  onCheckedChange={() => onToggle(option.value)}
                />
                <FieldLabel htmlFor={id} className="min-w-0 font-normal">
                  <span className="min-w-0 break-words" title={option.label}>
                    {option.label}
                  </span>
                </FieldLabel>
              </Field>
            );
          })}
        </FieldGroup>
      )}
    </FieldSet>
  );
}

const emptyFilters = (): DashboardFilterSelection => ({
  channels: [],
  categories: [],
  internalLabels: [],
  managerIds: [],
});

const copyFilters = (
  filters: DashboardFilterSelection
): DashboardFilterSelection => ({
  channels: [...filters.channels],
  categories: [...filters.categories],
  internalLabels: [...filters.internalLabels],
  managerIds: [...filters.managerIds],
});

export function DashboardToolbar({
  dateRange,
  filters,
  options,
  presets,
  comparisonEnabled,
  comparisonAvailable,
  comparisonPeriod,
  exportDisabled,
  onDateRangeChange,
  onComparisonChange,
  onFiltersChange,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
  onExport,
}: DashboardToolbarProps) {
  const t = useTranslations("DashboardPage");
  const dashboardT = useTranslations("DashboardClientPage");
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [draftFilters, setDraftFilters] =
    React.useState<DashboardFilterSelection>(() => copyFilters(filters));
  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false);
  const [presetName, setPresetName] = React.useState("");
  const presetNameId = React.useId();
  const savePresetTriggerRef = React.useRef<HTMLButtonElement>(null);
  const deleteConfirmedRef = React.useRef(false);
  const activeCount =
    filters.channels.length +
    filters.categories.length +
    filters.internalLabels.length +
    filters.managerIds.length;

  const channelOptions = React.useMemo(
    () => options.channels.map(value => ({ value, label: value })),
    [options.channels]
  );
  const categoryOptions = React.useMemo(
    () =>
      options.categories.map(value => ({
        value,
        label: formatDashboardCategory(value, (key, values) =>
          dashboardT(key, values)
        ),
      })),
    [dashboardT, options.categories]
  );
  const internalLabelOptions = React.useMemo(
    () => options.internalLabels.map(value => ({ value, label: value })),
    [options.internalLabels]
  );
  const managerOptions = React.useMemo(
    () =>
      options.managers.map(manager => ({
        value: manager.id,
        label: manager.name,
      })),
    [options.managers]
  );

  const handleSheetOpenChange = React.useCallback(
    (open: boolean) => {
      if (open) setDraftFilters(copyFilters(filters));
      setSheetOpen(open);
    },
    [filters]
  );

  const toggleDraft = React.useCallback(
    (dimension: DashboardFilterDimension, value: string) => {
      setDraftFilters(current => {
        const values = current[dimension];
        return {
          ...current,
          [dimension]: values.includes(value)
            ? values.filter(item => item !== value)
            : [...values, value],
        };
      });
    },
    []
  );

  const removeFilter = React.useCallback(
    (dimension: DashboardFilterDimension, value: string) => {
      onFiltersChange({
        ...filters,
        [dimension]: filters[dimension].filter(item => item !== value),
      });
    },
    [filters, onFiltersChange]
  );

  const submitPreset = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = presetName.trim();
    if (!name) return;
    onSavePreset(name);
    setPresetName("");
    setSaveDialogOpen(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="w-full sm:w-[260px]">
          <DateRangeControl
            iconFree
            value={dateRange}
            onChange={onDateRangeChange}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <ToggleGroup
            type="single"
            variant="outline"
            value={
              comparisonAvailable && comparisonEnabled ? "previous" : "current"
            }
            disabled={!comparisonAvailable}
            aria-label={dashboardT("comparison.label")}
            className="w-full sm:w-auto"
            onValueChange={value => {
              if (!comparisonAvailable || !value) return;
              onComparisonChange(value === "previous");
            }}
          >
            <ToggleGroupItem
              value="previous"
              className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-3 py-2 text-center leading-snug sm:h-9 sm:flex-none sm:whitespace-nowrap sm:py-0"
            >
              {dashboardT("comparison.enabled")}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="current"
              className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-3 py-2 text-center leading-snug sm:h-9 sm:flex-none sm:whitespace-nowrap sm:py-0"
            >
              {dashboardT("comparison.disabled")}
            </ToggleGroupItem>
          </ToggleGroup>
          {!comparisonAvailable ? (
            <span className="text-xs text-muted-foreground">
              {dashboardT("comparison.unavailable")}
            </span>
          ) : null}
        </div>

        <Sheet open={sheetOpen} onOpenChange={handleSheetOpenChange}>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              aria-label={dashboardT("activeFilters.count", {
                count: activeCount,
              })}
            >
              {t("filters.label")}
              <Badge variant="secondary" aria-hidden="true">
                {activeCount}
              </Badge>
            </Button>
          </SheetTrigger>
          <SheetContent showCloseButton={false} className="w-full sm:max-w-md">
            <SheetHeader>
              <SheetTitle>{t("filters.sheetTitle")}</SheetTitle>
              <SheetDescription>
                {t("filters.sheetDescription")}
              </SheetDescription>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <div className="flex flex-col gap-6">
                <DashboardFilterGroup
                  legend={t("filters.channels")}
                  emptyLabel={t("filters.noChannels")}
                  options={channelOptions}
                  selected={draftFilters.channels}
                  onToggle={value => toggleDraft("channels", value)}
                />
                <DashboardFilterGroup
                  legend={t("filters.categories")}
                  emptyLabel={t("filters.noCategories")}
                  options={categoryOptions}
                  selected={draftFilters.categories}
                  onToggle={value => toggleDraft("categories", value)}
                />
                <DashboardFilterGroup
                  legend={t("filters.internalLabels")}
                  emptyLabel={t("filters.noInternalLabels")}
                  options={internalLabelOptions}
                  selected={draftFilters.internalLabels}
                  onToggle={value => toggleDraft("internalLabels", value)}
                />
                <DashboardFilterGroup
                  legend={t("filters.managers")}
                  emptyLabel={t("filters.noManagers")}
                  options={managerOptions}
                  selected={draftFilters.managerIds}
                  onToggle={value => toggleDraft("managerIds", value)}
                />

                <Separator />

                <div className="flex min-w-0 flex-col gap-2">
                  <h3 className="text-sm font-medium">{t("presets.label")}</h3>
                  {presets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("presets.empty")}
                    </p>
                  ) : (
                    <div className="flex min-w-0 flex-col gap-1">
                      {presets.map(preset => (
                        <div
                          key={preset.name}
                          className="flex min-w-0 items-center gap-1"
                        >
                          <Button
                            variant="ghost"
                            className="min-w-0 flex-1 justify-start"
                            aria-label={t("presets.apply", {
                              name: preset.name,
                            })}
                            title={preset.name}
                            onClick={() => {
                              onApplyPreset(preset);
                              setSheetOpen(false);
                            }}
                          >
                            <span className="min-w-0 truncate">
                              {preset.name}
                            </span>
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0 text-xs"
                                aria-label={t("presets.deleteAria", {
                                  name: preset.name,
                                })}
                              >
                                {t("presets.deleteAction")}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent
                              onCloseAutoFocus={event => {
                                if (!deleteConfirmedRef.current) return;
                                deleteConfirmedRef.current = false;
                                event.preventDefault();
                                savePresetTriggerRef.current?.focus();
                              }}
                            >
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  {t("presets.deleteTitle")}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t("presets.deleteDescription", {
                                    name: preset.name,
                                  })}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>
                                  {t("presets.deleteCancel")}
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  className={buttonVariants({
                                    variant: "destructive",
                                  })}
                                  onClick={() => {
                                    deleteConfirmedRef.current = true;
                                    onDeletePreset(preset.name);
                                  }}
                                >
                                  {t("presets.deleteConfirm")}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      ))}
                    </div>
                  )}
                  <Dialog
                    open={saveDialogOpen}
                    onOpenChange={open => {
                      setSaveDialogOpen(open);
                      if (!open) setPresetName("");
                    }}
                  >
                    <DialogTrigger asChild>
                      <Button
                        ref={savePresetTriggerRef}
                        variant="outline"
                        className="w-full"
                      >
                        {t("presets.save")}
                      </Button>
                    </DialogTrigger>
                    <DialogContent showCloseButton={false}>
                      <form
                        className="flex flex-col gap-4"
                        onSubmit={submitPreset}
                      >
                        <DialogHeader>
                          <DialogTitle>{t("presets.saveTitle")}</DialogTitle>
                          <DialogDescription>
                            {t("presets.saveDescription")}
                          </DialogDescription>
                        </DialogHeader>
                        <FieldGroup>
                          <Field>
                            <FieldLabel htmlFor={presetNameId}>
                              {t("presets.nameLabel")}
                            </FieldLabel>
                            <Input
                              id={presetNameId}
                              value={presetName}
                              placeholder={t("presets.namePlaceholder")}
                              autoComplete="off"
                              onChange={event =>
                                setPresetName(event.target.value)
                              }
                            />
                          </Field>
                        </FieldGroup>
                        <DialogFooter>
                          <DialogClose asChild>
                            <Button variant="outline">
                              {t("presets.cancel")}
                            </Button>
                          </DialogClose>
                          <Button type="submit" disabled={!presetName.trim()}>
                            {t("presets.confirmSave")}
                          </Button>
                        </DialogFooter>
                      </form>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
            </div>

            <Separator />
            <SheetFooter className="pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:flex-wrap">
              <Button
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => setDraftFilters(emptyFilters())}
              >
                {t("filters.clearSelection")}
              </Button>
              <SheetClose asChild>
                <Button variant="outline" className="w-full sm:w-auto">
                  {t("presets.cancel")}
                </Button>
              </SheetClose>
              <Button
                className="w-full sm:w-auto"
                onClick={() => {
                  onFiltersChange(copyFilters(draftFilters));
                  setSheetOpen(false);
                }}
              >
                {t("filters.apply")}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        <div className="w-full sm:ml-auto sm:w-fit">
          <Button
            className="w-full"
            variant="outline"
            disabled={exportDisabled}
            onClick={onExport}
          >
            {t("actions.export")}
          </Button>
        </div>
      </div>

      <DashboardPeriodRanges
        period={comparisonPeriod}
        comparisonEnabled={comparisonAvailable && comparisonEnabled}
      />

      <ActiveFilters
        filters={filters}
        managers={options.managers}
        onRemove={removeFilter}
        onClearAll={() => onFiltersChange(emptyFilters())}
      />
    </div>
  );
}
