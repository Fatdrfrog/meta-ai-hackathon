import { utils, write } from "xlsx";
import {
  buildSkippedUploadRowsCsv,
  parseCsvRecipientUpload,
  parseExcelRecipientUpload,
} from "./recipient-upload-parser";

const messages = {
  emptyFile: "empty file",
  whatsappMissingPhone: "missing phone",
  whatsappBirthdayMissingColumns: "missing birthday columns",
  telegramMissingChatId: "missing telegram id",
  telegramBirthdayMissingColumns: "missing telegram birthday columns",
  emailMissingAddress: "missing email",
  noValidRecipients: "no valid recipients",
  maxRecipientsExceeded: "too many recipients",
  whatsappInvalidPhone: (row: number) => `Invalid phone in row ${row}`,
  invalidCsv: "invalid CSV format",
};

function makeWorkbookBuffer(
  rows: string[][],
  bookType: "xlsx" | "xls" = "xlsx",
  hiddenRowIndexes: number[] = []
): ArrayBuffer {
  const workbook = utils.book_new();
  const worksheet = utils.aoa_to_sheet(rows);
  if (hiddenRowIndexes.length > 0) {
    // What an Excel filter writes: the sheet keeps every row and hides the
    // ones it filters out.
    worksheet["!autofilter"] = { ref: `A1:B${rows.length}` };
    worksheet["!rows"] = rows.map((_, index) =>
      hiddenRowIndexes.includes(index) ? { hidden: true } : {}
    );
  }
  utils.book_append_sheet(workbook, worksheet, "Recipients");
  return write(workbook, { bookType, type: "array" }) as ArrayBuffer;
}

describe("recipient upload parser", () => {
  it("parses standard quoted CSV while preserving phone digits and quoted text", () => {
    const result = parseCsvRecipientUpload(
      '"phone","name","note"\r\n"\'+77001234567","Aibek, Dana","Said ""hello""\nand continued"\r\n"00123456789","Zero","text"',
      { channel: "whatsapp", messages }
    );
    expect(result.recipients).toEqual([
      expect.objectContaining({
        phone: "+77001234567",
        name: "Aibek, Dana",
        fields: { name: "Aibek, Dana", note: 'Said "hello"\nand continued' },
      }),
      expect.objectContaining({ phone: "00123456789", name: "Zero" }),
    ]);
  });

  it("parses semicolon CSV with BOM and CRLF without splitting commas inside names", () => {
    const result = parseCsvRecipientUpload(
      '\uFEFF"phone";"name"\r\n"\'+77001234567";"Aibek, Dana"\r\n',
      { channel: "whatsapp", messages }
    );
    expect(result.recipients).toEqual([
      expect.objectContaining({ phone: "+77001234567", name: "Aibek, Dana" }),
    ]);
  });

  it.each([
    'phone,name\n+77001234567,"unfinished',
    'phone,name\n+77001234567,"name"unexpected',
    "phone,name\n+77001234567,Name,Extra",
    "phone,name\n+77001234567",
  ])(
    "rejects the whole malformed CSV without exposing raw cell values",
    csv => {
      expect(() =>
        parseCsvRecipientUpload(csv, { channel: "whatsapp", messages })
      ).toThrow("invalid CSV format");
    }
  );

  it("reports physical file rows after quoted newlines", () => {
    const result = parseCsvRecipientUpload(
      'phone,name\n+77001234567,"Two\nLines"\n\ninvalid,Bad',
      { channel: "whatsapp", messages }
    );
    expect(result.recipients).toHaveLength(1);
    expect(result.skippedRows).toEqual([
      { row: 5, value: "invalid", reason: "invalid_phone" },
    ]);
  });

  it("imports spreadsheet text-prefixed phones as canonical phone values", () => {
    const result = parseCsvRecipientUpload(
      "phone,name\n'+77001234567,Aibek\n'87007654321,Dana",
      { channel: "whatsapp", messages }
    );
    expect(result.recipients.map(recipient => recipient.phone)).toEqual([
      "+77001234567",
      "77007654321",
    ]);
  });

  it.each([
    "KZ.1387452760252254",
    "wa_bsuid_US.123456789012",
    "'+SUM(77001234567)",
    "call +77001234567",
    "12345",
  ])("skips and reports a row whose phone is %s", phone => {
    const result = parseCsvRecipientUpload(
      `phone,name\n+77001234567,Valid\n${phone},Invalid`,
      {
        channel: "whatsapp",
        messages,
      }
    );
    expect(result.recipients).toEqual([
      expect.objectContaining({ phone: "+77001234567", name: "Valid" }),
    ]);
    expect(result.skippedRows).toEqual([
      expect.objectContaining({ row: 3, reason: "invalid_phone" }),
    ]);
  });

  it("reports the original file row after blank lines", () => {
    expect(
      parseCsvRecipientUpload(
        "phone,name\n\n+77001234567,Valid\n\ninvalid,Bad",
        {
          channel: "whatsapp",
          messages,
        }
      ).skippedRows
    ).toEqual([{ row: 5, value: "invalid", reason: "invalid_phone" }]);
  });

  it("reports a populated CSV row with no phone while ignoring entirely blank rows", () => {
    const result = parseCsvRecipientUpload(
      "phone,name\n+77001234567,Valid\n,\n,Missing phone",
      {
        channel: "whatsapp",
        messages,
      }
    );
    expect(result.recipients).toHaveLength(1);
    expect(result.skippedRows).toEqual([
      { row: 4, value: "", reason: "missing_recipient" },
    ]);
    expect(
      parseCsvRecipientUpload("phone,name\n,\n+77001234567,Valid\n,", {
        channel: "whatsapp",
        messages,
      })
    ).toMatchObject({ recipients: [expect.anything()], skippedRows: [] });
  });

  it("reports a populated spreadsheet row with no phone while ignoring entirely blank rows", async () => {
    await expect(
      parseExcelRecipientUpload(
        makeWorkbookBuffer([
          ["phone", "name"],
          ["+77001234567", "Valid"],
          [],
          ["", "Missing phone"],
        ]),
        { channel: "whatsapp", messages }
      )
    ).resolves.toMatchObject({
      originalRecipientCount: 1,
      skippedRows: [{ row: 4, value: "", reason: "missing_recipient" }],
    });
    await expect(
      parseExcelRecipientUpload(
        makeWorkbookBuffer([["phone", "name"], [], ["+77001234567", "Valid"]]),
        { channel: "whatsapp", messages }
      )
    ).resolves.toMatchObject({ originalRecipientCount: 1, skippedRows: [] });
  });

  it("reports the original spreadsheet row after empty rows", async () => {
    await expect(
      parseExcelRecipientUpload(
        makeWorkbookBuffer([["phone"], [], ["+77001234567"], [], ["invalid"]]),
        { channel: "whatsapp", messages }
      )
    ).resolves.toMatchObject({
      skippedRows: [{ row: 5, value: "invalid", reason: "invalid_phone" }],
    });
  });

  it("still refuses a file with no usable phone, naming the first bad row", () => {
    expect(() =>
      parseCsvRecipientUpload("phone,name\n,Missing\nbad,Bad\n12,Short", {
        channel: "whatsapp",
        messages,
      })
    ).toThrow("Invalid phone in row 3");
    expect(() =>
      parseCsvRecipientUpload("phone,name\n,Missing\n,Also missing", {
        channel: "whatsapp",
        messages,
      })
    ).toThrow("no valid recipients");
  });

  it("skips invalid email addresses instead of failing the file", () => {
    const result = parseCsvRecipientUpload(
      "email,name\nOK@Example.com,Ok\nnot-an-email,Bad\n,Missing",
      { channel: "email", messages }
    );
    expect(result.recipients).toEqual([
      expect.objectContaining({ email: "ok@example.com", name: "Ok" }),
    ]);
    expect(result.skippedRows).toEqual([
      { row: 3, value: "not-an-email", reason: "invalid_email" },
      { row: 4, value: "", reason: "missing_recipient" },
    ]);
  });

  it("reports Telegram rows without a chat id", () => {
    const result = parseCsvRecipientUpload("chat_id,name\n123,Ok\n,Missing", {
      channel: "telegram",
      messages,
    });
    expect(result.recipients).toHaveLength(1);
    expect(result.skippedRows).toEqual([
      { row: 3, value: "", reason: "missing_recipient" },
    ]);
  });

  it("does not count skipped rows toward the recipient limit", () => {
    const result = parseCsvRecipientUpload(
      "phone\n+77001234567\ninvalid\n+77007654321\n+77009999999",
      { channel: "whatsapp", messages, recipientLimit: 2 }
    );
    expect(result).toMatchObject({
      originalRecipientCount: 3,
      truncated: true,
      recipients: [
        expect.objectContaining({ phone: "+77001234567" }),
        expect.objectContaining({ phone: "+77007654321" }),
      ],
      skippedRows: [{ row: 3, value: "invalid", reason: "invalid_phone" }],
    });
  });

  it("includes leading empty spreadsheet rows in invalid phone locations", async () => {
    await expect(
      parseExcelRecipientUpload(
        makeWorkbookBuffer([[], [], ["phone"], ["invalid"]]),
        { channel: "whatsapp", messages }
      )
    ).rejects.toThrow("Invalid phone in row 4");
  });

  it("keeps existing CSV recipient parsing behavior", () => {
    const result = parseCsvRecipientUpload(
      "phone,name,var1\n+77001234567,Aibek,discount",
      {
        channel: "whatsapp",
        templateVariables: ["1"],
        messages,
      }
    );

    expect(result.recipients).toEqual([
      {
        phone: "+77001234567",
        name: "Aibek",
        fields: { name: "Aibek", var1: "discount" },
        variables: { "1": "discount" },
      },
    ]);
    expect(result.variableMapping).toEqual({ "1": "var1" });
  });

  it.each([
    ["адрес_1", "адрес_1,1"],
    ["phone1", "phone1,{{1}}"],
    ["2021", "2021,var_1"],
    ["var10", "var10,var1"],
  ])("does not take a column like %s as {{1}}", (decoy, columns) => {
    const result = parseCsvRecipientUpload(
      `phone,${columns}\n+77001234567,decoy,expected`,
      { channel: "whatsapp", templateVariables: ["1"], messages }
    );

    expect(result.variableMapping["1"]).not.toBe(decoy);
    expect(result.recipients[0]?.variables).toEqual({ "1": "expected" });
  });

  it.each([
    ["{1}", "{1}"],
    ["{{ 1 }}", "{{_1_}}"],
    ["Variable 1", "variable_1"],
    ["{{1}} Имя", "{{1}}_имя"],
  ])("takes a column named %s as {{1}}", (column, normalized) => {
    const result = parseCsvRecipientUpload(
      `phone,имя,${column}\n+77001234567,Aibek,expected`,
      { channel: "whatsapp", templateVariables: ["1"], messages }
    );

    expect(result.variableMapping).toEqual({ "1": normalized });
    expect(result.recipients[0]?.variables).toEqual({ "1": "expected" });
  });

  it("leaves {{1}} unmapped when only a column containing the digit exists", () => {
    const result = parseCsvRecipientUpload(
      "phone,адрес_1\n+77001234567,Abay 1",
      { channel: "whatsapp", templateVariables: ["1"], messages }
    );

    expect(result.variableMapping).toEqual({});
    expect(result.recipients[0]?.variables).toBeUndefined();
  });

  it("keeps matching named variables by a column that contains the name", () => {
    const result = parseCsvRecipientUpload(
      "phone,customer_first_name\n+77001234567,Aibek",
      { channel: "whatsapp", templateVariables: ["first_name"], messages }
    );

    expect(result.variableMapping).toEqual({
      first_name: "customer_first_name",
    });
    expect(result.recipients[0]?.variables).toEqual({ first_name: "Aibek" });
  });

  it("parses XLSX recipient spreadsheets with the same channel validation", async () => {
    const buffer = makeWorkbookBuffer([
      ["email", "name", "tier"],
      ["SAM@EXAMPLE.COM", "Samat", "vip"],
    ]);

    const result = await parseExcelRecipientUpload(buffer, {
      channel: "email",
      messages,
    });

    expect(result.recipients).toEqual([
      {
        email: "sam@example.com",
        name: "Samat",
        fields: { name: "Samat", tier: "vip" },
        variables: { name: "Samat", tier: "vip" },
      },
    ]);
  });

  it("parses legacy XLS recipient spreadsheets", async () => {
    const buffer = makeWorkbookBuffer(
      [
        ["chat_id", "name"],
        ["123456", "Samat"],
      ],
      "xls"
    );

    const result = await parseExcelRecipientUpload(buffer, {
      channel: "telegram",
      messages,
    });

    expect(result.recipients).toEqual([
      {
        chatId: "123456",
        name: "Samat",
        fields: { name: "Samat" },
        variables: { name: "Samat" },
      },
    ]);
  });

  it("keeps WhatsApp phone, Russian name, and email from XLSX imports", async () => {
    const buffer = makeWorkbookBuffer([
      ["phone", "Имя", "Email", "Баллов", "Регион"],
      ["+77001234567", "Жулдыз", "CLIENT@EXAMPLE.COM", "120", "Алматы"],
    ]);

    const result = await parseExcelRecipientUpload(buffer, {
      channel: "whatsapp",
      messages,
    });

    expect(result.recipients).toEqual([
      expect.objectContaining({
        phone: "+77001234567",
        name: "Жулдыз",
        email: "client@example.com",
      }),
    ]);
  });

  it("keeps birthday columns from WhatsApp uploads", () => {
    const result = parseCsvRecipientUpload(
      "phone,name,birthday\n+77001234567,Aibek,17.04.1992",
      {
        channel: "whatsapp",
        messages,
      }
    );

    expect(result.recipients).toEqual([
      expect.objectContaining({
        phone: "+77001234567",
        name: "Aibek",
        birthday: "17.04.1992",
        fields: expect.objectContaining({
          birthday: "17.04.1992",
        }),
      }),
    ]);
  });

  it("requires phone and birthday columns for birthday WhatsApp uploads", () => {
    expect(() =>
      parseCsvRecipientUpload("phone,name\n+77001234567,Aibek", {
        channel: "whatsapp",
        messages,
        requireBirthdayColumn: true,
      })
    ).toThrow("missing birthday columns");

    expect(() =>
      parseCsvRecipientUpload("birthday,name\n17.04.1992,Aibek", {
        channel: "whatsapp",
        messages,
        requireBirthdayColumn: true,
      })
    ).toThrow("missing birthday columns");
  });

  it("requires chat_id and birthday columns for birthday Telegram uploads", () => {
    expect(() =>
      parseCsvRecipientUpload("chat_id,name\n123456,Aibek", {
        channel: "telegram",
        messages,
        requireBirthdayColumn: true,
      })
    ).toThrow("missing telegram birthday columns");

    expect(() =>
      parseCsvRecipientUpload("birthday,name\n17.04.1992,Aibek", {
        channel: "telegram",
        messages,
        requireBirthdayColumn: true,
      })
    ).toThrow("missing telegram birthday columns");
  });

  it("keeps Telegram chat IDs and birthdays for birthday imports", () => {
    const result = parseCsvRecipientUpload(
      "chat_id,name,birthday\n123456,Aibek,17.04.1992",
      {
        channel: "telegram",
        messages,
        requireBirthdayColumn: true,
      }
    );

    expect(result.recipients).toEqual([
      expect.objectContaining({
        chatId: "123456",
        name: "Aibek",
        birthday: "17.04.1992",
        fields: expect.objectContaining({
          birthday: "17.04.1992",
        }),
      }),
    ]);
  });

  it("keeps imported recipients when no attach cap is provided", async () => {
    const buffer = makeWorkbookBuffer([
      ["phone", "name"],
      ["+77000000001", "One"],
      ["+77000000002", "Two"],
      ["+77000000003", "Three"],
    ]);

    const result = await parseExcelRecipientUpload(buffer, {
      channel: "whatsapp",
      messages,
    });

    expect(result.recipients).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(result.recipientLimit).toBe(50_000);
  });

  it("leaves out rows an Excel filter hides and counts them", async () => {
    const buffer = makeWorkbookBuffer(
      [
        ["phone", "name"],
        ["+77000000001", "Shown"],
        ["+77000000002", "Filtered out"],
        ["+77000000003", "Shown"],
        ["+77000000004", "Filtered out"],
      ],
      "xlsx",
      [2, 4]
    );

    const result = await parseExcelRecipientUpload(buffer, {
      channel: "whatsapp",
      messages,
    });

    expect(result.recipients.map(recipient => recipient.phone)).toEqual([
      "+77000000001",
      "+77000000003",
    ]);
    expect(result.hiddenRowCount).toBe(2);
    expect(result.originalRecipientCount).toBe(2);
  });

  it("keeps a hidden header and real sheet rows when rows are hidden", async () => {
    const hiddenHeader = makeWorkbookBuffer(
      [["phone"], ["+77000000001"], ["+77000000002"]],
      "xlsx",
      [0, 1]
    );
    await expect(
      parseExcelRecipientUpload(hiddenHeader, { channel: "whatsapp", messages })
    ).resolves.toMatchObject({
      recipients: [{ phone: "+77000000002" }],
      hiddenRowCount: 1,
    });

    // A hidden row above an invalid one must not shift its row number.
    const shifted = makeWorkbookBuffer(
      [["phone"], ["+77000000001"], ["invalid"]],
      "xlsx",
      [1]
    );
    await expect(
      parseExcelRecipientUpload(shifted, { channel: "whatsapp", messages })
    ).rejects.toThrow("Invalid phone in row 3");
  });

  it("reports no hidden rows for CSV and for sheets without hidden rows", async () => {
    expect(
      parseCsvRecipientUpload("phone\n+77000000001", {
        channel: "whatsapp",
        messages,
      }).hiddenRowCount
    ).toBe(0);
    await expect(
      parseExcelRecipientUpload(
        makeWorkbookBuffer([["phone"], ["+77000000001"]]),
        { channel: "whatsapp", messages }
      )
    ).resolves.toMatchObject({ hiddenRowCount: 0 });
  });

  it("cuts imported recipients to the provided recipient limit", async () => {
    const buffer = makeWorkbookBuffer([
      ["phone", "name"],
      ["+77000000001", "One"],
      ["+77000000002", "Two"],
      ["+77000000003", "Three"],
    ]);

    const result = await parseExcelRecipientUpload(buffer, {
      channel: "whatsapp",
      messages,
      recipientLimit: 2,
    });

    expect(result.recipients.map(recipient => recipient.phone)).toEqual([
      "+77000000001",
      "+77000000002",
    ]);
    expect(result.truncated).toBe(true);
    expect(result.originalRecipientCount).toBe(3);
    expect(result.recipientLimit).toBe(2);
  });
});

describe("buildSkippedUploadRowsCsv", () => {
  const labels = {
    columns: { row: "Row", value: "Value", reason: "Reason" },
    reasons: {
      missing_recipient: "No recipient",
      invalid_phone: "Invalid phone",
      invalid_email: "Invalid, email",
    },
  };

  it("quotes cells with commas, quotes and line breaks", () => {
    expect(
      buildSkippedUploadRowsCsv(
        [
          { row: 3, value: 'Aibek "Ali", KZ', reason: "invalid_phone" },
          { row: 4, value: "two\nlines", reason: "invalid_email" },
          { row: 5, value: "", reason: "missing_recipient" },
        ],
        labels
      )
    ).toBe(
      [
        "Row,Value,Reason",
        '3,"Aibek ""Ali"", KZ",Invalid phone',
        '4,"two\nlines","Invalid, email"',
        "5,,No recipient",
      ].join("\r\n")
    );
  });

  it.each(["=SUM(A1)", "+77001", "-1", "@cmd"])(
    "neutralizes a cell starting with %s",
    value => {
      expect(
        buildSkippedUploadRowsCsv(
          [{ row: 2, value, reason: "invalid_phone" }],
          labels
        )
      ).toContain(`2,'${value},Invalid phone`);
    }
  );
});
