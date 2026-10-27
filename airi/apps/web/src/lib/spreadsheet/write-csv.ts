// CSV text for files that people open in Excel or Google Sheets and import
// back with read-rows. Client-safe: no "use client", no server-only modules.

// Excel and Sheets run a cell that starts with one of these as a formula.
const FORMULA_PREFIX = /^ *(?:[=+\-@]|[\t\r\n])/;
// ";" is quoted too: readCsvRows switches to ";" when a header splits wider on it.
const NEEDS_QUOTES = /[",;\r\n]|^\s|\s$/;

/**
 * One CSV cell. Finite numbers and booleans are written as is; other text that
 * a spreadsheet would run as a formula gets a leading "'", so "+7 727 000"
 * becomes "'+7 727 000". Cells with quotes, separators, line breaks or edge
 * spaces are quoted. NaN and Infinity become empty cells.
 */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) {
    text = "";
  } else if (typeof value === "number") {
    text = Number.isFinite(value) ? String(value) : "";
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false";
  } else {
    text = String(value);
    if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  }
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Comma-separated rows joined with CRLF; bom adds the UTF-8 BOM Excel needs for Cyrillic. */
export function buildCsv(
  rows: readonly (readonly unknown[])[],
  options: { bom?: boolean } = {}
): string {
  const text = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  return options.bom ? `\uFEFF${text}` : text;
}
