import {
  buildScenarioBusinessLocationKey,
  findScenarioLocationOutlierOffices,
  listScenarioBusinessLocationIssues,
  normalizeScenarioBusinessLocation,
  normalizeScenarioBusinessLocationKey,
  parseScenarioLocationCoordinate,
  parseScenarioLocationInput,
  type ScenarioBusinessLocation,
  type ScenarioBusinessLocationIssue,
  type ScenarioLocationOutlierOffice,
} from "@icecore/scenario-contracts";
import { resolveCountryCode } from "@/lib/geo/countries";
import {
  findSpreadsheetColumn,
  isExcelSpreadsheetFile,
  normalizeSpreadsheetCell,
  normalizeSpreadsheetHeader,
  readCsvRows,
  readExcelRows,
  toNumberedNonEmptyRows,
  type SpreadsheetRow,
} from "@/lib/spreadsheet/read-rows";
import { buildCsv } from "@/lib/spreadsheet/write-csv";
import {
  MAX_BUSINESS_LOCATIONS_PER_SAVE,
  toBusinessLocationInput,
  type BusinessLocationInput,
  type BusinessLocationRecord,
} from "./types";

// The Settings → Offices import file reader and CSV export. It runs in the
// browser and in Node tests, so it must stay free of "use client",
// server-only modules and models. The server re-validates every office sent.

export type BusinessLocationColumn =
  | "key"
  | "name"
  | "country"
  | "city"
  | "address"
  | "phone"
  | "latitude"
  | "longitude"
  | "coordinates"
  | "mapUrl"
  | "tags"
  | "active"
  | "sortOrder";

/**
 * The headers each column is recognized by, in English, Russian and Kazakh,
 * already normalized with normalizeSpreadsheetHeader. Earlier names win.
 */
export const BUSINESS_LOCATION_COLUMN_ALIASES: Record<
  BusinessLocationColumn,
  readonly string[]
> = {
  key: [
    "key",
    "code",
    "id",
    "office_id",
    "office_key",
    "branch_id",
    "код",
    "ключ",
    "код_филиала",
    "филиал_коды",
  ],
  name: [
    "name",
    "office",
    "office_name",
    "branch",
    "title",
    "название",
    "наименование",
    "филиал",
    "атауы",
    "атау",
  ],
  country: ["country", "country_code", "страна", "код_страны", "ел", "елі"],
  city: ["city", "город", "қала", "кала", "қаласы"],
  address: ["address", "адрес", "мекенжай", "мекенжайы"],
  phone: [
    "phone",
    "phone_number",
    "telephone",
    "телефон",
    "тел",
    "телефон_нөмірі",
  ],
  latitude: ["latitude", "lat", "широта", "ендік"],
  longitude: ["longitude", "lng", "lon", "long", "долгота", "бойлық"],
  coordinates: ["coordinates", "coords", "координаты", "координаттар"],
  mapUrl: [
    "map_url",
    "map",
    "map_link",
    "google_maps",
    "maps_link",
    "link",
    "карта",
    "ссылка",
    "ссылка_на_карту",
    "сілтеме",
    "карта_сілтемесі",
  ],
  tags: ["tags", "tag", "теги", "тег", "тегтер"],
  active: [
    "active",
    "is_active",
    "status",
    "активен",
    "активный",
    "статус",
    "белсенді",
  ],
  sortOrder: [
    "sort_order",
    "sort",
    "order",
    "порядок",
    "сортировка",
    "сұрыптау",
  ],
};

/** The export's columns; each one is also an import alias, so a file re-imports 1:1. */
export const BUSINESS_LOCATION_EXPORT_HEADERS = [
  "key",
  "name",
  "country",
  "city",
  "address",
  "phone",
  "latitude",
  "longitude",
  "map_url",
  "tags",
  "active",
  "sort_order",
] as const;

export type BusinessLocationImportErrorCode =
  | "empty_file"
  | "invalid_file"
  | "invalid_encoding"
  | "missing_columns"
  | "too_many_rows"
  | "invalid_row"
  | "country_unknown"
  | "coordinates_missing"
  | "coordinates_short_link"
  | "coordinates_no_point"
  | "key_not_derivable"
  | "duplicate_key"
  | "active_invalid";

/**
 * One problem with the file. rowNumber is the row in the file, or null for
 * the whole file. invalid_row lists its issues; missing_columns names the
 * absent columns (one coordinates column would replace latitude and
 * longitude); duplicate_key names the key.
 */
export type BusinessLocationImportError = {
  rowNumber: number | null;
  code: BusinessLocationImportErrorCode;
  issues?: ScenarioBusinessLocationIssue[];
  columns?: string[];
  key?: string;
};

/** A row ready to send; keyDerived when the key was made from country, city and name. */
export type BusinessLocationImportRow = {
  rowNumber: number;
  input: BusinessLocationInput;
  keyDerived: boolean;
};

/**
 * Rows without errors, every error, how many of those rows got a made-up key,
 * and the columns the file has (empty when the whole file was refused).
 */
export type BusinessLocationImportResult = {
  rows: BusinessLocationImportRow[];
  errors: BusinessLocationImportError[];
  derivedKeys: number;
  presentColumns: BusinessLocationColumn[];
};

export type BusinessLocationImportPreview = {
  /**
   * What the save sends: one office per row, in the same order, so the
   * server's row index i is rows[i]. An office already in the catalog keeps
   * its stored value for each column the file doesn't have.
   */
  offices: BusinessLocationInput[];
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Active offices already in the catalog that the file doesn't list. */
  missing: string[];
  /** Active offices after the import, when missing offices stay active. */
  activeAfter: number;
  /** Active offices after the import, when missing offices are deactivated. */
  activeAfterDeactivation: number;
  /** Outlier pins among the active offices after the import. */
  outliers: ScenarioLocationOutlierOffice[];
};

type ColumnIndexes = Record<BusinessLocationColumn, number>;

// The export puts "'" before text a spreadsheet would run as a formula
// (write-csv.ts); a cell read back drops it.
const EXPORT_FORMULA_GUARD = /^'(?= *(?:[=+\-@]|[\t\r\n]))/;
const INTEGER_TEXT = /^[+-]?\d+$/;
const TAG_SEPARATORS = /[,;|]/;

const ACTIVE_VALUES = new Map<string, boolean>([
  ["true", true],
  ["false", false],
  ["yes", true],
  ["no", false],
  ["1", true],
  ["0", false],
  ["да", true],
  ["нет", false],
  ["иә", true],
  ["жоқ", false],
  ["active", true],
  ["inactive", false],
  ["активен", true],
  ["неактивен", false],
  ["белсенді", true],
  ["белсенді емес", false],
]);

const COORDINATE_ISSUES: readonly ScenarioBusinessLocationIssue[] = [
  "latitude_invalid",
  "longitude_invalid",
  "coordinates_zero",
];

function fileError(
  code: BusinessLocationImportErrorCode,
  extra: Partial<BusinessLocationImportError> = {}
): BusinessLocationImportResult {
  return {
    rows: [],
    errors: [{ rowNumber: null, code, ...extra }],
    derivedKeys: 0,
    presentColumns: [],
  };
}

function cellAt(values: readonly unknown[], index: number): unknown {
  return index < 0 ? undefined : values[index];
}

function readText(values: readonly unknown[], index: number): string {
  return normalizeSpreadsheetCell(cellAt(values, index))
    .trim()
    .replace(EXPORT_FORMULA_GUARD, "");
}

/** A number cell as is; text as a rounded number when it reads as one, else as typed. */
function readCoordinate(
  values: readonly unknown[],
  index: number,
  axis: "latitude" | "longitude"
): number | string {
  const value = cellAt(values, index);
  if (typeof value === "number") {
    return parseScenarioLocationCoordinate(value, axis) ?? value;
  }
  const text = readText(values, index);
  return parseScenarioLocationCoordinate(text, axis) ?? text;
}

type RowLocation =
  | { latitude: number | string; longitude: number | string }
  | {
      error:
        | "coordinates_missing"
        | "coordinates_short_link"
        | "coordinates_no_point";
    };

/** Latitude and longitude cells when both are filled, otherwise the coordinates cell. */
function readLocation(
  values: readonly unknown[],
  columns: ColumnIndexes
): RowLocation {
  if (
    readText(values, columns.latitude) &&
    readText(values, columns.longitude)
  ) {
    return {
      latitude: readCoordinate(values, columns.latitude, "latitude"),
      longitude: readCoordinate(values, columns.longitude, "longitude"),
    };
  }
  const location = parseScenarioLocationInput(
    readText(values, columns.coordinates)
  );
  switch (location.status) {
    case "point":
      return location.point;
    case "short_link":
      return { error: "coordinates_short_link" };
    case "no_coordinates":
      return { error: "coordinates_no_point" };
    default:
      return { error: "coordinates_missing" };
  }
}

/** true or false for a recognized value, undefined otherwise; empty means active. */
function readActive(text: string): boolean | undefined {
  if (!text) return true;
  return ACTIVE_VALUES.get(
    text.normalize("NFKC").replace(/\s+/g, " ").toLowerCase()
  );
}

/** A number for a number cell or integer text; other text is kept so validation refuses it. */
function readSortOrder(
  values: readonly unknown[],
  index: number
): number | string | undefined {
  const value = cellAt(values, index);
  if (typeof value === "number") return value;
  const text = readText(values, index);
  if (!text) return undefined;
  return INTEGER_TEXT.test(text) ? Number(text) : text;
}

type ParsedRow = BusinessLocationImportRow & {
  errors: BusinessLocationImportError[];
};

function parseRow(row: SpreadsheetRow, columns: ColumnIndexes): ParsedRow {
  const { values, rowNumber } = row;
  const text = (column: BusinessLocationColumn) =>
    readText(values, columns[column]);
  const codes: BusinessLocationImportErrorCode[] = [];
  // Issues another error already explains, so the row isn't reported twice.
  const explained = new Set<ScenarioBusinessLocationIssue>();

  const name = text("name");
  const city = text("city");
  const countryText = text("country");
  const country = resolveCountryCode(countryText);
  if (!country) {
    codes.push("country_unknown");
    explained.add("country_invalid");
  }

  const location = readLocation(values, columns);
  if ("error" in location) {
    codes.push(location.error);
    COORDINATE_ISSUES.forEach(issue => explained.add(issue));
  }

  const isActive = readActive(text("active"));
  if (isActive === undefined) codes.push("active_invalid");

  let key = text("key");
  const keyDerived = !key;
  if (keyDerived) {
    key = buildScenarioBusinessLocationKey({ country, city, name }) ?? "";
    if (!key) explained.add("key_invalid");
  }

  const address = text("address");
  const phone = text("phone");
  const mapUrl = text("mapUrl");
  const tags = text("tags")
    .split(TAG_SEPARATORS)
    .map(tag => tag.trim())
    .filter(Boolean);
  const sortOrder = readSortOrder(values, columns.sortOrder);
  const input: BusinessLocationInput = {
    key,
    name,
    country: country ?? countryText,
    city,
    ...(address ? { address } : {}),
    ...(phone ? { phone } : {}),
    ...(mapUrl ? { mapUrl } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    latitude: "error" in location ? "" : location.latitude,
    longitude: "error" in location ? "" : location.longitude,
    isActive: isActive ?? true,
    ...(typeof sortOrder === "number" ? { sortOrder } : {}),
  };

  const issues = listScenarioBusinessLocationIssues({ ...input, sortOrder });
  // Without a country, name or city the other errors already say why.
  if (
    keyDerived &&
    !key &&
    country &&
    !issues.includes("name_missing") &&
    !issues.includes("city_missing")
  ) {
    codes.push("key_not_derivable");
  }
  const errors: BusinessLocationImportError[] = codes.map(code => ({
    rowNumber,
    code,
  }));
  const unexplained = issues.filter(issue => !explained.has(issue));
  if (unexplained.length > 0) {
    errors.push({ rowNumber, code: "invalid_row", issues: unexplained });
  }
  return { rowNumber, input, keyDerived, errors };
}

/**
 * Reads offices from spreadsheet rows; rows[0] is the header. Each row is
 * checked as the server would check it, and a key on more than one row is an
 * error on every one of them. A row with any error is left out of rows.
 */
export function parseBusinessLocationRows(
  rows: readonly SpreadsheetRow[]
): BusinessLocationImportResult {
  const [headerRow, ...dataRows] = rows;
  if (!headerRow) return fileError("empty_file");

  const header = headerRow.values.map(normalizeSpreadsheetHeader);
  const columns = Object.fromEntries(
    Object.entries(BUSINESS_LOCATION_COLUMN_ALIASES).map(
      ([column, aliases]) => [column, findSpreadsheetColumn(header, aliases)]
    )
  ) as ColumnIndexes;
  const missing: BusinessLocationColumn[] = (
    ["name", "country", "city"] as const
  ).filter(column => columns[column] < 0);
  if (columns.coordinates < 0) {
    missing.push(
      ...(["latitude", "longitude"] as const).filter(
        column => columns[column] < 0
      )
    );
  }
  if (missing.length > 0) {
    return fileError("missing_columns", { columns: missing });
  }
  if (dataRows.length === 0) return fileError("empty_file");
  if (dataRows.length > MAX_BUSINESS_LOCATIONS_PER_SAVE) {
    return fileError("too_many_rows");
  }

  const parsed = dataRows.map(row => parseRow(row, columns));
  const rowsByKey = new Map<string, ParsedRow[]>();
  for (const row of parsed) {
    const key = normalizeScenarioBusinessLocationKey(row.input.key);
    if (!key) continue;
    const sameKey = rowsByKey.get(key);
    if (sameKey) sameKey.push(row);
    else rowsByKey.set(key, [row]);
  }
  for (const [key, sameKey] of rowsByKey) {
    if (sameKey.length < 2) continue;
    for (const row of sameKey) {
      row.errors.push({ rowNumber: row.rowNumber, code: "duplicate_key", key });
    }
  }

  const valid = parsed.filter(row => row.errors.length === 0);
  return {
    rows: valid.map(({ rowNumber, input, keyDerived }) => ({
      rowNumber,
      input,
      keyDerived,
    })),
    errors: parsed.flatMap(row => row.errors),
    derivedKeys: valid.filter(row => row.keyDerived).length,
    presentColumns: (Object.keys(columns) as BusinessLocationColumn[]).filter(
      column => columns[column] >= 0
    ),
  };
}

/**
 * The CSV as UTF-8 text, or null when it isn't UTF-8. Excel on Russian or
 * Kazakh Windows saves "CSV" in a legacy code page; read as UTF-8, every
 * Cyrillic letter would be stored as a replacement character. Environments
 * without TextDecoder (jsdom) read it as before.
 */
async function readUtf8Text(file: File): Promise<string | null> {
  if (typeof TextDecoder === "undefined") return file.text();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer()
    );
  } catch {
    return null;
  }
}

function isCsvFile(file: Pick<File, "name" | "type">): boolean {
  if (/\.csv$/i.test(file.name)) return true;
  return !/\.[^./\\]+$/.test(file.name) && file.type === "text/csv";
}

/**
 * Reads an import file: CSV by its .csv extension first (Windows may label a
 * CSV as Excel), otherwise XLSX or XLS, first sheet, with stored numbers so
 * coordinates keep every decimal. Never throws.
 */
export async function readBusinessLocationImportFile(
  file: File
): Promise<BusinessLocationImportResult> {
  let rows: SpreadsheetRow[];
  try {
    if (isCsvFile(file)) {
      const text = await readUtf8Text(file);
      if (text === null) return fileError("invalid_encoding");
      const csv = readCsvRows(text);
      rows = toNumberedNonEmptyRows(csv.rows, csv.sourceRowNumbers);
    } else if (isExcelSpreadsheetFile(file)) {
      rows = toNumberedNonEmptyRows(
        await readExcelRows(await file.arrayBuffer(), { raw: true })
      );
    } else {
      return fileError("invalid_file");
    }
  } catch {
    // Reader errors can contain cell contents; the dialog shows only the code.
    return fileError("invalid_file");
  }
  return parseBusinessLocationRows(rows);
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((tag, index) => tag === sortedRight[index]);
}

function isUnchanged(
  record: BusinessLocationRecord,
  office: ScenarioBusinessLocation,
  isActive: boolean
): boolean {
  return (
    record.name === office.name &&
    record.country === office.country &&
    record.city === office.city &&
    record.address === office.address &&
    record.phone === office.phone &&
    record.mapUrl === office.mapUrl &&
    sameTags(record.tags, office.tags) &&
    record.latitude === office.latitude &&
    record.longitude === office.longitude &&
    record.isActive === isActive &&
    record.sortOrder === office.sortOrder
  );
}

/**
 * The row for an office already in the catalog: each optional field whose
 * column the file lacks keeps the stored value, and so does the sort order
 * when the row has none.
 */
function keepStoredFields(
  input: BusinessLocationInput,
  record: BusinessLocationRecord,
  presentColumns: ReadonlySet<BusinessLocationColumn>
): BusinessLocationInput {
  const { address, phone, mapUrl, tags, isActive, sortOrder, ...required } =
    input;
  return toBusinessLocationInput(record, {
    ...required,
    ...(presentColumns.has("address") ? { address } : {}),
    ...(presentColumns.has("phone") ? { phone } : {}),
    ...(presentColumns.has("mapUrl") ? { mapUrl } : {}),
    ...(presentColumns.has("tags") ? { tags } : {}),
    ...(presentColumns.has("active") ? { isActive } : {}),
    ...(sortOrder === undefined ? {} : { sortOrder }),
  });
}

/**
 * What importing the file into the catalog would do, and the offices to send.
 *
 * A file changes only the columns it has. For an office already in the
 * catalog, a missing address, phone, map link, tags, active or sort order
 * column keeps the stored value, so a file of keys, names and coordinates
 * leaves phones alone and inactive offices inactive. A column that is there
 * with an empty cell clears the field; an empty active cell means active and
 * an empty sort order cell keeps the stored order. A new office gets only
 * what the file has and is active unless the file says otherwise.
 *
 * created, updated and unchanged compare those offices with the catalog.
 */
export function previewBusinessLocationImport(
  existing: readonly BusinessLocationRecord[],
  imported: {
    rows: readonly BusinessLocationImportRow[];
    presentColumns: readonly BusinessLocationColumn[];
  }
): BusinessLocationImportPreview {
  const existingByKey = new Map(existing.map(record => [record.key, record]));
  const presentColumns = new Set(imported.presentColumns);
  const fileOffices = new Map<
    string,
    { office: ScenarioBusinessLocation | null; isActive: boolean }
  >();
  const preview: BusinessLocationImportPreview = {
    offices: [],
    created: [],
    updated: [],
    unchanged: [],
    missing: [],
    activeAfter: 0,
    activeAfterDeactivation: 0,
    outliers: [],
  };
  for (const { input } of imported.rows) {
    const key =
      normalizeScenarioBusinessLocationKey(input.key) ?? input.key.trim();
    const record = existingByKey.get(key);
    const merged = record
      ? keepStoredFields(input, record, presentColumns)
      : input;
    preview.offices.push(merged);
    if (fileOffices.has(key)) continue;
    const office = normalizeScenarioBusinessLocation(merged);
    const isActive = merged.isActive !== false;
    fileOffices.set(key, { office, isActive });
    if (!record) preview.created.push(key);
    else if (office && isUnchanged(record, office, isActive)) {
      preview.unchanged.push(key);
    } else preview.updated.push(key);
  }

  const activeOffices: ScenarioBusinessLocation[] = [];
  for (const record of existing) {
    const row = fileOffices.get(record.key);
    if (!row) {
      if (record.isActive) {
        preview.missing.push(record.key);
        activeOffices.push(record);
      }
    } else if (row.isActive && row.office) {
      activeOffices.push(row.office);
    }
  }
  for (const key of preview.created) {
    const row = fileOffices.get(key);
    if (row?.isActive && row.office) activeOffices.push(row.office);
  }

  const activeInFile = [...fileOffices.values()].filter(
    row => row.isActive
  ).length;
  preview.activeAfter = activeInFile + preview.missing.length;
  preview.activeAfterDeactivation = activeInFile;
  preview.outliers = findScenarioLocationOutlierOffices(activeOffices);
  return preview;
}

/**
 * The catalog as CSV for Excel and Google Sheets: a BOM, CRLF and the
 * export headers, active offices first. It re-imports unchanged.
 */
export function buildBusinessLocationsCsv(
  records: readonly BusinessLocationRecord[]
): string {
  const ordered = [...records].sort(
    (left, right) => Number(right.isActive) - Number(left.isActive)
  );
  return buildCsv(
    [
      BUSINESS_LOCATION_EXPORT_HEADERS,
      ...ordered.map(record => [
        record.key,
        record.name,
        record.country,
        record.city,
        record.address,
        record.phone,
        record.latitude,
        record.longitude,
        record.mapUrl,
        record.tags.join(", "),
        record.isActive,
        record.sortOrder,
      ]),
    ],
    { bom: true }
  );
}
