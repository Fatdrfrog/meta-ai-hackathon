"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/ui/async-states";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buildBusinessLocationsCsv } from "@/lib/business-locations/import";
import {
  findBusinessLocationOutliers,
  summarizeBusinessLocations,
  toBusinessLocationInput,
  type BusinessLocationRecord,
  type BusinessLocationsListResponse,
  type BusinessLocationsSaveResponse,
} from "@/lib/business-locations/types";
import { getCountryLabel } from "@/lib/geo/countries";
import { downloadTextFile } from "@/lib/spreadsheet/download";
import { cn } from "@/lib/utils";
import { buildScenarioLocationMapsUrl } from "@icecore/scenario-contracts";
import {
  Download,
  ExternalLink,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Search,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { BusinessLocationDialog } from "./business-location-dialog";
import {
  businessLocationsApiUrl,
  describeBusinessLocationsError,
  requestBusinessLocations,
  type BusinessLocationsTranslator,
} from "./business-locations-client";
import { BusinessLocationsImportDialog } from "./business-locations-import-dialog";

const EMPTY_OFFICES: BusinessLocationRecord[] = [];
/** Outlier pins listed by name before the rest are only counted. */
const OUTLIERS_SHOWN = 5;

async function fetchOffices(
  url: string
): Promise<BusinessLocationsListResponse> {
  const data =
    await requestBusinessLocations<BusinessLocationsListResponse>(url);
  if (!Array.isArray(data?.offices)) throw new Error("Unexpected response");
  return data;
}

function matchesQuery(office: BusinessLocationRecord, query: string): boolean {
  return [office.name, office.key, office.city, office.address, office.phone]
    .filter((value): value is string => Boolean(value))
    .some(value => value.toLocaleLowerCase().includes(query));
}

type EditorState = {
  open: boolean;
  office: BusinessLocationRecord | null;
  /** A new value per opening, so each one starts from a fresh form. */
  version: number;
};

/** Settings → Offices: the workspace catalog that location routes send customers to. */
export function BusinessLocationsManager({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const t = useTranslations("BusinessLocationsSettings");
  const locale = useLocale();
  const url = businessLocationsApiUrl(workspaceId);
  const { data, error, isValidating, mutate } =
    useSWR<BusinessLocationsListResponse>(url, fetchOffices, {
      shouldRetryOnError: false,
    });
  const offices = data?.offices ?? EMPTY_OFFICES;
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    office: null,
    version: 0,
  });
  const [importer, setImporter] = useState({ open: false, version: 0 });
  const [confirm, setConfirm] = useState<{
    open: boolean;
    office: BusinessLocationRecord | null;
  }>({ open: false, office: null });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // Radix returns focus only to a trigger; the confirm opens from a row button.
  const confirmOpener = useRef<Element | null>(null);

  const summary = useMemo(() => summarizeBusinessLocations(offices), [offices]);
  const outliers = useMemo(
    () => findBusinessLocationOutliers(offices),
    [offices]
  );
  const officesByKey = useMemo(
    () => new Map(offices.map(office => [office.key, office])),
    [offices]
  );
  const needle = query.trim().toLocaleLowerCase();
  const visibleOffices = useMemo(
    () =>
      needle ? offices.filter(office => matchesQuery(office, needle)) : offices,
    [offices, needle]
  );

  const replaceOffices = (next: BusinessLocationRecord[]) =>
    mutate({ offices: next }, { revalidate: false });

  const openEditor = (office: BusinessLocationRecord | null) =>
    setEditor(current => ({
      open: true,
      office,
      version: current.version + 1,
    }));

  const openImporter = () =>
    setImporter(current => ({ open: true, version: current.version + 1 }));

  // A refused reply can follow a saved write, so a closing dialog reloads
  // the list.
  const reloadWhenClosed = (open: boolean) => {
    if (!open) void mutate();
  };

  // The row's buttons are disabled while it saves and the row moves between
  // the active and inactive offices, so its toggle gets focus back once the
  // list has re-rendered.
  const [refocusKey, setRefocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (!refocusKey) return;
    const toggles = [
      ...document.querySelectorAll<HTMLElement>("[data-office-toggle]"),
    ].filter(element => element.dataset.officeToggle === refocusKey);
    // The table and the cards both render; focus the one on screen.
    const target =
      toggles.find(element => element.getClientRects().length > 0) ??
      toggles[0];
    target?.focus();
    setRefocusKey(null);
  }, [refocusKey, offices]);

  async function setActive(office: BusinessLocationRecord, isActive: boolean) {
    if (pendingKey) return;
    setPendingKey(office.key);
    try {
      const response =
        await requestBusinessLocations<BusinessLocationsSaveResponse>(url, {
          method: "PUT",
          body: { offices: [toBusinessLocationInput(office, { isActive })] },
        });
      await replaceOffices(response.offices);
      toast.success(
        t(isActive ? "toasts.activated" : "toasts.deactivated", {
          name: office.name,
        })
      );
    } catch (requestError) {
      toast.error(describeBusinessLocationsError(t, requestError));
      // A failed reply can follow a saved write, so reload the list.
      void mutate();
    } finally {
      setPendingKey(null);
      setRefocusKey(office.key);
    }
  }

  function exportCsv() {
    downloadTextFile({
      filename: `offices-${new Date().toISOString().slice(0, 10)}.csv`,
      text: buildBusinessLocationsCsv(offices),
      mimeType: "text/csv;charset=utf-8",
    });
  }

  const busy = pendingKey !== null;
  const rowActions = (office: BusinessLocationRecord) => (
    <OfficeActions
      office={office}
      t={t}
      busy={busy}
      pending={pendingKey === office.key}
      onEdit={() => openEditor(office)}
      onDeactivate={() => {
        confirmOpener.current = document.activeElement;
        setConfirm({ open: true, office });
      }}
      onActivate={() => void setActive(office, true)}
    />
  );

  let body: ReactNode;
  if (!data) {
    body =
      error && !isValidating ? (
        <ErrorState
          message={t("loadError")}
          onRetry={() => void mutate()}
          retryLabel={t("retry")}
        />
      ) : (
        <div role="status" aria-label={t("loading")}>
          <LoadingState lines={4} />
        </div>
      );
  } else if (offices.length === 0) {
    body = (
      <EmptyState
        title={t("empty.title")}
        description={t("empty.manager")}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => openEditor(null)}>
              <Plus aria-hidden="true" />
              {t("actions.add")}
            </Button>
            <Button variant="outline" onClick={openImporter}>
              <Upload aria-hidden="true" />
              {t("actions.import")}
            </Button>
          </div>
        }
      />
    );
  } else {
    const inactive = offices.length - summary.active;
    body = (
      <div className="min-w-0 space-y-4">
        {outliers.length > 0 ? (
          <Alert className="border-amber-500/30 bg-amber-500/5">
            <TriangleAlert className="text-amber-600" aria-hidden="true" />
            <AlertTitle>{t("outliers.title")}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {outliers.slice(0, OUTLIERS_SHOWN).map(outlier => {
                  const office = officesByKey.get(outlier.key);
                  return (
                    <li key={outlier.key} className="break-words">
                      {t("outliers.item", {
                        name: office?.name ?? outlier.key,
                        city: office?.city ?? "",
                        km: Math.round(outlier.distanceMeters / 1000),
                      })}
                    </li>
                  );
                })}
              </ul>
              {outliers.length > OUTLIERS_SHOWN ? (
                <p>
                  {t("outliers.more", {
                    count: outliers.length - OUTLIERS_SHOWN,
                  })}
                </p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-sm text-muted-foreground">
            {t("summary", {
              active: summary.active,
              cities: summary.cities,
              countries: summary.countries,
            })}
            {inactive > 0
              ? ` · ${t("summaryInactive", { count: inactive })}`
              : ""}
          </p>
          <div className="relative w-full sm:max-w-sm">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              aria-label={t("search.label")}
              placeholder={t("search.placeholder")}
              className="pl-8"
            />
          </div>
        </div>

        {visibleOffices.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("noMatches")}
          </p>
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-xl border sm:block">
              <Table aria-label={t("title")}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.office")}</TableHead>
                    <TableHead>{t("columns.city")}</TableHead>
                    <TableHead className="hidden xl:table-cell">
                      {t("columns.address")}
                    </TableHead>
                    <TableHead className="hidden xl:table-cell">
                      {t("columns.phone")}
                    </TableHead>
                    <TableHead>{t("columns.location")}</TableHead>
                    <TableHead>{t("columns.status")}</TableHead>
                    <TableHead className="text-right">
                      {t("columns.actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleOffices.map(office => (
                    <TableRow
                      key={office.key}
                      className={cn(
                        !office.isActive && "text-muted-foreground"
                      )}
                    >
                      {/* The office column takes the width the others leave,
                          so long names truncate instead of pushing the
                          actions out of view. */}
                      <TableCell className="w-full max-w-0 whitespace-normal">
                        <OfficeName office={office} />
                        {office.address ? (
                          <p
                            className="line-clamp-2 text-xs break-words text-muted-foreground xl:hidden"
                            title={office.address}
                          >
                            {office.address}
                          </p>
                        ) : null}
                        {office.phone ? (
                          <p className="text-xs break-all text-muted-foreground xl:hidden">
                            {office.phone}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-40 whitespace-normal">
                        <p className="break-words">{office.city}</p>
                        <p className="text-xs break-words text-muted-foreground">
                          {getCountryLabel(office.country, locale)}
                        </p>
                      </TableCell>
                      <TableCell className="hidden max-w-64 min-w-44 whitespace-normal xl:table-cell">
                        {office.address ? (
                          <p
                            className="line-clamp-3 break-words"
                            title={office.address}
                          >
                            {office.address}
                          </p>
                        ) : (
                          t("noValue")
                        )}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        {office.phone || t("noValue")}
                      </TableCell>
                      <TableCell>
                        <OfficeLocation office={office} t={t} />
                      </TableCell>
                      <TableCell>
                        <OfficeStatus office={office} t={t} />
                      </TableCell>
                      <TableCell className="text-right">
                        {rowActions(office)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <ul className="space-y-2 sm:hidden" aria-label={t("title")}>
              {visibleOffices.map(office => (
                <li
                  key={office.key}
                  className={cn(
                    "min-w-0 space-y-2 rounded-lg border p-3 text-sm",
                    !office.isActive && "bg-muted/40 text-muted-foreground"
                  )}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <OfficeName office={office} wrap />
                    <OfficeStatus office={office} t={t} />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <p className="break-words">
                      {office.city}
                      <span className="text-muted-foreground">
                        {" · "}
                        {getCountryLabel(office.country, locale)}
                      </span>
                    </p>
                    {office.address ? (
                      <p className="break-words text-muted-foreground">
                        {office.address}
                      </p>
                    ) : null}
                    {office.phone ? (
                      <p className="break-all text-muted-foreground">
                        {office.phone}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <OfficeLocation office={office} t={t} />
                    {rowActions(office)}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-5">
      {/* The description sits under the header, not in it: beside three
          actions PageHeader clamps it to two lines and cuts it off. */}
      <div className="space-y-1">
        <PageHeader
          title={t("title")}
          secondaryAction={
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={exportCsv}
                disabled={offices.length === 0}
              >
                <Download aria-hidden="true" />
                {t("actions.export")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={openImporter}
                disabled={!data}
              >
                <Upload aria-hidden="true" />
                {t("actions.import")}
              </Button>
            </>
          }
          primaryAction={
            <Button size="sm" onClick={() => openEditor(null)} disabled={!data}>
              <Plus aria-hidden="true" />
              {t("actions.add")}
            </Button>
          }
        />
        <p className="text-muted-foreground text-sm text-pretty">
          {t("description")}
        </p>
      </div>

      {body}

      <BusinessLocationDialog
        key={`editor-${editor.version}`}
        open={editor.open}
        onOpenChange={open => {
          setEditor(current => ({ ...current, open }));
          reloadWhenClosed(open);
        }}
        workspaceId={workspaceId}
        office={editor.office}
        existing={offices}
        onSaved={next => void replaceOffices(next)}
      />
      <BusinessLocationsImportDialog
        key={`import-${importer.version}`}
        open={importer.open}
        onOpenChange={open => {
          setImporter(current => ({ ...current, open }));
          reloadWhenClosed(open);
        }}
        workspaceId={workspaceId}
        existing={offices}
        onImported={response => void replaceOffices(response.offices)}
      />
      <AlertDialog
        open={confirm.open}
        onOpenChange={open => setConfirm(current => ({ ...current, open }))}
      >
        <AlertDialogContent
          onCloseAutoFocus={event => {
            const opener = confirmOpener.current;
            if (!(opener instanceof HTMLElement) || !opener.isConnected) {
              return;
            }
            event.preventDefault();
            opener.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">
              {t("deactivateDialog.title", {
                name: confirm.office?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {t("deactivateDialog.description", {
                name: confirm.office?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("deactivateDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm.office) void setActive(confirm.office, false);
              }}
              className={buttonVariants({ variant: "destructive" })}
            >
              {t("deactivateDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Name and key; the table truncates them, a card (no hover title on touch) wraps them. */
function OfficeName({
  office,
  wrap = false,
}: {
  office: BusinessLocationRecord;
  wrap?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p
        className={cn("font-medium", wrap ? "break-words" : "truncate")}
        title={wrap ? undefined : office.name}
      >
        {office.name}
      </p>
      <p
        className={cn(
          "font-mono text-xs text-muted-foreground",
          wrap ? "break-all" : "truncate"
        )}
        title={wrap ? undefined : office.key}
      >
        {office.key}
      </p>
    </div>
  );
}

function OfficeStatus({
  office,
  t,
}: {
  office: BusinessLocationRecord;
  t: BusinessLocationsTranslator;
}) {
  return (
    <Badge
      variant={office.isActive ? "default" : "outline"}
      className={cn(
        "shrink-0",
        office.isActive
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300"
          : "text-muted-foreground"
      )}
    >
      {office.isActive ? t("status.active") : t("status.inactive")}
    </Badge>
  );
}

function OfficeLocation({
  office,
  t,
}: {
  office: BusinessLocationRecord;
  t: BusinessLocationsTranslator;
}) {
  return (
    <div className="flex items-center gap-2">
      <a
        href={buildScenarioLocationMapsUrl(office)}
        target="_blank"
        rel="noopener noreferrer"
        title={`${office.latitude}, ${office.longitude}`}
        aria-label={t("openInMapsFor", { name: office.name })}
        className="inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap text-primary underline-offset-4 hover:underline"
      >
        {t("openInMaps")}
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
      {office.mapUrl ? (
        <a
          href={office.mapUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={office.mapUrl}
          aria-label={t("mapLinkFor", { name: office.name })}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Link2 className="size-4" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

function OfficeActions({
  office,
  t,
  busy,
  pending,
  onEdit,
  onDeactivate,
  onActivate,
}: {
  office: BusinessLocationRecord;
  t: BusinessLocationsTranslator;
  busy: boolean;
  pending: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onActivate: () => void;
}) {
  const toggleLabel = office.isActive
    ? t("actions.deactivateOffice", { name: office.name })
    : t("actions.activateOffice", { name: office.name });
  const ToggleIcon = pending ? Loader2 : office.isActive ? PowerOff : Power;
  return (
    // Full color on a muted inactive row too, so Activate doesn't look disabled.
    <div className="flex shrink-0 justify-end gap-1 text-foreground">
      <Button
        variant="ghost"
        size="icon"
        onClick={onEdit}
        disabled={busy}
        title={t("actions.edit")}
        aria-label={t("actions.editOffice", { name: office.name })}
      >
        <Pencil aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={office.isActive ? onDeactivate : onActivate}
        disabled={busy}
        data-office-toggle={office.key}
        title={
          office.isActive ? t("actions.deactivate") : t("actions.activate")
        }
        aria-label={toggleLabel}
      >
        <ToggleIcon
          className={cn(pending && "animate-spin")}
          aria-hidden="true"
        />
      </Button>
    </div>
  );
}
