import { readCsvRows } from "./read-rows";
import { buildCsv, csvCell } from "./write-csv";

describe("csvCell", () => {
  it.each([
    [43.238949, "43.238949"],
    [-76.889709, "-76.889709"],
    [0, "0"],
    [Number.NaN, ""],
    [Number.POSITIVE_INFINITY, ""],
    [true, "true"],
    [false, "false"],
    [null, ""],
    [undefined, ""],
    ["Алматы", "Алматы"],
  ])("writes %j as %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it.each([
    ["=1+1", "'=1+1"],
    ["+7 727 000 00 00", "'+7 727 000 00 00"],
    ["-76.5", "'-76.5"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["  =1+1", "'  =1+1"],
    ["\tcmd", "'\tcmd"],
    ["\rcmd", '"\'\rcmd"'],
    ["\ncmd", '"\'\ncmd"'],
  ])("prefixes formula-like text %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it.each([
    ['Say "hi"', '"Say ""hi"""'],
    ["Abay, 1", '"Abay, 1"'],
    ["Abay; 1", '"Abay; 1"'],
    ["Two\nLines", '"Two\nLines"'],
    ["Two\r\nLines", '"Two\r\nLines"'],
    [" Abay", '" Abay"'],
    ["Abay ", '"Abay "'],
    ["a-b=c", "a-b=c"],
  ])("quotes %j only when needed", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
});

describe("buildCsv", () => {
  it("joins cells with commas and rows with CRLF, without a trailing line break", () => {
    expect(
      buildCsv([
        ["key", "latitude"],
        ["abay", 43.2],
      ])
    ).toBe("key,latitude\r\nabay,43.2");
  });

  it("adds a UTF-8 BOM only when asked", () => {
    expect(buildCsv([["name"], ["Абай"]], { bom: true })).toBe(
      "\uFEFFname\r\nАбай"
    );
    expect(buildCsv([])).toBe("");
    expect(buildCsv([], { bom: true })).toBe("\uFEFF");
  });

  it("reads back through readCsvRows with the same cells", () => {
    const rows = [
      ["key", "name;label", "phone", "latitude", "longitude", "note", "active"],
      [
        "abay",
        'Абай, "ЦУМ"',
        "+7 727 000 00 00",
        43.238949,
        -76.889709,
        "Two\nLines",
        false,
      ],
      ["dostyk", "Достык", "", 51.1, 71.4, "", true],
    ];

    expect(readCsvRows(buildCsv(rows, { bom: true }))).toEqual({
      rows: [
        [
          "key",
          "name;label",
          "phone",
          "latitude",
          "longitude",
          "note",
          "active",
        ],
        [
          "abay",
          'Абай, "ЦУМ"',
          "'+7 727 000 00 00",
          "43.238949",
          "-76.889709",
          "Two\nLines",
          "false",
        ],
        ["dostyk", "Достык", "", "51.1", "71.4", "", "true"],
      ],
      sourceRowNumbers: [1, 2, 4],
    });
  });
});
