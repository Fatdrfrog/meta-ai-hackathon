import { utils, write, type WorkSheet } from "xlsx";
import {
  normalizeSpreadsheetHeader,
  readCsvRows,
  toNumberedNonEmptyRows,
} from "@/lib/spreadsheet/read-rows";
import {
  BUSINESS_LOCATION_COLUMN_ALIASES,
  BUSINESS_LOCATION_EXPORT_HEADERS,
  buildBusinessLocationsCsv,
  parseBusinessLocationRows,
  previewBusinessLocationImport,
  readBusinessLocationImportFile,
  type BusinessLocationColumn,
  type BusinessLocationImportRow,
} from "./import";
import {
  toBusinessLocationInput,
  validateBusinessLocationInput,
  type BusinessLocationInput,
  type BusinessLocationRecord,
} from "./types";

const BOM = String.fromCharCode(0xfeff);
const HEADER = "name,country,city,latitude,longitude";
const HEADER_COLUMNS: BusinessLocationColumn[] = [
  "name",
  "country",
  "city",
  "latitude",
  "longitude",
];
const ALL_COLUMNS = Object.keys(
  BUSINESS_LOCATION_COLUMN_ALIASES
) as BusinessLocationColumn[];

function parseCsv(text: string) {
  const { rows, sourceRowNumbers } = readCsvRows(text);
  return parseBusinessLocationRows(
    toNumberedNonEmptyRows(rows, sourceRowNumbers)
  );
}

function csvFile(text: string, name = "offices.csv", type = "text/csv"): File {
  return new File([text], name, { type });
}

function workbookFile(
  rows: unknown[][],
  options: {
    formatSheet?: (worksheet: WorkSheet) => void;
    otherSheet?: unknown[][];
  } = {}
): File {
  const workbook = utils.book_new();
  const worksheet = utils.aoa_to_sheet(rows);
  options.formatSheet?.(worksheet);
  utils.book_append_sheet(workbook, worksheet, "Offices");
  if (options.otherSheet) {
    utils.book_append_sheet(
      workbook,
      utils.aoa_to_sheet(options.otherSheet),
      "Notes"
    );
  }
  const buffer = write(workbook, {
    bookType: "xlsx",
    type: "array",
  }) as ArrayBuffer;
  return new File([buffer], "offices.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function record(
  key: string,
  overrides: Partial<BusinessLocationRecord> = {}
): BusinessLocationRecord {
  return {
    key,
    name: key,
    country: "KZ",
    city: "Almaty",
    cityKey: "almaty",
    tags: [],
    latitude: 43.24,
    longitude: 76.91,
    sortOrder: 0,
    isActive: true,
    updatedAt: null,
    ...overrides,
  };
}

function importRow(
  key: string,
  overrides: Partial<BusinessLocationInput> = {}
): BusinessLocationImportRow {
  return {
    rowNumber: 2,
    keyDerived: false,
    input: {
      key,
      name: key,
      country: "KZ",
      city: "Almaty",
      latitude: 43.24,
      longitude: 76.91,
      isActive: true,
      ...overrides,
    },
  };
}

/** The preview of rows from a file with the given columns, every one by default. */
function preview(
  existing: readonly BusinessLocationRecord[],
  rows: readonly BusinessLocationImportRow[],
  presentColumns: readonly BusinessLocationColumn[] = ALL_COLUMNS
) {
  return previewBusinessLocationImport(existing, { rows, presentColumns });
}

describe("business location columns", () => {
  it("lists every alias normalized and under one column only", () => {
    const aliases = Object.values(BUSINESS_LOCATION_COLUMN_ALIASES).flat();
    for (const alias of aliases) {
      expect(normalizeSpreadsheetHeader(alias)).toBe(alias);
    }
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("names each export header first among its column's aliases", () => {
    const columnOf = (header: string) =>
      Object.entries(BUSINESS_LOCATION_COLUMN_ALIASES).find(
        ([, aliases]) => aliases[0] === header
      )?.[0];
    expect(BUSINESS_LOCATION_EXPORT_HEADERS.map(columnOf)).toEqual([
      "key",
      "name",
      "country",
      "city",
      "address",
      "phone",
      "latitude",
      "longitude",
      "mapUrl",
      "tags",
      "active",
      "sortOrder",
    ]);
  });
});

describe("parseBusinessLocationRows", () => {
  it("reads a comma CSV with every column", () => {
    expect(
      parseCsv(
        `${BUSINESS_LOCATION_EXPORT_HEADERS.join(",")}\r\n` +
          `kz_almaty_abay,Abay,KZ,Almaty,"Abay Ave 10, 2nd floor",'+7 727 000 00 00,43.238949,76.889709,https://maps.app.goo.gl/abc,"VIP, 24/7",true,3\r\n`
      )
    ).toEqual({
      rows: [
        {
          rowNumber: 2,
          keyDerived: false,
          input: {
            key: "kz_almaty_abay",
            name: "Abay",
            country: "KZ",
            city: "Almaty",
            address: "Abay Ave 10, 2nd floor",
            phone: "+7 727 000 00 00",
            mapUrl: "https://maps.app.goo.gl/abc",
            tags: ["VIP", "24/7"],
            latitude: 43.238949,
            longitude: 76.889709,
            isActive: true,
            sortOrder: 3,
          },
        },
      ],
      errors: [],
      derivedKeys: 0,
      presentColumns: ALL_COLUMNS.filter(column => column !== "coordinates"),
    });
  });

  it("reports the columns the file has, in column order", () => {
    expect(
      parseCsv(
        "Порядок;Теги;Название;Город;Страна;Координаты;Активен\n" +
          '2;вип;ЦУМ;Алматы;KZ;"43.25, 76.95";да\n'
      ).presentColumns
    ).toEqual([
      "name",
      "country",
      "city",
      "coordinates",
      "tags",
      "active",
      "sortOrder",
    ]);
    expect(
      parseCsv(`${HEADER}\nAbay,KZ,Almaty,43.2,76.9\n`).presentColumns
    ).toEqual(HEADER_COLUMNS);
  });

  it("reads a semicolon CSV with a BOM, CRLF and comma decimals", () => {
    const result = parseCsv(
      `${BOM}name;country;city;latitude;longitude\r\n` +
        "Абай, ЦУМ;KZ;Алматы;43,238949;76,889709\r\n"
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        keyDerived: true,
        input: {
          key: "kz_almaty_abay_tsum",
          name: "Абай, ЦУМ",
          country: "KZ",
          city: "Алматы",
          latitude: 43.238949,
          longitude: 76.889709,
          isActive: true,
        },
      },
    ]);
  });

  it("reads Russian headers and a Russian country name", () => {
    const result = parseCsv(
      "Название;Город;Страна;Широта;Долгота;Адрес;Телефон;Теги;Активен;Порядок\n" +
        "ЦУМ;Алматы;Казахстан;43,25;76,95;пр. Абылай хана 62;+7 727 111 11 11;вип;нет;2\n"
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.input).toEqual({
      key: "kz_almaty_tsum",
      name: "ЦУМ",
      country: "KZ",
      city: "Алматы",
      address: "пр. Абылай хана 62",
      phone: "+7 727 111 11 11",
      tags: ["вип"],
      latitude: 43.25,
      longitude: 76.95,
      isActive: false,
      sortOrder: 2,
    });
  });

  it("reads Kazakh headers and a Kazakh country name", () => {
    const result = parseCsv(
      "Атауы,Қала,Ел,Ендік,Бойлық,Мекенжай,Тегтер,Белсенді,Сұрыптау\n" +
        "Абай,Алматы,Қазақстан,43.238949,76.889709,Абай даңғылы 10,жаңа,иә,1\n"
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.input).toEqual({
      key: "kz_almaty_abay",
      name: "Абай",
      country: "KZ",
      city: "Алматы",
      address: "Абай даңғылы 10",
      tags: ["жаңа"],
      latitude: 43.238949,
      longitude: 76.889709,
      isActive: true,
      sortOrder: 1,
    });
  });

  it("reads a single coordinates column as a pair or a Google Maps link", () => {
    const result = parseCsv(
      "Name,Country,City,Координаты\n" +
        'Abay,KZ,Almaty,"43.238949, 76.889709"\n' +
        "Dostyk,KZ,Almaty,43.2;76.95\n" +
        'Esentai,KZ,Almaty,"https://www.google.com/maps/place/Esentai/@43.21,76.92,17z/data=!3m1!4b1!4m6!3m5!8m2!3d43.218!4d76.927"\n' +
        'Mega,KZ,Almaty,"https://maps.google.com/?q=43.2027,76.8925"\n'
    );
    expect(result.errors).toEqual([]);
    expect(
      result.rows.map(({ input }) => [input.latitude, input.longitude])
    ).toEqual([
      [43.238949, 76.889709],
      [43.2, 76.95],
      [43.218, 76.927],
      [43.2027, 76.8925],
    ]);
  });

  it.each([
    ["https://maps.app.goo.gl/AbCdEf123", "coordinates_short_link"],
    ["https://go.2gis.com/abcd", "coordinates_short_link"],
    ["https://2gis.kz/almaty/firm/70000001", "coordinates_no_point"],
    ["https://www.google.com/maps?q=Abay+Ave+10", "coordinates_no_point"],
    ["", "coordinates_missing"],
    ["somewhere downtown", "coordinates_missing"],
    ['"91, 76"', "coordinates_missing"],
    ['"0, 0"', "coordinates_missing"],
  ])("reports the coordinates cell %s as %s", (cell, code) => {
    expect(
      parseCsv(`name,country,city,coordinates\nAbay,KZ,Almaty,${cell}\n`)
    ).toEqual({
      rows: [],
      errors: [{ rowNumber: 2, code }],
      derivedKeys: 0,
      presentColumns: ["name", "country", "city", "coordinates"],
    });
  });

  it("uses filled latitude and longitude cells first, and the coordinates cell otherwise", () => {
    const result = parseCsv(
      `${HEADER},coordinates\n` +
        'Abay,KZ,Almaty,43.1,76.1,"44.1, 77.1"\n' +
        'Dostyk,KZ,Almaty,43.2,,"44.2, 77.2"\n'
    );
    expect(
      result.rows.map(({ input }) => [input.latitude, input.longitude])
    ).toEqual([
      [43.1, 76.1],
      [44.2, 77.2],
    ]);
  });

  it("needs both latitude and longitude without a coordinates column", () => {
    expect(parseCsv(`${HEADER}\nAbay,KZ,Almaty,43.2,\n`).errors).toEqual([
      { rowNumber: 2, code: "coordinates_missing" },
    ]);
  });

  it("refuses unreadable, out-of-range and zero coordinates as field issues", () => {
    expect(
      parseCsv(
        `${HEADER}\nAbay,KZ,Almaty,north,76.9\nDostyk,KZ,Almaty,43.2,181\nNull,KZ,Almaty,0,0\n`
      ).errors
    ).toEqual([
      { rowNumber: 2, code: "invalid_row", issues: ["latitude_invalid"] },
      { rowNumber: 3, code: "invalid_row", issues: ["longitude_invalid"] },
      { rowNumber: 4, code: "invalid_row", issues: ["coordinates_zero"] },
    ]);
  });

  it("reads the first XLSX sheet with number cells at full precision", async () => {
    const file = workbookFile(
      [
        ["Key", "Name", "Country", "City", "Lat", "Lng", "Phone", "Active"],
        [],
        [
          101,
          "Abay",
          "Kazakhstan",
          "Almaty",
          43.238949,
          76.889709,
          77270000000,
          true,
        ],
        ["dostyk", "Dostyk", "KZ", "Almaty", 43.2331, 76.9568, "", false],
      ],
      {
        formatSheet: worksheet => {
          worksheet.E3.z = "0.00";
          worksheet.F3.z = "0.00";
        },
        otherSheet: [["name"], ["Not an office"]],
      }
    );
    const result = await readBusinessLocationImportFile(file);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        rowNumber: 3,
        keyDerived: false,
        input: {
          key: "101",
          name: "Abay",
          country: "KZ",
          city: "Almaty",
          phone: "77270000000",
          latitude: 43.238949,
          longitude: 76.889709,
          isActive: true,
        },
      },
      {
        rowNumber: 4,
        keyDerived: false,
        input: {
          key: "dostyk",
          name: "Dostyk",
          country: "KZ",
          city: "Almaty",
          latitude: 43.2331,
          longitude: 76.9568,
          isActive: false,
        },
      },
    ]);
  });

  it("reads XLSX sort order and text coordinates", async () => {
    const result = await readBusinessLocationImportFile(
      workbookFile([
        ["name", "country", "city", "latitude", "longitude", "sort_order"],
        ["Abay", "KZ", "Almaty", "43,238949", "-76,889709", 4],
        ["Dostyk", "KZ", "Almaty", 43.2, 76.9, 1.5],
      ])
    );
    expect(result.rows.map(({ input }) => input)).toEqual([
      expect.objectContaining({
        latitude: 43.238949,
        longitude: -76.889709,
        sortOrder: 4,
      }),
    ]);
    expect(result.errors).toEqual([
      { rowNumber: 3, code: "invalid_row", issues: ["sort_order_invalid"] },
    ]);
  });

  describe("derived keys", () => {
    const file =
      `${HEADER}\n` +
      "Абай,KZ,Алматы,43.2,76.9\n" +
      "Dostyk Plaza,kz,Astana,51.13,71.43\n";

    it("derives the same Latin keys from the same rows every time", () => {
      const first = parseCsv(file);
      expect(first.derivedKeys).toBe(2);
      expect(
        first.rows.map(({ input, keyDerived }) => [input.key, keyDerived])
      ).toEqual([
        ["kz_almaty_abay", true],
        ["kz_astana_dostyk_plaza", true],
      ]);
      expect(parseCsv(file)).toEqual(first);
    });

    it("derives a key only where the key cell is empty", () => {
      const result = parseCsv(
        `key,${HEADER}\n` +
          "abay-1,Абай,KZ,Алматы,43.2,76.9\n" +
          ",Dostyk,KZ,Almaty,43.21,76.95\n"
      );
      expect(result.derivedKeys).toBe(1);
      expect(
        result.rows.map(({ input, keyDerived }) => [input.key, keyDerived])
      ).toEqual([
        ["abay-1", false],
        ["kz_almaty_dostyk", true],
      ]);
    });

    it("makes every row an error when two rows get the same key", () => {
      expect(
        parseCsv(
          `${HEADER}\n` +
            "Абай,KZ,Алматы,43.2,76.9\n" +
            "Dostyk,KZ,Almaty,43.21,76.95\n" +
            "Abay,KZ,Almaty,43.22,76.91\n"
        )
      ).toEqual({
        rows: [expect.objectContaining({ rowNumber: 3 })],
        errors: [
          { rowNumber: 2, code: "duplicate_key", key: "kz_almaty_abay" },
          { rowNumber: 4, code: "duplicate_key", key: "kz_almaty_abay" },
        ],
        derivedKeys: 1,
        presentColumns: HEADER_COLUMNS,
      });
    });

    it("compares a typed key with derived keys", () => {
      expect(
        parseCsv(
          `key,${HEADER}\n` +
            "kz_almaty_abay,Abay Center,KZ,Almaty,43.2,76.9\n" +
            ",Abay,KZ,Almaty,43.21,76.95\n"
        ).errors
      ).toEqual([
        { rowNumber: 2, code: "duplicate_key", key: "kz_almaty_abay" },
        { rowNumber: 3, code: "duplicate_key", key: "kz_almaty_abay" },
      ]);
    });

    it("reports a name and city with no Latin or Cyrillic letters", () => {
      expect(parseCsv(`${HEADER}\n北京店,CN,北京,39.9,116.4\n`)).toEqual({
        rows: [],
        errors: [{ rowNumber: 2, code: "key_not_derivable" }],
        derivedKeys: 0,
        presentColumns: HEADER_COLUMNS,
      });
    });

    it("leaves the reason to the country or name error when those are missing", () => {
      expect(
        parseCsv(
          `${HEADER}\nAbay,Atlantis,Almaty,43.2,76.9\n,KZ,Almaty,43.2,76.9\n`
        ).errors
      ).toEqual([
        { rowNumber: 2, code: "country_unknown" },
        { rowNumber: 3, code: "invalid_row", issues: ["name_missing"] },
      ]);
    });
  });

  it.each([
    ["Kazakhstan", "KZ"],
    ["Казахстан", "KZ"],
    ["Қазақстан", "KZ"],
    ["kz", "KZ"],
    ["Uzbekistan", "UZ"],
    ["Узбекистан", "UZ"],
    ["Өзбекстан", "UZ"],
    ["UZ", "UZ"],
  ])("resolves the country %s to %s", (country, code) => {
    expect(
      parseCsv(`key,${HEADER}\nabay,Abay,${country},Almaty,43.2,76.9\n`).rows[0]
        ?.input.country
    ).toBe(code);
  });

  it.each(["Atlantis", "", "XX"])("reports the unknown country %j", country => {
    expect(
      parseCsv(`key,${HEADER}\nabay,Abay,${country},Almaty,43.2,76.9\n`)
    ).toEqual({
      rows: [],
      errors: [{ rowNumber: 2, code: "country_unknown" }],
      derivedKeys: 0,
      presentColumns: ["key", ...HEADER_COLUMNS],
    });
  });

  it("splits tags on commas, semicolons and bars and drops empty ones", () => {
    const result = parseCsv(
      `${HEADER},tags\n` +
        'Abay,KZ,Almaty,43.2,76.9,"VIP, 24/7; Flagship | drive-thru,, "\n' +
        "Dostyk,KZ,Almaty,43.21,76.95,\n"
    );
    expect(result.rows.map(({ input }) => input.tags)).toEqual([
      ["VIP", "24/7", "Flagship", "drive-thru"],
      undefined,
    ]);
  });

  it.each([
    ["", true],
    ["TRUE", true],
    ["false", false],
    ["Yes", true],
    ["no", false],
    ["1", true],
    ["0", false],
    ["Да", true],
    ["НЕТ", false],
    ["иә", true],
    ["Жоқ", false],
    ["Active", true],
    ["inactive", false],
    ["Активен", true],
    ["неактивен", false],
    ["Белсенді", true],
    ["белсенді  емес", false],
  ])("reads the active value %j as %s", (active, isActive) => {
    expect(
      parseCsv(`${HEADER},status\nAbay,KZ,Almaty,43.2,76.9,${active}\n`).rows[0]
        ?.input.isActive
    ).toBe(isActive);
  });

  it("refuses an active value it doesn't know", () => {
    expect(
      parseCsv(`${HEADER},active\nAbay,KZ,Almaty,43.2,76.9,maybe\n`).errors
    ).toEqual([{ rowNumber: 2, code: "active_invalid" }]);
  });

  it.each([
    ["", undefined],
    ["3", 3],
    ["-2", -2],
    ["+7", 7],
  ])("reads the sort order %j as %s", (sortOrder, expected) => {
    const result = parseCsv(
      `${HEADER},sort_order\nAbay,KZ,Almaty,43.2,76.9,${sortOrder}\n`
    );
    expect(result.rows[0]?.input.sortOrder).toBe(expected);
    expect("sortOrder" in (result.rows[0]?.input ?? {})).toBe(
      expected !== undefined
    );
  });

  it.each(["1.5", "first", "99999999999999999999"])(
    "refuses the sort order %j",
    sortOrder => {
      expect(
        parseCsv(`${HEADER},order\nAbay,KZ,Almaty,43.2,76.9,${sortOrder}\n`)
          .errors
      ).toEqual([
        { rowNumber: 2, code: "invalid_row", issues: ["sort_order_invalid"] },
      ]);
    }
  );

  it("lists every field issue of a row", () => {
    const result = parseCsv(
      `key,${HEADER},phone,map_url\n` +
        `абай,${"A".repeat(161)},KZ,Almaty,43.2,76.9,${"7".repeat(41)},http://example.com/map\n`
    );
    expect(result.errors).toEqual([
      {
        rowNumber: 2,
        code: "invalid_row",
        issues: [
          "key_invalid",
          "name_too_long",
          "phone_too_long",
          "map_url_invalid",
        ],
      },
    ]);
  });

  it("drops the quote the export puts before formula-like text only", () => {
    const result = parseCsv(
      `key,${HEADER},phone\n` +
        "'-north,'@Abay,KZ,Almaty,43.2,76.9,'+7 727 000 00 00\n" +
        "south,'s-Hertogenbosch,KZ,Almaty,43.21,76.95,\n"
    );
    expect(
      result.rows.map(({ input }) => [input.key, input.name, input.phone])
    ).toEqual([
      ["-north", "@Abay", "+7 727 000 00 00"],
      ["south", "'s-Hertogenbosch", undefined],
    ]);
  });

  it.each([
    ["name,country,latitude", ["city", "longitude"]],
    ["name,country,city", ["latitude", "longitude"]],
    ["Name,City,Lat,Lng", ["country"]],
    ["address,phone", ["name", "country", "city", "latitude", "longitude"]],
  ])("reports the columns %s lacks", (header, columns) => {
    const row = header.split(",").fill("x").join(",");
    expect(parseCsv(`${header}\n${row}\n`)).toEqual({
      rows: [],
      errors: [{ rowNumber: null, code: "missing_columns", columns }],
      derivedKeys: 0,
      presentColumns: [],
    });
  });

  it("accepts a coordinates column instead of latitude and longitude", () => {
    expect(
      parseCsv('name,country,city,coords\nAbay,KZ,Almaty,"43.2, 76.9"\n').rows
    ).toHaveLength(1);
  });

  it("refuses a file with more than 500 offices and accepts 500", () => {
    const lines = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `office_${index},Office ${index},KZ,Almaty,43.2,76.9`
      ).join("\n");
    expect(parseCsv(`key,${HEADER}\n${lines(501)}\n`)).toEqual({
      rows: [],
      errors: [{ rowNumber: null, code: "too_many_rows" }],
      derivedKeys: 0,
      presentColumns: [],
    });
    const accepted = parseCsv(`key,${HEADER}\n${lines(500)}\n`);
    expect(accepted.errors).toEqual([]);
    expect(accepted.rows).toHaveLength(500);
  });

  it.each([
    ["an empty file", ""],
    ["blank cells only", ",,\n , , \n"],
    ["a header without offices", `${HEADER}\n\n`],
  ])("reports %s as empty", (_label, text) => {
    expect(parseCsv(text)).toEqual({
      rows: [],
      errors: [{ rowNumber: null, code: "empty_file" }],
      derivedKeys: 0,
      presentColumns: [],
    });
  });

  it("numbers rows by their line in the file after blank lines", () => {
    const result = parseCsv(
      `${HEADER}\n\nAbay,KZ,Almaty,43.2,76.9\n\n\nDostyk,KZ,Almaty,,\n` +
        '"Esentai\nMall",KZ,Almaty,43.21,76.92\n,,,,\nMega,Mars,Almaty,43.2,76.9\n'
    );
    expect(result.rows.map(({ rowNumber }) => rowNumber)).toEqual([3, 7]);
    expect(result.errors).toEqual([
      { rowNumber: 6, code: "coordinates_missing" },
      { rowNumber: 10, code: "country_unknown" },
    ]);
  });
});

describe("readBusinessLocationImportFile", () => {
  const text = `${HEADER}\nAbay,KZ,Almaty,43.2,76.9\n`;

  it.each([
    ["offices.csv", "text/csv"],
    ["OFFICES.CSV", "application/vnd.ms-excel"],
    ["offices", "text/csv"],
  ])("reads %s (%s) as CSV", async (name, type) => {
    const result = await readBusinessLocationImportFile(
      csvFile(text, name, type)
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  it.each([
    [
      "an unterminated quote",
      csvFile(`${HEADER}\n"Abay,KZ,Almaty,43.2,76.9\n`),
    ],
    ["a ragged row", csvFile(`${HEADER}\nAbay,KZ,Almaty,43.2,76.9,extra\n`)],
    [
      "a broken workbook",
      new File([`PK${String.fromCharCode(3, 4)}not a zip`], "offices.xlsx"),
    ],
    ["a text file", csvFile(text, "offices.txt", "text/plain")],
  ])("reports %s as an invalid file", async (_label, file) => {
    expect(await readBusinessLocationImportFile(file)).toEqual({
      rows: [],
      errors: [{ rowNumber: null, code: "invalid_file" }],
      derivedKeys: 0,
      presentColumns: [],
    });
  });

  // Excel on Russian Windows saves "CSV" in Windows-1251.
  it("refuses a CSV that isn't UTF-8 instead of storing garbled names", async () => {
    const ascii = (value: string) => [...value].map(c => c.charCodeAt(0));
    const cp1251 = new Uint8Array([
      ...ascii(`${HEADER}\n`),
      ...[0xc0, 0xe1, 0xe0, 0xe9], // Абай
      ...ascii(",KZ,"),
      ...[0xc0, 0xeb, 0xec, 0xe0, 0xf2, 0xfb], // Алматы
      ...ascii(",43.2,76.9\n"),
    ]);
    expect(
      await readBusinessLocationImportFile(
        new File([cp1251], "offices.csv", { type: "text/csv" })
      )
    ).toEqual({
      rows: [],
      errors: [{ rowNumber: null, code: "invalid_encoding" }],
      derivedKeys: 0,
      presentColumns: [],
    });

    const utf8 = await readBusinessLocationImportFile(
      csvFile(`\uFEFF${HEADER}\nАбай,KZ,Алматы,43.2,76.9\n`)
    );
    expect(utf8.errors).toEqual([]);
    expect(utf8.rows[0].input).toMatchObject({ name: "Абай", city: "Алматы" });
  });

  it("reports an empty CSV file", async () => {
    expect((await readBusinessLocationImportFile(csvFile(""))).errors).toEqual([
      { rowNumber: null, code: "empty_file" },
    ]);
  });
});

describe("previewBusinessLocationImport", () => {
  const existing = [
    record("abay", { tags: ["vip", "24/7"], phone: "+7 727 000 00 00" }),
    record("dostyk", { phone: "+7 727 111 11 11", sortOrder: 5 }),
    record("esentai"),
    record("closed", { isActive: false }),
    record("old", { isActive: false, latitude: 43.3 }),
  ];

  it("sorts rows into created, updated and unchanged, and lists missing active offices", () => {
    expect(
      preview(existing, [
        importRow("abay", {
          name: "  abay ",
          tags: ["24/7", "VIP"],
          phone: "+7 727 000 00 00",
          latitude: "43,24",
        }),
        importRow("dostyk", { phone: "+7 727 222 22 22" }),
        importRow("old", { latitude: 43.3 }),
        importRow("mega", { latitude: 43.2 }),
      ])
    ).toStrictEqual({
      offices: [
        {
          key: "abay",
          name: "  abay ",
          country: "KZ",
          city: "Almaty",
          phone: "+7 727 000 00 00",
          tags: ["24/7", "VIP"],
          latitude: "43,24",
          longitude: 76.91,
          isActive: true,
          sortOrder: 0,
        },
        {
          key: "dostyk",
          name: "dostyk",
          country: "KZ",
          city: "Almaty",
          phone: "+7 727 222 22 22",
          latitude: 43.24,
          longitude: 76.91,
          isActive: true,
          sortOrder: 5,
        },
        {
          key: "old",
          name: "old",
          country: "KZ",
          city: "Almaty",
          latitude: 43.3,
          longitude: 76.91,
          isActive: true,
          sortOrder: 0,
        },
        {
          key: "mega",
          name: "mega",
          country: "KZ",
          city: "Almaty",
          latitude: 43.2,
          longitude: 76.91,
          isActive: true,
        },
      ],
      created: ["mega"],
      updated: ["dostyk", "old"],
      unchanged: ["abay"],
      missing: ["esentai"],
      activeAfter: 5,
      activeAfterDeactivation: 4,
      outliers: [],
    });
  });

  it("keeps the stored sort order when the row has none", () => {
    const withSortOrder = (sortOrder?: number) =>
      preview(existing, [
        importRow("dostyk", {
          phone: "+7 727 111 11 11",
          ...(sortOrder === undefined ? {} : { sortOrder }),
        }),
      ]);
    expect(withSortOrder().unchanged).toEqual(["dostyk"]);
    expect(withSortOrder().offices[0]?.sortOrder).toBe(5);
    expect(withSortOrder(5).unchanged).toEqual(["dostyk"]);
    expect(withSortOrder(6).updated).toEqual(["dostyk"]);
    expect(withSortOrder(6).offices[0]?.sortOrder).toBe(6);
  });

  it("counts a row that deactivates an office as an update", () => {
    expect(
      preview(existing, [
        importRow("esentai", { isActive: false }),
        importRow("closed", { isActive: false }),
      ])
    ).toEqual(
      expect.objectContaining({
        updated: ["esentai"],
        unchanged: ["closed"],
        missing: ["abay", "dostyk"],
        activeAfter: 2,
        activeAfterDeactivation: 0,
      })
    );
  });

  it("finds outlier pins among the active offices after the import", () => {
    const astana = { latitude: 51.13, longitude: 71.43 };
    expect(
      preview(
        [
          record("abay"),
          record("far_inactive", { isActive: false, ...astana }),
          record("dostyk"),
        ],
        [
          importRow("dostyk", { ...astana }),
          importRow("mega", { latitude: 43.1, longitude: 76.9 }),
          importRow("far_inactive", { isActive: false }),
        ]
      ).outliers
    ).toEqual([
      expect.objectContaining({
        key: "dostyk",
        cityValue: "KZ:almaty",
        nearestKey: "abay",
      }),
    ]);
  });

  it("counts a repeated key once and still sends every row", () => {
    const result = preview(existing, [
      importRow("mega"),
      importRow("mega", { name: "Mega 2" }),
    ]);
    expect(result.offices.map(({ name }) => name)).toEqual(["mega", "Mega 2"]);
    expect(result.created).toEqual(["mega"]);
    expect(result.activeAfterDeactivation).toBe(1);
  });

  describe("when the file lacks some columns", () => {
    const stored = [
      record("abay", {
        address: "Abay Ave 10",
        phone: "+7 727 000 00 00",
        mapUrl: "https://maps.app.goo.gl/abay",
        tags: ["vip", "24/7"],
        sortOrder: 3,
      }),
      record("dostyk", {
        phone: "+7 727 111 11 11",
        latitude: 43.25,
        longitude: 76.95,
        sortOrder: 1,
      }),
      record("closed", {
        isActive: false,
        latitude: 43.26,
        longitude: 76.93,
        sortOrder: 9,
      }),
    ];
    const previewCsv = (text: string) =>
      previewBusinessLocationImport(stored, parseCsv(text));
    const abay = {
      key: "abay",
      name: "abay",
      country: "KZ",
      city: "Almaty",
      latitude: 43.24,
      longitude: 76.91,
    };

    it("keeps every stored field a coordinates-only file doesn't have", () => {
      const file =
        `key,${HEADER}\n` +
        "abay,abay,KZ,Almaty,43.2401,76.91\n" +
        "dostyk,dostyk,KZ,Almaty,43.25,76.95\n" +
        "closed,closed,KZ,Almaty,43.26,76.93\n" +
        "mega,Mega,KZ,Almaty,43.2,76.9\n";
      const result = previewCsv(file);

      expect(result).toStrictEqual({
        offices: [
          {
            ...abay,
            address: "Abay Ave 10",
            phone: "+7 727 000 00 00",
            mapUrl: "https://maps.app.goo.gl/abay",
            tags: ["vip", "24/7"],
            latitude: 43.2401,
            isActive: true,
            sortOrder: 3,
          },
          {
            key: "dostyk",
            name: "dostyk",
            country: "KZ",
            city: "Almaty",
            phone: "+7 727 111 11 11",
            latitude: 43.25,
            longitude: 76.95,
            isActive: true,
            sortOrder: 1,
          },
          {
            key: "closed",
            name: "closed",
            country: "KZ",
            city: "Almaty",
            latitude: 43.26,
            longitude: 76.93,
            isActive: false,
            sortOrder: 9,
          },
          {
            key: "mega",
            name: "Mega",
            country: "KZ",
            city: "Almaty",
            latitude: 43.2,
            longitude: 76.9,
            isActive: true,
          },
        ],
        created: ["mega"],
        updated: ["abay"],
        unchanged: ["dostyk", "closed"],
        missing: [],
        activeAfter: 3,
        activeAfterDeactivation: 3,
        outliers: [],
      });
      expect(result.offices.map(({ key }) => key)).toEqual(
        parseCsv(file).rows.map(({ input }) => input.key)
      );
      expect(
        result.offices.map(office => validateBusinessLocationInput(office).ok)
      ).toEqual([true, true, true, true]);
    });

    it("clears a field whose column is there but whose cell is empty", () => {
      const result = previewCsv(
        `key,${HEADER},address,phone,map_url,tags\n` +
          "abay,abay,KZ,Almaty,43.24,76.91,,,,\n"
      );
      expect(result.offices).toStrictEqual([
        { ...abay, isActive: true, sortOrder: 3 },
      ]);
      expect(result.updated).toEqual(["abay"]);
      expect(result.missing).toEqual(["dostyk"]);
    });

    it("replaces a field whose column has a value and keeps the rest", () => {
      const result = previewCsv(
        `key,${HEADER},phone,tags\n` +
          'abay,abay,KZ,Almaty,43.24,76.91,+7 727 999 99 99,"24/7, VIP"\n'
      );
      expect(result.offices).toStrictEqual([
        {
          ...abay,
          address: "Abay Ave 10",
          phone: "+7 727 999 99 99",
          mapUrl: "https://maps.app.goo.gl/abay",
          tags: ["24/7", "VIP"],
          isActive: true,
          sortOrder: 3,
        },
      ]);
      expect(result.updated).toEqual(["abay"]);
    });

    it("counts an office unchanged when the columns the file has match", () => {
      expect(
        previewCsv(
          `key,${HEADER},tags\n` +
            'abay,abay,KZ,Almaty,43.24,76.91,"24/7, VIP"\n'
        ).unchanged
      ).toEqual(["abay"]);
    });

    it("turns an office on for an empty active cell, and keeps its state without the column", () => {
      const withColumn = previewCsv(
        `key,${HEADER},active\n` +
          "closed,closed,KZ,Almaty,43.26,76.93,\n" +
          "dostyk,dostyk,KZ,Almaty,43.25,76.95,false\n"
      );
      expect(withColumn.offices.map(({ isActive }) => isActive)).toEqual([
        true,
        false,
      ]);
      expect(withColumn.offices[1]?.phone).toBe("+7 727 111 11 11");
      expect(withColumn).toEqual(
        expect.objectContaining({
          updated: ["closed", "dostyk"],
          missing: ["abay"],
          activeAfter: 2,
          activeAfterDeactivation: 1,
        })
      );

      const withoutColumn = previewCsv(
        `key,${HEADER}\n` + "closed,closed,KZ,Almaty,43.26,76.93\n"
      );
      expect(withoutColumn.offices[0]?.isActive).toBe(false);
      expect(withoutColumn).toEqual(
        expect.objectContaining({
          unchanged: ["closed"],
          missing: ["abay", "dostyk"],
          activeAfter: 2,
          activeAfterDeactivation: 0,
        })
      );
    });

    it("replaces the stored sort order with a value and keeps it for an empty cell", () => {
      const result = previewCsv(
        `key,${HEADER},sort_order\n` +
          "abay,abay,KZ,Almaty,43.24,76.91,\n" +
          "dostyk,dostyk,KZ,Almaty,43.25,76.95,7\n"
      );
      expect(result.offices.map(({ sortOrder }) => sortOrder)).toEqual([3, 7]);
      expect(result.unchanged).toEqual(["abay"]);
      expect(result.updated).toEqual(["dostyk"]);
    });

    it("gives a new office only the columns the file has", () => {
      const result = previewCsv(
        `${HEADER},phone,sort_order\n` + "Mega,KZ,Almaty,43.2,76.9,,\n"
      );
      expect(result.offices).toStrictEqual([
        {
          key: "kz_almaty_mega",
          name: "Mega",
          country: "KZ",
          city: "Almaty",
          latitude: 43.2,
          longitude: 76.9,
          isActive: true,
        },
      ]);
      expect(result.created).toEqual(["kz_almaty_mega"]);
    });
  });
});

describe("buildBusinessLocationsCsv", () => {
  const offices = [
    record("us_new_york_soho", {
      name: "SoHo",
      country: "US",
      city: "New York",
      cityKey: "new york",
      latitude: 40.7233,
      longitude: -74.003,
      isActive: false,
    }),
    record("kz_almaty_abay", {
      name: "Абай",
      city: "Алматы",
      cityKey: "алматы",
      address: "пр. Абая 10, 2 этаж",
      phone: "+7 727 000 00 00",
      mapUrl: "https://www.google.com/maps/place/@43.238949,76.889709,17z",
      tags: ["vip", "24/7"],
      latitude: 43.238949,
      longitude: 76.889709,
      sortOrder: 1,
    }),
    record("-north", {
      name: 'Café "Central"; East',
      tags: ["=sum"],
      sortOrder: -3,
    }),
  ];

  it("writes a BOM, the export headers and CRLF rows, active offices first", () => {
    expect(buildBusinessLocationsCsv(offices)).toBe(
      `${BOM}key,name,country,city,address,phone,latitude,longitude,map_url,tags,active,sort_order\r\n` +
        `kz_almaty_abay,Абай,KZ,Алматы,"пр. Абая 10, 2 этаж",'+7 727 000 00 00,43.238949,76.889709,"https://www.google.com/maps/place/@43.238949,76.889709,17z","vip, 24/7",true,1\r\n` +
        `'-north,"Café ""Central""; East",KZ,Almaty,,,43.24,76.91,,'=sum,true,-3\r\n` +
        "us_new_york_soho,SoHo,US,New York,,,40.7233,-74.003,,,false,0"
    );
  });

  it("re-imports the export unchanged", async () => {
    const csv = buildBusinessLocationsCsv(offices);
    const expected = [offices[1], offices[2], offices[0]].map(office =>
      toBusinessLocationInput(office)
    );

    const parsed = parseCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map(({ input }) => input)).toEqual(expected);
    expect(parsed.rows.map(({ rowNumber }) => rowNumber)).toEqual([2, 3, 4]);

    const fromFile = await readBusinessLocationImportFile(csvFile(csv));
    expect(fromFile.rows.map(({ input }) => input)).toEqual(expected);

    expect(previewBusinessLocationImport(offices, parsed)).toStrictEqual({
      offices: expected,
      created: [],
      updated: [],
      unchanged: ["kz_almaty_abay", "-north", "us_new_york_soho"],
      missing: [],
      activeAfter: 2,
      activeAfterDeactivation: 2,
      outliers: [],
    });
  });

  it("writes only the header for an empty catalog", () => {
    expect(buildBusinessLocationsCsv([])).toBe(
      `${BOM}${BUSINESS_LOCATION_EXPORT_HEADERS.join(",")}`
    );
  });
});
