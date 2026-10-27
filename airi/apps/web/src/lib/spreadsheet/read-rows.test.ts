import { utils, write, type WorkSheet } from "xlsx";
import {
  findSpreadsheetColumn,
  isExcelSpreadsheetFile,
  normalizeSpreadsheetCell,
  normalizeSpreadsheetHeader,
  readCsvRows,
  readExcelRows,
  SpreadsheetReadError,
  toNumberedNonEmptyRows,
} from "./read-rows";

function makeWorkbookBuffer(
  rows: unknown[][],
  bookType: "xlsx" | "xls" = "xlsx",
  formatSheet?: (worksheet: WorkSheet) => void
): ArrayBuffer {
  const workbook = utils.book_new();
  const worksheet = utils.aoa_to_sheet(rows);
  formatSheet?.(worksheet);
  utils.book_append_sheet(workbook, worksheet, "Offices");
  return write(workbook, { bookType, type: "array" }) as ArrayBuffer;
}

function readCsvError(text: string): unknown {
  try {
    readCsvRows(text);
  } catch (error) {
    return error;
  }
  return null;
}

describe("isExcelSpreadsheetFile", () => {
  it.each([
    [{ name: "offices.xlsx", type: "" }, true],
    [{ name: "OFFICES.XLS", type: "" }, true],
    [
      {
        name: "offices",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      true,
    ],
    [{ name: "offices", type: "application/vnd.ms-excel" }, true],
    [{ name: "offices.csv", type: "text/csv" }, false],
    [{ name: "offices.xlsx.txt", type: "text/plain" }, false],
  ])("detects %j as %s", (file, expected) => {
    expect(isExcelSpreadsheetFile(file)).toBe(expected);
  });
});

describe("readCsvRows", () => {
  it("reads comma CSV with quoted commas, quotes and line breaks", () => {
    expect(
      readCsvRows('name,note\r\n"Abay, 1","Said ""hi""\nagain"\r\nDostyk,x')
    ).toEqual({
      rows: [
        ["name", "note"],
        ["Abay, 1", 'Said "hi"\nagain'],
        ["Dostyk", "x"],
      ],
      sourceRowNumbers: [1, 2, 4],
    });
  });

  it("picks semicolons from the header, strips the BOM and keeps commas in cells", () => {
    expect(
      readCsvRows("\uFEFFkey;name;lat\r\nabay;Абай, ЦУМ;43,238949\r\n")
    ).toEqual({
      rows: [
        ["key", "name", "lat"],
        ["abay", "Абай, ЦУМ", "43,238949"],
      ],
      sourceRowNumbers: [1, 2],
    });
  });

  it("uses commas for a single-column file", () => {
    expect(readCsvRows("name\nAbay\n").rows).toEqual([["name"], ["Abay"]]);
  });

  it("keeps physical line numbers after blank lines and quoted line breaks", () => {
    expect(
      readCsvRows('name,city\n\n"Two\nLines",Almaty\n\nDostyk,Almaty')
        .sourceRowNumbers
    ).toEqual([1, 3, 6]);
  });

  it("trims cells and never casts them", () => {
    expect(readCsvRows("lat , active\n 43.2 , true ").rows).toEqual([
      ["lat", "active"],
      ["43.2", "true"],
    ]);
  });

  it.each([
    'name,city\nAbay,"unfinished',
    'name,city\nAbay,"Almaty"unexpected',
    "name,city\nAbay,Almaty,Extra",
    "name,city\nAbay",
  ])("rejects a malformed file with a code and no cell contents", csv => {
    const error = readCsvError(csv);
    expect(error).toBeInstanceOf(SpreadsheetReadError);
    expect(error).toMatchObject({
      code: "invalid_csv",
      message: "invalid_csv",
      name: "SpreadsheetReadError",
    });
  });
});

describe("readExcelRows", () => {
  it("returns formatted text by default and stored numbers with raw", async () => {
    const buffer = makeWorkbookBuffer(
      [
        ["name", "latitude", "phone"],
        ["Abay", 43.238949, "+7 727 000 00 00"],
      ],
      "xlsx",
      worksheet => {
        worksheet.B2.z = "0.00";
      }
    );

    await expect(readExcelRows(buffer)).resolves.toEqual([
      ["name", "latitude", "phone"],
      ["Abay", "43.24", "+7 727 000 00 00"],
    ]);
    await expect(readExcelRows(buffer, { raw: true })).resolves.toEqual([
      ["name", "latitude", "phone"],
      ["Abay", 43.238949, "+7 727 000 00 00"],
    ]);
  });

  it("keeps leading and inner empty rows so index + 1 is the sheet row", async () => {
    const rows = await readExcelRows(
      makeWorkbookBuffer([[], ["name"], [], ["Abay"]])
    );
    expect(rows).toEqual([[""], ["name"], [""], ["Abay"]]);
    expect(toNumberedNonEmptyRows(rows)).toEqual([
      { values: ["name"], rowNumber: 2 },
      { values: ["Abay"], rowNumber: 4 },
    ]);
  });

  it("reads legacy XLS files", async () => {
    await expect(
      readExcelRows(
        makeWorkbookBuffer(
          [
            ["name", "city"],
            ["Abay", "Алматы"],
          ],
          "xls"
        )
      )
    ).resolves.toEqual([
      ["name", "city"],
      ["Abay", "Алматы"],
    ]);
  });

  it("throws no_sheet for a workbook without sheets", async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("xlsx", () => ({
        read: () => ({ SheetNames: [], Sheets: {} }),
        utils: { sheet_to_json: jest.fn() },
      }));
      const reader = await import("./read-rows");
      const error = await reader
        .readExcelRows(new ArrayBuffer(0))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(reader.SpreadsheetReadError);
      expect(error).toMatchObject({ code: "no_sheet" });
    });
    jest.dontMock("xlsx");
  });
});

describe("toNumberedNonEmptyRows", () => {
  it("drops rows whose cells are all blank and keeps source row numbers", () => {
    expect(
      toNumberedNonEmptyRows(
        [["name"], ["", "  ", null, undefined], ["Abay"], [0]],
        [1, 3, 4, 7]
      )
    ).toEqual([
      { values: ["name"], rowNumber: 1 },
      { values: ["Abay"], rowNumber: 4 },
      { values: [0], rowNumber: 7 },
    ]);
  });

  it("numbers rows by position without source row numbers", () => {
    expect(toNumberedNonEmptyRows([[], ["name"], [""], ["Abay"]])).toEqual([
      { values: ["name"], rowNumber: 2 },
      { values: ["Abay"], rowNumber: 4 },
    ]);
  });
});

describe("cell and header normalization", () => {
  it.each([
    [null, ""],
    [undefined, ""],
    [43.238949, "43.238949"],
    [false, "false"],
    ["  Abay ", "  Abay "],
  ])("turns cell %j into %j", (value, expected) => {
    expect(normalizeSpreadsheetCell(value)).toBe(expected);
  });

  it.each([
    ["  Phone Number ", "phone_number"],
    ["E-mail", "e_mail"],
    ["map.url", "map_url"],
    ["Sort -- Order", "sort_order"],
    ["__Key__", "key"],
    ["Код филиала", "код_филиала"],
    ["ҚАЛА", "қала"],
    [null, ""],
  ])("turns header %j into %j", (value, expected) => {
    expect(normalizeSpreadsheetHeader(value)).toBe(expected);
  });
});

describe("findSpreadsheetColumn", () => {
  const header = ["id", "name", "key", "name"];

  it("prefers earlier aliases over earlier columns", () => {
    expect(findSpreadsheetColumn(header, ["key", "id"])).toBe(2);
    expect(findSpreadsheetColumn(header, ["office_id", "id"])).toBe(0);
  });

  it("returns the leftmost duplicate column", () => {
    expect(findSpreadsheetColumn(header, ["name"])).toBe(1);
  });

  it("returns -1 when no alias matches exactly", () => {
    expect(findSpreadsheetColumn(header, ["names", "Key"])).toBe(-1);
    expect(findSpreadsheetColumn([], ["key"])).toBe(-1);
  });
});
