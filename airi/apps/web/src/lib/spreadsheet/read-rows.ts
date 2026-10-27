import { parse as parseCsvSync } from "csv-parse/browser/esm/sync";

// Shared by the campaign recipient upload and the Settings > Offices import.
// It runs in the browser and in Node tests, so it must stay free of
// "use client", server-only modules and models.

/** One non-empty row with its 1-based row number in the source file. */
export type SpreadsheetRow = { values: unknown[]; rowNumber: number };

export type SpreadsheetReadErrorCode = "invalid_csv" | "no_sheet";

/** A file that can't be read. The message is the code, never cell contents. */
export class SpreadsheetReadError extends Error {
  constructor(readonly code: SpreadsheetReadErrorCode) {
    super(code);
    this.name = "SpreadsheetReadError";
  }
}

export function isExcelSpreadsheetFile(
  file: Pick<File, "name" | "type">
): boolean {
  return (
    /\.(xlsx|xls)$/i.test(file.name) ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.type === "application/vnd.ms-excel"
  );
}

/**
 * Reads CSV text separated by "," or ";", with or without a BOM. Each entry of
 * sourceRowNumbers is the physical line on which the matching row starts, so
 * blank lines and quoted line breaks don't shift reported row numbers.
 * Throws SpreadsheetReadError("invalid_csv") instead of the parser error,
 * because parser errors can contain cell contents.
 */
export function readCsvRows(text: string): {
  rows: string[][];
  sourceRowNumbers: number[];
} {
  const sourceRowNumbers: number[] = [];
  let rows: string[][];
  try {
    // Probe only the header with the existing parser. Treating both separators
    // as active would incorrectly split unquoted commas in semicolon files.
    let delimiter = ",";
    let headerWidth = -1;
    for (const candidate of [",", ";"]) {
      try {
        const [header = []] = parseCsvSync(text, {
          delimiter: candidate,
          bom: true,
          skip_empty_lines: true,
          trim: true,
          to: 1,
        });
        if (header.length > headerWidth) {
          delimiter = candidate;
          headerWidth = header.length;
        }
      } catch {
        // A quoted header with the other delimiter is not a valid candidate.
      }
    }
    rows = parseCsvSync(text, {
      delimiter,
      bom: true,
      cast: false,
      skip_empty_lines: true,
      trim: true,
      on_record: (record: string[], context) => {
        const embeddedLines = record.reduce(
          (count, cell) => count + (cell.match(/\r\n|\r|\n/g)?.length || 0),
          0
        );
        sourceRowNumbers.push(context.lines - embeddedLines);
        return record;
      },
    });
  } catch {
    throw new SpreadsheetReadError("invalid_csv");
  }
  return { rows, sourceRowNumbers };
}

/**
 * Reads the first sheet of an XLSX or XLS file, keeping leading empty rows so
 * that index + 1 is the sheet row. raw: false (the default) returns cells as
 * formatted text; raw: true returns stored numbers, so a coordinate shown as
 * "43.24" keeps all its decimals. Throws SpreadsheetReadError("no_sheet") when
 * the workbook has no sheet; SheetJS errors are passed through.
 */
export async function readExcelRows(
  buffer: ArrayBuffer,
  options: { raw?: boolean } = {}
): Promise<unknown[][]> {
  return (await readExcelSheet(buffer, options)).rows;
}

/**
 * readExcelRows that can leave out the rows Excel hides, which an Excel
 * filter does to every row it filters out. Hidden rows come back empty, so
 * index + 1 stays the sheet row and toNumberedNonEmptyRows drops them; the
 * first non-empty row (the header) is always kept.
 */
export async function readExcelSheet(
  buffer: ArrayBuffer,
  options: { raw?: boolean; skipHiddenRows?: boolean } = {}
): Promise<{ rows: unknown[][]; hiddenRowCount: number }> {
  const { read, utils } = await import("xlsx");
  // Row visibility is only read with cell styles.
  const workbook = read(buffer, {
    type: "array",
    cellStyles: options.skipHiddenRows === true,
  });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new SpreadsheetReadError("no_sheet");
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    range: 0,
    raw: options.raw ?? false,
    defval: "",
    blankrows: true,
  });
  if (!options.skipHiddenRows) return { rows, hiddenRowCount: 0 };

  const rowInfo = worksheet["!rows"] ?? [];
  const isBlank = (values: unknown[]) =>
    !values.some(cell => normalizeSpreadsheetCell(cell).trim());
  const headerIndex = rows.findIndex(values => !isBlank(values));
  let hiddenRowCount = 0;
  const visibleRows = rows.map((values, index) => {
    if (!rowInfo[index]?.hidden || index === headerIndex || isBlank(values)) {
      return values;
    }
    hiddenRowCount += 1;
    return [];
  });
  return { rows: visibleRows, hiddenRowCount };
}

/**
 * Drops rows whose cells are all blank and numbers the rest: the CSV source
 * line when sourceRowNumbers is given, otherwise index + 1.
 */
export function toNumberedNonEmptyRows(
  rows: readonly unknown[][],
  sourceRowNumbers?: readonly number[]
): SpreadsheetRow[] {
  return rows
    .map((values, index) => ({
      values,
      rowNumber: sourceRowNumbers?.[index] ?? index + 1,
    }))
    .filter(({ values }) =>
      values.some(cell => normalizeSpreadsheetCell(cell).trim())
    );
}

export function normalizeSpreadsheetCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** "Phone Number", "phone-number" and "phone.number" all become "phone_number". */
export function normalizeSpreadsheetHeader(value: unknown): string {
  return normalizeSpreadsheetCell(value)
    .trim()
    .toLowerCase()
    .replace(/[.\-]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * The index of the column named by the first alias that the header contains,
 * or -1. Earlier aliases win, and so does the leftmost of duplicate columns.
 * Both lists must already be normalized with normalizeSpreadsheetHeader.
 */
export function findSpreadsheetColumn(
  header: readonly string[],
  aliases: readonly string[]
): number {
  for (const alias of aliases) {
    const index = header.indexOf(alias);
    if (index !== -1) return index;
  }
  return -1;
}
