"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import {
  BUSINESS_LOCATION_COLUMN_ALIASES,
  BUSINESS_LOCATION_EXPORT_HEADERS,
  previewBusinessLocationImport,
  readBusinessLocationImportFile,
  type BusinessLocationColumn,
  type BusinessLocationImportError,
  type BusinessLocationImportResult,
  type BusinessLocationImportRow,
} from "@/lib/business-locations/import";
import {
  MAX_BUSINESS_LOCATION_RECORDS,
  MAX_BUSINESS_LOCATIONS_PER_SAVE,
  type BusinessLocationRecord,
  type BusinessLocationsSaveResponse,
} from "@/lib/business-locations/types";
import { downloadTextFile } from "@/lib/spreadsheet/download";
import { buildCsv } from "@/lib/spreadsheet/write-csv";
import { MAX_SCENARIO_BUSINESS_LOCATIONS } from "@icecore/scenario-contracts";
import {
  AlertCircle,
  Download,
  FileUp,
  Info,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { toast } from "sonner";
import {
  BusinessLocationsRequestError,
  businessLocationsApiUrl,
  describeBusinessLocationIssue,
  describeBusinessLocationsError,
  requestBusinessLocations,
  type BusinessLocationsTranslator,
} from "./business-locations-client";

export type BusinessLocationsImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The catalog as loaded, for the preview. */
  existing: BusinessLocationRecord[];
  onImported: (response: BusinessLocationsSaveResponse) => void;
};

/** Problems listed one by one before the rest are only counted. */
const PROBLEMS_SHOWN = 20;
/** Outlier pins listed by name before the rest are only counted. */
const OUTLIERS_SHOWN = 5;
/** Columns whose stored values an import keeps when the file lacks them. */
const KEPT_COLUMNS: readonly BusinessLocationColumn[] = [
  "address",
  "phone",
  "mapUrl",
  "tags",
  "active",
  "sortOrder",
];

/** One line of a problem list; a null row is about the whole file. */
type Problem = { rowNumber: number | null; message: string };
type Refusal = { message: string; rows: Problem[] };

function downloadTemplate() {
  downloadTextFile({
    filename: "offices-template.csv",
    text: buildCsv([BUSINESS_LOCATION_EXPORT_HEADERS], { bom: true }),
    mimeType: "text/csv;charset=utf-8",
  });
}

function describeColumns(
  t: BusinessLocationsTranslator,
  columns: readonly string[]
): string {
  return columns
    .map(column =>
      column in BUSINESS_LOCATION_COLUMN_ALIASES
        ? t(`import.columnNames.${column}`)
        : column
    )
    .join(", ");
}

/** One translated sentence for a problem the file reader found. */
function describeImportError(
  t: BusinessLocationsTranslator,
  error: BusinessLocationImportError
): string {
  switch (error.code) {
    case "invalid_row":
      return t("import.errors.invalid_row", {
        issues: (error.issues ?? [])
          .map(issue => describeBusinessLocationIssue(t, issue))
          .join(" "),
      });
    case "missing_columns":
      return t("import.errors.missing_columns", {
        columns: describeColumns(t, error.columns ?? []),
      });
    case "too_many_rows":
      return t("import.errors.too_many_rows", {
        max: MAX_BUSINESS_LOCATIONS_PER_SAVE,
      });
    case "duplicate_key":
      return t("import.errors.duplicate_key", { key: error.key ?? "" });
    default:
      return t(`import.errors.${error.code}`);
  }
}

/** Why the save was refused; refused offices are named by their row in the file. */
function describeRefusal(
  t: BusinessLocationsTranslator,
  error: unknown,
  rows: readonly BusinessLocationImportRow[]
): Refusal {
  if (
    !(error instanceof BusinessLocationsRequestError) ||
    error.code !== "invalid_offices"
  ) {
    return { message: describeBusinessLocationsError(t, error), rows: [] };
  }
  return {
    message: t("import.serverRows"),
    // The server's index is the office's place in the request, which is
    // the place of its row among the rows read from the file.
    rows: (error.body?.rows ?? []).map(row => ({
      rowNumber: rows[row.index]?.rowNumber ?? null,
      message: row.issues
        .map(issue => describeBusinessLocationIssue(t, issue))
        .join(" "),
    })),
  };
}

function ProblemList({
  t,
  problems,
}: {
  t: BusinessLocationsTranslator;
  problems: readonly Problem[];
}) {
  return (
    <>
      <ul className="w-full min-w-0 list-disc space-y-1 pl-4">
        {problems.slice(0, PROBLEMS_SHOWN).map((problem, index) => (
          <li key={index} className="min-w-0 [overflow-wrap:anywhere]">
            {problem.rowNumber === null
              ? problem.message
              : t("import.rowError", {
                  row: problem.rowNumber,
                  message: problem.message,
                })}
          </li>
        ))}
      </ul>
      {problems.length > PROBLEMS_SHOWN ? (
        <p>
          {t("import.moreErrors", { count: problems.length - PROBLEMS_SHOWN })}
        </p>
      ) : null}
    </>
  );
}

/**
 * Import offices from a CSV or Excel file: read it in the browser, preview
 * what changes, then save every row in one request.
 */
export function BusinessLocationsImportDialog({
  open,
  onOpenChange,
  workspaceId,
  existing,
  onImported,
}: BusinessLocationsImportDialogProps) {
  // The manager mounts this dialog afresh for each opening, so this is what
  // opened it. Radix only returns focus to a DialogTrigger, and there is none.
  const [opener] = useState(() =>
    typeof document === "undefined" ? null : document.activeElement
  );
  const [importing, setImporting] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!importing) onOpenChange(nextOpen);
      }}
    >
      {/* Clip, not hidden: below 768px this is the drawer, whose background
          extends below it, and a hidden overflow can still be scrolled by
          focus, leaving a blank sheet with the title out of view. */}
      <DialogContent
        className="flex max-h-[90dvh] flex-col overflow-clip sm:max-w-2xl"
        onCloseAutoFocus={event => {
          if (!(opener instanceof HTMLElement) || !opener.isConnected) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        {/* The content unmounts once the dialog has closed, so the file and
            its preview are dropped and the next opening starts empty. */}
        <ImportDialogBody
          workspaceId={workspaceId}
          existing={existing}
          importing={importing}
          onImportingChange={setImporting}
          onClose={() => onOpenChange(false)}
          onImported={onImported}
        />
      </DialogContent>
    </Dialog>
  );
}

function ImportDialogBody({
  workspaceId,
  existing,
  importing,
  onImportingChange,
  onClose,
  onImported,
}: {
  workspaceId: string;
  existing: readonly BusinessLocationRecord[];
  importing: boolean;
  onImportingChange: (importing: boolean) => void;
  onClose: () => void;
  onImported: (response: BusinessLocationsSaveResponse) => void;
}) {
  const t = useTranslations("BusinessLocationsSettings");
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const refusalRef = useRef<HTMLDivElement>(null);
  const parsingRequestId = useRef(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<BusinessLocationImportResult | null>(
    null
  );
  const [deactivateMissing, setDeactivateMissing] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    return () => {
      // A file still being read when the dialog closes is ignored.
      parsingRequestId.current += 1;
    };
  }, []);

  useEffect(() => {
    if (refusal) refusalRef.current?.focus();
  }, [refusal]);

  const preview = useMemo(
    () =>
      result && result.rows.length > 0
        ? previewBusinessLocationImport(existing, result)
        : null,
    [existing, result]
  );

  async function readFile(file: File) {
    const requestId = ++parsingRequestId.current;
    setFileName(file.name);
    setParsing(true);
    setResult(null);
    setDeactivateMissing(false);
    setRefusal(null);
    try {
      const next = await readBusinessLocationImportFile(file);
      if (requestId !== parsingRequestId.current) return;
      setResult(next);
    } finally {
      if (requestId === parsingRequestId.current) setParsing(false);
    }
  }

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so that choosing the same file again reads it again.
    event.target.value = "";
    if (file) void readFile(file);
  };

  const errors = result?.errors ?? [];
  const fileErrors = errors.filter(error => error.rowNumber === null);
  const rowProblems: Problem[] = errors
    .filter(error => error.rowNumber !== null)
    .map(error => ({
      rowNumber: error.rowNumber,
      message: describeImportError(t, error),
    }));
  const missing = preview?.missing.length ?? 0;
  const deactivating = deactivateMissing && missing > 0;
  const activeAfter = preview
    ? deactivating
      ? preview.activeAfterDeactivation
      : preview.activeAfter
    : 0;
  const overActiveLimit = activeAfter > MAX_SCENARIO_BUSINESS_LOCATIONS;
  const overRecordLimit =
    existing.length + (preview?.created.length ?? 0) >
    MAX_BUSINESS_LOCATION_RECORDS;
  // Offices already in the catalog keep these when the file lacks the column.
  const keptColumns =
    result && preview && preview.updated.length + preview.unchanged.length > 0
      ? KEPT_COLUMNS.filter(column => !result.presentColumns.includes(column))
      : [];
  const canImport =
    preview !== null &&
    errors.length === 0 &&
    !overActiveLimit &&
    !overRecordLimit &&
    !parsing &&
    !importing &&
    // Refused rows have to be fixed in the file, then the file read again.
    !refusal?.rows.length;

  const officeLabel = (key: string) =>
    preview?.offices.find(office => office.key.trim() === key) ??
    existing.find(record => record.key === key);

  async function importOffices() {
    if (!preview || !result || !canImport) return;
    const { rows } = result;
    onImportingChange(true);
    setRefusal(null);
    try {
      const response =
        await requestBusinessLocations<BusinessLocationsSaveResponse>(
          businessLocationsApiUrl(workspaceId),
          {
            method: "PUT",
            body: {
              offices: preview.offices,
              deactivateMissing: deactivating,
            },
          }
        );
      toast.success(
        t("import.success", {
          created: response.summary.created,
          updated: response.summary.updated,
          deactivated: response.summary.deactivated,
        })
      );
      onClose();
      onImported(response);
    } catch (error) {
      setRefusal(describeRefusal(t, error, rows));
    } finally {
      onImportingChange(false);
    }
  }

  return (
    <>
      <DialogHeader className="shrink-0">
        <DialogTitle>{t("import.title")}</DialogTitle>
        <DialogDescription>{t("import.description")}</DialogDescription>
      </DialogHeader>

      {/* Only the file details and the preview scroll; the padding keeps
          focus rings visible. */}
      <div className="-m-1 min-h-0 flex-1 overflow-y-auto p-1">
        <fieldset disabled={importing} className="grid min-w-0 gap-4">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={chooseFile}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInput.current?.click()}
            >
              <FileUp aria-hidden="true" />
              {fileName
                ? t("import.chooseAnotherFile")
                : t("import.chooseFile")}
            </Button>
            <Button
              type="button"
              variant="link"
              className="h-auto px-0"
              onClick={downloadTemplate}
            >
              <Download aria-hidden="true" />
              {t("import.downloadTemplate")}
            </Button>
          </div>
          {fileName ? (
            <p className="min-w-0 text-sm font-medium break-all">
              {t("import.fileName", { name: fileName })}
            </p>
          ) : null}
          {/* Once a file previews, the preview takes the hint's place, so a
              phone shows the counts without scrolling. */}
          {preview ? null : (
            <div className="min-w-0 space-y-1 text-sm text-muted-foreground">
              <p>
                {t("import.accepted", { max: MAX_BUSINESS_LOCATIONS_PER_SAVE })}
              </p>
              <p>{t("import.columnsHint")}</p>
            </div>
          )}

          <div role="status" className="min-w-0 text-sm empty:hidden">
            {parsing ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("import.parsing")}
              </span>
            ) : preview ? (
              <span className="font-medium">
                {t("import.preview", {
                  created: preview.created.length,
                  updated: preview.updated.length,
                  unchanged: preview.unchanged.length,
                  missing,
                })}
              </span>
            ) : null}
          </div>

          {refusal ? (
            <Alert variant="destructive" tabIndex={-1} ref={refusalRef}>
              <AlertCircle aria-hidden="true" />
              <AlertDescription>
                <p>{refusal.message}</p>
                {refusal.rows.length > 0 ? (
                  <ProblemList t={t} problems={refusal.rows} />
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {fileErrors.length > 0 ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>
                {fileErrors.map(error => (
                  <p key={error.code}>{describeImportError(t, error)}</p>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}

          {preview && missing > 0 ? (
            <Field orientation="horizontal" className="rounded-lg border p-3">
              <Checkbox
                id={`${id}-deactivate`}
                checked={deactivateMissing}
                aria-describedby={`${id}-deactivate-hint`}
                onCheckedChange={checked => {
                  setDeactivateMissing(checked === true);
                  // A refusal about the old choice no longer applies.
                  setRefusal(current =>
                    current?.rows.length ? current : null
                  );
                }}
              />
              <FieldContent>
                <FieldLabel htmlFor={`${id}-deactivate`}>
                  {t("import.deactivateMissing", { count: missing })}
                </FieldLabel>
                <FieldDescription id={`${id}-deactivate-hint`}>
                  {t("import.deactivateMissingHint")}
                </FieldDescription>
              </FieldContent>
            </Field>
          ) : null}

          {overActiveLimit || overRecordLimit ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>
                {overActiveLimit ? (
                  <p>
                    {t("import.limit", {
                      count: activeAfter,
                      limit: MAX_SCENARIO_BUSINESS_LOCATIONS,
                    })}
                  </p>
                ) : null}
                {overRecordLimit ? (
                  <p>
                    {t("errors.record_limit", {
                      limit: MAX_BUSINESS_LOCATION_RECORDS,
                    })}
                  </p>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {rowProblems.length > 0 ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle className="line-clamp-none">
                {t("import.errorsTitle", { count: rowProblems.length })}
              </AlertTitle>
              <AlertDescription>
                <ProblemList t={t} problems={rowProblems} />
              </AlertDescription>
            </Alert>
          ) : null}

          {result && result.derivedKeys > 0 ? (
            <Alert className="border-amber-500/30 bg-amber-500/5">
              <TriangleAlert className="text-amber-600" aria-hidden="true" />
              <AlertDescription>
                {t("import.derivedKeys", { count: result.derivedKeys })}
              </AlertDescription>
            </Alert>
          ) : null}

          {keptColumns.length > 0 ? (
            <Alert>
              <Info aria-hidden="true" />
              <AlertDescription>
                {t("import.keptColumns", {
                  columns: describeColumns(t, keptColumns),
                })}
              </AlertDescription>
            </Alert>
          ) : null}

          {preview && preview.outliers.length > 0 ? (
            <Alert className="border-amber-500/30 bg-amber-500/5">
              <TriangleAlert className="text-amber-600" aria-hidden="true" />
              <AlertTitle>{t("outliers.title")}</AlertTitle>
              <AlertDescription>
                <ul className="w-full min-w-0 list-disc space-y-1 pl-4">
                  {preview.outliers.slice(0, OUTLIERS_SHOWN).map(outlier => {
                    const office = officeLabel(outlier.key);
                    return (
                      <li
                        key={outlier.key}
                        className="min-w-0 [overflow-wrap:anywhere]"
                      >
                        {t("outliers.item", {
                          name: office?.name ?? outlier.key,
                          city: office?.city ?? "",
                          km: Math.round(outlier.distanceMeters / 1000),
                        })}
                      </li>
                    );
                  })}
                </ul>
                {preview.outliers.length > OUTLIERS_SHOWN ? (
                  <p>
                    {t("outliers.more", {
                      count: preview.outliers.length - OUTLIERS_SHOWN,
                    })}
                  </p>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </fieldset>
      </div>

      <DialogFooter className="shrink-0">
        <Button
          type="button"
          variant="outline"
          disabled={importing}
          onClick={onClose}
        >
          {t("import.cancel")}
        </Button>
        <Button
          type="button"
          disabled={!canImport}
          onClick={() => void importOffices()}
        >
          {importing ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              {t("import.importing")}
            </>
          ) : preview ? (
            t("import.submit", { count: preview.offices.length })
          ) : (
            t("actions.import")
          )}
        </Button>
      </DialogFooter>
    </>
  );
}
